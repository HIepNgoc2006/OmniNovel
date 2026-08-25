import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  namespace: '/ws/ai',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class TranslationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TranslationGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to /ws/ai: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from /ws/ai: ${client.id}`);
  }

  @SubscribeMessage('subscribe_job')
  handleSubscribeJob(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { jobId: string },
  ) {
    if (data?.jobId) {
      const room = `job_${data.jobId}`;
      client.join(room);
      client.emit('subscribed', { room, jobId: data.jobId, status: 'OK' });
      this.logger.log(`Client ${client.id} joined room ${room}`);
    }
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
    payload: { stage: string; progress: number; heartbeatAt?: Date },
  ) {
    if (this.server) {
      this.server.to(`job_${jobId}`).emit('job_progress', {
        jobId,
        ...payload,
        timestamp: new Date().toISOString(),
      });
    }
  }

  broadcastJobReady(
    jobId: string,
    payload: { targetVersionId?: string; resultManifest?: any },
  ) {
    if (this.server) {
      this.server.to(`job_${jobId}`).emit('job_ready_for_review', {
        jobId,
        ...payload,
        timestamp: new Date().toISOString(),
      });
    }
  }

  broadcastJobFailed(jobId: string, payload: { errorTrace?: string }) {
    if (this.server) {
      this.server.to(`job_${jobId}`).emit('job_failed', {
        jobId,
        ...payload,
        timestamp: new Date().toISOString(),
      });
    }
  }

  broadcastJobCanceled(jobId: string) {
    if (this.server) {
      this.server.to(`job_${jobId}`).emit('job_canceled', {
        jobId,
        status: 'CANCELED',
        timestamp: new Date().toISOString(),
      });
    }
  }
}
