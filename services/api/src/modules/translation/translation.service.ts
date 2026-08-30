import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TranslationJobStatus,
  ChapterVersionType,
  MediaAssetType,
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
import {
  ApplyTranslationJobDto,
  ApplyTranslationMode,
} from './dto/apply-translation-job.dto';
import { CreateGlossaryDto } from './dto/create-glossary.dto';
import { WorkerEventCallbackDto } from './dto/worker-event-callback.dto';
import {
  assertWorkerReportableState,
  assertTransitionAllowed,
  canBeginRetryAttempt,
  SYSTEM_TERMINAL_STATES,
  WORKER_REPORTABLE_ACTIVE_STATES,
} from './translation-state-machine';

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

    const inputManifest = {
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

      // Enqueue thành công -> Cập nhật DB sang QUEUED
      job.status = TranslationJobStatus.QUEUED;
      await this.jobRepo.save(job);
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
   * Truy vấn chi tiết Job
   */
  async getJob(id: string, user: any) {
    const job = await this.jobRepo.findOne({
      where: { id },
      relations: [
        'project',
        'project.storyEdition',
        'project.storyEdition.story',
        'sourceVersion',
        'targetVersion',
        'segments',
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

    // Generate Presigned GET URLs cho diff previews (thời hạn 15 phút)
    const diffPreviewUrls: string[] = [];
    if (job.resultManifest?.pages && Array.isArray(job.resultManifest.pages)) {
      for (const page of job.resultManifest.pages) {
        const key = page.previewKey || page.storageKey;
        if (key) {
          try {
            const url = await this.storageService.createInternalDownloadUrl(
              key,
              true,
              900,
            );
            diffPreviewUrls.push(url);
          } catch {}
        }
      }
    }

    return {
      job: {
        id: job.id,
        projectId: job.projectId,
        sourceVersionId: job.sourceVersionId,
        targetVersionId: job.targetVersionId,
        sourceUploadSessionId: job.sourceUploadSessionId,
        status: job.status,
        progressPercentage: job.progressPercentage,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        provider: job.provider,
        modelName: job.modelName,
        promptVersion: job.promptVersion,
        errorTrace: job.errorTrace,
        startedAt: job.startedAt,
        heartbeatAt: job.heartbeatAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
      },
      segments: job.segments || [],
      diffPreviewUrls,
    };
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
   * Xuất bản kết quả dịch (Immutable ChapterVersion)
   */
  async applyJob(
    id: string,
    dto: ApplyTranslationJobDto,
    user: any,
    idempotencyKey?: string,
  ) {
    return await this.dataSource.transaction(async (manager) => {
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
        // Chỉ Story Owner, Editor hoặc Admin mới được apply
        await this.checkStoryPermission(storyId, user, ['OWNER', 'EDITOR']);
      }

      // Durable Idempotency: Nếu đã apply cùng key hoặc đã APPLIED
      if (
        job.status === TranslationJobStatus.APPLIED &&
        job.targetVersionId &&
        (job.applyIdempotencyKey === idempotencyKey || !idempotencyKey)
      ) {
        const existingTargetVersion = await manager.findOne(ChapterVersion, {
          where: { id: job.targetVersionId },
        });
        const chapter = await manager.findOne(Chapter, {
          where: { id: job.sourceVersion.chapterId },
        });
        return {
          chapterId: chapter?.id,
          activeVersionId: chapter?.activeVersionId,
          versionNumber: existingTargetVersion?.versionNumber,
          versionType: existingTargetVersion?.versionType,
          isAlreadyApplied: true,
        };
      }

      // Enforce job.status === READY_FOR_REVIEW
      if (job.status !== TranslationJobStatus.READY_FOR_REVIEW) {
        throw new BadRequestException(
          `Chỉ có thể apply job khi đã hoàn thành ở trạng thái READY_FOR_REVIEW. Trạng thái hiện tại: ${job.status}`,
        );
      }

      // Invariant P0: Defense-in-depth gate cho Novel Structural QA
      if (job.resultManifest?.mediaFormat === 'NOVEL') {
        if (
          job.resultManifest?.qa?.passed !== true ||
          job.resultManifest?.qa?.fingerprintMatch !== true
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
        if (Array.isArray(job.resultManifest.pages) && job.resultManifest.pages.length > 0) {
          for (const page of job.resultManifest.pages) {
            const mediaAsset = manager.create(MediaAsset, {
              versionId: savedVersion.id,
              assetType: MediaAssetType.MANGA_PAGE,
              storageKey: page.previewKey || page.storageKey,
              sortOrder: page.page || 1,
              width: page.width || 1200,
              height: page.height || 1800,
              fileSizeBytes: (page.fileSize || 102400).toString(),
            });
            await manager.save(MediaAsset, mediaAsset);
          }
        } else if (job.resultManifest.htmlKey || job.resultManifest.mediaFormat === 'NOVEL') {
          if (job.resultManifest.htmlKey) {
            const htmlAsset = manager.create(MediaAsset, {
              versionId: savedVersion.id,
              assetType: MediaAssetType.NOVEL_HTML,
              storageKey: job.resultManifest.htmlKey,
              sortOrder: 1,
              width: null,
              height: null,
              fileSizeBytes: (job.resultManifest.fileSize || 20480).toString(),
            });
            await manager.save(MediaAsset, htmlAsset);
          }
          if (Array.isArray(job.resultManifest.assets)) {
            let sortIdx = 2;
            for (const assetItem of job.resultManifest.assets) {
              const imgAsset = manager.create(MediaAsset, {
                versionId: savedVersion.id,
                assetType: MediaAssetType.ILLUSTRATION,
                storageKey: assetItem.storageKey,
                sortOrder: sortIdx++,
                width: 1200,
                height: 1800,
                fileSizeBytes: (assetItem.fileSize || 51200).toString(),
              });
              await manager.save(MediaAsset, imgAsset);
            }
          }
        }
      }

      // 5. Phân nhánh Apply Mode
      if (dto.mode === ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION) {
        chapter.activeVersionId = savedVersion.id;
        await manager.save(Chapter, chapter);
      }
      // Mode CREATE_ALTERNATE_VERSION -> Giữ nguyên chapter.activeVersionId

      // 6. Cập nhật TranslationJob sang APPLIED
      job.targetVersionId = savedVersion.id;
      job.status = TranslationJobStatus.APPLIED;
      job.applyIdempotencyKey = idempotencyKey || null;
      job.completedAt = new Date();
      await manager.save(TranslationJob, job);

      return {
        chapterId: chapter.id,
        activeVersionId: chapter.activeVersionId,
        versionNumber: savedVersion.versionNumber,
        versionType: savedVersion.versionType,
        isAlreadyApplied: false,
      };
    });
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

      job.status = TranslationJobStatus.CANCELED;
      job.completedAt = new Date();
      await manager.save(TranslationJob, job);
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

    // 2. Validate prefix jail trên result_manifest (Cả Manga và Novel)
    const allowedPrefix = `ai/jobs/${jobId}/attempt-${eventDto.attemptNumber}/`;
    if (eventDto.resultManifest) {
      if (
        eventDto.resultManifest.pages &&
        Array.isArray(eventDto.resultManifest.pages)
      ) {
        for (const page of eventDto.resultManifest.pages) {
          const key = page.previewKey || page.storageKey;
          if (key && !key.startsWith(allowedPrefix)) {
            throw new BadRequestException(
              `Storage key trong result_manifest (${key}) không nằm trong prefix được cấp phép: ${allowedPrefix}`,
            );
          }
        }
      }

      if (eventDto.resultManifest.htmlKey) {
        if (!eventDto.resultManifest.htmlKey.startsWith(allowedPrefix)) {
          throw new BadRequestException(
            `HTML storage key trong result_manifest (${eventDto.resultManifest.htmlKey}) không nằm trong prefix được cấp phép: ${allowedPrefix}`,
          );
        }
      }

      if (
        eventDto.resultManifest.assets &&
        Array.isArray(eventDto.resultManifest.assets)
      ) {
        for (const asset of eventDto.resultManifest.assets) {
          const key = asset.storageKey;
          if (key && !key.startsWith(allowedPrefix)) {
            throw new BadRequestException(
              `Asset storage key trong result_manifest (${key}) không nằm trong prefix được cấp phép: ${allowedPrefix}`,
            );
          }
        }
      }
    }

    // 3. Nếu là READY_FOR_REVIEW -> Xác thực file thật trong MinIO NGOÀI Transaction DB
    if (eventDto.stage === TranslationJobStatus.READY_FOR_REVIEW) {
      if (eventDto.resultManifest) {
        // Manga pages verification (Manga Bucket)
        if (
          eventDto.resultManifest.pages &&
          Array.isArray(eventDto.resultManifest.pages) &&
          eventDto.resultManifest.pages.length > 0
        ) {
          for (const page of eventDto.resultManifest.pages) {
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
        }

        // Novel HTML verification (Novel Bucket)
        if (eventDto.resultManifest.htmlKey) {
          const exists = await this.storageService.headInternalObject(
            eventDto.resultManifest.htmlKey,
            false,
          );
          if (!exists) {
            throw new BadRequestException(
              `ARTIFACT_NOT_FOUND_IN_STORAGE: Novel HTML ${eventDto.resultManifest.htmlKey} không tồn tại trong MinIO storage.`,
            );
          }
        }

        // Novel Assets verification (Novel Bucket)
        if (
          eventDto.resultManifest.assets &&
          Array.isArray(eventDto.resultManifest.assets)
        ) {
          for (const asset of eventDto.resultManifest.assets) {
            const key = asset.storageKey;
            if (key) {
              const exists = await this.storageService.headInternalObject(
                key,
                false,
              );
              if (!exists) {
                throw new BadRequestException(
                  `ARTIFACT_NOT_FOUND_IN_STORAGE: Novel asset ${key} không tồn tại trong MinIO storage.`,
                );
              }
            }
          }
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
        await manager.delete(TranslationSegment, { jobId: job.id });
        if (eventDto.segments && eventDto.segments.length > 0) {
          for (const seg of eventDto.segments) {
            const segmentEntity = manager.create(TranslationSegment, {
              jobId: job.id,
              pageNumber: seg.pageNumber ?? null,
              anchorBlockId: seg.anchorBlockId ?? null,
              sortOrder: seg.sortOrder,
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

      // Cập nhật state & sequence atomically
      job.status = eventDto.stage;
      job.progressPercentage = eventDto.progress;
      job.lastSequence = eventDto.sequence;
      job.heartbeatAt = new Date();

      if (eventDto.errorTrace) {
        job.errorTrace = eventDto.errorTrace;
      }
      if (eventDto.resultManifest) {
        job.resultManifest = eventDto.resultManifest;
      }

      await manager.save(TranslationJob, job);

      return {
        received: true,
        status: job.status,
        sequence: job.lastSequence,
        manifest: job.resultManifest,
      };
    });

    if (result.ignored) {
      return result;
    }

    // 5. Phát tán WebSocket sau khi commit thành công
    if (result.status === TranslationJobStatus.READY_FOR_REVIEW) {
      this.gateway.broadcastJobReady(jobId, {
        resultManifest: result.manifest,
      });
    } else {
      this.gateway.broadcastJobProgress(jobId, {
        stage: result.status,
        progress: eventDto.progress,
        heartbeatAt: new Date(),
      });
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
    return await this.dataSource.transaction(async (manager) => {
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

      job.attemptCount = attemptNumber;
      job.lastSequence = 0; // Reset sequence mỗi attempt mới
      job.status = TranslationJobStatus.PREPROCESSING;
      job.startedAt = job.startedAt || new Date();
      job.heartbeatAt = new Date();
      await manager.save(TranslationJob, job);

      const story =
        job.project?.storyEdition?.story ||
        job.sourceVersion?.chapter?.storyEdition?.story;

      let sourceDownloadUrl = '';
      if (job.sourceUploadSessionId) {
        const session = await manager.findOne(UploadSession, {
          where: { id: job.sourceUploadSessionId },
        });
        if (session?.finalKey) {
          const isManga =
            session.fileType === 'MANGA_PACKAGE' ||
            session.fileType === 'MANGA_ZIP_ARCHIVE' ||
            session.fileType === 'IMAGE' ||
            session.fileType?.startsWith('MANGA') ||
            story?.mediaFormat === 'COMIC';
          sourceDownloadUrl =
            await this.storageService.createInternalDownloadUrl(
              session.finalKey,
              isManga,
              3600,
            );
        }
      }

      return {
        jobId: job.id,
        attemptNumber: job.attemptCount,
        sourceDownloadUrl,
        mediaFormat: story?.mediaFormat || 'COMIC',
        sourceLang: job.inputManifest.sourceLang || job.project.sourceLanguage,
        targetLang: job.inputManifest.targetLang || job.project.targetLanguage,
        inputManifest: job.inputManifest,
      };
    });
  }

  /**
   * Đánh dấu Job thất bại khi hết số lần retry BullMQ
   */
  async handleJobFailure(jobId: string, errorTrace: string) {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT id FROM translation_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );

      const job = await manager.findOne(TranslationJob, {
        where: { id: jobId },
      });

      if (!job) return;

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
        return;
      }

      job.status = TranslationJobStatus.FAILED;
      job.errorTrace = errorTrace;
      job.completedAt = new Date();
      await manager.save(TranslationJob, job);

      this.gateway.broadcastJobFailed(job.id, { errorTrace });
    });
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
}
