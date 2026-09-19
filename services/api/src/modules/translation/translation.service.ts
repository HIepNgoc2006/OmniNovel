import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between, EntityManager } from 'typeorm';
import * as crypto from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TranslationJobStatus,
  ChapterVersionType,
  MediaAssetType,
  MediaFormat,
  GlobalRole,
  StoryMemberRole,
  TranslationProjectSummaryDto,
  TranslationJobSummaryDto,
  TranslationJobReviewDetailResponse,
  TranslationJobSegmentsResponse,
  TranslationSegmentDto,
  PaginatedResponse,
  validateProtectedAnchorTopology,
  NovelBlockType,
  validateTranslationResultManifest,
  validateTranslationInputManifestV1,
  TranslationResultManifestV1,
  MangaResultManifestV1,
  NovelResultManifestV1,
  MaterializationSnapshotV1,
  TranslationSegmentSnapshotV1,
  MaterializationJobData,
  ComicMaterializationResultV1,
  NovelMaterializationResultV1,
  validateMaterializationSnapshotV1,
  validateComicMaterializationResultV1,
  validateNovelMaterializationResultV1,
  isMaterializationResultEqual,
  ReviewAssetDto,
  ReviewSummaryDto,
  TranslationJobPreviewsResponse,
  MaterializationRequestResponse,
  ApplyTranslationMode,
} from '@omninovel/shared';
import { TranslationJob } from './entities/translation-job.entity';
import { TranslationProject } from './entities/translation-project.entity';
import { TranslationGlossary } from './entities/translation-glossary.entity';
import { TranslationSegment } from './entities/translation-segment.entity';
import { ChapterVersion } from '../chapters/entities/chapter-version.entity';
import { Chapter } from '../chapters/entities/chapter.entity';
import { MediaAsset } from '../chapters/entities/media-asset.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from '../storage/entities/upload-session.entity';
import { StoryMember } from '../stories/entities/story-member.entity';
import { StorageService } from '../storage/storage.service';
import { TranslationGateway } from './translation.gateway';
import { TranslationProcessor } from './translation.processor';
import { CreateTranslationJobDto } from './dto/create-translation-job.dto';
import { RequestSourceReviewSlotsPageDto } from './dto/request-source-review-slots.dto';
import { ApplyTranslationJobDto } from './dto/apply-translation-job.dto';
import { CreateGlossaryDto } from './dto/create-glossary.dto';
import { WorkerEventCallbackDto } from './dto/worker-event-callback.dto';
import { CompleteMaterializationDto } from './dto/complete-materialization.dto';
import { FindTranslationProjectsQueryDto } from './dto/find-translation-projects-query.dto';
import { FindTranslationJobsQueryDto } from './dto/find-translation-jobs-query.dto';
import { FindJobSegmentsQueryDto } from './dto/find-job-segments-query.dto';
import { FindJobPreviewsQueryDto, normalizePreviewWindow } from './dto/find-job-previews-query.dto';
import { UpdateTranslationSegmentDto } from './dto/update-translation-segment.dto';
import {
  assertWorkerReportableState,
  assertTransitionAllowed,
  canBeginRetryAttempt,
  SYSTEM_TERMINAL_STATES,
  WORKER_REPORTABLE_ACTIVE_STATES,
} from './translation-state-machine';

export const PACKAGE_MANGA_FILE_TYPES = new Set([
  'MANGA_ZIP',
  'MANGA_ZIP_ARCHIVE',
  'MANGA_PACKAGE',
]);

export interface StoryAccessResolution {
  canReview: boolean;
  canApply: boolean;
  effectiveRole: 'ADMIN' | StoryMemberRole;
}

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);

  constructor(
    @InjectRepository(TranslationJob)
    private jobRepo: Repository<TranslationJob>,
    @InjectRepository(TranslationProject)
    private projectRepo: Repository<TranslationProject>,
    @InjectRepository(TranslationGlossary)
    private glossaryRepo: Repository<TranslationGlossary>,
    @InjectRepository(TranslationSegment)
    private segmentRepo: Repository<TranslationSegment>,
    @InjectRepository(ChapterVersion)
    private versionRepo: Repository<ChapterVersion>,
    @InjectRepository(Chapter)
    private chapterRepo: Repository<Chapter>,
    @InjectRepository(MediaAsset)
    private mediaAssetRepo: Repository<MediaAsset>,
    @InjectRepository(UploadSession)
    private uploadSessionRepo: Repository<UploadSession>,
    @InjectRepository(StoryMember)
    private storyMemberRepo: Repository<StoryMember>,
    @InjectQueue('translation')
    private translationQueue: Queue,
    @InjectQueue('translation-materialization')
    private materializationQueue: Queue,
    private storageService: StorageService,
    private dataSource: DataSource,
    private gateway: TranslationGateway,
    @Inject(forwardRef(() => TranslationProcessor))
    private processor: TranslationProcessor,
  ) {}

  /**
   * Tạo tác vụ dịch mới với Durable Idempotency & Pin Source Artifact
   */
  async createJob(
    user: any,
    dto: CreateTranslationJobDto,
    idempotencyKey?: string,
  ) {
    // 1. Durable Idempotency: Kiểm tra nếu job với idempotencyKey đã tồn tại
    if (idempotencyKey) {
      const existingJob = await this.jobRepo.findOne({
        where: { createdBy: user.id, idempotencyKey },
      });
      if (existingJob) {
        return {
          id: existingJob.id,
          status: existingJob.status,
          inputManifest: existingJob.inputManifest,
          isDuplicate: true,
        };
      }
    }

    // 2. Tìm ChapterVersion nguồn
    const sourceVersion = await this.versionRepo.findOne({
      where: { id: dto.chapterVersionId },
      relations: [
        'chapter',
        'chapter.storyEdition',
        'chapter.storyEdition.story',
      ],
    });

    if (!sourceVersion) {
      throw new NotFoundException(
        `Không tìm thấy ChapterVersion với ID: ${dto.chapterVersionId}`,
      );
    }

    const story = sourceVersion.chapter?.storyEdition?.story;
    const edition = sourceVersion.chapter?.storyEdition;

    if (!story || !edition) {
      throw new NotFoundException(
        'Không tìm thấy thông tin Story hoặc Edition tương ứng với version này.',
      );
    }

    // 3. Phân quyền RBAC (Story Translator/Editor/Owner hoặc Global Admin)
    await this.checkStoryPermission(story.id, user, [
      'OWNER',
      'EDITOR',
      'TRANSLATOR',
    ]);

    // 4. Resolve & Pin Source Artifact
    const promotedSessions = await this.uploadSessionRepo.find({
      where: {
        chapterVersionId: sourceVersion.id,
        status: UploadSessionStatus.PROMOTED,
      },
    });

    let sourceUploadSessionId: string | null = null;
    if (promotedSessions.length > 1) {
      throw new ConflictException(
        'SOURCE_ARTIFACT_AMBIGUOUS: Có nhiều upload session đã PROMOTED cho version này. Vui lòng liên hệ Admin hoặc chỉ định chính xác.',
      );
    } else if (promotedSessions.length === 1) {
      sourceUploadSessionId = promotedSessions[0].id;
    } else {
      // 0 upload session -> Kiểm tra xem có media assets nào cho version này không
      const mediaAssetsCount = await this.mediaAssetRepo.count({
        where: { versionId: sourceVersion.id },
      });
      if (mediaAssetsCount === 0) {
        throw new NotFoundException(
          'Không tìm thấy source package hay media assets cho version này.',
        );
      }
    }

    // 5. Resolve/Upsert TranslationProject (Unique theo editionId + sourceLang + targetLang)
    let project = await this.projectRepo.findOne({
      where: {
        storyEditionId: edition.id,
        sourceLanguage: dto.sourceLang,
        targetLanguage: dto.targetLang,
      },
    });

    if (!project) {
      project = this.projectRepo.create({
        storyEditionId: edition.id,
        sourceLanguage: dto.sourceLang,
        targetLanguage: dto.targetLang,
        createdBy: user.id,
      });
      try {
        project = await this.projectRepo.save(project);
      } catch (err: any) {
        // Concurrency conflict fallback
        project = await this.projectRepo.findOneOrFail({
          where: {
            storyEditionId: edition.id,
            sourceLanguage: dto.sourceLang,
            targetLanguage: dto.targetLang,
          },
        });
      }
    }

    // 6. Kiểm tra External Provider Consent và Snapshot Glossary
    const provider = dto.provider || 'MOCK';
    const isExternalProvider =
      provider !== 'MOCK' && provider !== 'LOCAL' && provider !== 'LOCAL_LLM';
    if (isExternalProvider && dto.externalConsent !== true) {
      throw new BadRequestException(
        'EXTERNAL_PROVIDER_CONSENT_REQUIRED: Dịch vụ yêu cầu sự đồng ý (externalConsent = true) trước khi gửi văn bản sang nhà cung cấp bên thứ ba.',
      );
    }

    const liveGlossaries = await this.glossaryRepo.find({
      where: { projectId: project.id },
    });

    const sortedGlossary = liveGlossaries
      .map((g) => ({
        sourceTerm: g.sourceTerm.trim(),
        targetTerm: g.targetTerm.trim(),
        category: g.category || 'CHARACTER_NAME',
      }))
      .sort((a, b) => {
        const cmpSource = a.sourceTerm.localeCompare(b.sourceTerm, 'ja');
        if (cmpSource !== 0) return cmpSource;
        const cmpTarget = a.targetTerm.localeCompare(b.targetTerm, 'vi');
        if (cmpTarget !== 0) return cmpTarget;
        return a.category.localeCompare(b.category);
      });

    const canonicalJson = JSON.stringify(sortedGlossary);
    const glossaryHash = `sha256:${crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`;
    const modelName = provider === 'OPENAI' ? 'gpt-4o-mini' : 'mock-model-v1';
    const isNovel = story?.mediaFormat === 'NOVEL';
    const promptVersion = isNovel ? 'novel-ja-vi-v2' : 'manga-ja-vi-v1';

    const candidateInputManifest = {
      version: 1,
      sourceLang: dto.sourceLang,
      targetLang: dto.targetLang,
      provider,
      model: modelName,
      promptVersion,
      glossarySnapshot: sortedGlossary,
      glossaryHash,
      externalConsent: {
        consented: dto.externalConsent === true,
        consentedAt:
          dto.externalConsent === true ? new Date().toISOString() : null,
        provider,
      },
    };

    const inputValidation = validateTranslationInputManifestV1(candidateInputManifest);
    if (!inputValidation.valid) {
      throw new BadRequestException({
        code: 'INVALID_INPUT_MANIFEST',
        message: `Input manifest không hợp lệ: ${inputValidation.errors.join('; ')}`,
        errors: inputValidation.errors,
      });
    }

    const inputManifest = inputValidation.value!;

    // 7. Tạo TranslationJob ở trạng thái VALIDATING (Dual-write mitigation)
    const job = this.jobRepo.create({
      projectId: project.id,
      sourceVersionId: sourceVersion.id,
      sourceUploadSessionId,
      createdBy: user.id,
      idempotencyKey: idempotencyKey || null,
      status: TranslationJobStatus.VALIDATING,
      provider,
      modelName,
      promptVersion,
      inputManifest,
      attemptCount: 0,
      maxAttempts: 3,
      lastSequence: 0,
      progressPercentage: 0,
    });

    try {
      await this.jobRepo.save(job);
    } catch (err: any) {
      if (
        idempotencyKey &&
        (err.code === '23505' || err.message?.includes('duplicate key'))
      ) {
        const existing = await this.jobRepo.findOneOrFail({
          where: { createdBy: user.id, idempotencyKey },
        });
        return {
          id: existing.id,
          status: existing.status,
          inputManifest: existing.inputManifest,
          isDuplicate: true,
        };
      }
      throw err;
    }

    // 7. Enqueue vào BullMQ với deterministic jobId = job.id
    try {
      await this.translationQueue.add(
        'process',
        { translationJobId: job.id },
        {
          jobId: job.id,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      // Enqueue thành công -> Cập nhật DB sang QUEUED với atomic conditional update
      const updateRes = await this.dataSource.query(
        `UPDATE translation_jobs
         SET status = 'QUEUED', workspace_revision = workspace_revision + 1
         WHERE id = $1 AND status = 'VALIDATING'
         RETURNING workspace_revision, status;`,
        [job.id],
      );

      if (updateRes[0]?.length > 0) {
        job.status = updateRes[0][0].status;
        job.workspaceRevision = updateRes[0][0].workspace_revision;
      } else {
        // Zero-row: Watchdog (hoặc process concurrent) đã enqueue và chuyển status
        const current = await this.jobRepo.findOne({ where: { id: job.id } });
        if (current?.status === TranslationJobStatus.QUEUED) {
          job.status = current.status;
          job.workspaceRevision = current.workspaceRevision;
        } else if (current) {
          job.status = current.status;
          job.workspaceRevision = current.workspaceRevision;
        }
      }
    } catch (enqueueErr: any) {
      this.logger.error(
        `Không thể enqueue BullMQ cho TranslationJob ${job.id}: ${enqueueErr.message}. Giữ trạng thái VALIDATING để reconciler xử lý.`,
      );
      // Giữ nguyên VALIDATING để Reconciler tự enqueue lại
    }

    return {
      id: job.id,
      status: job.status,
      isDuplicate: false,
    };
  }

  /**
   * Danh sách Translation Projects trong Studio (#144)
   * Single-query latestJob (LATERAL / DISTINCT ON subquery, không N+1), count query riêng,
   * deterministic sorting, bounded pagination.
   */
  async getProjects(
    user: any,
    query: FindTranslationProjectsQueryDto,
  ): Promise<PaginatedResponse<TranslationProjectSummaryDto>> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const qb = this.projectRepo
      .createQueryBuilder('project')
      .innerJoinAndSelect('project.storyEdition', 'edition')
      .innerJoinAndSelect('edition.story', 'story');

    if (user.role !== GlobalRole.ADMIN) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM story_members sm
          WHERE sm.story_id = story.id
            AND sm.user_id = :userId
            AND sm.role IN (:...roles)
        )`,
        {
          userId: user.id,
          roles: [
            StoryMemberRole.OWNER,
            StoryMemberRole.EDITOR,
            StoryMemberRole.TRANSLATOR,
          ],
        },
      );
    }

    if (query.storyId) {
      qb.andWhere('story.id = :storyId', { storyId: query.storyId });
    }

    // Count query độc lập (không tốn chi phí JOIN LATERAL)
    const total = await qb.getCount();

    // Data query: lấy latestJob bằng correlated subqueries trên trang hiện tại
    // EXPLAIN chứng minh cách này tận dụng idx_translation_jobs_project_created, nhanh hơn ~90x so với DISTINCT ON toàn bảng (0.29ms vs 26.7ms).
    qb.addSelect((subQuery) => {
      return subQuery
        .select('j.id')
        .from('translation_jobs', 'j')
        .where('j.project_id = project.id')
        .orderBy('j.created_at', 'DESC')
        .addOrderBy('j.id', 'DESC')
        .limit(1);
    }, 'latest_job_id')
      .addSelect((subQuery) => {
        return subQuery
          .select('j.status')
          .from('translation_jobs', 'j')
          .where('j.project_id = project.id')
          .orderBy('j.created_at', 'DESC')
          .addOrderBy('j.id', 'DESC')
          .limit(1);
      }, 'latest_job_status')
      .addSelect((subQuery) => {
        return subQuery
          .select('j.progress_percentage')
          .from('translation_jobs', 'j')
          .where('j.project_id = project.id')
          .orderBy('j.created_at', 'DESC')
          .addOrderBy('j.id', 'DESC')
          .limit(1);
      }, 'latest_job_progress')
      .orderBy('project.createdAt', 'DESC')
      .addOrderBy('project.id', 'DESC')
      .skip(skip)
      .take(limit);

    const rawAndEntities = await qb.getRawAndEntities();

    const data: TranslationProjectSummaryDto[] = rawAndEntities.entities.map(
      (p, index) => {
        const raw = rawAndEntities.raw[index];
        return {
          id: p.id,
          storyId: p.storyEdition?.story?.id,
          storyEditionId: p.storyEditionId,
          sourceLanguage: p.sourceLanguage,
          targetLanguage: p.targetLanguage,
          createdAt: p.createdAt.toISOString(),
          latestJob: raw?.latest_job_id
            ? {
                id: raw.latest_job_id,
                status: raw.latest_job_status as TranslationJobStatus,
                progressPercentage: Number(raw.latest_job_progress || 0),
              }
            : undefined,
        };
      },
    );

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Danh sách Translation Jobs trong Studio (#144)
   * Phân trang bounded, sắp xếp deterministic, filter storyId, projectId, status.
   */
  async getJobs(
    user: any,
    query: FindTranslationJobsQueryDto,
  ): Promise<PaginatedResponse<TranslationJobSummaryDto>> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const qb = this.jobRepo
      .createQueryBuilder('job')
      .innerJoinAndSelect('job.project', 'project')
      .innerJoinAndSelect('project.storyEdition', 'edition')
      .innerJoinAndSelect('edition.story', 'story')
      .leftJoinAndSelect('job.sourceVersion', 'sourceVersion')
      .leftJoinAndSelect('sourceVersion.chapter', 'chapter');

    if (user.role !== GlobalRole.ADMIN) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM story_members sm
          WHERE sm.story_id = story.id
            AND sm.user_id = :userId
            AND sm.role IN (:...roles)
        )`,
        {
          userId: user.id,
          roles: [
            StoryMemberRole.OWNER,
            StoryMemberRole.EDITOR,
            StoryMemberRole.TRANSLATOR,
          ],
        },
      );
    }

    if (query.storyId) {
      qb.andWhere('story.id = :storyId', { storyId: query.storyId });
    }

    if (query.projectId) {
      qb.andWhere('job.projectId = :projectId', { projectId: query.projectId });
    }

    if (query.status) {
      qb.andWhere('job.status = :status', { status: query.status });
    }

    qb.orderBy('job.createdAt', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .skip(skip)
      .take(limit);

    const [jobs, total] = await qb.getManyAndCount();

    const data: TranslationJobSummaryDto[] = jobs.map((job) => ({
      id: job.id,
      projectId: job.projectId,
      storyId: job.project?.storyEdition?.story?.id,
      storyTitle: job.project?.storyEdition?.story?.title,
      storyEditionId: job.project?.storyEdition?.id,
      editionName: job.project?.storyEdition?.editionName,
      chapterId: job.sourceVersion?.chapter?.id,
      chapterNumber: job.sourceVersion?.chapter
        ? String(job.sourceVersion.chapter.chapterNumber)
        : '',
      chapterTitle: job.sourceVersion?.chapter?.title || null,
      sourceLanguage: job.project?.sourceLanguage,
      targetLanguage: job.project?.targetLanguage,
      status: job.status,
      progressPercentage: job.progressPercentage,
      provider: job.provider,
      modelName: job.modelName,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt ? job.startedAt.toISOString() : null,
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    }));

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Truy vấn chi tiết TranslationJob (#148)
   * Slim response: Chỉ trả metadata & reviewSummary (aggregate SQL),
   * KHÔNG load segments relation, KHÔNG sign 200 diff URLs, KHÔNG expose raw errorTrace/storageKey.
   */
  async getJob(id: string, user: any): Promise<TranslationJobReviewDetailResponse> {
    return await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const job = await manager.findOne(TranslationJob, {
        where: { id },
        relations: [
          'project',
          'project.storyEdition',
          'project.storyEdition.story',
          'sourceVersion',
          'sourceVersion.chapter',
          'targetVersion',
        ],
      });

      if (!job) {
        throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${id}`);
      }

      const story = job.project?.storyEdition?.story;
      const edition = job.project?.storyEdition;
      const chapter = job.sourceVersion?.chapter;

      if (!story || !edition || !chapter) {
        throw new NotFoundException(
          'Không tìm thấy đầy đủ ngữ cảnh Story/Edition/Chapter cho TranslationJob này.',
        );
      }

      const access = await this.resolveStoryAccess(story.id, user, manager);

      // SQL Aggregation trực tiếp qua manager để đếm segments/pages mà không load toàn bộ vào RAM
      const aggResult = await manager.query(
        `SELECT
          COUNT(*)::int as segment_count,
          COUNT(*) FILTER (WHERE is_human_verified = true)::int as verified_count,
          COUNT(DISTINCT page_number)::int as page_count,
          COUNT(DISTINCT anchor_block_id)::int as block_count
        FROM translation_segments
        WHERE job_id = $1`,
        [job.id],
      );

      const agg = aggResult[0] || {
        segment_count: 0,
        verified_count: 0,
        page_count: 0,
        block_count: 0,
      };

      const isComic = story.mediaFormat === MediaFormat.COMIC;
      const isNovel = story.mediaFormat === MediaFormat.NOVEL;

      let resultPageCount: number | null = null;
      if (
        isComic &&
        (job.status === TranslationJobStatus.READY_FOR_REVIEW ||
          job.status === TranslationJobStatus.APPLIED) &&
        job.resultManifest
      ) {
        try {
          const rawManifest =
            typeof job.resultManifest === 'string'
              ? JSON.parse(job.resultManifest)
              : job.resultManifest;
          const validation = validateTranslationResultManifest(
            rawManifest,
            'COMIC',
          );
          if (
            validation.valid &&
            validation.value &&
            validation.value.mediaFormat === 'COMIC'
          ) {
            resultPageCount = validation.value.pages.length;
          }
        } catch {
          resultPageCount = null;
        }
      }

      const reviewSummary: ReviewSummaryDto = {
        segmentCount: Number(agg.segment_count || 0),
        verifiedCount: Number(agg.verified_count || 0),
        pageCount: isComic ? Number(agg.page_count || 0) : null,
        resultPageCount,
        blockCount: isNovel ? Number(agg.block_count || 0) : null,
      };

      let errorSummary: { code: string; message: string } | undefined;
      if (job.status === TranslationJobStatus.FAILED) {
        errorSummary = {
          code: 'TRANSLATION_JOB_FAILED',
          message: 'Translation job failed. Please retry or review job diagnostics.',
        };
      }

      return {
        job: {
          id: job.id,
          status: job.status,
          progressPercentage: job.progressPercentage,
          provider: job.provider,
          modelName: job.modelName,
          promptVersion: job.promptVersion,
          attemptCount: job.attemptCount,
          maxAttempts: job.maxAttempts,
          createdAt: job.createdAt.toISOString(),
          startedAt: job.startedAt ? job.startedAt.toISOString() : null,
          heartbeatAt: job.heartbeatAt ? job.heartbeatAt.toISOString() : null,
          completedAt: job.completedAt ? job.completedAt.toISOString() : null,
          expiresAt: job.expiresAt ? job.expiresAt.toISOString() : null,
          reviewRevision: Number(job.reviewRevision || 0),
          materializedRevision: Number(job.materializedRevision || 0),
          workspaceRevision: job.workspaceRevision,
        },
        context: {
          story: {
            id: story.id,
            title: story.title,
            slug: story.slug,
            mediaFormat: story.mediaFormat,
          },
          edition: {
            id: edition.id,
            editionName: edition.editionName,
            language: edition.language,
            isDefault: edition.isDefault,
          },
          chapter: {
            id: chapter.id,
            chapterNumber: String(chapter.chapterNumber),
            title: chapter.title || null,
          },
          project: {
            id: job.project.id,
            sourceLanguage: job.project.sourceLanguage,
            targetLanguage: job.project.targetLanguage,
          },
          sourceVersion: {
            id: job.sourceVersion.id,
            versionNumber: job.sourceVersion.versionNumber,
          },
          targetVersion: job.targetVersion
            ? {
                id: job.targetVersion.id,
                versionNumber: job.targetVersion.versionNumber,
              }
            : null,
        },
        reviewSummary,
        permissions: {
          canApply: access.canApply,
          ...(access.canApply
            ? {}
            : { applyBlockReason: 'INSUFFICIENT_ROLE' as const }),
        },
        glossarySnapshot: job.inputManifest?.glossarySnapshot || undefined,
        error: errorSummary,
      };
    });
  }

  /**
   * Danh sách Translation Segments phân trang (#155)
   */
  async getJobSegments(
    id: string,
    user: any,
    query: FindJobSegmentsQueryDto,
  ): Promise<TranslationJobSegmentsResponse> {
    return await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const job = await manager.findOne(TranslationJob, {
        where: { id },
        relations: [
          'project',
          'project.storyEdition',
          'project.storyEdition.story',
        ],
      });

      if (!job) {
        throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${id}`);
      }

      const story = job.project?.storyEdition?.story;
      if (!story) {
        throw new NotFoundException(
          'Không tìm thấy Story context hợp lệ cho TranslationJob.',
        );
      }

      await this.checkStoryPermission(story.id, user, [
        'OWNER',
        'EDITOR',
        'TRANSLATOR',
      ]);

      const page = Math.max(1, Number(query.page) || 1);
      const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
      const skip = (page - 1) * limit;

      const qb = manager
        .getRepository(TranslationSegment)
        .createQueryBuilder('segment')
        .where('segment.jobId = :jobId', { jobId: job.id });

      if (query.pageNumber !== undefined && query.pageNumber !== null) {
        qb.andWhere('segment.pageNumber = :pageNumber', {
          pageNumber: query.pageNumber,
        });
      }

      if (story?.mediaFormat === MediaFormat.COMIC) {
        qb.orderBy('segment.pageNumber', 'ASC')
          .addOrderBy('segment.sortOrder', 'ASC')
          .addOrderBy('segment.id', 'ASC');
      } else {
        qb.orderBy('segment.sortOrder', 'ASC').addOrderBy('segment.id', 'ASC');
      }

      qb.skip(skip).take(limit);

      const [segments, total] = await qb.getManyAndCount();

      const data: TranslationSegmentDto[] = segments.map((s) => ({
        id: s.id,
        jobId: s.jobId,
        pageNumber: s.pageNumber,
        anchorBlockId: s.anchorBlockId,
        sortOrder: s.sortOrder,
        bboxX: s.bboxX !== null ? Number(s.bboxX) : null,
        bboxY: s.bboxY !== null ? Number(s.bboxY) : null,
        bboxW: s.bboxW !== null ? Number(s.bboxW) : null,
        bboxH: s.bboxH !== null ? Number(s.bboxH) : null,
        rawText: s.rawText,
        translatedText: s.translatedText,
        confidence: s.confidence !== null ? Number(s.confidence) : null,
        isHumanVerified: s.isHumanVerified,
        blockType: s.blockType ?? null,
        version: s.version ?? 1,
        createdAt: s.createdAt.toISOString(),
      }));

      return {
        data,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
        workspaceRevision: job.workspaceRevision,
      };
    });
  }

  /**
   * Lấy danh sách presigned preview assets cho active review Manga trong bounded window (#155)
   */
  async getJobPreviews(
    id: string,
    user: any,
    query: FindJobPreviewsQueryDto,
  ): Promise<TranslationJobPreviewsResponse> {
    const window = normalizePreviewWindow(query);

    // Phase 1: REPEATABLE READ snapshot - Đóng băng toàn bộ DB-derived metadata và giải phóng kết nối DB
    const frozen = await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const job = await manager.findOne(TranslationJob, {
        where: { id },
        relations: [
          'project',
          'project.storyEdition',
          'project.storyEdition.story',
        ],
      });

      if (!job) {
        throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${id}`);
      }

      const story = job.project?.storyEdition?.story;
      if (!story) {
        throw new NotFoundException(
          'Không tìm thấy Story context hợp lệ cho TranslationJob.',
        );
      }

      await this.checkStoryPermission(story.id, user, [
        'OWNER',
        'EDITOR',
        'TRANSLATOR',
      ]);

      if (story.mediaFormat !== MediaFormat.COMIC) {
        throw new BadRequestException({
          code: 'PREVIEWS_ONLY_SUPPORTED_FOR_COMIC',
          message: 'Previews are only supported for COMIC media format.',
        });
      }

      if (job.status !== TranslationJobStatus.READY_FOR_REVIEW) {
        throw new ConflictException({
          code: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS',
          message: `Previews are only available for status READY_FOR_REVIEW, current status: ${job.status}`,
        });
      }

      let rawManifest: unknown = job.resultManifest;
      if (typeof rawManifest === 'string') {
        try {
          rawManifest = JSON.parse(rawManifest);
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
          this.throwPreviewManifestInvariant(
            `Manifest JSON is malformed for job ${id}`,
          );
        }
      }

      const manifestValidation = validateTranslationResultManifest(
        rawManifest,
        'COMIC',
      );
      if (!manifestValidation.valid || !manifestValidation.value) {
        this.throwPreviewManifestInvariant(
          `Manifest validation failed for job ${id}: ${manifestValidation.errors?.join('; ') || 'invalid manifest'}`,
        );
      }

      const mangaManifest = manifestValidation.value as MangaResultManifestV1;

      // 1. Source Asset Resolution: Rule A (sourceReview precedence) vs Rule B (MediaAsset fallback)
      let targetSourceReviewPages: Array<{
        page: number;
        storageKey: string;
        width: number | null;
        height: number | null;
      }> = [];
      let fallbackMediaAssets: MediaAsset[] = [];

      const sourceReview = mangaManifest.sourceReview;
      if (sourceReview && Array.isArray(sourceReview.pages)) {
        targetSourceReviewPages = sourceReview.pages
          .filter((p) => p.page >= window.fromPage && p.page <= window.toPage)
          .map((p) => ({
            page: p.page,
            storageKey: p.storageKey,
            width: p.width ?? null,
            height: p.height ?? null,
          }));
      } else if (job.sourceVersionId) {
        fallbackMediaAssets = await manager.find(MediaAsset, {
          where: {
            versionId: job.sourceVersionId,
            assetType: MediaAssetType.MANGA_PAGE,
            sortOrder: Between(window.fromPage, window.toPage),
          },
          order: {
            sortOrder: 'ASC',
            id: 'ASC',
          },
        });
      }

      // 2. Result Asset Resolution
      const targetResultPages = mangaManifest.pages
        .filter((p) => p.page >= window.fromPage && p.page <= window.toPage)
        .map((p) => ({
          page: p.page,
          previewKey: p.previewKey,
          width: p.width ?? null,
          height: p.height ?? null,
          fileSizeBytes: p.fileSizeBytes !== undefined ? Number(p.fileSizeBytes) : undefined,
        }));

      return {
        jobId: job.id,
        workspaceRevision: job.workspaceRevision,
        targetSourceReviewPages,
        fallbackMediaAssets,
        targetResultPages,
      };
    });

    // Phase 2: Ký Presigned URLs NGOÀI transaction DB
    const sourceAssets: ReviewAssetDto[] = [];
    const resultAssets: ReviewAssetDto[] = [];

    if (frozen.targetSourceReviewPages.length > 0) {
      for (const p of frozen.targetSourceReviewPages) {
        this.assertSourceReviewPreviewKey(frozen.jobId, p.page, p.storageKey);
        const presignedUrl = await this.storageService.createInternalDownloadUrl(
          p.storageKey,
          true,
          900,
        );
        sourceAssets.push({
          kind: 'SOURCE_REVIEW',
          pageNumber: p.page,
          width: p.width,
          height: p.height,
          url: presignedUrl,
        });
      }
    } else if (frozen.fallbackMediaAssets.length > 0) {
      for (const asset of frozen.fallbackMediaAssets) {
        const presignedUrl = await this.storageService.createInternalDownloadUrl(
          asset.storageKey,
          true,
          900,
        );
        sourceAssets.push({
          kind: 'SOURCE_MEDIA',
          id: asset.id,
          pageNumber: asset.sortOrder,
          width: asset.width ?? null,
          height: asset.height ?? null,
          url: presignedUrl,
        });
      }
    }

    for (const p of frozen.targetResultPages) {
      this.assertResultPreviewKey(frozen.jobId, p.page, p.previewKey);
      const presignedUrl = await this.storageService.createInternalDownloadUrl(
        p.previewKey,
        true,
        900,
      );
      resultAssets.push({
        kind: 'RESULT',
        pageNumber: p.page,
        width: p.width,
        height: p.height,
        ...(p.fileSizeBytes !== undefined && {
          fileSizeBytes: p.fileSizeBytes,
        }),
        url: presignedUrl,
      });
    }

    sourceAssets.sort((a, b) => a.pageNumber - b.pageNumber);
    resultAssets.sort((a, b) => a.pageNumber - b.pageNumber);

    return {
      workspaceRevision: frozen.workspaceRevision,
      sourceAssets,
      resultAssets,
    };
  }

  private throwPreviewManifestInvariant(reason: string): never {
    this.logger.error(`[PreviewInvariant] ${reason}`);
    throw new InternalServerErrorException({
      code: 'PREVIEW_MANIFEST_INVARIANT_VIOLATION',
      message:
        'Preview assets are unavailable because the persisted manifest is invalid.',
    });
  }

  private assertSourceReviewPreviewKey(
    jobId: string,
    pageNumber: number,
    storageKey: string,
  ): void {
    const sourceReviewRegex = new RegExp(
      `^ai/jobs/${jobId}/source-review/attempt-[1-9]\\d*/page_${pageNumber}\\.(jpg|png|webp|avif)$`,
    );
    if (
      !storageKey ||
      typeof storageKey !== 'string' ||
      storageKey.includes('..') ||
      storageKey.includes('\\') ||
      !sourceReviewRegex.test(storageKey)
    ) {
      this.throwPreviewManifestInvariant(
        `Invalid SOURCE_REVIEW key for job=${jobId}, page=${pageNumber}, key=${storageKey}`,
      );
    }
  }

  private assertResultPreviewKey(
    jobId: string,
    pageNumber: number,
    previewKey: string,
  ): void {
    const paddedPage = String(pageNumber).padStart(4, '0');
    const initialOutputRegex = new RegExp(
      `^ai/jobs/${jobId}/attempt-[1-9]\\d*/(page_${paddedPage}|page_${pageNumber}|p${pageNumber})\\.webp$`,
    );
    const materializationRegex = new RegExp(
      `^ai/jobs/${jobId}/materializations/rev-[1-9]\\d*/page_${pageNumber}\\.webp$`,
    );
    if (
      !previewKey ||
      typeof previewKey !== 'string' ||
      previewKey.includes('..') ||
      previewKey.includes('\\') ||
      (!initialOutputRegex.test(previewKey) &&
        !materializationRegex.test(previewKey))
    ) {
      this.throwPreviewManifestInvariant(
        `Invalid RESULT previewKey for job=${jobId}, page=${pageNumber}, key=${previewKey}`,
      );
    }
  }

  /**
   * Cập nhật bản dịch của một Translation Segment (OCC + Per-Job Mutex) (#147)
   */
  async updateSegment(
    jobId: string,
    segmentId: string,
    user: any,
    dto: UpdateTranslationSegmentDto,
  ): Promise<TranslationSegmentDto> {
    // 0. Defense-in-depth: empty mutation check
    if (dto.translatedText === undefined && dto.isHumanVerified === undefined) {
      throw new BadRequestException({
        code: 'EMPTY_MUTATION',
        message:
          'Yêu cầu cập nhật phải chứa ít nhất translatedText hoặc isHumanVerified.',
      });
    }

    return await this.dataSource.transaction(async (manager) => {
      // 1. Canonical Lock Order: Per-Job Mutex FIRST (triệt tiêu deadlock & race condition)
      await manager.query(
        `SELECT id FROM translation_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );

      const job = await manager.findOne(TranslationJob, {
        where: { id: jobId },
        relations: [
          'project',
          'project.storyEdition',
          'project.storyEdition.story',
        ],
      });

      if (!job) {
        throw new NotFoundException(
          `Không tìm thấy TranslationJob với ID: ${jobId}`,
        );
      }

      const story = job.project?.storyEdition?.story;
      if (!story) {
        throw new NotFoundException(
          'Không tìm thấy Story context hợp lệ cho TranslationJob.',
        );
      }

      // 2. Check RBAC
      await this.checkStoryPermission(story.id, user, [
        'OWNER',
        'EDITOR',
        'TRANSLATOR',
      ]);

      // 3. Check Job Status: Chỉ duy nhất READY_FOR_REVIEW được phép mutate
      if (job.status !== TranslationJobStatus.READY_FOR_REVIEW) {
        throw new ConflictException({
          code: 'NOT_REVIEWABLE',
          message: `Chỉ có thể chỉnh sửa segment khi Job ở trạng thái READY_FOR_REVIEW. Trạng thái hiện tại: ${job.status}`,
        });
      }

      // 4. Canonical Lock Order: Child resource Segment FOR UPDATE
      const segment = await manager.findOne(TranslationSegment, {
        where: { id: segmentId, jobId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!segment) {
        throw new NotFoundException(
          `Không tìm thấy TranslationSegment với ID: ${segmentId} thuộc Job: ${jobId}`,
        );
      }

      // 5. Check OCC Version: Phải kiểm tra trước khi check no-op!
      if (segment.version !== dto.expectedVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: `Xung đột phiên bản (OCC Conflict). Phiên bản hiện tại: ${segment.version}, phiên bản gửi lên: ${dto.expectedVersion}`,
          meta: {
            currentVersion: segment.version,
            expectedVersion: dto.expectedVersion,
          },
        });
      }

      // 6. Novel Inline Protected Anchors Strict Validation
      if (
        story.mediaFormat === MediaFormat.NOVEL &&
        dto.translatedText !== undefined
      ) {
        const anchorCheck = validateProtectedAnchorTopology(
          segment.rawText,
          dto.translatedText,
        );
        if (!anchorCheck.valid) {
          throw new BadRequestException({
            code: 'ANCHOR_TOPOLOGY_VIOLATION',
            message: `Vi phạm cấu trúc protected anchor: ${anchorCheck.error}`,
          });
        }
      }

      // 7. Determine Changes & No-Op Semantics
      const textChanged =
        dto.translatedText !== undefined &&
        dto.translatedText !== segment.translatedText;
      const verificationChanged =
        dto.isHumanVerified !== undefined &&
        dto.isHumanVerified !== segment.isHumanVerified;

      // No-op: Nếu không có gì thay đổi, không tăng version, không tăng reviewRevision
      if (!textChanged && !verificationChanged) {
        return {
          id: segment.id,
          jobId: segment.jobId,
          pageNumber: segment.pageNumber,
          anchorBlockId: segment.anchorBlockId,
          sortOrder: segment.sortOrder,
          bboxX: segment.bboxX !== null ? Number(segment.bboxX) : null,
          bboxY: segment.bboxY !== null ? Number(segment.bboxY) : null,
          bboxW: segment.bboxW !== null ? Number(segment.bboxW) : null,
          bboxH: segment.bboxH !== null ? Number(segment.bboxH) : null,
          rawText: segment.rawText,
          translatedText: segment.translatedText,
          confidence:
            segment.confidence !== null ? Number(segment.confidence) : null,
          isHumanVerified: segment.isHumanVerified,
          blockType: segment.blockType ?? null,
          version: segment.version,
          createdAt: segment.createdAt.toISOString(),
        };
      }

      // 8. Atomic Conditional SQL UPDATE
      const newText =
        dto.translatedText !== undefined
          ? dto.translatedText
          : segment.translatedText;
      let newVerification: boolean;
      if (dto.isHumanVerified !== undefined) {
        newVerification = dto.isHumanVerified;
      } else if (textChanged) {
        newVerification = false; // Auto-reset verification when text is modified without explicit verification
      } else {
        newVerification = segment.isHumanVerified;
      }

      const updateResult = await manager
        .createQueryBuilder()
        .update(TranslationSegment)
        .set({
          translatedText: newText,
          isHumanVerified: newVerification,
          version: () => 'version + 1',
        })
        .where('id = :id AND jobId = :jobId AND version = :expectedVersion', {
          id: segmentId,
          jobId,
          expectedVersion: dto.expectedVersion,
        })
        .execute();

      if (updateResult.affected === 0) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message:
            'Xung đột phiên bản khi cập nhật segment (OCC Atomic Update Failed).',
        });
      }

      // 9. Atomic Revision Bump (P1-I):
      // Luôn tăng workspace_revision + 1 atomically cho bất kỳ thay đổi nào (text hoặc verification).
      // Chỉ tăng review_revision + 1 khi translatedText thực sự thay đổi.
      // Cả hai được gom trong MỘT câu lệnh SQL duy nhất loại trừ tương hỗ (exactly 1 bump to workspace_revision).
      await manager.query(
        `UPDATE translation_jobs
         SET review_revision = CASE WHEN $2::boolean THEN review_revision + 1 ELSE review_revision END,
             workspace_revision = workspace_revision + 1
         WHERE id = $1
         RETURNING workspace_revision, review_revision;`,
        [jobId, textChanged],
      );

      // Đọc lại segment vừa cập nhật
      const updatedSegment = await manager.findOneOrFail(TranslationSegment, {
        where: { id: segmentId },
      });

      return {
        id: updatedSegment.id,
        jobId: updatedSegment.jobId,
        pageNumber: updatedSegment.pageNumber,
        anchorBlockId: updatedSegment.anchorBlockId,
        sortOrder: updatedSegment.sortOrder,
        bboxX:
          updatedSegment.bboxX !== null ? Number(updatedSegment.bboxX) : null,
        bboxY:
          updatedSegment.bboxY !== null ? Number(updatedSegment.bboxY) : null,
        bboxW:
          updatedSegment.bboxW !== null ? Number(updatedSegment.bboxW) : null,
        bboxH:
          updatedSegment.bboxH !== null ? Number(updatedSegment.bboxH) : null,
        rawText: updatedSegment.rawText,
        translatedText: updatedSegment.translatedText,
        confidence:
          updatedSegment.confidence !== null
            ? Number(updatedSegment.confidence)
            : null,
        isHumanVerified: updatedSegment.isHumanVerified,
        blockType: updatedSegment.blockType ?? null,
        version: updatedSegment.version,
        createdAt: updatedSegment.createdAt.toISOString(),
      };
    });
  }

  /**
   * Cấp danh sách Presigned PUT URLs cho Worker (Two-step upload protocol)
   */
  async createOutputUploadUrls(
    id: string,
    attemptNumber: number,
    files: Array<{ filename: string; contentType?: string }>,
  ) {
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new BadRequestException('Danh sách files yêu cầu không được rỗng.');
    }
    if (files.length > 200) {
      throw new BadRequestException(
        'Vượt quá giới hạn số lượng files tối đa (tối đa 200 pages).',
      );
    }

    const job = await this.jobRepo.findOne({
      where: { id },
      relations: [
        'project',
        'project.storyEdition',
        'project.storyEdition.story',
        'sourceVersion',
        'sourceVersion.chapter',
        'sourceVersion.chapter.storyEdition',
        'sourceVersion.chapter.storyEdition.story',
      ],
    });
    if (!job) {
      throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${id}`);
    }

    if (SYSTEM_TERMINAL_STATES.includes(job.status)) {
      throw new BadRequestException(
        `Job đã ở trạng thái Terminal (${job.status}), không thể cấp URL upload mới.`,
      );
    }

    if (attemptNumber !== job.attemptCount) {
      throw new BadRequestException(
        `Attempt ${attemptNumber} không khớp với attempt hiện tại của job (${job.attemptCount}).`,
      );
    }

    const story =
      job.project?.storyEdition?.story ||
      job.sourceVersion?.chapter?.storyEdition?.story;
    const isManga = story?.mediaFormat !== 'NOVEL';

    const presignedOutputs = [];
    for (const f of files) {
      const sanitizedFilename = f.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storageKey = `ai/jobs/${id}/attempt-${attemptNumber}/${sanitizedFilename}`;
      const uploadUrl = await this.storageService.createInternalUploadUrl(
        storageKey,
        f.contentType || (isManga ? 'image/webp' : 'text/html; charset=utf-8'),
        isManga,
        1800,
      );
      presignedOutputs.push({
        filename: f.filename,
        storageKey,
        uploadUrl,
      });
    }

    return {
      jobId: id,
      attemptNumber,
      files: presignedOutputs,
    };
  }

  /**
   * Cấp danh sách Presigned PUT URLs cho Clean Base Manga backgrounds (#162)
   */
  async createCleanBaseUploadUrls(
    id: string,
    attemptNumber: number,
    pages: number[],
  ) {
    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      throw new BadRequestException('Danh sách pages yêu cầu không được rỗng.');
    }
    if (pages.length > 200) {
      throw new BadRequestException(
        'Vượt quá giới hạn số lượng pages tối đa (tối đa 200 pages).',
      );
    }

    const job = await this.jobRepo.findOne({
      where: { id },
      relations: [
        'project',
        'project.storyEdition',
        'project.storyEdition.story',
        'sourceVersion',
        'sourceVersion.chapter',
        'sourceVersion.chapter.storyEdition',
        'sourceVersion.chapter.storyEdition.story',
      ],
    });
    if (!job) {
      throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${id}`);
    }

    // Chặn nghiêm ngặt: Không cấp slot nếu job đã vào Review hoặc Terminal states
    const ALLOWED_CLEAN_BASE_STATUSES = [
      TranslationJobStatus.CREATED,
      TranslationJobStatus.VALIDATING,
      TranslationJobStatus.QUEUED,
      TranslationJobStatus.PREPROCESSING,
      TranslationJobStatus.OCR,
      TranslationJobStatus.TRANSLATING,
      TranslationJobStatus.INPAINTING,
      TranslationJobStatus.TYPESETTING,
      TranslationJobStatus.QUALITY_CHECK,
    ];
    if (!ALLOWED_CLEAN_BASE_STATUSES.includes(job.status)) {
      throw new BadRequestException(
        `Không thể cấp clean base upload slots khi job ở trạng thái: ${job.status}. Chỉ cho phép trong quá trình xử lý của Worker trước khi vào Review.`,
      );
    }

    if (attemptNumber !== job.attemptCount) {
      throw new BadRequestException(
        `Attempt ${attemptNumber} không khớp với attempt hiện tại của job (${job.attemptCount}).`,
      );
    }

    // Fail-closed: Chỉ hỗ trợ COMIC, mọi format khác hoặc thiếu story đều reject
    const story =
      job.project?.storyEdition?.story ||
      job.sourceVersion?.chapter?.storyEdition?.story;
    if (story?.mediaFormat !== MediaFormat.COMIC) {
      throw new BadRequestException(
        'Clean base upload slots chỉ hỗ trợ cho định dạng COMIC / Manga.',
      );
    }

    // Validate duplicate & valid page numbers (>= 1)
    const seenPages = new Set<number>();
    for (const page of pages) {
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
        throw new BadRequestException(
          `Page number không hợp lệ: ${page}. Phải là số nguyên >= 1.`,
        );
      }
      if (seenPages.has(page)) {
        throw new BadRequestException(
          `Duplicate page number trong danh sách clean base: ${page}`,
        );
      }
      seenPages.add(page);
    }

    // Core độc quyền sinh canonical keys & cấp Presigned PUT URLs
    const presignedCleanBases = [];
    for (const page of pages) {
      const storageKey = `ai/jobs/${id}/review-base/attempt-${attemptNumber}/page_${page}.webp`;
      const uploadUrl = await this.storageService.createInternalUploadUrl(
        storageKey,
        'image/webp',
        true,
        1800,
      );
      presignedCleanBases.push({
        page,
        storageKey,
        uploadUrl,
      });
    }

    return {
      jobId: id,
      attemptNumber,
      cleanBases: presignedCleanBases,
    };
  }

  /**
   * Cấp Presigned PUT URLs cho Manga source review page previews trích xuất từ MANGA_ZIP (#159)
   */
  async createSourceReviewUploadUrls(
    id: string,
    attemptNumber: number,
    pages: RequestSourceReviewSlotsPageDto[],
  ) {
    const job = await this.jobRepo.findOne({
      where: { id },
      relations: [
        'project',
        'project.storyEdition',
        'project.storyEdition.story',
        'sourceVersion',
        'sourceVersion.chapter',
        'sourceVersion.chapter.storyEdition',
        'sourceVersion.chapter.storyEdition.story',
        'sourceUploadSession',
      ],
    });

    if (!job) {
      throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${id}`);
    }

    // Least-Privilege Gate: Chỉ cho phép trong trạng thái PREPROCESSING sau khi giải nén
    if (job.status !== TranslationJobStatus.PREPROCESSING) {
      throw new BadRequestException(
        `Không thể cấp source review upload slots khi job ở trạng thái: ${job.status}. Chỉ cho phép trong trạng thái PREPROCESSING (#159).`,
      );
    }

    if (attemptNumber !== job.attemptCount) {
      throw new BadRequestException(
        `Attempt ${attemptNumber} không khớp với attempt hiện tại của job (${job.attemptCount}).`,
      );
    }

    // Fail-closed: Chỉ hỗ trợ COMIC và Manga bắt nguồn từ package (#159)
    const story =
      job.project?.storyEdition?.story ||
      job.sourceVersion?.chapter?.storyEdition?.story;
    if (
      story?.mediaFormat !== MediaFormat.COMIC ||
      !job.sourceUploadSession?.fileType ||
      !PACKAGE_MANGA_FILE_TYPES.has(job.sourceUploadSession.fileType)
    ) {
      throw new BadRequestException(
        'SOURCE_REVIEW_ONLY_SUPPORTED_FOR_PACKAGE: Source review upload slots chỉ hỗ trợ cho Manga package-backed jobs (MANGA_ZIP) (#159).',
      );
    }

    // Validate duplicate & valid page numbers (>= 1)
    const MIME_TO_EXT: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/avif': '.avif',
    };

    const seenPages = new Set<number>();
    for (const p of pages) {
      if (typeof p.pageNumber !== 'number' || !Number.isInteger(p.pageNumber) || p.pageNumber < 1) {
        throw new BadRequestException(
          `Page number không hợp lệ: ${p.pageNumber}. Phải là số nguyên >= 1.`,
        );
      }
      if (seenPages.has(p.pageNumber)) {
        throw new BadRequestException(
          `Duplicate page number trong danh sách source review: ${p.pageNumber}`,
        );
      }
      seenPages.add(p.pageNumber);

      if (!MIME_TO_EXT[p.mimeType]) {
        throw new BadRequestException(
          `MIME type ${p.mimeType} không được hỗ trợ cho source review previews.`,
        );
      }
    }

    // Core độc quyền sinh canonical keys & cấp Presigned PUT URLs
    const presignedSourcePages = [];
    for (const p of pages) {
      const canonicalExt = MIME_TO_EXT[p.mimeType];
      const storageKey = `ai/jobs/${id}/source-review/attempt-${attemptNumber}/page_${p.pageNumber}${canonicalExt}`;
      const uploadUrl = await this.storageService.createInternalUploadUrl(
        storageKey,
        p.mimeType,
        true,
        1800,
      );
      presignedSourcePages.push({
        pageNumber: p.pageNumber,
        storageKey,
        uploadUrl,
      });
    }

    return {
      jobId: id,
      attemptNumber,
      sourcePages: presignedSourcePages,
    };
  }

  /**
   * Xuất bản kết quả dịch (Immutable ChapterVersion)
   */
  async applyJob(
    id: string,
    dto: ApplyTranslationJobDto,
    user: any,
    idempotencyKey?: string,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      // 1. Pessimistic lock trên TranslationJob (chống concurrent apply)
      await manager.query(
        `SELECT id FROM translation_jobs WHERE id = $1 FOR UPDATE`,
        [id],
      );

      const job = await manager.findOne(TranslationJob, {
        where: { id },
        relations: [
          'project',
          'project.storyEdition',
          'project.storyEdition.story',
          'sourceVersion',
          'sourceVersion.chapter',
        ],
      });

      if (!job) {
        throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${id}`);
      }

      const storyId = job.project?.storyEdition?.story?.id;
      if (storyId) {
        const access = await this.resolveStoryAccess(storyId, user, manager);
        if (!access.canApply) {
          throw new ForbiddenException({
            code: 'FORBIDDEN',
            message: 'Bạn không có quyền áp dụng bản dịch cho tác phẩm này.',
          });
        }
      }

      // Durable Idempotency: same key must preserve the original apply mode.
      if (
        job.status === TranslationJobStatus.APPLIED &&
        job.targetVersionId &&
        job.applyIdempotencyKey === idempotencyKey
      ) {
        if (job.applyMode !== null && job.applyMode !== dto.mode) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message:
              'Idempotency-Key đã được sử dụng với một apply mode khác.',
          });
        }

        const existingTargetVersion = await manager.findOne(ChapterVersion, {
          where: { id: job.targetVersionId },
        });
        const chapter = await manager.findOne(Chapter, {
          where: { id: job.sourceVersion.chapterId },
        });
        if (!chapter || !existingTargetVersion || !job.targetVersionId) {
          throw new InternalServerErrorException(
            'Dữ liệu Chapter hoặc TargetVersion không tồn tại cho TranslationJob đã áp dụng.',
          );
        }
        return {
          chapterId: chapter.id,
          activeVersionId: chapter.activeVersionId,
          targetVersionId: job.targetVersionId,
          versionNumber: existingTargetVersion.versionNumber,
          versionType: existingTargetVersion.versionType,
          isAlreadyApplied: true,
        };
      }

      // Enforce job.status === READY_FOR_REVIEW
      if (job.status !== TranslationJobStatus.READY_FOR_REVIEW) {
        throw new BadRequestException(
          `Chỉ có thể apply job khi đã hoàn thành ở trạng thái READY_FOR_REVIEW. Trạng thái hiện tại: ${job.status}`,
        );
      }

      // Invariant #156: Review-Revision Freshness Gate (materializedRevision === reviewRevision)
      if (job.materializedRevision !== job.reviewRevision) {
        throw new ConflictException({
          code: 'ARTIFACT_STALE',
          message: 'Bản dịch đã có chỉnh sửa mới chưa được tạo artifact.',
          meta: {
            reviewRevision: job.reviewRevision,
            materializedRevision: job.materializedRevision,
          },
        });
      }

      // Invariant P0: Defense-in-depth gate cho Novel Structural QA (authoritative DB source)
      const storyMediaFormat = job.project?.storyEdition?.story?.mediaFormat;
      const isNovelJob = storyMediaFormat === MediaFormat.NOVEL;

      if (isNovelJob) {
        const manifest = job.resultManifest as NovelResultManifestV1 | null;
        if (
          !manifest ||
          typeof manifest !== 'object' ||
          manifest.mediaFormat !== 'NOVEL'
        ) {
          throw new BadRequestException(
            'Không thể apply Novel translation job: Result manifest không tồn tại hoặc sai mediaFormat.',
          );
        }
        if (!manifest.htmlKey || typeof manifest.htmlKey !== 'string') {
          throw new BadRequestException(
            'Không thể apply Novel translation job: Thiếu htmlKey trong result_manifest.',
          );
        }
        if (
          manifest.qa?.passed !== true ||
          manifest.qa?.fingerprintMatch !== true
        ) {
          throw new BadRequestException(
            'Không thể apply Novel translation job: Kiểm định chất lượng cấu trúc (Structural QA) không đạt yêu cầu (passed=false hoặc fingerprintMatch=false).',
          );
        }
      }

      await manager.query(
        `SELECT id FROM chapters WHERE id = $1 FOR UPDATE`,
        [job.sourceVersion.chapterId],
      );

      const chapter = await manager.findOne(Chapter, {
        where: { id: job.sourceVersion.chapterId },
      });

      if (!chapter) {
        throw new NotFoundException('Không tìm thấy Chapter tương ứng.');
      }

      // 2. Tìm version_number cao nhất hiện tại của Chapter
      const latestVersion = await manager.findOne(ChapterVersion, {
        where: { chapterId: chapter.id },
        order: { versionNumber: 'DESC' },
      });
      const nextVersionNumber = (latestVersion?.versionNumber || 1) + 1;

      // 3. Luôn tạo NEW ChapterVersion (AI_TRANSLATED) - Giữ bản RAW_ORIGINAL bất biến
      const newVersion = manager.create(ChapterVersion, {
        chapterId: chapter.id,
        versionNumber: nextVersionNumber,
        versionType: ChapterVersionType.AI_TRANSLATED,
        language: job.project.targetLanguage,
        sourceVersionId: job.sourceVersionId,
        createdBy: user.id,
        isPublished: true,
      });
      const savedVersion = await manager.save(ChapterVersion, newVersion);

      // 4. Materialize MediaAssets từ result_manifest (Manga Pages hoặc Novel HTML & Assets)
      if (job.resultManifest) {
        const validatedResult = validateTranslationResultManifest(
          job.resultManifest,
          isNovelJob ? 'NOVEL' : 'COMIC',
        );
        if (!validatedResult.valid) {
          throw new BadRequestException({
            code: 'INVALID_TRANSLATION_MANIFEST',
            message: `Persisted result manifest không hợp lệ: ${validatedResult.errors.join('; ')}`,
            errors: validatedResult.errors,
          });
        }

        let cleanBaseKeysToCleanup: string[] = [];
        let shouldCleanupSourceReview = false;
        if (!isNovelJob) {
          const mangaManifest = validatedResult.value as MangaResultManifestV1;
          if (Array.isArray(mangaManifest.pages) && mangaManifest.pages.length > 0) {
            for (const page of mangaManifest.pages) {
              const mediaAsset = manager.create(MediaAsset, {
                versionId: savedVersion.id,
                assetType: MediaAssetType.MANGA_PAGE,
                storageKey: page.previewKey || page.storageKey,
                sortOrder: page.page || 1,
                width: page.width || 1200,
                height: page.height || 1800,
                fileSizeBytes: page.fileSizeBytes.toString(),
              });
              await manager.save(MediaAsset, mediaAsset);
            }
          }
          if (Array.isArray(mangaManifest.cleanBases)) {
            cleanBaseKeysToCleanup = mangaManifest.cleanBases.map(
              (cb) => cb.cleanBaseKey,
            );
          }
          if (mangaManifest.sourceReview) {
            shouldCleanupSourceReview = true;
          }
        } else {
          const novelManifest = validatedResult.value as NovelResultManifestV1;
          if (novelManifest.htmlKey) {
            const htmlAsset = manager.create(MediaAsset, {
              versionId: savedVersion.id,
              assetType: MediaAssetType.NOVEL_HTML,
              storageKey: novelManifest.htmlKey,
              sortOrder: 1,
              width: null,
              height: null,
              fileSizeBytes: novelManifest.htmlFileSizeBytes.toString(),
            });
            await manager.save(MediaAsset, htmlAsset);
          }
          if (Array.isArray(novelManifest.assets)) {
            let sortIdx = 2;
            for (const assetItem of novelManifest.assets) {
              const imgAsset = manager.create(MediaAsset, {
                versionId: savedVersion.id,
                assetType: MediaAssetType.ILLUSTRATION,
                storageKey: assetItem.storageKey,
                sortOrder: sortIdx++,
                width: 1200,
                height: 1800,
                fileSizeBytes: assetItem.fileSizeBytes.toString(),
              });
              await manager.save(MediaAsset, imgAsset);
            }
          }
        }

        // 5. Phân nhánh Apply Mode
        if (dto.mode === ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION) {
          chapter.activeVersionId = savedVersion.id;
          await manager.save(Chapter, chapter);
        }
        // Mode CREATE_ALTERNATE_VERSION -> Giữ nguyên chapter.activeVersionId

        // 6. Cập nhật TranslationJob sang APPLIED với atomic SQL bump
        await manager.query(
          `UPDATE translation_jobs
           SET target_version_id = $2,
               status = 'APPLIED',
               apply_idempotency_key = $3,
               apply_mode = $4,
               completed_at = NOW(),
               workspace_revision = workspace_revision + 1
           WHERE id = $1`,
          [job.id, savedVersion.id, idempotencyKey || null, dto.mode],
        );

        return {
          chapterId: chapter.id,
          activeVersionId: chapter.activeVersionId,
          versionNumber: savedVersion.versionNumber,
          versionType: savedVersion.versionType,
          targetVersionId: savedVersion.id,
          isAlreadyApplied: false,
          cleanBaseKeysToCleanup,
          shouldCleanupSourceReview,
        };
      }

      // Trường hợp không có resultManifest
      if (dto.mode === ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION) {
        chapter.activeVersionId = savedVersion.id;
        await manager.save(Chapter, chapter);
      }

      await manager.query(
        `UPDATE translation_jobs
         SET target_version_id = $2,
             status = 'APPLIED',
             apply_idempotency_key = $3,
             apply_mode = $4,
             completed_at = NOW(),
             workspace_revision = workspace_revision + 1
         WHERE id = $1`,
        [job.id, savedVersion.id, idempotencyKey || null, dto.mode],
      );

      return {
        chapterId: chapter.id,
        activeVersionId: chapter.activeVersionId,
        versionNumber: savedVersion.versionNumber,
        versionType: savedVersion.versionType,
        targetVersionId: savedVersion.id,
        isAlreadyApplied: false,
        cleanBaseKeysToCleanup: [] as string[],
      };
    });

    // 7. Post-commit lifecycle cleanup for clean bases (#162): hoàn toàn ngoài DB transaction
    if (
      result.cleanBaseKeysToCleanup &&
      result.cleanBaseKeysToCleanup.length > 0
    ) {
      for (const key of result.cleanBaseKeysToCleanup) {
        try {
          await this.storageService.deleteInternalObject(key, true);
        } catch (err: any) {
          this.logger.warn(
            `Failed to cleanup clean base object ${key} after apply: ${err.message}`,
          );
        }
      }
    }

    // 8. Post-commit lifecycle cleanup for source review prefix (#159): xóa toàn bộ prefix ai/jobs/{id}/source-review/
    if (result.shouldCleanupSourceReview) {
      try {
        await this.storageService.deleteInternalPrefix(
          `ai/jobs/${id}/source-review/`,
          true,
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to cleanup source review prefix for job ${id} after apply: ${err.message}`,
        );
      }
    }

    const { cleanBaseKeysToCleanup, shouldCleanupSourceReview: _s, ...clientResponse } = result;
    return clientResponse;
  }

  /**
   * Hủy tác vụ dịch (Full Lifecycle: Lock DB, Remove Queue, Abort HTTP)
   */
  async cancelJob(id: string, user: any) {
    let canceledJobId: string;

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT id FROM translation_jobs WHERE id = $1 FOR UPDATE`,
        [id],
      );

      const job = await manager.findOne(TranslationJob, {
        where: { id },
        relations: [
          'project',
          'project.storyEdition',
          'project.storyEdition.story',
        ],
      });

      if (!job) {
        throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${id}`);
      }

      const storyId = job.project?.storyEdition?.story?.id;
      if (storyId) {
        await this.checkStoryPermission(storyId, user, [
          'OWNER',
          'EDITOR',
          'TRANSLATOR',
        ]);
      }

      if (SYSTEM_TERMINAL_STATES.includes(job.status)) {
        throw new BadRequestException(
          `Không thể hủy job đã ở trạng thái kết thúc (${job.status}).`,
        );
      }

      await manager.query(
        `UPDATE translation_jobs
         SET status = 'CANCELED',
             completed_at = NOW(),
             workspace_revision = workspace_revision + 1
         WHERE id = $1`,
        [job.id],
      );
      canceledJobId = job.id;
    });

    // 1. Xóa job khỏi BullMQ Queue nếu đang waiting/delayed
    try {
      const queueJob = await this.translationQueue.getJob(id);
      if (queueJob) {
        const state = await queueJob.getState();
        if (['waiting', 'delayed', 'paused'].includes(state)) {
          await queueJob.remove();
        }
      }
    } catch (qErr: any) {
      this.logger.warn(`Không thể remove BullMQ job ${id}: ${qErr.message}`);
    }

    // 2. Abort attempt đang chạy nếu có (với reason CANCELED để processor không retry)
    this.processor.abortAttempt(id, 'CANCELED');

    // 3. Broadcast WebSocket event
    this.gateway.broadcastJobCanceled(id);

    return {
      id: canceledJobId!,
      status: TranslationJobStatus.CANCELED,
    };
  }

  /**
   * Xử lý Fenced Callback từ Python Worker (Atomic DB Lock & Non-blocking MinIO Verification)
   */
  async handleWorkerEvent(jobId: string, eventDto: WorkerEventCallbackDto) {
    // 1. Kiểm tra stage hợp lệ từ worker
    assertWorkerReportableState(eventDto.stage);

    // Truy vấn metadata Story từ DB để xác định authoritative mediaFormat & source session (#159)
    const jobInfo = await this.jobRepo.findOne({
      where: { id: jobId },
      relations: [
        'project',
        'project.storyEdition',
        'project.storyEdition.story',
        'sourceUploadSession',
      ],
    });

    if (!jobInfo) {
      throw new NotFoundException(
        `Không tìm thấy TranslationJob với ID: ${jobId}`,
      );
    }

    const storyMediaFormat = jobInfo.project?.storyEdition?.story?.mediaFormat;
    const isNovel = storyMediaFormat === MediaFormat.NOVEL;

    // 2. Fail-closed: READY_FOR_REVIEW bắt buộc phải có resultManifest (cho cả Comic lẫn Novel)
    const isReady = eventDto.stage === TranslationJobStatus.READY_FOR_REVIEW;
    if (isReady && eventDto.resultManifest == null) {
      throw new BadRequestException({
        code: 'INVALID_TRANSLATION_MANIFEST',
        message: 'READY_FOR_REVIEW requires resultManifest.',
      });
    }

    const allowedPrefix = `ai/jobs/${jobId}/attempt-${eventDto.attemptNumber}/`;
    if (eventDto.resultManifest) {
      const manifestValidation = validateTranslationResultManifest(
        eventDto.resultManifest,
        isNovel ? 'NOVEL' : 'COMIC',
      );
      if (!manifestValidation.valid) {
        throw new BadRequestException({
          code: 'INVALID_TRANSLATION_MANIFEST',
          message: `Result manifest không hợp lệ cho ${isNovel ? 'NOVEL' : 'COMIC'}: ${manifestValidation.errors.join('; ')}`,
          errors: manifestValidation.errors,
        });
      }
      // Áp dụng canonicalized manifest đã validate chặt chẽ
      eventDto.resultManifest = manifestValidation.value!;

      // Validate prefix jail
      if (!isNovel) {
        const comicManifest = eventDto.resultManifest as MangaResultManifestV1;
        for (const page of comicManifest.pages) {
          const key = page.previewKey || page.storageKey;
          if (key && !key.startsWith(allowedPrefix)) {
            throw new BadRequestException(
              `Storage key trong result_manifest (${key}) không nằm trong prefix được cấp phép: ${allowedPrefix}`,
            );
          }
        }
        if (comicManifest.cleanBases) {
          for (const cb of comicManifest.cleanBases) {
            const expectedKey = `ai/jobs/${jobId}/review-base/attempt-${eventDto.attemptNumber}/page_${cb.page}.webp`;
            if (cb.cleanBaseKey !== expectedKey) {
              throw new BadRequestException(
                `CleanBase storage key trong result_manifest (${cb.cleanBaseKey}) không khớp với canonical path: ${expectedKey}`,
              );
            }
          }
        }
        if (comicManifest.sourceReview?.pages) {
          for (const sp of comicManifest.sourceReview.pages) {
            const expectedPrefix = `ai/jobs/${jobId}/source-review/attempt-${eventDto.attemptNumber}/page_${sp.page}.`;
            const hasValidExt = ['.jpg', '.png', '.webp', '.avif'].some(
              (ext) => sp.storageKey === `${expectedPrefix.slice(0, -1)}${ext}`,
            );
            if (!hasValidExt) {
              throw new BadRequestException(
                `SourceReview storage key trong result_manifest (${sp.storageKey}) không khớp với canonical attempt jail: ${expectedPrefix}{ext}`,
              );
            }
          }
        }
      } else {
        const novelManifest = eventDto.resultManifest as NovelResultManifestV1;
        if (!novelManifest.htmlKey.startsWith(allowedPrefix)) {
          throw new BadRequestException(
            `HTML storage key trong result_manifest (${novelManifest.htmlKey}) không nằm trong prefix được cấp phép: ${allowedPrefix}`,
          );
        }
        if (novelManifest.assets) {
          for (const asset of novelManifest.assets) {
            if (asset.storageKey && !asset.storageKey.startsWith(allowedPrefix)) {
              throw new BadRequestException(
                `Asset storage key trong result_manifest (${asset.storageKey}) không nằm trong prefix được cấp phép: ${allowedPrefix}`,
              );
            }
          }
        }
      }
    }

    // 3. Nếu là READY_FOR_REVIEW -> Xác thực file thật trong MinIO NGOÀI Transaction DB & Enforce Invariants
    if (isReady) {
      if (isNovel) {
        const novelManifest = eventDto.resultManifest as NovelResultManifestV1;

        if (
          novelManifest.qa.passed !== true ||
          novelManifest.qa.fingerprintMatch !== true
        ) {
          throw new BadRequestException(
            'Novel job không thể chuyển sang READY_FOR_REVIEW khi Structural QA không đạt yêu cầu (passed=false hoặc fingerprintMatch=false).',
          );
        }

        if (!eventDto.segments || eventDto.segments.length === 0) {
          throw new BadRequestException({
            code: 'NOVEL_MISSING_SEGMENTS',
            message:
              'Novel job bắt buộc phải có danh sách segments khi ở trạng thái READY_FOR_REVIEW.',
          });
        }
        for (const seg of eventDto.segments) {
          if (
            !seg.blockType ||
            !Object.values(NovelBlockType).includes(seg.blockType)
          ) {
            throw new BadRequestException({
              code: 'NOVEL_SEGMENT_MISSING_BLOCK_TYPE',
              message: `Novel segment (sortOrder: ${seg.sortOrder}) thiếu hoặc có blockType không hợp lệ: ${seg.blockType}. Yêu cầu: HEADING, DIALOGUE, NARRATION, BLOCKQUOTE`,
            });
          }
        }
      } else {
        // COMIC: Tuyệt đối không được chứa blockType
        if (eventDto.segments) {
          for (const seg of eventDto.segments) {
            if (seg.blockType !== undefined && seg.blockType !== null) {
              throw new BadRequestException({
                code: 'COMIC_SEGMENT_UNEXPECTED_BLOCK_TYPE',
                message: `Comic segment (sortOrder: ${seg.sortOrder}) không được phép chứa blockType: ${seg.blockType}`,
              });
            }
          }
        }
      }

      if (isNovel) {
        const novelManifest = eventDto.resultManifest as NovelResultManifestV1;

        // Cross-object count checks
        const eventSegments = eventDto.segments || [];
        if (novelManifest.segmentCount !== eventSegments.length) {
          throw new BadRequestException({
            code: 'MANIFEST_SEGMENT_COUNT_MISMATCH',
            message: `Novel result manifest segmentCount (${novelManifest.segmentCount}) không khớp với số lượng segments nhận được (${eventSegments.length}).`,
          });
        }

        // Unicode code points count parity
        const actualCharCount = eventSegments.reduce(
          (sum, s) => sum + [...(s.translatedText ?? '')].length,
          0,
        );
        if (novelManifest.charCount !== actualCharCount) {
          throw new BadRequestException({
            code: 'MANIFEST_CHAR_COUNT_MISMATCH',
            message: `Novel result manifest charCount (${novelManifest.charCount}) không khớp với tổng số Unicode code points của segments (${actualCharCount}).`,
          });
        }

        const exists = await this.storageService.headInternalObject(
          novelManifest.htmlKey,
          false,
        );
        if (!exists) {
          throw new BadRequestException(
            `ARTIFACT_NOT_FOUND_IN_STORAGE: Novel HTML ${novelManifest.htmlKey} không tồn tại trong MinIO storage.`,
          );
        }

        if (novelManifest.assets) {
          for (const asset of novelManifest.assets) {
            const key = asset.storageKey;
            if (key) {
              const assetExists = await this.storageService.headInternalObject(
                key,
                false,
              );
              if (!assetExists) {
                throw new BadRequestException(
                  `ARTIFACT_NOT_FOUND_IN_STORAGE: Novel asset ${key} không tồn tại trong MinIO storage.`,
                );
              }
            }
          }
        }
      } else {
        const comicManifest = eventDto.resultManifest as MangaResultManifestV1;
        if (!comicManifest.pages || comicManifest.pages.length === 0) {
          throw new BadRequestException(
            'Comic result manifest bắt buộc phải có ít nhất 1 trang khi READY_FOR_REVIEW.',
          );
        }
        for (const page of comicManifest.pages) {
          const key = page.previewKey || page.storageKey;
          if (key) {
            const exists = await this.storageService.headInternalObject(
              key,
              true,
            );
            if (!exists) {
              throw new BadRequestException(
                `ARTIFACT_NOT_FOUND_IN_STORAGE: Manga page ${key} không tồn tại trong MinIO storage.`,
              );
            }
          }
        }

        // Invariant #162: Full clean base coverage & existence in MinIO storage
        if (!comicManifest.cleanBases || comicManifest.cleanBases.length === 0) {
          throw new BadRequestException(
            'Comic result manifest bắt buộc phải có cleanBases khi READY_FOR_REVIEW (#162).',
          );
        }

        if (comicManifest.cleanBases.length !== comicManifest.pages.length) {
          throw new BadRequestException(
            `Số lượng cleanBases (${comicManifest.cleanBases.length}) không khớp với số lượng pages (${comicManifest.pages.length}).`,
          );
        }

        const pageNumbers = new Set(comicManifest.pages.map((p) => p.page));
        const cleanBasePageNumbers = new Set(
          comicManifest.cleanBases.map((cb) => cb.page),
        );
        for (const p of pageNumbers) {
          if (!cleanBasePageNumbers.has(p)) {
            throw new BadRequestException(
              `Thiếu clean base cho trang ${p}. Toàn bộ các trang phải có clean base tương ứng khi READY_FOR_REVIEW.`,
            );
          }
        }

        for (const cb of comicManifest.cleanBases) {
          const stat = await this.storageService.statInternalObject(
            cb.cleanBaseKey,
            true,
          );
          if (
            !stat.exists ||
            stat.contentLength === null ||
            stat.contentLength <= 0
          ) {
            throw new BadRequestException(
              `ARTIFACT_NOT_FOUND_IN_STORAGE: Clean base ${cb.cleanBaseKey} không tồn tại hoặc rỗng trong MinIO storage.`,
            );
          }
          if (stat.contentType !== 'image/webp') {
            throw new BadRequestException(
              `ARTIFACT_INVALID_CONTENT_TYPE: Clean base ${cb.cleanBaseKey} có contentType (${stat.contentType}) không hợp lệ trong MinIO storage. Bắt buộc image/webp.`,
            );
          }
        }

        // Invariant #159: Package-backed Manga source review enforcement & HEAD verification
        const isPackageBackedManga =
          !!jobInfo.sourceUploadSession?.fileType &&
          PACKAGE_MANGA_FILE_TYPES.has(jobInfo.sourceUploadSession.fileType);

        if (isPackageBackedManga) {
          if (
            !comicManifest.sourceReview ||
            !comicManifest.sourceReview.pages ||
            comicManifest.sourceReview.pages.length === 0
          ) {
            throw new BadRequestException(
              'SOURCE_REVIEW_REQUIRED: Manga package-backed job bắt buộc phải có sourceReview khi READY_FOR_REVIEW (#159).',
            );
          }

          if (comicManifest.sourceReview.pages.length !== comicManifest.pages.length) {
            throw new BadRequestException(
              `SOURCE_REVIEW_PAGE_COVERAGE_MISMATCH: Số lượng sourceReview pages (${comicManifest.sourceReview.pages.length}) không khớp với số lượng result pages (${comicManifest.pages.length}).`,
            );
          }

          const resultPageNumbers = new Set(comicManifest.pages.map((p) => p.page));
          const sourceReviewPageNumbers = new Set(
            comicManifest.sourceReview.pages.map((sp) => sp.page),
          );
          for (const p of resultPageNumbers) {
            if (!sourceReviewPageNumbers.has(p)) {
              throw new BadRequestException(
                `SOURCE_REVIEW_PAGE_COVERAGE_MISMATCH: Thiếu source review cho trang ${p}. Toàn bộ các trang phải có source review tương ứng.`,
              );
            }
          }

          const EXT_TO_MIME: Record<string, string> = {
            '.jpg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.avif': 'image/avif',
          };

          for (const sp of comicManifest.sourceReview.pages) {
            const stat = await this.storageService.statInternalObject(
              sp.storageKey,
              true,
            );
            if (
              !stat.exists ||
              stat.contentLength === null ||
              stat.contentLength <= 0
            ) {
              throw new BadRequestException(
                `ARTIFACT_NOT_FOUND_IN_STORAGE: Source review page ${sp.storageKey} không tồn tại hoặc rỗng trong MinIO storage.`,
              );
            }

            const ext = sp.storageKey.substring(sp.storageKey.lastIndexOf('.'));
            const expectedMime = EXT_TO_MIME[ext];
            if (!expectedMime || stat.contentType !== expectedMime) {
              throw new BadRequestException(
                `ARTIFACT_INVALID_CONTENT_TYPE: Source review page ${sp.storageKey} có contentType (${stat.contentType}) không khớp với extension (${expectedMime}) trong MinIO storage.`,
              );
            }
          }
        } else if (comicManifest.sourceReview) {
          throw new BadRequestException(
            'UNEXPECTED_SOURCE_REVIEW_FOR_NON_PACKAGE: Source review chỉ được hỗ trợ cho Manga package-backed jobs (#159).',
          );
        }
      }
    }

    // 4. Mở DB Transaction có pessimistic write lock bảo vệ fencing
    const result = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT id FROM translation_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );

      const job = await manager.findOne(TranslationJob, {
        where: { id: jobId },
      });

      if (!job) {
        throw new NotFoundException(
          `Không tìm thấy TranslationJob với ID: ${jobId}`,
        );
      }

      // Fencing: Bỏ qua nếu job đã terminal
      if (SYSTEM_TERMINAL_STATES.includes(job.status)) {
        return { received: true, ignored: true, reason: 'JOB_ALREADY_TERMINAL' };
      }

      // Fencing: Bỏ qua nếu callback từ attempt cũ
      if (eventDto.attemptNumber !== job.attemptCount) {
        return { received: true, ignored: true, reason: 'STALE_ATTEMPT' };
      }

      // Fencing: Bỏ qua nếu sequence bị out-of-order
      if (eventDto.sequence <= job.lastSequence) {
        return {
          received: true,
          ignored: true,
          reason: 'OUT_OF_ORDER_SEQUENCE',
        };
      }

      // State Machine Transition Check
      assertTransitionAllowed(job.status, eventDto.stage);

      // Invariant P0: Intermediate callbacks tuyệt đối không được gửi segments
      if (
        eventDto.stage !== TranslationJobStatus.READY_FOR_REVIEW &&
        eventDto.segments &&
        eventDto.segments.length > 0
      ) {
        throw new BadRequestException(
          'INTERMEDIATE_SEGMENTS_FORBIDDEN: Chỉ được phép gửi segments tại trạng thái READY_FOR_REVIEW.',
        );
      }

      // Lưu segments atomic & idempotent khi READY_FOR_REVIEW
      if (eventDto.stage === TranslationJobStatus.READY_FOR_REVIEW) {
        // Enforce invariants theo mediaFormat (#160)
        await manager.delete(TranslationSegment, { jobId: job.id });
        if (eventDto.segments && eventDto.segments.length > 0) {
          for (const seg of eventDto.segments) {
            const segmentEntity = manager.create(TranslationSegment, {
              jobId: job.id,
              pageNumber: seg.pageNumber ?? null,
              anchorBlockId: seg.anchorBlockId ?? null,
              sortOrder: seg.sortOrder,
              blockType: seg.blockType ?? null,
              bboxX: seg.bboxX ?? null,
              bboxY: seg.bboxY ?? null,
              bboxW: seg.bboxW ?? null,
              bboxH: seg.bboxH ?? null,
              rawText: seg.rawText,
              translatedText: seg.translatedText ?? null,
              confidence: seg.confidence ?? null,
            });
            await manager.save(TranslationSegment, segmentEntity);
          }
        }
      }

      // Cập nhật state & sequence atomically kèm workspace_revision bump (P1-I: đúng 1 bump cho mọi worker event)
      await manager.query(
        `UPDATE translation_jobs
         SET status = $2,
             progress_percentage = $3,
             last_sequence = $4,
             heartbeat_at = NOW(),
             error_trace = COALESCE($5, error_trace),
             result_manifest = COALESCE($6, result_manifest),
             workspace_revision = workspace_revision + 1
         WHERE id = $1`,
        [
          job.id,
          eventDto.stage,
          eventDto.progress,
          eventDto.sequence,
          eventDto.errorTrace || null,
          eventDto.resultManifest ? JSON.stringify(eventDto.resultManifest) : null,
        ],
      );

      return {
        received: true,
        status: eventDto.stage,
        sequence: eventDto.sequence,
        manifest: eventDto.resultManifest || job.resultManifest,
      };
    });

    if (result.ignored) {
      return result;
    }

    // 5. Phát tán WebSocket sau khi commit thành công
    if (result.status === TranslationJobStatus.READY_FOR_REVIEW) {
      this.gateway.broadcastJobReady(jobId);
    } else {
      this.gateway.broadcastJobProgress(
        jobId,
        result.status,
        eventDto.progress,
        new Date(),
      );
    }

    return {
      received: true,
      status: result.status,
      sequence: result.sequence,
    };
  }

  /**
   * Bắt đầu một BullMQ attempt mới (Anti-resurrection & State guard)
   */
  async startAttempt(jobId: string, attemptNumber: number) {
    // 1. Transaction DB: Khóa hàng, cập nhật PREPROCESSING + bump workspace_revision, commit giải phóng lock
    const frozen = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT id FROM translation_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );

      const job = await manager.findOne(TranslationJob, {
        where: { id: jobId },
        relations: [
          'project',
          'project.storyEdition',
          'project.storyEdition.story',
          'sourceVersion',
          'sourceVersion.chapter',
          'sourceVersion.chapter.storyEdition',
          'sourceVersion.chapter.storyEdition.story',
        ],
      });

      if (!job) return null;

      // Anti-resurrection & Retry transition guard:
      if (
        job.status === TranslationJobStatus.CANCELED ||
        SYSTEM_TERMINAL_STATES.includes(job.status) ||
        job.status === TranslationJobStatus.READY_FOR_REVIEW ||
        !canBeginRetryAttempt(
          job.status,
          job.attemptCount,
          attemptNumber,
          job.maxAttempts,
        )
      ) {
        this.logger.warn(
          `[BullMQ] Bỏ qua startAttempt cho TranslationJob ${job.id} (attempt: ${attemptNumber}, status: ${job.status}, currentAttempt: ${job.attemptCount})`,
        );
        return null;
      }

      if (!job.inputManifest) {
        this.logger.error(
          `[BullMQ] TranslationJob ${job.id} thiếu snapshot input_manifest. Fail-closed.`,
        );
        throw new Error(
          `MISSING_INPUT_MANIFEST: TranslationJob ${job.id} không có snapshot input hợp lệ.`,
        );
      }

      // Atomic SQL Update: Bảo toàn writer semantics (COALESCE started_at, heartbeat_at = NOW())
      await manager.query(
        `UPDATE translation_jobs
         SET status = 'PREPROCESSING',
             attempt_count = $2,
             last_sequence = 0,
             started_at = COALESCE(started_at, NOW()),
             heartbeat_at = NOW(),
             workspace_revision = workspace_revision + 1
         WHERE id = $1`,
        [job.id, attemptNumber],
      );

      const story =
        job.project?.storyEdition?.story ||
        job.sourceVersion?.chapter?.storyEdition?.story;

      let sessionFinalKey: string | null = null;
      let sessionFileType: string | null = null;
      if (job.sourceUploadSessionId) {
        const session = await manager.findOne(UploadSession, {
          where: { id: job.sourceUploadSessionId },
        });
        if (session?.finalKey) {
          sessionFinalKey = session.finalKey;
          sessionFileType = session.fileType;
        }
      }

      return {
        jobId: job.id,
        attemptNumber,
        sessionFinalKey,
        sessionFileType,
        storyMediaFormat: story?.mediaFormat,
        sourceLang: job.inputManifest.sourceLang || job.project.sourceLanguage,
        targetLang: job.inputManifest.targetLang || job.project.targetLanguage,
        inputManifest: job.inputManifest,
      };
    });

    if (!frozen) return null;

    // 2. NGOÀI Transaction DB: Ký Presigned URL (Hướng B: không giữ row-lock DB trong lúc I/O mạng)
    let sourceDownloadUrl = '';
    if (frozen.sessionFinalKey) {
      const isManga =
        frozen.sessionFileType === 'MANGA_PACKAGE' ||
        frozen.sessionFileType === 'MANGA_ZIP_ARCHIVE' ||
        frozen.sessionFileType === 'IMAGE' ||
        frozen.sessionFileType?.startsWith('MANGA') ||
        frozen.storyMediaFormat === 'COMIC';
      sourceDownloadUrl = await this.storageService.createInternalDownloadUrl(
        frozen.sessionFinalKey,
        isManga,
        3600,
      );
    }

    return {
      jobId: frozen.jobId,
      attemptNumber: frozen.attemptNumber,
      sourceDownloadUrl,
      mediaFormat: frozen.storyMediaFormat || 'COMIC',
      sourceLang: frozen.sourceLang,
      targetLang: frozen.targetLang,
      inputManifest: frozen.inputManifest,
    };
  }

  /**
   * Đánh dấu Job thất bại khi hết số lần retry BullMQ
   */
  async handleJobFailure(jobId: string, errorTrace: string) {
    const result = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT id FROM translation_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );

      const job = await manager.findOne(TranslationJob, {
        where: { id: jobId },
      });

      if (!job) {
        return { transitioned: false, jobId };
      }

      // Không đổi sang FAILED nếu job đã READY_FOR_REVIEW hoặc ở các Terminal States (CANCELED, APPLIED, EXPIRED, FAILED)
      const allowedFailureOriginStates = [
        TranslationJobStatus.CREATED,
        TranslationJobStatus.VALIDATING,
        TranslationJobStatus.QUEUED,
        TranslationJobStatus.PREPROCESSING,
        TranslationJobStatus.OCR,
        TranslationJobStatus.TRANSLATING,
        TranslationJobStatus.INPAINTING,
        TranslationJobStatus.TYPESETTING,
        TranslationJobStatus.QUALITY_CHECK,
      ];

      if (!allowedFailureOriginStates.includes(job.status)) {
        this.logger.warn(
          `[BullMQ] Bỏ qua handleJobFailure cho TranslationJob ${job.id}: Job đang ở trạng thái ${job.status}, không thể chuyển sang FAILED.`,
        );
        return { transitioned: false, jobId: job.id };
      }

      await manager.query(
        `UPDATE translation_jobs
         SET status = 'FAILED',
             error_trace = $2,
             completed_at = NOW(),
             workspace_revision = workspace_revision + 1
         WHERE id = $1`,
        [job.id, errorTrace],
      );

      return { transitioned: true, jobId: job.id };
    });

    if (result?.transitioned && result.jobId) {
      this.gateway.broadcastJobFailed(result.jobId);
    }
  }

  /**
   * Quản lý Từ điển thuật ngữ (Glossary)
   */
  async createGlossary(user: any, dto: CreateGlossaryDto) {
    const project = await this.projectRepo.findOne({
      where: { id: dto.projectId },
      relations: ['storyEdition', 'storyEdition.story'],
    });

    if (!project) {
      throw new NotFoundException('Không tìm thấy TranslationProject.');
    }

    const storyId = project.storyEdition?.story?.id;
    if (storyId) {
      await this.checkStoryPermission(storyId, user, [
        'OWNER',
        'EDITOR',
        'TRANSLATOR',
      ]);
    }

    let glossary = await this.glossaryRepo.findOne({
      where: { projectId: dto.projectId, sourceTerm: dto.sourceTerm },
    });

    if (glossary) {
      glossary.targetTerm = dto.targetTerm;
      glossary.category = dto.category || glossary.category;
    } else {
      glossary = this.glossaryRepo.create({
        projectId: dto.projectId,
        sourceTerm: dto.sourceTerm,
        targetTerm: dto.targetTerm,
        category: dto.category || 'CHARACTER_NAME',
      });
    }

    return await this.glossaryRepo.save(glossary);
  }

  async getGlossaries(projectId: string, user: any) {
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
      relations: ['storyEdition', 'storyEdition.story'],
    });

    if (!project) {
      throw new NotFoundException('Không tìm thấy TranslationProject.');
    }

    const storyId = project.storyEdition?.story?.id;
    if (storyId) {
      await this.checkStoryPermission(storyId, user, [
        'OWNER',
        'EDITOR',
        'TRANSLATOR',
      ]);
    }

    return await this.glossaryRepo.find({
      where: { projectId },
      order: { createdAt: 'ASC' },
    });
  }

  private async resolveStoryAccess(
    storyId: string,
    user: any,
    manager?: EntityManager,
  ): Promise<StoryAccessResolution> {
    if (user?.role === 'ADMIN') {
      return { canReview: true, canApply: true, effectiveRole: 'ADMIN' };
    }

    let membership: StoryMember | null = null;
    if (manager && typeof manager.getRepository === 'function') {
      try {
        const repo = manager.getRepository(StoryMember);
        if (repo && typeof repo.findOne === 'function') {
          membership = await repo.findOne({
            where: { storyId, userId: user.id },
          });
        }
      } catch {
        // Fallback below
      }
    }

    if (
      !membership &&
      this.storyMemberRepo &&
      typeof this.storyMemberRepo.findOne === 'function'
    ) {
      membership = await this.storyMemberRepo.findOne({
        where: { storyId, userId: user.id },
      });
    }

    if (
      !membership ||
      !['OWNER', 'EDITOR', 'TRANSLATOR'].includes(membership.role)
    ) {
      throw new ForbiddenException(
        'Bạn không có quyền truy cập tác phẩm này.',
      );
    }

    const canApply = ['OWNER', 'EDITOR'].includes(membership.role);
    return {
      canReview: true,
      canApply,
      effectiveRole: membership.role as StoryMemberRole,
    };
  }

  /**
   * Phân quyền nội bộ Story Member
   */
  private async checkStoryPermission(
    storyId: string,
    user: any,
    requiredRoles: string[],
  ) {
    if (user.role === 'ADMIN') return;

    const membership = await this.storyMemberRepo.findOne({
      where: { storyId, userId: user.id },
    });

    if (!membership || !requiredRoles.includes(membership.role)) {
      throw new ForbiddenException(
        'Bạn không có quyền thực hiện thao tác dịch thuật trên tác phẩm này.',
      );
    }
  }

  /**
   * Yêu cầu tạo artifact (Materialization) có Snapshot bất biến và Coalescing BullMQ
   */
  async requestMaterialization(
    jobId: string,
    user: any,
  ): Promise<MaterializationRequestResponse> {
    // 1. Transaction: Lock job FOR UPDATE & evaluate revision invariants
    const txResult = await this.dataSource.transaction(async (manager) => {
      const job = await manager
        .getRepository(TranslationJob)
        .createQueryBuilder('job')
        .useTransaction(true)
        .setLock('pessimistic_write')
        .innerJoinAndSelect('job.project', 'project')
        .innerJoinAndSelect('project.storyEdition', 'edition')
        .innerJoinAndSelect('edition.story', 'story')
        .where('job.id = :id', { id: jobId })
        .getOne();

      if (!job) {
        throw new NotFoundException('Translation job không tồn tại.');
      }

      const story = job.project?.storyEdition?.story;
      if (!story) {
        throw new NotFoundException('Không tìm thấy thông tin tác phẩm.');
      }

      // Check mutation RBAC (OWNER, EDITOR, TRANSLATOR or ADMIN)
      await this.checkStoryPermission(story.id, user, [
        'OWNER',
        'EDITOR',
        'TRANSLATOR',
      ]);

      if (job.status !== TranslationJobStatus.READY_FOR_REVIEW) {
        throw new ConflictException({
          code: 'NOT_REVIEWABLE',
          message:
            'Chỉ có thể yêu cầu tạo artifact cho job đang ở trạng thái READY_FOR_REVIEW.',
        });
      }

      // Invariant P1: Revision checks
      if (job.materializedRevision === job.reviewRevision) {
        return {
          isAlreadyFresh: true,
          targetRevision: job.reviewRevision,
          mediaFormat: story.mediaFormat,
          segments: [],
        };
      }

      if (job.materializedRevision > job.reviewRevision) {
        throw new ConflictException({
          code: 'REVISION_INVARIANT_VIOLATION',
          message:
            'Lỗi bất biến phiên bản: materializedRevision không thể lớn hơn reviewRevision.',
          meta: {
            reviewRevision: job.reviewRevision,
            materializedRevision: job.materializedRevision,
          },
        });
      }

      const targetRev = job.reviewRevision;
      const mediaFormat = story.mediaFormat;

      // Deterministic segment projection: ORDER BY sort_order ASC, id ASC
      const segments = await manager
        .getRepository(TranslationSegment)
        .createQueryBuilder('segment')
        .where('segment.jobId = :jobId', { jobId })
        .orderBy('segment.sortOrder', 'ASC')
        .addOrderBy('segment.id', 'ASC')
        .getMany();

      return {
        isAlreadyFresh: false,
        targetRevision: targetRev,
        mediaFormat,
        segments,
      };
    });

    if (txResult.isAlreadyFresh) {
      return {
        status: 'ALREADY_FRESH' as const,
        targetRevision: txResult.targetRevision,
      };
    }

    const { targetRevision, mediaFormat, segments } = txResult;
    const isNovel = mediaFormat === MediaFormat.NOVEL;

    // 2. Map segments to TranslationSegmentSnapshotV1
    const snapshotSegments: TranslationSegmentSnapshotV1[] = segments.map(
      (s) => ({
        id: s.id,
        version: s.version,
        pageNumber: s.pageNumber,
        bboxX: s.bboxX !== null && s.bboxX !== undefined ? Number(s.bboxX) : null,
        bboxY: s.bboxY !== null && s.bboxY !== undefined ? Number(s.bboxY) : null,
        bboxW: s.bboxW !== null && s.bboxW !== undefined ? Number(s.bboxW) : null,
        bboxH: s.bboxH !== null && s.bboxH !== undefined ? Number(s.bboxH) : null,
        anchorBlockId: s.anchorBlockId,
        sortOrder: s.sortOrder,
        rawText: s.rawText,
        translatedText: s.translatedText || '',
        blockType: s.blockType,
      }),
    );

    const snapshot: MaterializationSnapshotV1 = {
      version: 1,
      jobId,
      targetRevision,
      mediaFormat: isNovel ? 'NOVEL' : 'COMIC',
      segments: snapshotSegments,
    };

    const snapshotValidation = validateMaterializationSnapshotV1(snapshot);
    if (!snapshotValidation.valid) {
      throw new BadRequestException(
        `Materialization snapshot không hợp lệ: ${snapshotValidation.errors.join('; ')}`,
      );
    }

    // 3. Serialize & SHA256 content-addressing (P0 fix)
    const snapshotJson = JSON.stringify(snapshot);
    const buffer = Buffer.from(snapshotJson, 'utf-8');
    const snapshotSha256 = crypto
      .createHash('sha256')
      .update(buffer)
      .digest('hex');
    const snapshotKey = `ai/jobs/${jobId}/materializations/rev-${targetRevision}/snapshots/${snapshotSha256}.json`;

    await this.storageService.uploadInternalBuffer(
      snapshotKey,
      buffer,
      'application/json',
      !isNovel,
    );

    // 4. BullMQ Native Retry Lifecycle
    const bullJobId = `materialize-${jobId}-${targetRevision}`;
    const outputPrefix = `ai/jobs/${jobId}/materializations/rev-${targetRevision}/`;
    const jobData: MaterializationJobData = {
      jobId,
      targetRevision,
      mediaFormat: isNovel ? 'NOVEL' : 'COMIC',
      snapshotKey,
      snapshotSha256,
      outputPrefix,
    };

    const existingJob = await this.materializationQueue.getJob(bullJobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return {
          status: 'ALREADY_ENQUEUED' as const,
          targetRevision,
        };
      }
      if (state === 'failed') {
        await existingJob.retry('failed', { resetAttemptsMade: true });
        return {
          status: 'ENQUEUED' as const,
          targetRevision,
        };
      }
      if (state === 'completed') {
        await existingJob.retry('completed', { resetAttemptsMade: true });
        return {
          status: 'ENQUEUED' as const,
          targetRevision,
        };
      }
    }

    await this.materializationQueue.add('materialize', jobData, {
      jobId: bullJobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 604800, count: 5000 },
    });

    return {
      status: 'ENQUEUED' as const,
      targetRevision,
    };
  }

  /**
   * Fenced Completion Callback cho Materialization với Exact Size Verification & Idempotency
   */
  async completeMaterialization(jobId: string, dto: CompleteMaterializationDto) {
    // 1. Read-Only DB Preflight (KHÔNG LOCK)
    const jobPreflight = await this.jobRepo
      .createQueryBuilder('job')
      .innerJoinAndSelect('job.project', 'project')
      .innerJoinAndSelect('project.storyEdition', 'edition')
      .innerJoinAndSelect('edition.story', 'story')
      .where('job.id = :id', { id: jobId })
      .getOne();

    if (!jobPreflight) {
      throw new NotFoundException('Translation job không tồn tại.');
    }

    const storyMediaFormat = jobPreflight.project?.storyEdition?.story?.mediaFormat;
    const isNovel = storyMediaFormat === MediaFormat.NOVEL;
    if (dto.mediaFormat !== storyMediaFormat) {
      throw new BadRequestException(
        `MEDIA_FORMAT_MISMATCH: Callback mediaFormat '${dto.mediaFormat}' không khớp với tác phẩm '${storyMediaFormat}'.`,
      );
    }

    // 2. Validate Candidate Payload (Pure schema validation without storage calls)
    let validatedComicResult: ComicMaterializationResultV1 | null = null;
    let validatedNovelResult: NovelMaterializationResultV1 | null = null;

    if (!isNovel) {
      const comicVal = validateComicMaterializationResultV1(dto.result);
      if (!comicVal.valid) {
        throw new BadRequestException(
          `Comic materialization result không hợp lệ: ${comicVal.errors.join('; ')}`,
        );
      }
      validatedComicResult = comicVal.value!;
    } else {
      const novelVal = validateNovelMaterializationResultV1(dto.result);
      if (!novelVal.valid) {
        throw new BadRequestException(
          `Novel materialization result không hợp lệ: ${novelVal.errors.join('; ')}`,
        );
      }
      validatedNovelResult = novelVal.value!;
    }

    const candidateResult = isNovel ? validatedNovelResult! : validatedComicResult!;

    // 3. Preflight Idempotency Check FIRST (NO MinIO HEAD calls!)
    // If targetRevision === materializedRevision: check result equality
    // - If identical: return ALREADY_APPLIED (200), even after Job status is APPLIED
    // - If different: throw MATERIALIZATION_RESULT_CONFLICT (409)
    if (dto.targetRevision === jobPreflight.materializedRevision) {
      const isIdentical = isMaterializationResultEqual(
        jobPreflight.resultManifest as TranslationResultManifestV1 | null,
        candidateResult,
        storyMediaFormat,
      );
      if (isIdentical) {
        return {
          outcome: 'ALREADY_APPLIED' as const,
          targetRevision: dto.targetRevision,
          materializedRevision: jobPreflight.materializedRevision,
        };
      }
      throw new ConflictException({
        code: 'MATERIALIZATION_RESULT_CONFLICT',
        message:
          'Target revision is already materialized with different output artifacts.',
      });
    }

    // 4. Preflight Stale Check AFTER Idempotency (NO MinIO HEAD calls!)
    // If targetRevision < materializedRevision OR targetRevision !== reviewRevision OR status !== READY_FOR_REVIEW
    if (
      jobPreflight.status !== TranslationJobStatus.READY_FOR_REVIEW ||
      dto.targetRevision !== jobPreflight.reviewRevision ||
      dto.targetRevision < jobPreflight.materializedRevision
    ) {
      return {
        outcome: 'STALE_DISCARDED' as const,
        targetRevision: dto.targetRevision,
        currentReviewRevision: jobPreflight.reviewRevision,
        materializedRevision: jobPreflight.materializedRevision,
      };
    }

    // 5. For Candidates for APPLIED: Prefix-Jail & Exact Size Verification
    const expectedPrefix = `ai/jobs/${jobId}/materializations/rev-${dto.targetRevision}/`;

    if (!isNovel) {
      // Exact Canonical Jail & Preview Identity Check (#157)
      for (const p of validatedComicResult!.pages) {
        const expectedKey = `${expectedPrefix}page_${p.page}.webp`;
        if (p.storageKey !== expectedKey) {
          throw new BadRequestException(
            `PREFIX_JAIL_VIOLATION: storageKey '${p.storageKey}' không khớp exact canonical key '${expectedKey}'.`,
          );
        }
        if (p.previewKey !== p.storageKey) {
          throw new BadRequestException(
            `PREFIX_JAIL_VIOLATION: previewKey '${p.previewKey}' phải giống hệt storageKey.`,
          );
        }
      }

      // Pre-transaction HEAD & Exact Size & MIME Verification (#157)
      for (const p of validatedComicResult!.pages) {
        const stat = await this.storageService.statInternalObject(p.storageKey, true);
        if (!stat.exists) {
          throw new BadRequestException(
            `ARTIFACT_NOT_FOUND_IN_STORAGE: Manga page ${p.storageKey} không tồn tại trong MinIO storage.`,
          );
        }
        if (stat.contentType !== 'image/webp') {
          throw new BadRequestException({
            code: 'ARTIFACT_INVALID_CONTENT_TYPE',
            message: `Manga page ${p.storageKey} có contentType (${stat.contentType}) không hợp lệ. Bắt buộc image/webp.`,
          });
        }
        if (stat.contentLength !== p.fileSizeBytes) {
          throw new BadRequestException({
            code: 'ARTIFACT_SIZE_MISMATCH',
            message: `ARTIFACT_SIZE_MISMATCH: Page ${p.page} storageKey contentLength (${stat.contentLength}) không khớp với khai báo fileSizeBytes (${p.fileSizeBytes}).`,
          });
        }
      }
    } else {
      // Prefix-jail
      if (!validatedNovelResult!.htmlKey.startsWith(expectedPrefix)) {
        throw new BadRequestException(
          `PREFIX_JAIL_VIOLATION: htmlKey '${validatedNovelResult!.htmlKey}' không nằm trong prefix '${expectedPrefix}'.`,
        );
      }

      // Pre-transaction HEAD & Exact Size Verification
      const stat = await this.storageService.statInternalObject(validatedNovelResult!.htmlKey, false);
      if (!stat.exists) {
        throw new BadRequestException(
          `ARTIFACT_NOT_FOUND_IN_STORAGE: Novel HTML artifact ${validatedNovelResult!.htmlKey} không tồn tại trong MinIO storage.`,
        );
      }
      if (stat.contentLength !== validatedNovelResult!.htmlFileSizeBytes) {
        throw new BadRequestException({
          code: 'ARTIFACT_SIZE_MISMATCH',
          message: `ARTIFACT_SIZE_MISMATCH: Novel htmlKey contentLength (${stat.contentLength}) không khớp với khai báo htmlFileSizeBytes (${validatedNovelResult!.htmlFileSizeBytes}).`,
        });
      }
    }

    // 6. DB Transaction (FOR UPDATE trên cùng connection/manager)
    return await this.dataSource.transaction(async (manager) => {
      const job = await manager
        .getRepository(TranslationJob)
        .createQueryBuilder('job')
        .useTransaction(true)
        .setLock('pessimistic_write')
        .where('job.id = :id', { id: jobId })
        .getOne();

      if (!job) {
        throw new NotFoundException('Translation job không tồn tại.');
      }

      // Re-verify Idempotency FIRST under lock with canonical result equality!
      if (dto.targetRevision === job.materializedRevision) {
        const isIdentical = isMaterializationResultEqual(
          job.resultManifest as TranslationResultManifestV1 | null,
          candidateResult,
          storyMediaFormat,
        );
        if (isIdentical) {
          return {
            outcome: 'ALREADY_APPLIED' as const,
            targetRevision: dto.targetRevision,
            materializedRevision: job.materializedRevision,
          };
        }
        throw new ConflictException({
          code: 'MATERIALIZATION_RESULT_CONFLICT',
          message:
            'Target revision is already materialized with different output artifacts.',
        });
      }

      // Re-verify Stale status AFTER Idempotency under lock!
      if (
        job.status !== TranslationJobStatus.READY_FOR_REVIEW ||
        dto.targetRevision !== job.reviewRevision ||
        dto.targetRevision < job.materializedRevision
      ) {
        return {
          outcome: 'STALE_DISCARDED' as const,
          targetRevision: dto.targetRevision,
          currentReviewRevision: job.reviewRevision,
          materializedRevision: job.materializedRevision,
        };
      }

      // Selective Manifest Merge (Strictly typed as TranslationResultManifestV1)
      let mergedManifest: TranslationResultManifestV1;
      if (!isNovel) {
        const currentManifest = job.resultManifest as MangaResultManifestV1 | null;
        mergedManifest = {
          version: 1,
          mediaFormat: 'COMIC',
          pages: validatedComicResult!.pages,
          ...(currentManifest?.cleanBases ? { cleanBases: currentManifest.cleanBases } : {}),
          ...(currentManifest?.sourceReview ? { sourceReview: currentManifest.sourceReview } : {}),
        };
      } else {
        const currentManifest = job.resultManifest as NovelResultManifestV1 | null;
        mergedManifest = {
          version: 1,
          mediaFormat: 'NOVEL',
          htmlKey: validatedNovelResult!.htmlKey,
          htmlFileSizeBytes: validatedNovelResult!.htmlFileSizeBytes,
          segmentCount: validatedNovelResult!.segmentCount,
          charCount: validatedNovelResult!.charCount,
          qa: validatedNovelResult!.qa,
          ...(currentManifest?.title ? { title: currentManifest.title } : {}),
          ...(currentManifest?.language ? { language: currentManifest.language } : {}),
          ...(currentManifest?.assets ? { assets: currentManifest.assets } : {}),
          ...(currentManifest?.metrics ? { metrics: currentManifest.metrics } : {}),
        };
      }

      // Full revalidation of merged manifest
      const fullValidation = validateTranslationResultManifest(
        mergedManifest,
        isNovel ? 'NOVEL' : 'COMIC',
      );
      if (!fullValidation.valid) {
        throw new BadRequestException(
          `Merged result manifest không hợp lệ: ${fullValidation.errors.join('; ')}`,
        );
      }

      // Persist strictly on transaction manager connection (connection X)
      await manager
        .createQueryBuilder()
        .update(TranslationJob)
        .set({
          resultManifest: mergedManifest,
          materializedRevision: dto.targetRevision,
          workspaceRevision: () => 'workspace_revision + 1',
        })
        .where('id = :id', { id: jobId })
        .execute();

      return {
        outcome: 'APPLIED' as const,
        targetRevision: dto.targetRevision,
        materializedRevision: dto.targetRevision,
      };
    });
  }
}
