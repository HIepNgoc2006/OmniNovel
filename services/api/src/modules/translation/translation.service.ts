import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
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
import { TranslationGateway } from './translation.gateway';
import { CreateTranslationJobDto } from './dto/create-translation-job.dto';
import {
  ApplyTranslationJobDto,
  ApplyTranslationMode,
} from './dto/apply-translation-job.dto';
import { CreateGlossaryDto } from './dto/create-glossary.dto';
import { WorkerEventCallbackDto } from './dto/worker-event-callback.dto';

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
    private dataSource: DataSource,
    private gateway: TranslationGateway,
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
        // Concurrency safe: Nếu request song song đã tạo project trước
        project = await this.projectRepo.findOneOrFail({
          where: {
            storyEditionId: edition.id,
            sourceLanguage: dto.sourceLang,
            targetLanguage: dto.targetLang,
          },
        });
      }
    }

    // 6. DB Creation: Tạo TranslationJob ở trạng thái VALIDATING (Dual-write mitigation)
    let job = this.jobRepo.create({
      projectId: project.id,
      sourceVersionId: sourceVersion.id,
      sourceUploadSessionId,
      createdBy: user.id,
      idempotencyKey: idempotencyKey || null,
      status: TranslationJobStatus.VALIDATING,
      provider: dto.provider || 'OPENAI',
      attemptCount: 0,
      lastSequence: 0,
      maxAttempts: 3,
      progressPercentage: 0,
    });

    try {
      job = await this.jobRepo.save(job);
    } catch (err: any) {
      if (
        idempotencyKey &&
        (err.code === '23505' || err.message?.includes('uq_translation_job_user_idemp'))
      ) {
        const existing = await this.jobRepo.findOneOrFail({
          where: { createdBy: user.id, idempotencyKey },
        });
        return { id: existing.id, status: existing.status, isDuplicate: true };
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
      diffPreviewUrls: job.resultManifest?.previewUrls || [],
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

      // 4. Materialize MediaAssets từ result_manifest
      if (job.resultManifest && Array.isArray(job.resultManifest.pages)) {
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
   * Hủy tác vụ dịch
   */
  async cancelJob(id: string, user: any) {
    const job = await this.jobRepo.findOne({
      where: { id },
      relations: ['project', 'project.storyEdition', 'project.storyEdition.story'],
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

    const terminalStatuses = [
      TranslationJobStatus.READY_FOR_REVIEW,
      TranslationJobStatus.APPLIED,
      TranslationJobStatus.FAILED,
      TranslationJobStatus.CANCELED,
      TranslationJobStatus.EXPIRED,
    ];

    if (terminalStatuses.includes(job.status)) {
      throw new BadRequestException(
        `Không thể hủy job đã ở trạng thái kết thúc (${job.status}).`,
      );
    }

    job.status = TranslationJobStatus.CANCELED;
    await this.jobRepo.save(job);

    this.gateway.broadcastJobCanceled(job.id);

    return {
      id: job.id,
      status: TranslationJobStatus.CANCELED,
    };
  }

  /**
   * Xử lý Fenced Callback từ Python Worker
   */
  async handleWorkerEvent(jobId: string, eventDto: WorkerEventCallbackDto) {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException(`Không tìm thấy TranslationJob với ID: ${jobId}`);
    }

    // 1. Fencing: Bỏ qua nếu job đã terminal
    const terminalStatuses = [
      TranslationJobStatus.APPLIED,
      TranslationJobStatus.FAILED,
      TranslationJobStatus.CANCELED,
      TranslationJobStatus.EXPIRED,
    ];
    if (terminalStatuses.includes(job.status)) {
      return { ignored: true, reason: 'JOB_TERMINAL' };
    }

    // 2. Fencing: Bỏ qua nếu callback từ attempt cũ
    if (eventDto.attemptNumber !== job.attemptCount) {
      return { ignored: true, reason: 'STALE_ATTEMPT' };
    }

    // 3. Fencing: Bỏ qua nếu sequence bị out-of-order
    if (eventDto.sequence <= job.lastSequence) {
      return { ignored: true, reason: 'OUT_OF_ORDER_SEQUENCE' };
    }

    // 4. Validate result_manifest storage keys
    if (eventDto.resultManifest?.pages && Array.isArray(eventDto.resultManifest.pages)) {
      const allowedPrefix = `ai/jobs/${jobId}/attempt-${job.attemptCount}/`;
      for (const page of eventDto.resultManifest.pages) {
        const key = page.previewKey || page.storageKey;
        if (key && !key.startsWith(allowedPrefix)) {
          throw new BadRequestException(
            `Storage key trong result_manifest (${key}) không nằm trong prefix được cấp phép: ${allowedPrefix}`,
          );
        }
      }
      job.resultManifest = eventDto.resultManifest;
    }

    // 5. Lưu segments nếu có
    if (eventDto.segments && eventDto.segments.length > 0) {
      for (const seg of eventDto.segments) {
        const segmentEntity = this.segmentRepo.create({
          jobId: job.id,
          pageNumber: seg.pageNumber || null,
          anchorBlockId: seg.anchorBlockId || null,
          sortOrder: seg.sortOrder,
          bboxX: seg.bboxX || null,
          bboxY: seg.bboxY || null,
          bboxW: seg.bboxW || null,
          bboxH: seg.bboxH || null,
          rawText: seg.rawText,
          translatedText: seg.translatedText || null,
          confidence: seg.confidence || 0.95,
        });
        await this.segmentRepo.save(segmentEntity);
      }
    }

    // 6. Cập nhật state & sequence
    job.status = eventDto.stage;
    job.progressPercentage = eventDto.progress;
    job.lastSequence = eventDto.sequence;
    job.heartbeatAt = new Date();

    if (eventDto.errorTrace) {
      job.errorTrace = eventDto.errorTrace;
    }

    await this.jobRepo.save(job);

    // 7. Phát tán WebSocket
    if (job.status === TranslationJobStatus.READY_FOR_REVIEW) {
      this.gateway.broadcastJobReady(job.id, {
        resultManifest: job.resultManifest,
      });
    } else {
      this.gateway.broadcastJobProgress(job.id, {
        stage: job.status,
        progress: job.progressPercentage,
        heartbeatAt: job.heartbeatAt,
      });
    }

    return {
      success: true,
      status: job.status,
      sequence: job.lastSequence,
    };
  }

  /**
   * Bắt đầu một BullMQ attempt mới (Reset last_sequence = 0)
   */
  async startAttempt(jobId: string, attemptNumber: number) {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) return;

    job.attemptCount = attemptNumber;
    job.lastSequence = 0; // Reset sequence mỗi attempt mới
    job.status = TranslationJobStatus.PREPROCESSING;
    job.startedAt = new Date();
    job.heartbeatAt = new Date();
    await this.jobRepo.save(job);
  }

  /**
   * Đánh dấu Job thất bại khi hết số lần retry BullMQ
   */
  async handleJobFailure(jobId: string, errorTrace: string) {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) return;

    job.status = TranslationJobStatus.FAILED;
    job.errorTrace = errorTrace;
    job.completedAt = new Date();
    await this.jobRepo.save(job);

    this.gateway.broadcastJobFailed(job.id, { errorTrace });
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
   * Helper kiểm tra Story Member RBAC
   */
  private async checkStoryPermission(
    storyId: string,
    user: any,
    allowedRoles: string[],
  ) {
    if (user.globalRole === 'ADMIN' || user.role === 'ADMIN') {
      return true;
    }

    const member = await this.storyMemberRepo.findOne({
      where: { storyId, userId: user.id },
    });

    if (!member || !allowedRoles.includes(member.role)) {
      throw new ForbiddenException(
        'Bạn không có quyền thực hiện thao tác này trên truyện được yêu cầu.',
      );
    }

    return true;
  }
}
