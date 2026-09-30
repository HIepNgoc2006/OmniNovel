import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { TranslationService } from '../src/modules/translation/translation.service';
import {
  ApplyTranslationMode,
  GlobalRole,
  MediaFormat,
  PublicationFormat,
  StoryMemberRole,
  StoryStatus,
  StoryVisibility,
} from '@omninovel/shared';

describe('Apply job idempotency & permission projection E2E (#152)', () => {
  jest.setTimeout(30000);

  let app: INestApplication;
  let dataSource: DataSource;
  let service: TranslationService;

  let storyId: string;
  let chapterId: string;
  let sourceVersionId: string;
  let targetVersionId: string;
  let projectId: string;
  let appliedJobId: string;
  let legacyJobId: string;

  const sameKey = '11111111-1111-4111-8111-111111111111';
  const legacyKey = '22222222-2222-4222-8222-222222222222';

  let adminUser: any;
  let ownerUser: any;
  let editorUser: any;
  let translatorUser: any;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = app.get(DataSource);
    service = app.get(TranslationService);

    const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const insertUser = async (name: string, role: GlobalRole) => {
      const rows = await dataSource.query(
        `INSERT INTO users (email, password_hash, username, role, is_active)
         VALUES ($1, 'hash', $2, $3, true)
         RETURNING id, role`,
        [`${name}_${runId}@omninovel.test`, `${name}_${runId}`, role],
      );
      return rows[0];
    };

    adminUser = await insertUser('apply_admin', GlobalRole.ADMIN);
    ownerUser = await insertUser('apply_owner', GlobalRole.READER);
    editorUser = await insertUser('apply_editor', GlobalRole.READER);
    translatorUser = await insertUser('apply_translator', GlobalRole.READER);

    const storyRows = await dataSource.query(
      `INSERT INTO stories
       (title, slug, cover_url, original_language, media_format, publication_format, status, visibility, created_by)
       VALUES ($1, $2, 'https://example.com/cover.webp', 'ja', $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        'Apply Job E2E',
        `apply-job-e2e-${runId}`,
        MediaFormat.COMIC,
        PublicationFormat.MANGA,
        StoryStatus.ONGOING,
        StoryVisibility.PUBLIC,
        ownerUser.id,
      ],
    );
    storyId = storyRows[0].id;

    await dataSource.query(
      `INSERT INTO story_members (story_id, user_id, role)
       VALUES ($1, $2, $3), ($1, $4, $5), ($1, $6, $7)`,
      [
        storyId,
        ownerUser.id,
        StoryMemberRole.OWNER,
        editorUser.id,
        StoryMemberRole.EDITOR,
        translatorUser.id,
        StoryMemberRole.TRANSLATOR,
      ],
    );

    const editionRows = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Raw', 'ja', true)
       RETURNING id`,
      [storyId],
    );
    const editionId = editionRows[0].id;

    const chapterRows = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, 1, 'Chapter 1')
       RETURNING id`,
      [editionId],
    );
    chapterId = chapterRows[0].id;

    const sourceRows = await dataSource.query(
      `INSERT INTO chapter_versions
       (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'ja', true, $2)
       RETURNING id`,
      [chapterId, ownerUser.id],
    );
    sourceVersionId = sourceRows[0].id;

    const targetRows = await dataSource.query(
      `INSERT INTO chapter_versions
       (chapter_id, version_number, version_type, language, source_version_id, is_published, created_by)
       VALUES ($1, 2, 'AI_TRANSLATED', 'vi', $2, true, $3)
       RETURNING id`,
      [chapterId, sourceVersionId, ownerUser.id],
    );
    targetVersionId = targetRows[0].id;

    await dataSource.query(
      `UPDATE chapters SET active_version_id = $1 WHERE id = $2`,
      [targetVersionId, chapterId],
    );

    const projectRows = await dataSource.query(
      `INSERT INTO translation_projects
       (story_edition_id, source_language, target_language, created_by)
       VALUES ($1, 'ja', 'vi', $2)
       RETURNING id`,
      [editionId, ownerUser.id],
    );
    projectId = projectRows[0].id;

    const artRows = await dataSource.query(
      `INSERT INTO chapter_artifacts (chapter_version_id, artifact_type, status)
       VALUES ($1, 'TRANSLATION_SOURCE', 'READY')
       RETURNING id`,
      [sourceVersionId],
    );
    const sourceArtifactId = artRows[0].id;

    const appliedRows = await dataSource.query(
      `INSERT INTO translation_jobs
       (project_id, source_version_id, source_artifact_id, target_version_id, created_by, status,
        apply_idempotency_key, apply_mode, review_revision, materialized_revision)
       VALUES ($1, $2, $3, $4, $5, 'APPLIED', $6, $7, 1, 1)
       RETURNING id`,
      [
        projectId,
        sourceVersionId,
        sourceArtifactId,
        targetVersionId,
        ownerUser.id,
        sameKey,
        ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION,
      ],
    );
    appliedJobId = appliedRows[0].id;

    const legacyRows = await dataSource.query(
      `INSERT INTO translation_jobs
       (project_id, source_version_id, source_artifact_id, target_version_id, created_by, status,
        apply_idempotency_key, apply_mode, review_revision, materialized_revision)
       VALUES ($1, $2, $3, $4, $5, 'APPLIED', $6, NULL, 1, 1)
       RETURNING id`,
      [projectId, sourceVersionId, sourceArtifactId, targetVersionId, ownerUser.id, legacyKey],
    );
    legacyJobId = legacyRows[0].id;
  });

  afterAll(async () => {
    if (storyId) {
      await dataSource.query('DELETE FROM stories WHERE id = $1', [storyId]);
    }
    const ids = [adminUser?.id, ownerUser?.id, editorUser?.id, translatorUser?.id].filter(Boolean);
    if (ids.length > 0) {
      await dataSource.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
    }
    await app.close();
  });

  it('replays same key + same mode with a complete non-null response', async () => {
    const response = await service.applyJob(
      appliedJobId,
      { mode: ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION },
      ownerUser,
      sameKey,
    );

    expect(response).toMatchObject({
      chapterId,
      activeVersionId: targetVersionId,
      targetVersionId,
      versionNumber: 2,
      isAlreadyApplied: true,
    });
    expect(response.targetVersionId).toBeTruthy();
  });

  it('rejects same key + different mode with IDEMPOTENCY_CONFLICT', async () => {
    await expect(
      service.applyJob(
        appliedJobId,
        { mode: ApplyTranslationMode.CREATE_ALTERNATE_VERSION },
        ownerUser,
        sameKey,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
      status: 409,
    });
  });

  it('replays legacy apply rows where apply_mode is NULL', async () => {
    const response = await service.applyJob(
      legacyJobId,
      { mode: ApplyTranslationMode.CREATE_ALTERNATE_VERSION },
      ownerUser,
      legacyKey,
    );

    expect(response.isAlreadyApplied).toBe(true);
    expect(response.targetVersionId).toBe(targetVersionId);
  });

  it.each([
    ['ADMIN', () => adminUser, true],
    ['OWNER', () => ownerUser, true],
    ['EDITOR', () => editorUser, true],
    ['TRANSLATOR', () => translatorUser, false],
  ])('projects canApply for %s', async (_label, getUser, canApply) => {
    const detail = await service.getJob(appliedJobId, getUser());
    expect(detail.permissions.canApply).toBe(canApply);
    if (canApply) {
      expect(detail.permissions.applyBlockReason).toBeUndefined();
    } else {
      expect(detail.permissions.applyBlockReason).toBe('INSUFFICIENT_ROLE');
    }
  });

  it('forbids TRANSLATOR from applyJob()', async () => {
    await expect(
      service.applyJob(
        appliedJobId,
        { mode: ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION },
        translatorUser,
        sameKey,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FORBIDDEN' }),
      status: 403,
    });
  });
});
