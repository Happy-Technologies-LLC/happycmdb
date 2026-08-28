// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket Service
 * Provides real-time updates for AI patterns and discovery sessions
 */

import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';

export interface WebSocketMessage {
  type: 'pattern_update' | 'pattern_approved' | 'pattern_learned' | 'session_update' | 'cost_alert';
  data: any;
  timestamp: string;
}

export class WebSocketService {
  private wss: WebSocketServer | null = null;
  private redis = getRedisClient();
  private clients = new Set<WebSocket>();
  private readonly PUBSUB_CHANNEL = 'ai:realtime';

  /**
   * Initialize WebSocket server
   */
  initialize(httpServer: HTTPServer): void {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      logger.info('WebSocket client connected');
      this.clients.add(ws);

      // Send welcome message
      this.sendToClient(ws, {
        type: 'pattern_update' as const,
        data: { message: 'Connected to AI Discovery WebSocket' },
        timestamp: new Date().toISOString(),
      });

      ws.on('close', () => {
        logger.info('WebSocket client disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error', { error });
        this.clients.delete(ws);
      });

      // Handle ping/pong for keepalive
      ws.on('pong', () => {
        // Client is alive
      });
    });

    // Start ping interval (30 seconds)
    setInterval(() => {
      this.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        }
      });
    }, 30000);

    // Subscribe to Redis pub/sub for cross-instance updates
    this.subscribeToRedis();

    logger.info('WebSocket service initialized', { path: '/ws' });
  }

  /**
   * Subscribe to Redis pub/sub for cross-instance communication
   */
  private async subscribeToRedis(): Promise<void> {
    try {
      // Create separate Redis client for pub/sub. The base client (packages/database/src/redis/client.ts)
      // does not set lazyConnect, so duplicate() begins connecting immediately - do not call
      // .connect() again here, it would throw "Redis is already connecting/connected". ioredis
      // queues subsequent commands (e.g. subscribe below) until the connection is ready.
      const subscriber = this.redis.duplicate();

      // Subscribe to channel
      await subscriber.subscribe(this.PUBSUB_CHANNEL);

      // Listen for messages
      subscriber.on('message', (channel: string, message: string) => {
        if (channel === this.PUBSUB_CHANNEL) {
          try {
            const data = JSON.parse(message);
            this.broadcast(data);
          } catch (error) {
            logger.error('Failed to parse Redis pub/sub message', { error });
          }
        }
      });

      logger.info('Subscribed to Redis pub/sub channel', { channel: this.PUBSUB_CHANNEL });
    } catch (error) {
      logger.error('Failed to subscribe to Redis pub/sub', { error });
    }
  }

  /**
   * Publish message to Redis (for cross-instance updates)
   */
  async publish(message: WebSocketMessage): Promise<void> {
    try {
      await this.redis.publish(this.PUBSUB_CHANNEL, JSON.stringify(message));
    } catch (error) {
      logger.error('Failed to publish to Redis', { error });
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message: WebSocketMessage): void {
    const messageStr = JSON.stringify(message);
    let sent = 0;
    let failed = 0;

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(messageStr);
          sent++;
        } catch (error) {
          logger.error('Failed to send message to client', { error });
          failed++;
        }
      }
    });

    logger.debug('Broadcast message', {
      type: message.type,
      sent,
      failed,
      totalClients: this.clients.size,
    });
  }

  /**
   * Send message to specific client
   */
  private sendToClient(client: WebSocket, message: WebSocketMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(message));
      } catch (error) {
        logger.error('Failed to send message to client', { error });
      }
    }
  }

  /**
   * Notify pattern update
   */
  async notifyPatternUpdate(patternId: string, action: 'created' | 'updated' | 'deleted', pattern?: any): Promise<void> {
    const message: WebSocketMessage = {
      type: 'pattern_update',
      data: { patternId, action, pattern },
      timestamp: new Date().toISOString(),
    };

    await this.publish(message);
    this.broadcast(message);
  }

  /**
   * Notify pattern approved
   */
  async notifyPatternApproved(patternId: string, approver: string, pattern: any): Promise<void> {
    const message: WebSocketMessage = {
      type: 'pattern_approved',
      data: { patternId, approver, pattern },
      timestamp: new Date().toISOString(),
    };

    await this.publish(message);
    this.broadcast(message);
  }

  /**
   * Notify new pattern learned
   */
  async notifyPatternLearned(pattern: any): Promise<void> {
    const message: WebSocketMessage = {
      type: 'pattern_learned',
      data: { pattern },
      timestamp: new Date().toISOString(),
    };

    await this.publish(message);
    this.broadcast(message);
  }

  /**
   * Notify discovery session update
   */
  async notifySessionUpdate(sessionId: string, status: string, session?: any): Promise<void> {
    const message: WebSocketMessage = {
      type: 'session_update',
      data: { sessionId, status, session },
      timestamp: new Date().toISOString(),
    };

    await this.publish(message);
    this.broadcast(message);
  }

  /**
   * Notify cost alert
   */
  async notifyCostAlert(message: string, currentCost: number, budget: number): Promise<void> {
    const wsMessage: WebSocketMessage = {
      type: 'cost_alert',
      data: { message, currentCost, budget },
      timestamp: new Date().toISOString(),
    };

    await this.publish(wsMessage);
    this.broadcast(wsMessage);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      connectedClients: this.clients.size,
      isRunning: this.wss !== null,
    };
  }

  /**
   * Close WebSocket server
   */
  close(): void {
    if (this.wss) {
      this.clients.forEach(client => {
        client.close();
      });
      this.wss.close();
      this.wss = null;
      logger.info('WebSocket service closed');
    }
  }
}

// Singleton instance
let wsServiceInstance: WebSocketService | null = null;

export function getWebSocketService(): WebSocketService {
  if (!wsServiceInstance) {
    wsServiceInstance = new WebSocketService();
  }
  return wsServiceInstance;
}
