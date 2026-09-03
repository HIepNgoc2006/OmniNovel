import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId =
      (request.headers['x-request-id'] as string) ||
      `req-${Math.random().toString(36).substring(2, 10)}`;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'Đã có lỗi không mong muốn xảy ra từ máy chủ.';
    let details: Array<{ field: string; issue: string }> | undefined;
    let extraData: Record<string, any> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
        code = this.getStatusCodeName(status);
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;
        code = resObj.code || this.getStatusCodeName(status);
        message = resObj.message || exception.message;

        if (Array.isArray(resObj.message)) {
          details = resObj.message.map((msg: string) => ({
            field: 'validation',
            issue: msg,
          }));
          message = 'Dữ liệu yêu cầu không hợp lệ.';
        } else if (resObj.details) {
          details = resObj.details;
        }

        const { code: _c, message: _m, details: _d, error: _e, statusCode: _s, ...rest } = resObj;
        extraData = rest;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    response.status(status).json({
      error: {
        code,
        message,
        requestId,
        timestamp: new Date().toISOString(),
        ...extraData,
        ...(details ? { details } : {}),
      },
    });
  }

  private getStatusCodeName(status: number): string {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'TOO_MANY_REQUESTS';
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }
}
