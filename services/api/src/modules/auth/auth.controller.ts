import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ReactivateAccountDto } from './dto/reactivate-account.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 30, ttlSeconds: 60, keyPrefix: 'auth_register', scope: 'IP' })
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'] as string;
    const result = await this.authService.register(dto, ip, userAgent);

    // Gán Refresh Token vào httpOnly Cookie an toàn cho client Web
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 ngày
      path: '/api/v1/auth',
    });

    return {
      message: 'Đăng ký tài khoản thành công.',
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 30, ttlSeconds: 60, keyPrefix: 'auth_login', scope: 'IP' })
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'] as string;
    const { user, accessToken, refreshToken } = await this.authService.login(dto, ip, userAgent);

    // Gán Refresh Token vào httpOnly Cookie an toàn
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 ngày
      path: '/api/v1/auth',
    });

    return {
      user,
      accessToken,
      refreshToken,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('refreshToken') bodyRefreshToken?: string,
  ) {
    const refreshToken =
      req.cookies?.refreshToken ||
      bodyRefreshToken ||
      (req.headers['x-refresh-token'] as string);

    const ip = req.ip;
    const userAgent = req.headers['user-agent'] as string;
    const { accessToken, refreshToken: newRefreshToken } =
      await this.authService.refreshTokens(refreshToken, ip, userAgent);

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth',
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@CurrentUser() user: any) {
    return this.authService.getProfile(user.id);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('refreshToken') bodyRefreshToken?: string,
  ) {
    const refreshToken =
      req.cookies?.refreshToken ||
      bodyRefreshToken ||
      (req.headers['x-refresh-token'] as string);

    await this.authService.logout(refreshToken);

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
    });

    return {
      message: 'Đăng xuất thành công.',
    };
  }

  @Post('forgot-password')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 3, ttlSeconds: 900, keyPrefix: 'auth_forgot_pwd', scope: 'IP' })
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 10, ttlSeconds: 900, keyPrefix: 'auth_reset_pwd', scope: 'IP' })
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: any,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.id, user.sessionId, dto);
  }

  @Post('reactivate-account')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 5, ttlSeconds: 900, keyPrefix: 'auth_reactivate', scope: 'IP' })
  @HttpCode(HttpStatus.OK)
  async reactivateAccount(
    @Body() dto: ReactivateAccountDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'] as string;
    const result = await this.authService.reactivateAccount(dto, ip, userAgent);

    if (result.refreshToken) {
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
      });
    }

    return result;
  }
}
