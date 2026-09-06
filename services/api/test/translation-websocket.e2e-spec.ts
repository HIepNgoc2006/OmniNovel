import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TranslationJobStatus } from '@omninovel/shared';
import { TranslationGateway } from '../src/modules/translation/translation.gateway';

describe('Translation WebSocket Gateway (/ws/ai) Security & RBAC Suite', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let gateway: TranslationGateway;
  let port: number;

  let translatorAId: string;
  let translatorBId: string;
  let translatorAToken: string;
  let translatorBToken: string;

  let storyAId: string;
  let editionAId: string;
  let versionAId: string;
  let jobAId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer();
    port = server.address().port;

    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    gateway = app.get(TranslationGateway);

    // Chuẩn bị User & Story dữ liệu
    const userARes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('ws_trans_a_${Date.now()}', 'ws_trans_a_${Date.now()}@example.com', 'hash', 'TRANSLATOR', true)
       RETURNING id, email, role`,
    );
    translatorAId = userARes[0].id;
    const secret = process.env.JWT_SECRET || 'super_secret_jwt_key_omninovel_2026';
    translatorAToken = jwtService.sign(
      {
        sub: translatorAId,
        email: userARes[0].email,
        role: userARes[0].role,
      },
      { secret },
    );

    const userBRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('ws_trans_b_${Date.now()}', 'ws_trans_b_${Date.now()}@example.com', 'hash', 'TRANSLATOR', true)
       RETURNING id, email, role`,
    );
    translatorBId = userBRes[0].id;
    translatorBToken = jwtService.sign(
      {
        sub: translatorBId,
        email: userBRes[0].email,
        role: userBRes[0].role,
      },
      { secret },
    );

    // Story A của Translator A
    const storyRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('WS Story A', 'ws-story-a-${Date.now()}', 'https://example.com/c.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    storyAId = storyRes[0].id;

    await dataSource.query(
      `INSERT INTO story_members (story_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
      [storyAId, translatorAId],
    );

    const editionRes = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Bản gốc', 'ja', true)
       RETURNING id`,
      [storyAId],
    );
    editionAId = editionRes[0].id;

    const chapterRes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, 1, 'Chương 1')
       RETURNING id`,
      [editionAId],
    );

    const versionRes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'ja', true, $2)
       RETURNING id`,
      [chapterRes[0].id, translatorAId],
    );
    versionAId = versionRes[0].id;

    const projRes = await dataSource.query(
      `INSERT INTO translation_projects (story_edition_id, source_language, target_language, created_by)
       VALUES ($1, 'ja', 'vi', $2)
       RETURNING id`,
      [editionAId, translatorAId],
    );

    const jobRes = await dataSource.query(
      `INSERT INTO translation_jobs (project_id, source_version_id, status, created_by, provider, attempt_count, max_attempts, last_sequence, progress_percentage)
       VALUES ($1, $2, 'QUEUED', $3, 'OPENAI', 1, 3, 0, 0)
       RETURNING id`,
      [projRes[0].id, versionAId, translatorAId],
    );
    jobAId = jobRes[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  function createClient(token?: string): Socket {
    return io(`http://localhost:${port}/ws/ai`, {
      transports: ['websocket'],
      auth: token ? { token } : undefined,
      forceNew: true,
      autoConnect: true,
    });
  }

  it('Handshake without JWT should be rejected and disconnected with UNAUTHORIZED', (done) => {
    const socket = createClient();

    socket.on('connect_error', (err) => {
      expect(err.message).toContain('UNAUTHORIZED');
      socket.close();
      done();
    });

    socket.on('connect', () => {
      socket.close();
      done(new Error('Socket should not have connected without token'));
    });
  });

  it('Handshake with invalid JWT should be rejected and disconnected', (done) => {
    const socket = createClient('invalid_token_12345');

    socket.on('connect_error', (err) => {
      expect(err.message).toContain('UNAUTHORIZED');
      socket.close();
      done();
    });

    socket.on('connect', () => {
      socket.close();
      done(new Error('Socket should not have connected with invalid token'));
    });
  });

  it('Translator B (Unauthorized) attempting to subscribe Story A job should receive FORBIDDEN error', (done) => {
    const socket = createClient(translatorBToken);

    socket.on('connect', () => {
      socket.emit('subscribe_job', { jobId: jobAId });
    });

    socket.on('error', (err) => {
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toContain('không có quyền theo dõi');
      socket.close();
      done();
    });
  });

  const FORBIDDEN_KEYS = [
    'resultManifest',
    'storageKey',
    'previewKey',
    'htmlKey',
    'errorTrace',
  ];

  function assertNoForbiddenKeys(obj: any) {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        expect(FORBIDDEN_KEYS).not.toContain(key);
        assertNoForbiddenKeys(obj[key]);
      }
    }
  }

  it('Translator A (Story Owner) receives sanitized job_progress with exact allowlist and zero forbidden keys', (done) => {
    const socket = createClient(translatorAToken);

    socket.on('connect', () => {
      socket.emit('subscribe_job', { jobId: jobAId });
    });

    socket.on('subscribed', (data) => {
      expect(data.status).toBe('OK');
      expect(data.jobId).toBe(jobAId);

      setTimeout(() => {
        gateway.broadcastJobProgress(
          jobAId,
          TranslationJobStatus.OCR,
          35,
          new Date('2026-09-06T12:30:00.000Z'),
        );
      }, 50);
    });

    socket.on('job_progress', (msg) => {
      expect(msg.jobId).toBe(jobAId);
      expect(msg.status).toBe(TranslationJobStatus.OCR);
      expect(msg.progress).toBe(35);
      expect(msg.heartbeatAt).toBe('2026-09-06T12:30:00.000Z');
      expect(typeof msg.timestamp).toBe('string');

      const expectedKeys = ['heartbeatAt', 'jobId', 'progress', 'status', 'timestamp'].sort();
      expect(Object.keys(msg).sort()).toEqual(expectedKeys);
      assertNoForbiddenKeys(msg);

      socket.close();
      done();
    });
  });

  it('Translator A receives sanitized job_ready_for_review without resultManifest or internal storage keys', (done) => {
    const socket = createClient(translatorAToken);

    socket.on('connect', () => {
      socket.emit('subscribe_job', { jobId: jobAId });
    });

    socket.on('subscribed', () => {
      setTimeout(() => {
        gateway.broadcastJobReady(jobAId);
      }, 50);
    });

    socket.on('job_ready_for_review', (msg) => {
      expect(msg.jobId).toBe(jobAId);
      expect(msg.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);
      expect(typeof msg.timestamp).toBe('string');

      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(msg).sort()).toEqual(expectedKeys);
      assertNoForbiddenKeys(msg);

      const serialized = JSON.stringify(msg);
      expect(serialized).not.toContain('resultManifest');
      expect(serialized).not.toContain('storageKey');
      expect(serialized).not.toContain('previewKey');

      socket.close();
      done();
    });
  });

  it('Translator A receives sanitized job_failed without errorTrace or provider diagnostics', (done) => {
    const socket = createClient(translatorAToken);

    socket.on('connect', () => {
      socket.emit('subscribe_job', { jobId: jobAId });
    });

    socket.on('subscribed', () => {
      setTimeout(() => {
        gateway.broadcastJobFailed(jobAId);
      }, 50);
    });

    socket.on('job_failed', (msg) => {
      expect(msg.jobId).toBe(jobAId);
      expect(msg.status).toBe(TranslationJobStatus.FAILED);
      expect(typeof msg.timestamp).toBe('string');

      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(msg).sort()).toEqual(expectedKeys);
      assertNoForbiddenKeys(msg);

      const serialized = JSON.stringify(msg);
      expect(serialized).not.toContain('errorTrace');

      socket.close();
      done();
    });
  });

  it('Translator A receives sanitized job_canceled with exact allowlist', (done) => {
    const socket = createClient(translatorAToken);

    socket.on('connect', () => {
      socket.emit('subscribe_job', { jobId: jobAId });
    });

    socket.on('subscribed', () => {
      setTimeout(() => {
        gateway.broadcastJobCanceled(jobAId);
      }, 50);
    });

    socket.on('job_canceled', (msg) => {
      expect(msg.jobId).toBe(jobAId);
      expect(msg.status).toBe(TranslationJobStatus.CANCELED);
      expect(typeof msg.timestamp).toBe('string');

      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(msg).sort()).toEqual(expectedKeys);
      assertNoForbiddenKeys(msg);

      socket.close();
      done();
    });
  });

  it('CANARY: wire payload ignores arbitrary caller arguments and never leaks CANARY data', (done) => {
    const socket = createClient(translatorAToken);
    const wireCanary = 'SUPER_SECRET_AWS_S3_BUCKET_KEY_CANARY_12345';

    socket.on('connect', () => {
      socket.emit('subscribe_job', { jobId: jobAId });
    });

    socket.on('subscribed', () => {
      setTimeout(() => {
        // Cố tình truyền payload cũ chứa resultManifest & storageKey
        (gateway as any).broadcastJobReady(jobAId, {
          resultManifest: {
            storageKey: wireCanary,
            previewKey: 'ANOTHER_CANARY_KEY',
          },
        });
      }, 50);
    });

    socket.on('job_ready_for_review', (msg) => {
      const serialized = JSON.stringify(msg);
      expect(serialized).not.toContain(wireCanary);
      expect(serialized).not.toContain('ANOTHER_CANARY_KEY');
      expect(serialized).not.toContain('resultManifest');

      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(msg).sort()).toEqual(expectedKeys);
      assertNoForbiddenKeys(msg);

      socket.close();
      done();
    });
  });
});
