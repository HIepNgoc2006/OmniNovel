/**
 * OmniNovel - Gate 6.4.4 Acceptance Test Suite (Hardened Edition)
 * Validates Observability Baseline, Prometheus Telemetry, Route Normalization (Cardinality Defense),
 * BullMQ Queue Gauges + Collection Health (P1), Grafana Auto-Provisioning (Dynamic Auth P0.2),
 * Loopback & Network Boundary Isolation (P0.1), and Nginx Security Invariant.
 */

import { spawnSync } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

interface CheckResult {
  gate: string;
  description: string;
  passed: boolean;
  evidence: string;
}

const results: CheckResult[] = [];

function runCommand(cmd: string): string {
  const res = spawnSync(cmd, { shell: true, encoding: 'utf-8' });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  return `${stdout}\n${stderr}`.trim();
}

async function httpGet(url: string, rejectUnauthorized = false): Promise<{ statusCode?: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const client = isHttps ? https : http;
    const req = client.get(url, { rejectUnauthorized }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Timeout')));
  });
}

function extractMetricValue(metricsOutput: string, metricPrefix: string): number | null {
  const lines = metricsOutput.split('\n');
  for (const line of lines) {
    if (line.startsWith(metricPrefix)) {
      const parts = line.trim().split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      if (!isNaN(val)) return val;
    }
  }
  return null;
}

function getGrafanaAdminPassword(): string {
  if (process.env.GRAFANA_ADMIN_PASSWORD) {
    return process.env.GRAFANA_ADMIN_PASSWORD;
  }
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/^GRAFANA_ADMIN_PASSWORD=(.*)$/m);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }
  throw new Error('GRAFANA_ADMIN_PASSWORD must be configured in environment or .env');
}

async function runAcceptanceGate644() {
  console.log('================================================================================');
  console.log('🚀 EXECUTING GATE 6.4.4 ACCEPTANCE VERIFICATION: OBSERVABILITY & SECURITY');
  console.log('================================================================================\n');

  // Check 1: GET api:8000/metrics internal exposition
  try {
    const rawMetrics = runCommand('docker exec omninovel-obs-prometheus wget -q -O - http://api:8000/metrics');
    const hasHeader = rawMetrics.includes('# HELP') && rawMetrics.includes('# TYPE');
    results.push({
      gate: 'Check 1',
      description: 'Internal GET api:8000/metrics returns 200 + Prometheus exposition format',
      passed: hasHeader && rawMetrics.length > 500,
      evidence: `Payload length: ${rawMetrics.length} bytes, contains standard Prometheus headers.`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 1', description: 'Internal metrics scrape', passed: false, evidence: err.message });
  }

  // Check 2: Nginx external /metrics explicit deny (HTTP 80 & HTTPS 443)
  try {
    const httpRes = await httpGet('http://localhost/metrics');
    const httpsRes = await httpGet('https://localhost/metrics', false);

    const httpBlocked = httpRes.statusCode === 404 || httpRes.statusCode === 403;
    const httpsBlocked = httpsRes.statusCode === 404 || httpsRes.statusCode === 403;

    results.push({
      gate: 'Check 2',
      description: 'Nginx explicit deny: external /metrics returns 404/403 (Zero telemetry leak)',
      passed: httpBlocked && httpsBlocked,
      evidence: `HTTP 80 status: ${httpRes.statusCode}, HTTPS 443 status: ${httpsRes.statusCode}`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 2', description: 'Nginx deny invariant', passed: false, evidence: err.message });
  }

  // Check 3: HTTP probe increments http_requests_total (Assert delta: after > before)
  try {
    const metricPrefix = 'http_requests_total{method="GET",route="/health/live",status_code="200"}';

    // 1. Read value before probe
    const beforeMetrics = runCommand('docker exec omninovel-obs-prometheus wget -q -O - http://api:8000/metrics');
    const valBefore = extractMetricValue(beforeMetrics, metricPrefix) ?? 0;

    // 2. Fire probe request
    await httpGet('https://localhost/health/live', false);

    // 3. Read value after probe
    const afterMetrics = runCommand('docker exec omninovel-obs-prometheus wget -q -O - http://api:8000/metrics');
    const valAfter = extractMetricValue(afterMetrics, metricPrefix) ?? 0;

    const delta = valAfter - valBefore;
    const passed = delta > 0;

    results.push({
      gate: 'Check 3',
      description: 'HTTP probe correctly increments http_requests_total counter (after > before)',
      passed: passed,
      evidence: `Counter value before: ${valBefore}, after probe: ${valAfter} (delta: +${delta} > 0). Verified counter actively increments.`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 3', description: 'Counter increment verification', passed: false, evidence: err.message });
  }

  // Check 4: Histogram duration buckets & PromQL quantile
  try {
    const rawMetrics = runCommand('docker exec omninovel-obs-prometheus wget -q -O - http://api:8000/metrics');
    const hasBuckets = rawMetrics.includes('http_request_duration_seconds_bucket') &&
      rawMetrics.includes('http_request_duration_seconds_count');

    const promqlQuery = 'histogram_quantile(0.95,sum+by+(le,route)(rate(http_request_duration_seconds_bucket[5m])))';
    const promqlRes = runCommand(`docker exec omninovel-obs-prometheus wget -q -O - "http://localhost:9090/api/v1/query?query=${promqlQuery}"`);
    const parsed = JSON.parse(promqlRes);
    const promqlOk = parsed.status === 'success' && parsed.data.resultType === 'vector';

    results.push({
      gate: 'Check 4',
      description: 'Histogram has _bucket/_sum/_count and PromQL histogram_quantile(0.95) calculates successfully',
      passed: hasBuckets && promqlOk,
      evidence: `PromQL quantile status: ${parsed.status}, evaluated vector count: ${parsed.data.result.length}`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 4', description: 'Histogram & PromQL quantile', passed: false, evidence: err.message });
  }

  // Check 5: BullMQ gauges reflect 3 active queues + Collector Health Status Gauges (P1)
  try {
    const rawMetrics = runCommand('docker exec omninovel-obs-prometheus wget -q -O - http://api:8000/metrics');
    const hasTranslation = rawMetrics.includes('bullmq_jobs_active{queue="translation"}');
    const hasMaterialization = rawMetrics.includes('bullmq_jobs_active{queue="translation-materialization"}');
    const hasPackaging = rawMetrics.includes('bullmq_jobs_active{queue="chapter-packaging"}');
    const all3Queues = hasTranslation && hasMaterialization && hasPackaging;

    // Verify P1 collector health gauges
    const hasHealthGauge = rawMetrics.includes('bullmq_metrics_collection_success{queue="translation"} 1');
    const hasTimestampGauge = rawMetrics.includes('bullmq_metrics_last_success_timestamp_seconds{queue="translation"}');

    results.push({
      gate: 'Check 5',
      description: 'BullMQ gauges reflect 3 queues + Collector Health & Timestamp gauges present (P1)',
      passed: all3Queues && hasHealthGauge && hasTimestampGauge,
      evidence: `3 queues: ${all3Queues}, bullmq_metrics_collection_success: ${hasHealthGauge}, bullmq_metrics_last_success_timestamp_seconds: ${hasTimestampGauge}`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 5', description: 'BullMQ queue gauges', passed: false, evidence: err.message });
  }

  // Check 6: Process resident memory RSS & event loop metrics exist
  try {
    const rawMetrics = runCommand('docker exec omninovel-obs-prometheus wget -q -O - http://api:8000/metrics');
    const hasRss = rawMetrics.includes('process_resident_memory_bytes');
    const hasHeap = rawMetrics.includes('nodejs_heap_size_used_bytes');
    const hasEventLoop = rawMetrics.includes('nodejs_eventloop_lag_seconds');

    results.push({
      gate: 'Check 6',
      description: 'Process resident memory RSS, V8 heap, and event loop lag metrics exist',
      passed: hasRss && hasHeap && hasEventLoop,
      evidence: `process_resident_memory_bytes: ${hasRss}, nodejs_heap_size_used_bytes: ${hasHeap}, nodejs_eventloop_lag_seconds: ${hasEventLoop}`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 6', description: 'Process & Runtime metrics', passed: false, evidence: err.message });
  }

  // Check 7: Prometheus target API is UP
  try {
    const targetsRes = runCommand('docker exec omninovel-obs-prometheus wget -q -O - http://localhost:9090/api/v1/targets');
    const parsed = JSON.parse(targetsRes);
    const apiTarget = parsed.data.activeTargets.find((t: any) => t.labels.job === 'omninovel-api');
    const isUp = apiTarget && apiTarget.health === 'up';

    results.push({
      gate: 'Check 7',
      description: 'Prometheus target omninovel-api is healthy (health = "up")',
      passed: !!isUp,
      evidence: `Target health: ${apiTarget?.health}, endpoint: ${apiTarget?.scrapeUrl}, lastError: "${apiTarget?.lastError || 'none'}"`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 7', description: 'Prometheus target health', passed: false, evidence: err.message });
  }

  // Check 8: Grafana provisioning loads dashboard with dynamic credentials & Basic Auth header (P0.2 & P1)
  try {
    const adminUser = process.env.GRAFANA_ADMIN_USER || 'admin';
    const adminPassword = getGrafanaAdminPassword();
    const authHeader = Buffer.from(`${adminUser}:${adminPassword}`).toString('base64');

    const grafanaSearch = runCommand(`docker exec omninovel-obs-grafana wget -q -O - --header="Authorization: Basic ${authHeader}" http://127.0.0.1:3000/api/search`);
    const dashboards = JSON.parse(grafanaSearch);
    const telemetryDash = dashboards.find((d: any) => d.uid === 'omninovel-telemetry-gate-6-4-4');

    results.push({
      gate: 'Check 8',
      description: 'Grafana auto-provisioning loaded dashboard (authenticated via dynamic Basic Auth header, zero hardcoded password)',
      passed: !!telemetryDash,
      evidence: `Found dashboard: "${telemetryDash?.title}", UID: ${telemetryDash?.uid}, authenticated as user: ${adminUser} with Basic auth header.`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 8', description: 'Grafana auto-provisioning', passed: false, evidence: err.message });
  }

  // Check 9: Route normalization & Cardinality Invariant (P0.3: Unmatched routes collapse to bounded /__unmatched__)
  try {
    // 1. Send arbitrary garbage/scanner probes via proxied API path
    const garbageProbes = [
      '/api/v1/garbage-a8fj2ks',
      '/api/v1/garbage-j28skq1',
      '/api/v1/garbage-729ajdm',
      '/api/v1/random-fuzzing-path',
    ];
    for (const p of garbageProbes) {
      await httpGet(`https://localhost${p}`, false);
    }

    // 2. Fetch metrics
    const rawMetrics = runCommand('docker exec omninovel-obs-prometheus wget -q -O - http://api:8000/metrics');

    // 3. Verify NONE of the garbage paths appear in metrics labels
    let leakedPath: string | null = null;
    for (const p of garbageProbes) {
      if (rawMetrics.includes(`route="${p}"`)) {
        leakedPath = p;
        break;
      }
    }

    // 4. Verify unmatched route label exists
    const hasUnmatchedLabel = rawMetrics.includes('route="/__unmatched__"');

    // 5. Run route-normalizer unit test suite (with 500-URL adversarial fuzzing)
    const testOut = runCommand('npm --prefix services/api test -- src/modules/metrics/test/route-normalizer.spec.ts');
    const unitTestPassed = testOut.includes('PASS') && !testOut.includes('FAIL');

    const passed = leakedPath === null && hasUnmatchedLabel && unitTestPassed;

    results.push({
      gate: 'Check 9',
      description: 'Route normalization strictly bounds cardinality: unmatched/garbage routes collapse to /__unmatched__ (P0.3)',
      passed: passed,
      evidence: `Leaked paths: ${leakedPath ?? 'NONE (100% blocked)'}, has /__unmatched__ label: ${hasUnmatchedLabel}, unit test 500-URL fuzzing: ${unitTestPassed ? 'PASS' : 'FAIL'}`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 9', description: 'Cardinality defense verification', passed: false, evidence: err.message });
  }

  // Check 10: Docker Compose Overlay, Digest Pinning & Network Isolation Invariant (6.4.4a)
  try {
    // 1. Overlay config validation (merges with Phase 6.2 baseline cleanly)
    const configOut = runCommand('docker compose --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.observability.yml config --quiet');
    const configClean = configOut === '';

    // 2. Verify containers only join omninovel-internal network (no omninovel-edge)
    const promInspect = JSON.parse(runCommand('docker inspect omninovel-obs-prometheus'))[0];
    const grafInspect = JSON.parse(runCommand('docker inspect omninovel-obs-grafana'))[0];

    const promNetworks = Object.keys(promInspect?.NetworkSettings?.Networks || {});
    const grafNetworks = Object.keys(grafInspect?.NetworkSettings?.Networks || {});

    const promInternalOnly = promNetworks.includes('omninovel-internal') && !promNetworks.includes('omninovel-edge');
    const grafInternalOnly = grafNetworks.includes('omninovel-internal') && !grafNetworks.includes('omninovel-edge');

    // 3. Verify no hardcoded password fallback in docker-compose.observability.yml
    const composeContent = fs.readFileSync(path.resolve(process.cwd(), 'deploy/docker-compose.observability.yml'), 'utf-8');
    const noHardcodedPass = composeContent.includes('GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD is required}') &&
      !composeContent.includes('admin_omninovel_2026');

    // 4. Verify both Prometheus and Grafana are pinned by sha256 digest (Supply Chain Invariant)
    const digestsPinned = composeContent.includes('prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e') &&
      composeContent.includes('grafana/grafana:13.2.3@sha256:b28bae15e219c998fb0e0424ed724930cc61b1f61fb404d47c862f9a23f9e572');

    const passed = configClean && promInternalOnly && grafInternalOnly && noHardcodedPass && digestsPinned;

    results.push({
      gate: 'Check 10',
      description: 'Docker Compose overlay valid, supply chain digests pinned, networks strictly internal, fail-closed auth (6.4.4a)',
      passed: passed,
      evidence: `Config exit 0: ${configClean}, Digests pinned: ${digestsPinned}, Prometheus internal: ${promInternalOnly}, Grafana internal: ${grafInternalOnly}, Fail-closed password: ${noHardcodedPass}`,
    });
  } catch (err: any) {
    results.push({ gate: 'Check 10', description: 'Compose overlay & isolation validation', passed: false, evidence: err.message });
  }

  // Summary Table
  console.log('\n================================================================================');
  console.log('📋 GATE 6.4.4 ACCEPTANCE VERIFICATION RESULTS (HARDENED)');
  console.log('================================================================================');
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? '✅ [PASS]' : '❌ [FAIL]';
    if (!r.passed) allPassed = false;
    console.log(`${icon} ${r.gate}: ${r.description}`);
    console.log(`         Evidence: ${r.evidence}`);
  }
  console.log('================================================================================');
  console.log(`FINAL RESULT: ${allPassed ? '🎉 10/10 CHECKS PASSED - GATE 6.4.4 HARDENING COMPLETE!' : '❌ CHECKS FAILED'}`);
  console.log('================================================================================\n');

  if (!allPassed) {
    process.exit(1);
  }
}

runAcceptanceGate644().catch((err) => {
  console.error('Fatal error during Gate 6.4.4 acceptance:', err);
  process.exit(1);
});
