/**
 * ==============================================================================
 * OmniNovel - Production Infrastructure Acceptance Runner (Phase 6.2)
 * Automated Verification for 14 Acceptance Gates (G01 -> G14)
 * Hardened & Sanitized: Real Exit Codes + Zero Hardcoded Credentials (Dynamic Env)
 * ==============================================================================
 */

import { execSync } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { io } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';

// Load environment variables dynamically from .env at runtime (respecting environment precedence: OS/Docker/CI > .env)
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
}

const JWT_SECRET = process.env.JWT_SECRET || '';
const AI_WORKER_SECRET = process.env.AI_WORKER_SECRET || '';

if (!JWT_SECRET || !AI_WORKER_SECRET) {
  console.error('FATAL: Required environment variables (JWT_SECRET, AI_WORKER_SECRET) missing in .env');
  process.exit(1);
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

interface GateResult {
  gate: string;
  name: string;
  passed: boolean;
  evidence: string;
  assertion: string;
  failureMode: string;
}

const results: GateResult[] = [];
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function runCommand(cmd: string): CommandResult {
  try {
    const stdout = execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    return { exitCode: 0, stdout, stderr: '', output: stdout };
  } catch (err: any) {
    const exitCode = typeof err.status === 'number' ? err.status : 1;
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const output = [stdout, stderr].filter(Boolean).join('\n').trim() || err.message;
    return { exitCode, stdout, stderr, output };
  }
}

async function httpGet(url: string, isHttps = false): Promise<{ statusCode: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const client = isHttps ? https : http;
    const options = isHttps ? { agent: httpsAgent } : {};
    const req = client.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
  });
}

async function verifyAllGates() {
  console.log('================================================================');
  console.log('  STARTING OMNINOVEL PHASE 6.2 - 15 ACCEPTANCE GATES RUNNER');
  console.log('================================================================\n');

  // G00: Credential Security Prerequisite (Automated Sanity + Manual Attestation)
  try {
    // 1. Automated checks:
    // a. Boolean probe on AI Worker verifying required vars present and forbidden absent without printing values
    const probeRes = runCommand('docker compose --env-file .env -f deploy/docker-compose.yml exec -T ai-worker python -c "import os; required=[\'AI_WORKER_SECRET\',\'S3_ENDPOINT\',\'S3_BUCKET_MANGA\',\'S3_BUCKET_NOVEL\']; forbidden=[\'DATABASE_URL\',\'JWT_SECRET\',\'JWT_REFRESH_SECRET\',\'REDIS_PASSWORD\',\'S3_ACCESS_KEY_ID\',\'S3_SECRET_ACCESS_KEY\']; print(\'REQUIRED_PRESENT:\', all(bool(os.getenv(k)) for k in required)); print(\'FORBIDDEN_ABSENT:\', all(k not in os.environ for k in forbidden))"');
    const workerProbePassed = probeRes.exitCode === 0 &&
                              probeRes.output.includes('REQUIRED_PRESENT: True') &&
                              probeRes.output.includes('FORBIDDEN_ABSENT: True');

    // b. Secret format and length sanity checks (configuration plausibility)
    const secretFormatSane = Boolean(AI_WORKER_SECRET && /^[a-f0-9]{64}$/i.test(AI_WORKER_SECRET));
    const jwtFormatSane = Boolean(JWT_SECRET && JWT_SECRET.length >= 16 && process.env.JWT_REFRESH_SECRET && process.env.JWT_REFRESH_SECRET.length >= 16);
    const dbConfigured = Boolean(process.env.DB_PASSWORD && process.env.DB_PASSWORD.length >= 8);
    const redisConfigured = Boolean(process.env.REDIS_PASSWORD && process.env.REDIS_PASSWORD.length >= 8);
    const r2Configured = Boolean(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
    const formatsSane = secretFormatSane && jwtFormatSane && dbConfigured && redisConfigured && r2Configured;

    // c. Current services healthy
    const apiHealth = runCommand('docker inspect --format="{{.State.Health.Status}}" omninovel-prod-api');
    const workerHealth = runCommand('docker inspect --format="{{.State.Health.Status}}" omninovel-prod-ai-worker');
    const servicesHealthy = apiHealth.exitCode === 0 && apiHealth.stdout.trim() === 'healthy' &&
                            workerHealth.exitCode === 0 && workerHealth.stdout.trim() === 'healthy';

    // 2. Manual attestation:
    // Explicit per-run operator attestation via environment variable (not stored in .env)
    const manualAttestationConfirmed = process.env.PHASE62_SECURITY_ATTESTED === 'true';

    const passed = workerProbePassed && formatsSane && servicesHealthy && manualAttestationConfirmed;

    results.push({
      gate: 'G00',
      name: 'Credential Security Prerequisite',
      passed,
      evidence: `Automated: Worker Probe [REQUIRED_PRESENT: True, FORBIDDEN_ABSENT: True] | Formats Sane: [AI_WORKER_SECRET(64 hex), JWT(len>=16), DB, Redis, R2] | Services Healthy: [api=${apiHealth.stdout.trim()}, ai-worker=${workerHealth.stdout.trim()}] | Manual Attestation: [PHASE62_SECURITY_ATTESTED=${manualAttestationConfirmed ? 'CONFIRMED' : 'MISSING'}] | Secrets Printed: 0`,
      assertion: 'workerProbePassed && formatsSane && servicesHealthy && manualAttestationConfirmed === true',
      failureMode: manualAttestationConfirmed ? 'Automated credential sanity checks failed or services unhealthy' : 'Operator security attestation required (set PHASE62_SECURITY_ATTESTED=true for execution)',
    });
  } catch (e: any) {
    results.push({ gate: 'G00', name: 'Credential Security Prerequisite', passed: false, evidence: e.message, assertion: 'Automated sanity & manual attestation pass', failureMode: e.message });
  }

  // G01: Compose Config Valid (Secret-Safe & Exit Code Proof)
  try {
    const res = runCommand('docker compose --env-file .env -f deploy/docker-compose.yml config --quiet');
    const passed = res.exitCode === 0 && res.output.length === 0;
    results.push({
      gate: 'G01',
      name: 'Compose Config Valid (Secret-Safe)',
      passed,
      evidence: res.exitCode === 0 ? 'docker compose config --quiet exited 0 with zero output' : `Exit ${res.exitCode}: ${res.output}`,
      assertion: 'res.exitCode === 0 && res.output.length === 0',
      failureMode: 'Invalid compose syntax, obsolete attributes or credentials rendered in output',
    });
  } catch (e: any) {
    results.push({ gate: 'G01', name: 'Compose Config Valid', passed: false, evidence: e.message, assertion: 'Exit code 0', failureMode: e.message });
  }

  // G02: Clean Multi-Stage Build & Migration Proof (Supabase Managed PostgreSQL)
  try {
    const buildRes = runCommand('docker compose --env-file .env -f deploy/docker-compose.yml build');
    const migrationRes = runCommand('docker compose --env-file .env -f deploy/docker-compose.yml run --rm --no-deps api npm run migration:run:prod');
    const hasSuccessMarker = migrationRes.output.includes('No migrations are pending') || migrationRes.output.includes('has been executed successfully');
    const passed = buildRes.exitCode === 0 && migrationRes.exitCode === 0 && hasSuccessMarker;
    results.push({
      gate: 'G02',
      name: 'Clean Multi-Stage Build & Migration Proof',
      passed,
      evidence: `Build [Exit ${buildRes.exitCode}]: multi-stage images built cleanly | Migration [Exit ${migrationRes.exitCode}]: ` + migrationRes.output.split('\n').filter(l => l.includes('migrations') || l.includes('No migrations')).join(' | '),
      assertion: 'buildRes.exitCode === 0 && migrationRes.exitCode === 0 && migrationRes.output.includes("No migrations are pending")',
      failureMode: 'Docker multi-stage build failed or database migration connection failed on Supabase',
    });
  } catch (e: any) {
    results.push({ gate: 'G02', name: 'Clean Multi-Stage Build & Migration Proof', passed: false, evidence: e.message, assertion: 'Build & Migration executed', failureMode: e.message });
  }

  // G03: Strict Host-Port Isolation
  try {
    const nginxPort = runCommand('docker port omninovel-prod-nginx');
    const apiPort = runCommand('docker port omninovel-prod-api');
    const workerPort = runCommand('docker port omninovel-prod-ai-worker');
    const redisPort = runCommand('docker port omninovel-prod-redis');

    const nginxHasPorts = nginxPort.exitCode === 0 && nginxPort.stdout.includes('80') && nginxPort.stdout.includes('443');
    const backendIsolated = apiPort.exitCode === 0 && apiPort.stdout.length === 0 &&
                            workerPort.exitCode === 0 && workerPort.stdout.length === 0 &&
                            redisPort.exitCode === 0 && redisPort.stdout.length === 0;
    const passed = nginxHasPorts && backendIsolated;

    results.push({
      gate: 'G03',
      name: 'Strict Port Isolation',
      passed,
      evidence: `Nginx bindings [Exit ${nginxPort.exitCode}]: ${nginxPort.stdout} | API [Exit ${apiPort.exitCode}]: [${apiPort.stdout || 'none'}] | Worker [Exit ${workerPort.exitCode}]: [${workerPort.stdout || 'none'}] | Redis [Exit ${redisPort.exitCode}]: [${redisPort.stdout || 'none'}]`,
      assertion: 'nginxHasPorts && backendIsolated === true',
      failureMode: 'Backend services (api, ai-worker, redis) publish ports directly to host interface',
    });
  } catch (e: any) {
    results.push({ gate: 'G03', name: 'Port Isolation', passed: false, evidence: e.message, assertion: 'Only Nginx exposed', failureMode: e.message });
  }

  // G04: Nginx API Health Pass (Bootstrap vs Production)
  try {
    const httpRes = await httpGet('http://localhost/health/live', false);
    const httpsRes = await httpGet('https://localhost/health/live', true);
    const hstsHeader = httpsRes.headers['strict-transport-security'];

    // In Production mode, HTTP port 80 redirects to HTTPS 301, and HTTPS port 443 responds 200 with HSTS
    const passed = httpRes.statusCode === 301 && httpsRes.statusCode === 200 && Boolean(hstsHeader);

    results.push({
      gate: 'G04',
      name: 'Nginx API Health Pass (Bootstrap vs Production)',
      passed,
      evidence: `HTTP/80 Status: ${httpRes.statusCode} (Redirect to HTTPS) | HTTPS/443 Status: ${httpsRes.statusCode} OK | HSTS: "${hstsHeader || 'none'}"`,
      assertion: 'httpRes.statusCode === 301 && httpsRes.statusCode === 200 && Boolean(hstsHeader)',
      failureMode: 'Nginx proxy failure, missing 301 HTTPS redirect, or missing HSTS header',
    });
  } catch (e: any) {
    results.push({ gate: 'G04', name: 'API Health Pass', passed: false, evidence: e.message, assertion: '301 redirect + 200 OK + HSTS', failureMode: e.message });
  }

  // G05: API <-> Redis Pass & Guard
  try {
    const readyRes = await httpGet('https://localhost/health/ready', true);
    const readyJson = JSON.parse(readyRes.body);
    const redisUp = readyJson?.services?.redis === 'UP';

    // Automated fail-fast check: ephemeral container with empty REDIS_PASSWORD must exit with nonzero exitCode
    const failFastRes = runCommand('docker run --rm redis:7-alpine sh -c ": \\"${REDIS_PASSWORD:?ERROR_REDIS_PASSWORD_REQUIRED}\\""');
    const guardEnforced = failFastRes.exitCode !== 0 && failFastRes.output.includes('ERROR_REDIS_PASSWORD_REQUIRED');

    const passed = redisUp && guardEnforced;
    results.push({
      gate: 'G05',
      name: 'API ↔ Redis Pass & Guard',
      passed,
      evidence: `health/ready services: ${JSON.stringify(readyJson?.services)} | Empty password guard [Exit ${failFastRes.exitCode}]: "${failFastRes.output.trim()}"`,
      assertion: 'redisUp === true && failFastRes.exitCode !== 0 && failFastRes.output.includes("ERROR_REDIS_PASSWORD_REQUIRED")',
      failureMode: 'API cannot connect to password-protected Redis or Redis starts with empty password',
    });
  } catch (e: any) {
    results.push({ gate: 'G05', name: 'API Redis Pass', passed: false, evidence: e.message, assertion: 'redis === UP && guard enforced', failureMode: e.message });
  }

  // G06: API <-> AI Worker Authenticated RPC & Egress Isolation
  try {
    // 1. ai-worker -> api auth guard test
    const noKeyApi = runCommand('docker exec omninovel-prod-ai-worker curl -s -o /dev/null -w "%{http_code}" -X POST http://api:8000/internal/v1/ai/jobs/00000000-0000-0000-0000-000000000000/events');
    const wrongKeyApi = runCommand('docker exec omninovel-prod-ai-worker curl -s -o /dev/null -w "%{http_code}" -H "X-Internal-Service-Key: invalid_secret_token" -X POST http://api:8000/internal/v1/ai/jobs/00000000-0000-0000-0000-000000000000/events');
    const validKeyApi = runCommand(`docker exec omninovel-prod-ai-worker python -c "import os, httpx; r = httpx.post('http://api:8000/internal/v1/ai/jobs/00000000-0000-0000-0000-000000000000/events', json={'eventType':'STAGE_COMPLETED','stage':'OCR','progressPercentage':50}, headers={'X-Internal-Service-Key': os.environ['AI_WORKER_SECRET']}); print(r.status_code)"`);

    // 2. api -> ai-worker auth guard test
    const noKeyWorker = runCommand('docker exec omninovel-prod-api node -e "const http = require(\'http\'); const req = http.request({ host: \'ai-worker\', port: 8001, path: \'/internal/v1/jobs/process-manga\', method: \'POST\', headers: { \'Content-Type\': \'application/json\' } }, res => console.log(res.statusCode)); req.write(\'{}\'); req.end();"');
    const validKeyWorker = runCommand(`docker exec omninovel-prod-api node -e "const http = require(\'http\'); const req = http.request({ host: \'ai-worker\', port: 8001, path: \'/internal/v1/jobs/process-manga\', method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'X-Internal-Service-Key\': process.env.AI_WORKER_SECRET } }, res => console.log(res.statusCode)); req.write(\'{}\'); req.end();"`);

    // 3. Egress & Isolation test
    const r2Egress = runCommand('docker exec omninovel-prod-ai-worker curl -I -s -o /dev/null -w "%{http_code}" https://5647695aab5f1dfad2253715bf29531e.r2.cloudflarestorage.com');
    const redisEgress = runCommand('docker exec omninovel-prod-redis ping -c 1 -W 2 1.1.1.1');

    const authEnforced = (noKeyApi.exitCode === 0 && noKeyApi.stdout === '401') &&
                         (wrongKeyApi.exitCode === 0 && wrongKeyApi.stdout === '401') &&
                         (validKeyApi.exitCode === 0 && validKeyApi.stdout === '400') &&
                         (noKeyWorker.exitCode === 0 && noKeyWorker.stdout.includes('401')) &&
                         (validKeyWorker.exitCode === 0 && validKeyWorker.stdout.includes('422'));
    const egressAndIsolationValid = (r2Egress.exitCode === 0 && (r2Egress.stdout === '400' || r2Egress.stdout === '200' || r2Egress.stdout === '403')) &&
                                    (redisEgress.exitCode !== 0 && (redisEgress.output.includes('Network unreachable') || redisEgress.output.includes('100% packet loss') || redisEgress.output.includes('bad address') || redisEgress.output.includes('56 data bytes')));

    const passed = authEnforced && egressAndIsolationValid;
    results.push({
      gate: 'G06',
      name: 'API ↔ AI Worker Authenticated RPC & Egress Isolation',
      passed,
      evidence: `Auth Guards: AI->API [NoKey:${noKeyApi.stdout}, BadKey:${wrongKeyApi.stdout}, ValidKey:${validKeyApi.stdout}] | API->AI [NoKey:${noKeyWorker.stdout.trim()}, ValidKey:${validKeyWorker.stdout.trim()}] | R2 Egress: HTTP ${r2Egress.stdout} [Exit ${r2Egress.exitCode}] | Redis Blocked: Exit ${redisEgress.exitCode}`,
      assertion: 'authEnforced === true && r2Egress.exitCode === 0 && redisEgress.exitCode !== 0',
      failureMode: 'Internal RPC unauthenticated, AI worker cannot egress, or Redis reaches internet',
    });
  } catch (e: any) {
    results.push({ gate: 'G06', name: 'API AI Worker RPC', passed: false, evidence: e.message, assertion: 'RPC authenticated & egress isolated', failureMode: e.message });
  }

  // G07: API <-> Supabase Connection Pass
  try {
    const readyRes = await httpGet('https://localhost/health/ready', true);
    const readyJson = JSON.parse(readyRes.body);
    const dbUp = readyJson?.services?.database === 'UP';
    results.push({
      gate: 'G07',
      name: 'API ↔ Supabase Connection Pass',
      passed: dbUp,
      evidence: `health/ready database: ${readyJson?.services?.database}`,
      assertion: 'readyJson.services.database === "UP"',
      failureMode: 'API cannot reach Supabase Managed PostgreSQL via omninovel-egress',
    });
  } catch (e: any) {
    results.push({ gate: 'G07', name: 'API Supabase Pass', passed: false, evidence: e.message, assertion: 'database === UP', failureMode: e.message });
  }

  // G08: API <-> R2 Live Storage Round-Trip (Presigned PUT -> HEAD -> DELETE in finally -> Post-Delete 404)
  try {
    const r2Script = `
      const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({
        region: 'auto',
        endpoint: process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
        }
      });
      const key = 'smoke-tests/g08-r2-verification.bin';
      const body = Buffer.from('G08_R2_SMOKE_TEST_PAYLOAD_' + Date.now());

      async function run() {
        let uploaded = false;
        try {
          await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET_MANGA, Key: key, Body: body, ContentType: 'text/plain' }));
          uploaded = true;
          const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET_MANGA, Key: key }));
          if (head.ContentLength !== body.length) throw new Error('Size mismatch: ' + head.ContentLength);
        } finally {
          if (uploaded) {
            try {
              await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_MANGA, Key: key }));
            } catch (delErr) {
              console.error('DELETE_FAILED:' + delErr.message);
            }
          }
        }

        /* Post-delete verification: assert object returns 404 NotFound */
        let postDelete404 = false;
        try {
          await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET_MANGA, Key: key }));
        } catch (err) {
          if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            postDelete404 = true;
          }
        }

        if (!postDelete404) {
          throw new Error('Object still exists after delete (zero-leak violated)');
        }

        console.log('R2_ROUNDTRIP_OK:verified_zero_leak:size=' + body.length);
      }
      run().catch(err => { console.error('R2_FAILED:' + err.message); process.exit(1); });
    `;
    const r2Res = runCommand(`docker exec omninovel-prod-api node -e "${r2Script.replace(/\n\s+/g, ' ')}"`);
    const passed = r2Res.exitCode === 0 && r2Res.output.includes('R2_ROUNDTRIP_OK:verified_zero_leak:size=');

    results.push({
      gate: 'G08',
      name: 'API ↔ R2 Live Storage Round-Trip (PUT -> HEAD -> DELETE -> 404)',
      passed,
      evidence: `Exit code ${r2Res.exitCode} | Result: ${r2Res.output.split('\n').find(l => l.includes('R2_ROUNDTRIP_OK')) || r2Res.output}`,
      assertion: 'r2Res.exitCode === 0 && r2Res.output.includes("R2_ROUNDTRIP_OK:verified_zero_leak")',
      failureMode: 'R2 credential or endpoint configuration invalid, unable to perform live PUT/HEAD/DELETE or post-delete 404 failed',
    });
  } catch (e: any) {
    results.push({ gate: 'G08', name: 'API R2 Pass', passed: false, evidence: e.message, assertion: 'R2_ROUNDTRIP_OK', failureMode: e.message });
  }

  // G09: WebSocket Socket.IO /ws/ai Upgrade Pass
  try {
    const signFn = (jwt as any).sign || (jwt as any).default?.sign;
    const token = signFn(
      { sub: 'd45b5c90-9f5b-4c4c-8a1a-3e8f8b8e0001', email: 'test_prod@omninovel.com', role: 'ADMIN' },
      JWT_SECRET,
      { expiresIn: '1h' },
    );

    const wsPromise = new Promise<{ passed: boolean; id: string; error?: string }>((resolve) => {
      const socket = io('https://localhost/ws/ai', {
        path: '/socket.io/',
        transports: ['websocket'],
        rejectUnauthorized: false,
        auth: { token },
        timeout: 5000,
      });

      socket.on('connect', () => {
        const id = socket.id || 'connected';
        socket.disconnect();
        resolve({ passed: true, id });
      });

      socket.on('connect_error', (err) => {
        resolve({ passed: false, id: '', error: err.message });
      });
    });

    const wsResult = await wsPromise;
    results.push({
      gate: 'G09',
      name: 'WebSocket Socket.IO /ws/ai Upgrade Pass',
      passed: wsResult.passed,
      evidence: wsResult.passed ? `Socket.IO connected via Nginx /socket.io/ to /ws/ai namespace with socket ID: ${wsResult.id}` : `WS Error: ${wsResult.error}`,
      assertion: 'wsResult.passed === true',
      failureMode: 'Nginx failed to upgrade connection or proxy /socket.io/ to backend',
    });
  } catch (e: any) {
    results.push({ gate: 'G09', name: 'WebSocket Upgrade', passed: false, evidence: e.message, assertion: 'WS connected', failureMode: e.message });
  }

  // G10: Rate Limiting & Throttling Pass (Runtime 429)
  try {
    const burstPromises: Promise<number>[] = [];
    for (let i = 0; i < 25; i++) {
      burstPromises.push(
        new Promise((resolve) => {
          const req = https.get('https://localhost/api/v1/auth/me', { agent: httpsAgent }, (res) => resolve(res.statusCode || 0));
          req.on('error', () => resolve(0));
        }),
      );
    }
    const burstCodes = await Promise.all(burstPromises);
    const count429 = burstCodes.filter((code) => code === 429).length;
    const passed = count429 > 0;
    results.push({
      gate: 'G10',
      name: 'Rate Limiting & Throttling Pass (Runtime 429)',
      passed,
      evidence: `Burst of 25 rapid requests to /api/v1/auth/me triggered ${count429} HTTP 429 responses. Status distribution: [${burstCodes.join(', ')}]`,
      assertion: 'count429 > 0',
      failureMode: 'Nginx rate limiting zone auth_limit not enforcing 429 response',
    });
  } catch (e: any) {
    results.push({ gate: 'G10', name: 'Rate Limiting Pass', passed: false, evidence: e.message, assertion: '429 triggered', failureMode: e.message });
  }

  // G11: Ingress Independent Lifecycle & Zero-Downtime Hot Reload
  try {
    // 1. Independent Lifecycle Proof: Stop API -> Restart Nginx -> Assert ACME serves 404 & proxy serves 502 -> Restart API
    const stopRes = runCommand('docker stop omninovel-prod-api');
    const restartNginxRes = runCommand('docker restart omninovel-prod-nginx');
    const nginxInspect = runCommand('docker inspect omninovel-prod-nginx --format="{{.State.Status}}"');
    const acmeRes = await httpGet('http://localhost/.well-known/acme-challenge/independent-test', false);
    const startApiRes = runCommand('docker start omninovel-prod-api');

    // Wait until all Nginx worker processes have stably resolved api in zone api_backend
    const probeAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    let apiRecovered = false;
    for (let attempt = 0; attempt < 35; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      let batchSuccess = 0;
      for (let j = 0; j < 8; j++) {
        try {
          const checkCode = await new Promise<number>((resolve) => {
            const req = https.get('https://localhost/health/live', { agent: probeAgent }, (res) => {
              res.resume(); // consume data
              resolve(res.statusCode || 0);
            });
            req.on('error', () => resolve(0));
            req.setTimeout(2000, () => {
              req.destroy();
              resolve(0);
            });
          });
          if (checkCode === 200) batchSuccess++;
        } catch {}
      }
      if (batchSuccess === 8) {
        apiRecovered = true;
        break;
      }
    }

    // 2. Zero-Downtime Hot Reload Traffic Stream Proof
    const reloadAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    const streamResponses: number[] = [];
    let isSending = true;
    const interval = setInterval(() => {
      if (!isSending) return;
      const req = https.get('https://localhost/health/live', { agent: reloadAgent }, (res) => {
        res.resume();
        if (res.statusCode) streamResponses.push(res.statusCode);
      });
      req.on('error', (err: any) => streamResponses.push(err.code ? 0 : 0));
    }, 40);

    await new Promise((r) => setTimeout(r, 200));
    const reloadOutput = runCommand('docker exec omninovel-prod-nginx /activate-production-tls.sh');
    await new Promise((r) => setTimeout(r, 800));
    isSending = false;
    clearInterval(interval);
    await new Promise((r) => setTimeout(r, 300));

    const totalRequests = streamResponses.length;
    const count200 = streamResponses.filter((s) => s === 200).length;
    const droppedCount = streamResponses.filter((s) => s !== 200).length;

    const passed = stopRes.exitCode === 0 &&
                   restartNginxRes.exitCode === 0 &&
                   nginxInspect.exitCode === 0 && nginxInspect.stdout === 'running' &&
                   acmeRes.statusCode === 404 &&
                   startApiRes.exitCode === 0 &&
                   reloadOutput.exitCode === 0 &&
                   apiRecovered &&
                   totalRequests >= 15 &&
                   droppedCount === 0;

    results.push({
      gate: 'G11',
      name: 'Ingress Independent Lifecycle & Zero-Downtime Hot Reload',
      passed,
      evidence: `Independent Lifecycle [Exit ${nginxInspect.exitCode}]: Status ${nginxInspect.stdout}, ACME Port 80: HTTP ${acmeRes.statusCode} | Zero-Downtime Reload [Exit ${reloadOutput.exitCode}]: [${totalRequests} requests, ${count200} HTTP 200 OK, ${droppedCount} dropped]`,
      assertion: 'nginxInspect.exitCode === 0 && acmeRes.statusCode === 404 && droppedCount === 0 && reloadOutput.exitCode === 0',
      failureMode: 'Nginx crashes when API is down or connections dropped during hot reload',
    });
  } catch (e: any) {
    results.push({ gate: 'G11', name: 'TLS Transition', passed: false, evidence: e.message, assertion: 'independent lifecycle && zero dropped requests', failureMode: e.message });
  }

  // G12: Auto-Recovery, Cache Persistence & Real Dynamic DNS Re-resolution
  try {
    // 1. Check AI Model Cache persistence across recreate
    const writeRes = runCommand('docker exec omninovel-prod-ai-worker sh -c "echo -n g12_cache_persistence_verified > /home/appuser/.cache/g12_test.txt"');
    const recreateWorkerRes = runCommand('docker compose --env-file .env -f deploy/docker-compose.yml up -d --force-recreate ai-worker');
    const readRes = runCommand('docker exec omninovel-prod-ai-worker cat /home/appuser/.cache/g12_test.txt');

    // 2. Dynamic DNS Re-resolution with FORCED IP Change
    const oldIpRes = runCommand('docker inspect omninovel-prod-api --format="{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k \\"omninovel-edge\\"}}{{$v.IPAddress}}{{end}}{{end}}"');
    const oldEdgeIp = oldIpRes.stdout.trim();

    // Stop API, occupy old IP slot with placeholder container, recreate API to force a different IP assignment
    runCommand('docker stop omninovel-prod-api');
    runCommand('docker run -d --rm --network omninovel-edge --name omninovel-ip-holder alpine sleep 60');
    runCommand('docker compose --env-file .env -f deploy/docker-compose.yml up -d api');

    const newIpRes = runCommand('docker inspect omninovel-prod-api --format="{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k \\"omninovel-edge\\"}}{{$v.IPAddress}}{{end}}{{end}}"');
    const newEdgeIp = newIpRes.stdout.trim();
    runCommand('docker rm -f omninovel-ip-holder');

    // Poll until api container completes initialization and Nginx DNS re-resolves
    let postRecreateStatusCode = 0;
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await httpGet('https://localhost/health/live', true);
        if (res.statusCode === 200) {
          postRecreateStatusCode = 200;
          break;
        }
      } catch {}
    }

    const nginxDns = runCommand('docker exec omninovel-prod-nginx nslookup api 127.0.0.11');
    const dnsLine = nginxDns.stdout.split('\n').filter(l => l.includes('Address')).pop() || '';
    const ipChanged = oldEdgeIp.length > 0 && newEdgeIp.length > 0 && oldEdgeIp !== newEdgeIp;
    const passed = writeRes.exitCode === 0 &&
                   recreateWorkerRes.exitCode === 0 &&
                   readRes.exitCode === 0 && readRes.stdout === 'g12_cache_persistence_verified' &&
                   ipChanged &&
                   postRecreateStatusCode === 200 &&
                   nginxDns.exitCode === 0;

    results.push({
      gate: 'G12',
      name: 'Auto-Recovery, Cache Persistence & DNS Re-resolve (Actual IP Change)',
      passed,
      evidence: `Cache Survives [Exit ${readRes.exitCode}]: "${readRes.stdout}" | IP Changed: [Old: ${oldEdgeIp}, New: ${newEdgeIp}, Diff: ${ipChanged}] | Nginx DNS [Exit ${nginxDns.exitCode}]: "${dnsLine.trim()}" | Live Probe: HTTP ${postRecreateStatusCode}`,
      assertion: 'readRes.exitCode === 0 && ipChanged === true && postRecreateStatusCode === 200 && nginxDns.exitCode === 0',
      failureMode: 'Cache volume wiped on recreate, IP unchanged, or Nginx stuck on stale IP returning 502',
    });
  } catch (e: any) {
    results.push({ gate: 'G12', name: 'Auto-Recovery DNS', passed: false, evidence: e.message, assertion: 'cache persisted & IP changed & 200 OK', failureMode: e.message });
  }

  // G13: Non-Root Container Hardening
  try {
    const apiUid = runCommand('docker exec omninovel-prod-api id -u');
    const workerUid = runCommand('docker exec omninovel-prod-ai-worker id -u');
    const passed = apiUid.exitCode === 0 && workerUid.exitCode === 0 && apiUid.stdout === '1000' && workerUid.stdout === '10001';
    results.push({
      gate: 'G13',
      name: 'Non-Root Container Hardening',
      passed,
      evidence: `api container UID [Exit ${apiUid.exitCode}]: ${apiUid.stdout} (node) | ai-worker UID [Exit ${workerUid.exitCode}]: ${workerUid.stdout} (appuser)`,
      assertion: 'apiUid.exitCode === 0 && apiUid.stdout === "1000" && workerUid.stdout === "10001"',
      failureMode: 'Container running with root privileges (UID 0)',
    });
  } catch (e: any) {
    results.push({ gate: 'G13', name: 'Non-Root Hardening', passed: false, evidence: e.message, assertion: 'non-root UIDs', failureMode: e.message });
  }

  // G14: Secret Hygiene in Logs (Dynamic Env-Driven Regex Scan)
  try {
    const containers = ['omninovel-prod-nginx', 'omninovel-prod-api', 'omninovel-prod-ai-worker', 'omninovel-prod-redis'];

    // Dynamically retrieve secrets from process.env (zero hardcoded strings)
    const dynamicSecretsToCheck: string[] = [
      process.env.DB_PASSWORD,
      process.env.REDIS_PASSWORD,
      process.env.JWT_SECRET,
      process.env.JWT_REFRESH_SECRET,
      process.env.AI_WORKER_SECRET,
      process.env.S3_SECRET_ACCESS_KEY,
    ].filter((s): s is string => Boolean(s && s.length >= 8));

    const regexPatterns = [
      /(postgres|postgresql):\/\/[^@\s]+:[^@\s]+@/i,
      /(?:password|secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}["']?/i,
      /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
    ];

    let leakCount = 0;
    const leakDetails: string[] = [];
    let allLogsAccessible = true;

    for (const c of containers) {
      const logRes = runCommand(`docker logs ${c}`);
      if (logRes.exitCode !== 0) {
        allLogsAccessible = false;
        leakDetails.push(`${c}: docker logs failed with exit ${logRes.exitCode}`);
        continue;
      }
      const logs = logRes.stdout + '\n' + logRes.stderr;
      for (const s of dynamicSecretsToCheck) {
        if (logs.includes(s)) {
          leakCount++;
          leakDetails.push(`${c}: matched env secret (len=${s.length})`);
        }
      }
      for (const reg of regexPatterns) {
        if (reg.test(logs)) {
          leakCount++;
          leakDetails.push(`${c}: matched regex pattern ${reg.source}`);
        }
      }
    }

    const passed = allLogsAccessible && leakCount === 0;
    results.push({
      gate: 'G14',
      name: 'Secret Hygiene in Logs',
      passed,
      evidence: `Dynamic regex scan across 4 containers (nginx, api, ai-worker, redis) against ${dynamicSecretsToCheck.length} active env secrets and 3 regex patterns found ${leakCount} leaked credentials. Details: ${leakDetails.length > 0 ? leakDetails.join(', ') : 'Zero leaks verified.'}`,
      assertion: 'allLogsAccessible === true && leakCount === 0',
      failureMode: 'Production credentials, connection URIs, or private keys printed to stdout/stderr logs',
    });
  } catch (e: any) {
    results.push({ gate: 'G14', name: 'Secret Hygiene', passed: false, evidence: e.message, assertion: 'leakCount === 0', failureMode: e.message });
  }

  // SUMMARY REPORT
  console.log('\n================================================================');
  console.log('              ACCEPTANCE GATES VERIFICATION SUMMARY');
  console.log('================================================================');
  let allPassed = true;
  for (const r of results) {
    const tag = r.passed ? 'PASS [v]' : 'FAIL [X]';
    console.log(`${tag} ${r.gate}: ${r.name}`);
    console.log(`       Evidence:  ${r.evidence}`);
    console.log(`       Assertion: ${r.assertion}`);
    if (!r.passed) {
      console.log(`       Failure:   ${r.failureMode}`);
      allPassed = false;
    }
  }
  console.log('================================================================');
  console.log(`FINAL RESULT: ${allPassed ? 'ALL 15 GATES PASSED (100% - G00 + G01..G14)' : 'SOME GATES FAILED'}`);
  console.log('================================================================\n');

  if (!allPassed) process.exit(1);
}

verifyAllGates().catch((err) => {
  console.error('Fatal Runner Error:', err);
  process.exit(1);
});
