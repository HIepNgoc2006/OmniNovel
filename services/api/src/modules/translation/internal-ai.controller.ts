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
}
