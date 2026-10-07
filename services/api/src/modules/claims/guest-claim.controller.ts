import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GuestClaimService } from './guest-claim.service';
import { PrepareGuestClaimDto } from './dto/prepare-guest-claim.dto';
import { CommitGuestClaimDto } from './dto/commit-guest-claim.dto';
import {
  GuestClaimPreviewResponseDto,
  GuestClaimCommitResponseDto,
  GuestClaimStatusResponseDto,
} from './dto/guest-claim-response.dto';

@Controller('account/guest-claims')
@UseGuards(JwtAuthGuard)
export class GuestClaimController {
  constructor(private readonly guestClaimService: GuestClaimService) {}

  @Post('prepare')
  @HttpCode(HttpStatus.OK)
  async prepareClaim(
    @CurrentUser('id') userId: string,
    @Body() dto: PrepareGuestClaimDto,
  ): Promise<GuestClaimPreviewResponseDto> {
    return this.guestClaimService.prepareClaim(userId, dto);
  }

  @Post(':claimId/commit')
  @HttpCode(HttpStatus.OK)
  async commitClaim(
    @CurrentUser('id') userId: string,
    @Param('claimId', new ParseUUIDPipe({ version: '4' })) claimId: string,
    @Body() dto: CommitGuestClaimDto,
  ): Promise<GuestClaimCommitResponseDto> {
    return this.guestClaimService.commitClaim(userId, claimId, dto);
  }

  @Get(':claimId/status')
  async getClaimStatus(
    @CurrentUser('id') userId: string,
    @Param('claimId', new ParseUUIDPipe({ version: '4' })) claimId: string,
  ): Promise<GuestClaimStatusResponseDto> {
    return this.guestClaimService.getClaimStatus(userId, claimId);
  }
}
