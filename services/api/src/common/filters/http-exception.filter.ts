import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
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

        // Allowlisted public metadata only under error.meta (Fail-Closed)
        const PUBLIC_ERROR_META_FIELDS = [
          'currentVersion',
          'expectedVersion',
          'reviewRevision',
          'materializedRevision',
          'retryAfter',
        ] as const;

        let meta: Record<string, any> | undefined;
        for (const field of PUBLIC_ERROR_META_FIELDS) {
          if (resObj[field] !== undefined) {
            if (!meta) meta = {};
            meta[field] = resObj[field];
          } else if (resObj.meta && resObj.meta[field] !== undefined) {
            if (!meta) meta = {};
            meta[field] = resObj.meta[field];
          }
        }

        extraData = meta ? { meta } : {};
      }
    } else {
      this.logger.error(`[${requestId}] Unhandled Server Error:`, exception);
      message = 'Đã có lỗi không mong muốn xảy ra từ máy chủ.';
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
