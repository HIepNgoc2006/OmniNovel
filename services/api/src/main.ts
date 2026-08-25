import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // 1. Cookie Parser
  app.use(cookieParser());

  // 2. Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      stopAtFirstError: false,
    }),
  );

  // 3. Global Exception Filter (StandardErrorResponse JSON)
  app.useGlobalFilters(new GlobalExceptionFilter());

  // 4. Global API Prefix
  app.setGlobalPrefix('api/v1', {
    exclude: ['health/live', 'health/ready', 'internal/v1/(.*)'],
  });

  // 5. CORS
  const webBaseUrl = configService.get<string>('WEB_BASE_URL', 'http://localhost:3000');
  app.enableCors({
    origin: [webBaseUrl, 'http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'Idempotency-Key'],
  });

  const port = configService.get<number>('PORT', 8000);
  await app.listen(port);
  console.log(`[OmniNovel API] Core Backend API is running on http://localhost:${port}/api/v1`);
}

bootstrap();
