import {
  Controller,
  Delete,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AccountService } from './account.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('account')
export class AccountController {
  constructor(private accountService: AccountService) {}

  @Delete()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async deleteAccount(
    @CurrentUser() user: any,
    @Body() dto: DeleteAccountDto,
  ) {
    return this.accountService.deleteAccount(user.id, dto);
  }

  @Get('export-data')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async exportData(@CurrentUser() user: any) {
    return this.accountService.exportUserData(user.id);
  }
}
