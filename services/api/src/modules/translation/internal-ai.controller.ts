import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { InternalServiceKeyGuard } from '../../common/guards/internal-service-key.guard';
import { TranslationService } from './translation.service';
import { WorkerEventCallbackDto } from './dto/worker-event-callback.dto';
import { RequestOutputUploadsDto } from './dto/request-output-uploads.dto';
import { RequestCleanBaseUploadsDto } from './dto/request-clean-base-uploads.dto';
import { RequestSourceReviewSlotsDto } from './dto/request-source-review-slots.dto';
import { CompleteMaterializationDto } from './dto/complete-materialization.dto';
import { RequestStructureSnapshotUploadDto } from './dto/request-structure-snapshot-upload.dto';
import { ParseUUIDPipe } from '@nestjs/common';

@Controller('internal/v1/ai')
@UseGuards(InternalServiceKeyGuard)
export class InternalAiController {
  constructor(private readonly translationService: TranslationService) {}

  @Post('jobs/:id/events')
  @HttpCode(HttpStatus.OK)
  async handleWorkerEvent(
    @Param('id') id: string,
    @Body() dto: WorkerEventCallbackDto,
  ) {
    return await this.translationService.handleWorkerEvent(id, dto);
  }

  @Post('jobs/:id/output-uploads')
  @HttpCode(HttpStatus.OK)
  async createOutputUploadUrls(
    @Param('id') id: string,
    @Body() dto: RequestOutputUploadsDto,
  ) {
    return await this.translationService.createOutputUploadUrls(
      id,
      dto.attemptNumber,
      dto.files,
    );
  }

  @Post('jobs/:id/clean-base-uploads')
  @HttpCode(HttpStatus.OK)
  async createCleanBaseUploadUrls(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RequestCleanBaseUploadsDto,
  ) {
    return await this.translationService.createCleanBaseUploadUrls(
      id,
      dto.attemptNumber,
      dto.pages,
    );
  }

  @Post('jobs/:id/source-review-slots')
  @HttpCode(HttpStatus.OK)
  async createSourceReviewUploadUrls(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RequestSourceReviewSlotsDto,
  ) {
    return await this.translationService.createSourceReviewUploadUrls(
      id,
      dto.attemptNumber,
      dto.pages,
    );
  }

  @Post('jobs/:id/materializations/complete')
  @HttpCode(HttpStatus.OK)
  async completeMaterialization(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CompleteMaterializationDto,
  ) {
    return await this.translationService.completeMaterialization(id, dto);
  }

  @Post('jobs/:id/structure-snapshot-upload')
  @HttpCode(HttpStatus.OK)
  async createStructureSnapshotUploadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RequestStructureSnapshotUploadDto,
  ) {
    return await this.translationService.createStructureSnapshotUploadUrl(
      id,
      dto.attemptNumber,
      dto.sha256,
    );
  }
}

