import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SyncService } from './services/sync.service';
import {
  PushMutationsBatchDto,
  PushMutationsBatchResponseDto,
  SyncChangesQueryDto,
  SyncChangesResponseDto,
  SyncSnapshotQueryDto,
  SyncSnapshotResponseDto,
} from './dto';

@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /**
   * Endpoint GET /api/v1/sync/changes
   * Lấy các thay đổi Delta của thư viện sau con trỏ `after`.
   */
  @Get('changes')
  async getChanges(
    @CurrentUser('id') userId: string,
    @Query() query: SyncChangesQueryDto,
  ): Promise<SyncChangesResponseDto> {
    return this.syncService.getChanges(userId, query);
  }

  /**
   * Endpoint GET /api/v1/sync/snapshot
   * Lấy ảnh chụp toàn bộ trạng thái thư viện với Repeatable Read Isolation
   * và cơ chế Optimistic Snapshot Restart (HTTP 409 SNAPSHOT_INVALIDATED).
   */
  @Get('snapshot')
  async getSnapshot(
    @CurrentUser('id') userId: string,
    @Query() query: SyncSnapshotQueryDto,
  ): Promise<SyncSnapshotResponseDto> {
    return this.syncService.getSnapshot(userId, query);
  }

  /**
   * Endpoint POST /api/v1/sync/mutations/batch
   * Đẩy batch các mutations từ client với Durable Idempotency Receipts.
   */
  @Post('mutations/batch')
  @HttpCode(HttpStatus.OK)
  async pushMutations(
    @CurrentUser('id') userId: string,
    @Body() dto: PushMutationsBatchDto,
  ): Promise<PushMutationsBatchResponseDto> {
    return this.syncService.pushMutations(userId, dto);
  }
}
