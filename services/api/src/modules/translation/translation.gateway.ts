import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import {
  GlobalRole,
  TranslationJobStatus,
  JobProgressWsEvent,
  JobReadyWsEvent,
  JobFailedWsEvent,
  JobCanceledWsEvent,
} from '@omninovel/shared';

@WebSocketGateway({
  namespace: '/ws/ai',
  cors: {
    origin: (origin, callback) => {
      const webBaseUrl = process.env.WEB_BASE_URL;
      if (
        !origin ||
        origin.startsWith('http://localhost') ||
        origin.startsWith('http://127.0.0.1') ||
        (webBaseUrl && origin === webBaseUrl)
      ) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  },
})
export class TranslationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TranslationGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Thiết lập Socket.IO Middleware để xác thực JWT và nạp User an toàn vào socket.data.user
   * Đảm bảo socket.data.user luôn sẵn sàng trước khi bất kỳ SubscribeMessage nào được gọi.
   */
  afterInit(server: Server) {
    this.logger.log('Translation Gateway initialized on namespace /ws/ai');

    server.use(async (socket: Socket, next) => {
      try {
        const authHeader = socket.handshake.headers?.authorization;
        const rawToken =
          socket.handshake.auth?.token ||
          (typeof authHeader === 'string'
            ? authHeader.replace(/^Bearer\s+/i, '')
            : null);

        if (!rawToken) {
          return next(
            new Error('UNAUTHORIZED: Yêu cầu Bearer JWT Token để kết nối.'),
          );
        }

        let payload: any;
        try {
          payload = this.jwtService.verify(rawToken);
        } catch {
          const jwtSecret =
            this.configService.get<string>('JWT_SECRET') ||
            'super_secret_jwt_key_omninovel_2026';
          payload = this.jwtService.verify(rawToken, { secret: jwtSecret });
        }

        if (!payload?.sub) {
          return next(
            new Error('UNAUTHORIZED: Token payload không chứa user ID.'),
          );
        }

        // Xác thực User tồn tại, đang active và chưa bị xóa trong Database
        const users = await this.dataSource.query(
          `SELECT id, email, role, is_active, is_deleted FROM users WHERE id = $1`,
          [payload.sub],
        );

        if (users.length === 0 || !users[0].is_active || users[0].is_deleted) {
          return next(
            new Error(
              'UNAUTHORIZED: Tài khoản không hợp lệ, đã bị vô hiệu hóa hoặc đã bị xóa.',
            ),
          );
        }

        socket.data.user = users[0];
        next();
      } catch (err: any) {
        next(new Error(`UNAUTHORIZED: ${err.message}`));
      }
    });
  }

  handleConnection(client: Socket) {
    if (client.data?.user) {
      this.logger.log(
        `[WebSocket /ws/ai] Client ${client.id} kết nối thành công (User: ${client.data.user.email})`,
      );
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from /ws/ai: ${client.id}`);
  }

  /**
   * Subscribe Job Progress với RBAC Authorization (IDOR Protection)
   */
  @SubscribeMessage('subscribe_job')
  async handleSubscribeJob(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { jobId: string },
  ) {
    const user = client.data?.user;
    if (!user) {
      client.emit('error', {
        code: 'UNAUTHORIZED',
        message: 'Bạn chưa xác thực.',
      });
      client.disconnect(true);
      return;
    }

    if (!data?.jobId) {
      client.emit('error', {
        code: 'BAD_REQUEST',
        message: 'Vui lòng cung cấp jobId hợp lệ.',
      });
      return;
    }

    // Global Admin có toàn quyền subscribe mọi job
    if (user.role === GlobalRole.ADMIN) {
      const room = `job_${data.jobId}`;
      client.join(room);
      client.emit('subscribed', { room, jobId: data.jobId, status: 'OK' });
      this.logger.log(`Admin ${user.email} joined room ${room}`);
      return;
    }

    // Kiểm tra quyền StoryMember (OWNER, EDITOR, TRANSLATOR)
    const records = await this.dataSource.query(
      `SELECT s.id as story_id, sm.role as member_role
       FROM translation_jobs tj
       JOIN translation_projects tp ON tp.id = tj.project_id
       JOIN story_editions se ON se.id = tp.story_edition_id
       JOIN stories s ON s.id = se.story_id
       LEFT JOIN story_members sm ON sm.story_id = s.id AND sm.user_id = $1
       WHERE tj.id = $2`,
      [user.id, data.jobId],
    );

    if (records.length === 0) {
      client.emit('error', {
        code: 'NOT_FOUND',
        message: 'Không tìm thấy TranslationJob chỉ định.',
      });
      return;
    }

    const memberRole = records[0].member_role;
    if (
      !memberRole ||
      !['OWNER', 'EDITOR', 'TRANSLATOR'].includes(memberRole)
    ) {
      this.logger.warn(
        `[WebSocket /ws/ai] IDOR chặn: User ${user.email} không có quyền trên Story chứa TranslationJob ${data.jobId}`,
      );
      client.emit('error', {
        code: 'FORBIDDEN',
        message: 'Bạn không có quyền theo dõi tiến trình dịch của truyện này.',
      });
      return;
    }

    const room = `job_${data.jobId}`;
    client.join(room);
    client.emit('subscribed', { room, jobId: data.jobId, status: 'OK' });
    this.logger.log(
      `User ${user.email} (${memberRole}) joined room ${room}`,
    );
  }

  @SubscribeMessage('unsubscribe_job')
  handleUnsubscribeJob(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { jobId: string },
  ) {
    if (data?.jobId) {
      const room = `job_${data.jobId}`;
      client.leave(room);
      client.emit('unsubscribed', { room, jobId: data.jobId });
    }
  }

  broadcastJobProgress(
    jobId: string,
    status: TranslationJobStatus,
    progress: number,
    heartbeatAt?: Date,
  ) {
    if (this.server) {
      const payload: JobProgressWsEvent = {
        jobId,
        status,
        progress,
        timestamp: new Date().toISOString(),
      };
      if (heartbeatAt) {
        payload.heartbeatAt = heartbeatAt.toISOString();
      }
      this.server.to(`job_${jobId}`).emit('job_progress', payload);
    }
  }

  broadcastJobReady(jobId: string) {
    if (this.server) {
      const payload: JobReadyWsEvent = {
        jobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        timestamp: new Date().toISOString(),
      };
      this.server.to(`job_${jobId}`).emit('job_ready_for_review', payload);
    }
  }

  broadcastJobFailed(jobId: string) {
    if (this.server) {
      const payload: JobFailedWsEvent = {
        jobId,
        status: TranslationJobStatus.FAILED,
        timestamp: new Date().toISOString(),
      };
      this.server.to(`job_${jobId}`).emit('job_failed', payload);
    }
  }

  broadcastJobCanceled(jobId: string) {
    if (this.server) {
      const payload: JobCanceledWsEvent = {
        jobId,
        status: TranslationJobStatus.CANCELED,
        timestamp: new Date().toISOString(),
      };
      this.server.to(`job_${jobId}`).emit('job_canceled', payload);
    }
  }
}
