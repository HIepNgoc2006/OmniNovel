import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TranslationService } from './translation.service';
import { CreateTranslationJobDto } from './dto/create-translation-job.dto';
import { ApplyTranslationJobDto } from './dto/apply-translation-job.dto';
import { CreateGlossaryDto } from './dto/create-glossary.dto';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TranslationController {
  constructor(private readonly translationService: TranslationService) {}

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
  async getJob(@Param('id') id: string, @CurrentUser() user: any) {
    return await this.translationService.getJob(id, user);
  }

  @Post('jobs/:id/apply')
  @HttpCode(HttpStatus.OK)
  async applyJob(
    @Param('id') id: string,
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

  @Post('jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelJob(@Param('id') id: string, @CurrentUser() user: any) {
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
