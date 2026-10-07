import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as crypto from 'crypto';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { AccountPurgeService } from '../src/modules/account/account-purge.service';

describe('Account Lifecycle & Security Management (PostgreSQL/Redis Integration - Task 7B.2)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let purgeService: AccountPurgeService;

  const testUserEmail = `lifecycle_${Date.now()}@test.com`;
  const testUsername = `lifecycle_${Date.now()}`;
  const initialPassword = 'InitialPassword123!';
  const updatedPassword = 'UpdatedPassword456!';

  let accessToken: string;
  let refreshToken: string;
  let userId: string;
  let sessionId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'internal/v1/(.*)'],
    });
    await app.init();

    dataSource = app.get(DataSource);
    purgeService = app.get(AccountPurgeService);
  });

  afterAll(async () => {
    if (userId) {
      try {
        await dataSource.query('DELETE FROM users WHERE id = $1', [userId]);
      } catch {}
    }
    if (app) {
      await app.close();
    }
  });

  it('1. Register Auto-Login (Option A): should return tokens, set cookie, and include sid claim', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        username: testUsername,
        email: testUserEmail,
        password: initialPassword,
      })
      .expect(201);

    expect(res.body.user).toBeDefined();
    expect(res.body.user.username).toBe(testUsername);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();

    userId = res.body.user.id;
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;

    // Verify cookie set
    const cookieHeader = res.headers['set-cookie'];
    const cookies: string[] = Array.isArray(cookieHeader)
      ? cookieHeader
      : typeof cookieHeader === 'string'
        ? [cookieHeader]
        : [];
    const hasRefreshCookie = cookies.some((c: string) => c.includes('refreshToken='));
    expect(hasRefreshCookie).toBe(true);

    // Verify JWT sid claim
    const parts = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    expect(payload.sid).toBeDefined();
    sessionId = payload.sid;
  });

  it('2. GET /api/v1/auth/me should succeed with access token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.user.id).toBe(userId);
    expect(res.body.user.username).toBe(testUsername);
  });

  it('3. GET /api/v1/account/sessions should return sessions with isCurrentSession flag', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/account/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);

    const current = res.body.find((s: any) => s.sessionId === sessionId);
    expect(current).toBeDefined();
    expect(current.isCurrentSession).toBe(true);
  });

  it('3b. Immediate Access Token Revocation: revoking session B should immediately reject token B with 401', async () => {
    // Login second device (Session B)
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: testUsername,
        password: initialPassword,
      })
      .expect(200);

    const tokenB = loginRes.body.accessToken;
    expect(tokenB).toBeDefined();

    // Extract sessionBId from JWT sid claim
    const partsB = tokenB.split('.');
    const payloadB = JSON.parse(Buffer.from(partsB[1], 'base64').toString('utf8'));
    const sessionBId = payloadB.sid;
    expect(sessionBId).toBeDefined();

    // Verify token B works before revocation
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);

    // Revoke Session B from Session A
    await request(app.getHttpServer())
      .delete(`/api/v1/account/sessions/${sessionBId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Token B must immediately fail with 401 Unauthorized even though 15m TTL is not expired
    const rejectedRes = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(401);

    expect(rejectedRes.body.message).toContain('thu hồi');

    // Token A must still work
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('3c. Reject reactivate-account on already active account (Branch 4 strict contract)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/reactivate-account')
      .send({
        identifier: testUsername,
        password: initialPassword,
      })
      .expect(400);

    expect(res.body.error).toBe('ACCOUNT_ALREADY_ACTIVE');
    expect(res.body.accessToken).toBeUndefined();
  });

  it('3d. GET /api/v1/account/export-data should return complete GDPR dataset including translations', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/account/export-data')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.exportDate).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.id).toBe(userId);
    expect(res.body.translations).toBeDefined();
    expect(Array.isArray(res.body.translations.projects)).toBe(true);
    expect(Array.isArray(res.body.translations.jobs)).toBe(true);
    expect(Array.isArray(res.body.translations.versions)).toBe(true);
    expect(Array.isArray(res.body.translations.memberships)).toBe(true);
  });

  it('4. POST /api/v1/auth/forgot-password should enforce Anti-Enumeration', async () => {
    // Registered user
    const res1 = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: testUserEmail })
      .expect(200);
    expect(res1.body.success).toBe(true);

    // Non-existent user
    const res2 = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody_exists@unknown.com' })
      .expect(200);
    expect(res2.body.success).toBe(true);
    expect(res2.body.message).toBe(res1.body.message);
  });

  it('5. POST /api/v1/auth/change-password should update password and keep current session', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        currentPassword: initialPassword,
        newPassword: updatedPassword,
      })
      .expect(200);

    expect(res.body.success).toBe(true);

    // Old password should fail login
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: testUsername,
        password: initialPassword,
      })
      .expect(401);

    // New password should succeed
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: testUsername,
        password: updatedPassword,
      })
      .expect(200);

    expect(loginRes.body.accessToken).toBeDefined();
    accessToken = loginRes.body.accessToken;
    sessionId = loginRes.body.familyId;
  });

  it('6. DELETE /api/v1/account (Day 0 Soft Delete) should mark is_deleted = true and revoke sessions', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/v1/account')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: updatedPassword })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.scheduledPurgeAt).toBeDefined();

    // Verify database state: is_deleted = true, is_active = false
    const users = await dataSource.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(users[0].is_deleted).toBe(true);
    expect(users[0].is_active).toBe(false);
    expect(users[0].scheduled_purge_at).not.toBeNull();

    // Access token should now be rejected by JwtStrategy (account disabled)
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });

  it('7. POST /api/v1/auth/reactivate-account should restore account within grace period', async () => {
    // Wrong password -> 401
    await request(app.getHttpServer())
      .post('/api/v1/auth/reactivate-account')
      .send({
        identifier: testUsername,
        password: 'WrongPassword!',
      })
      .expect(401);

    // Correct password -> 200 OK & restored
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/reactivate-account')
      .send({
        identifier: testUsername,
        password: updatedPassword,
      })
      .expect(200);

    expect(res.body.message).toBe('Khôi phục tài khoản thành công.');
    expect(res.body.accessToken).toBeDefined();

    accessToken = res.body.accessToken;

    // Verify database state restored
    const users = await dataSource.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(users[0].is_deleted).toBe(false);
    expect(users[0].is_active).toBe(true);
    expect(users[0].scheduled_purge_at).toBeNull();
  });

  it('8. Day 30 Final Purge: should hard-delete users row and anonymize durable ledgers', async () => {
    // Soft-delete user again
    await request(app.getHttpServer())
      .delete('/api/v1/account')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: updatedPassword })
      .expect(200);

    // Insert durable records for this user into guest_claims and reward_transactions
    const claimId = crypto.randomUUID();
    await dataSource.query(
      `INSERT INTO guest_claims (
        claim_id, user_id, guest_profile_id, payload_hash, state_fingerprint,
        status, preview_data, expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'COMMITTED', '{}', NOW() + INTERVAL '1 hour')`,
      [claimId, userId, crypto.randomUUID(), 'dummy_hash', 'dummy_fp'],
    );

    const txId = crypto.randomUUID();
    await dataSource.query(
      `INSERT INTO reward_transactions (
        id, user_id, reward_type, amount, balance_after, source_type, idempotency_key
      ) VALUES ($1, $2, 'EXP', 100, 100, 'CHECKIN', $3)`,
      [txId, userId, `purge_test_tx_${Date.now()}`],
    );

    // Force scheduled_purge_at into the past (due for purge)
    await dataSource.query(
      `UPDATE users SET scheduled_purge_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [userId],
    );

    // Run purge service
    const purgeResult = await purgeService.purgeDueAccounts();
    expect(purgeResult.purgedCount).toBeGreaterThanOrEqual(1);
    expect(purgeResult.purgedUserIds).toContain(userId);

    // Verify users row is HARD DELETED
    const users = await dataSource.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(users.length).toBe(0);

    // Verify guest_claims is ANONYMIZED
    const expectedHash = crypto.createHash('sha256').update(userId).digest('hex');
    const claims = await dataSource.query('SELECT * FROM guest_claims WHERE claim_id = $1', [claimId]);
    expect(claims[0].user_id).toBeNull();
    expect(claims[0].anonymized_subject_hash.trim()).toBe(expectedHash);

    // Verify reward_transactions is ANONYMIZED
    const txs = await dataSource.query('SELECT * FROM reward_transactions WHERE id = $1', [txId]);
    expect(txs[0].user_id).toBeNull();
    expect(txs[0].anonymized_subject_hash.trim()).toBe(expectedHash);

    // Cleanup ledger test rows
    await dataSource.query('DELETE FROM guest_claims WHERE claim_id = $1', [claimId]);
    await dataSource.query('DELETE FROM reward_transactions WHERE id = $1', [txId]);
  });
});
