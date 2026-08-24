import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const headerName = 'x-request-id';
    const requestId = (req.headers[headerName] as string) || `req-${uuidv4()}`;
    req.headers[headerName] = requestId;
    res.setHeader(headerName, requestId);
    next();
  }
}
