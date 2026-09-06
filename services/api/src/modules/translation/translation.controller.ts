import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Headers,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TranslationService } from './translation.service';
import { CreateTranslationJobDto } from './dto/create-translation-job.dto';
import { ApplyTranslationJobDto } from './dto/apply-translation-job.dto';
import { CreateGlossaryDto } from './dto/create-glossary.dto';
import { FindTranslationProjectsQueryDto } from './dto/find-translation-projects-query.dto';
import { FindTranslationJobsQueryDto } from './dto/find-translation-jobs-query.dto';
import { FindJobSegmentsQueryDto } from './dto/find-job-segments-query.dto';
import { UpdateTranslationSegmentDto } from './dto/update-translation-segment.dto';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TranslationController {
  constructor(private readonly translationService: TranslationService) {}

  @Get('projects')
  async getProjects(
    @CurrentUser() user: any,
    @Query() query: FindTranslationProjectsQueryDto,
  ) {
    return await this.translationService.getProjects(user, query);
  }

  @Get('jobs')
  async getJobs(
    @CurrentUser() user: any,
    @Query() query: FindTranslationJobsQueryDto,
  ) {
    return await this.translationService.getJobs(user, query);
  }

  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  async createJob(
    @CurrentUser() user: any,
    @Body() dto: CreateTranslationJobDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException(
        'IDEMPOTENCY_KEY_REQUIRED: Header Idempotency-Key là bắt buộc theo chuẩn API Contract.',
      );
    }
    if (!UUID_V4_REGEX.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key phải là UUID-v4 hợp lệ.');
    }

    const result = await this.translationService.createJob(
      user,
      dto,
      idempotencyKey,
    );
    return {
      jobId: result.id,
      status: result.status,
      isDuplicate: result.isDuplicate,
    };
  }

  @Get('jobs/:id')
  async getJob(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
  ) {
    return await this.translationService.getJob(id, user);
  }

  @Get('jobs/:id/segments')
  async getJobSegments(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
    @Query() query: FindJobSegmentsQueryDto,
  ) {
    return await this.translationService.getJobSegments(id, user, query);
  }

  @Patch('jobs/:jobId/segments/:segmentId')
  @HttpCode(HttpStatus.OK)
  async updateSegment(
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
    @Param('segmentId', new ParseUUIDPipe({ version: '4' })) segmentId: string,
    @Body() dto: UpdateTranslationSegmentDto,
    @CurrentUser() user: any,
  ) {
    return await this.translationService.updateSegment(
      jobId,
      segmentId,
      user,
      dto,
    );
  }

  @Post('jobs/:id/apply')
  @HttpCode(HttpStatus.OK)
  async applyJob(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApplyTranslationJobDto,
    @CurrentUser() user: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException(
        'IDEMPOTENCY_KEY_REQUIRED: Header Idempotency-Key là bắt buộc theo chuẩn API Contract.',
      );
    }
    if (!UUID_V4_REGEX.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key phải là UUID-v4 hợp lệ.');
    }

    return await this.translationService.applyJob(
      id,
      dto,
      user,
      idempotencyKey,
    );
  }

  @Post('jobs/:id/materializations')
  async requestMaterialization(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.translationService.requestMaterialization(id, user);
    res.status(
      result.status === 'ALREADY_FRESH'
        ? HttpStatus.OK
        : HttpStatus.ACCEPTED,
    );
    return result;
  }

  @Post('jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelJob(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
  ) {
    return await this.translationService.cancelJob(id, user);
  }

  @Post('glossary')
  @HttpCode(HttpStatus.CREATED)
  async createGlossary(
    @CurrentUser() user: any,
    @Body() dto: CreateGlossaryDto,
  ) {
    return await this.translationService.createGlossary(user, dto);
  }

  @Get('glossary')
  async getGlossaries(
    @Query('projectId') projectId: string,
    @CurrentUser() user: any,
  ) {
    if (!projectId) {
      throw new BadRequestException('Query param projectId không được để trống.');
    }
    return await this.translationService.getGlossaries(projectId, user);
  }
}
