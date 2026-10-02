// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket Service
 * Provides real-time updates for AI patterns and discovery sessions
 *
 * Authentication: the /ws upgrade is authenticated before the handshake
 * completes. The access token is read from the `Authorization: Bearer`
 * header (non-browser clients) or, because browsers cannot set headers on a
 * WebSocket, from a `bearer.<token>` entry of `Sec-WebSocket-Protocol`. The
 * client must also offer WS_PROTOCOL, which is the only subprotocol the
 * server ever selects, so the token is never echoed back. Missing/invalid
 * token => 401, no well-formed organization claim => 403; either way the
 * socket is closed before a connection is registered. Tokens are never read
 * from the query string and never logged.
 *
 * Tenancy: every message carries the organization it belongs to and is
 * delivered only to connections of that organization. A message without an
 * organization id is dropped (fail closed); no message type is global.
 */

import type { IncomingMessage, Server as HTTPServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';
import { getAuthService } from '../auth/auth-bootstrap';
import type { AuthService } from '../auth/auth.service';
import { organizationClaim } from '../middleware/auth.middleware';

export const WS_PATH = '/ws';
/** Subprotocol the server selects; clients offer it next to the bearer entry. */
export const WS_PROTOCOL = 'cmdb.v1';
/** Prefix of the `Sec-WebSocket-Protocol` entry that carries the access token. */
export const WS_BEARER_PROTOCOL_PREFIX = 'bearer.';

export interface WebSocketMessage {
  type: 'pattern_update' | 'pattern_approved' | 'pattern_learned' | 'session_update' | 'cost_alert';
  /** Tenant the message belongs to; messages without one are never delivered. */
  organizationId?: string;
  data: unknown;
  timestamp: string;
}

interface ClientIdentity {
  organizationId: string;
  userId: string;
}

/** Access token from `Authorization: Bearer` or the `bearer.` subprotocol entry, or null. */
function extractToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    return parts.length === 2 && parts[0] === 'Bearer' && parts[1] ? parts[1] : null;
  }

  const protocols = req.headers['sec-websocket-protocol'];
  if (protocols) {
    for (const entry of protocols.split(',')) {
      const protocol = entry.trim();
      if (protocol.startsWith(WS_BEARER_PROTOCOL_PREFIX) && protocol.length > WS_BEARER_PROTOCOL_PREFIX.length) {
        return protocol.slice(WS_BEARER_PROTOCOL_PREFIX.length);
      }
    }
  }

  return null;
}

/** Refuse the upgrade with a plain HTTP response, then close the socket. */
function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403): void {
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden' }[status];
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`
  );
}

export class WebSocketService {
  private wss: WebSocketServer | null = null;
  private httpServer: HTTPServer | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private authService: AuthService | null = null;
  private redis = getRedisClient();
  private clients = new Map<WebSocket, ClientIdentity>();
  private readonly PUBSUB_CHANNEL = 'ai:realtime';

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void this.handleUpgrade(req, socket, head);
  };

  /**
   * Initialize WebSocket server
   */
  initialize(httpServer: HTTPServer, authService: AuthService = getAuthService()): void {
    this.authService = authService;
    this.wss = new WebSocketServer({
      noServer: true,
      // The channel is server-to-client only; no client message is ever read.
      maxPayload: 1024,
      // Never select the bearer entry: that would echo the token in the response.
      handleProtocols: (protocols: Set<string>) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    });
    this.httpServer = httpServer;
    httpServer.on('upgrade', this.onUpgrade);

    // Start ping interval (30 seconds)
    this.pingInterval = setInterval(() => {
      this.clients.forEach((_identity, client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        }
      });
    }, 30000);

    // Subscribe to Redis pub/sub for cross-instance updates
    this.subscribeToRedis();

    logger.info('WebSocket service initialized', { path: WS_PATH });
  }

  /**
   * Authenticate the upgrade request, then complete the handshake and
   * register the connection under the caller's organization.
   */
  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // The client may drop the socket while the token is verified.
    socket.on('error', () => socket.destroy());

    const authService = this.authService;
    if (this.wss === null || authService === null) {
      socket.destroy();
      return;
    }

    const url = req.url ?? '';
    const queryIndex = url.indexOf('?');
    if ((queryIndex === -1 ? url : url.slice(0, queryIndex)) !== WS_PATH) {
      rejectUpgrade(socket, 400);
      return;
    }

    const token = extractToken(req);
    if (token === null) {
      logger.warn('WebSocket upgrade rejected', { status: 401, reason: 'missing token' });
      rejectUpgrade(socket, 401);
      return;
    }

    let identity: ClientIdentity;
    try {
      const payload = await authService.verifyToken(token);
      const organizationId = organizationClaim(payload);
      if (organizationId === null) {
        logger.warn('WebSocket upgrade rejected', { status: 403, reason: 'organization claim required' });
        rejectUpgrade(socket, 403);
        return;
      }
      identity = { organizationId, userId: payload._userId };
    } catch {
      // The verification error is not logged: it is not needed here and must never carry the token.
      logger.warn('WebSocket upgrade rejected', { status: 401, reason: 'invalid token' });
      rejectUpgrade(socket, 401);
      return;
    }

    if (this.wss === null || socket.destroyed) {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, ws => this.registerClient(ws, identity));
  }

  private registerClient(ws: WebSocket, identity: ClientIdentity): void {
    logger.info('WebSocket client connected', identity);
    this.clients.set(ws, identity);

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
            this.deliver(data);
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
   * Deliver a message to the connected clients of its organization only.
   * A message without an organization id reaches nobody.
   */
  deliver(message: WebSocketMessage): void {
    const organizationId = message.organizationId;
    if (typeof organizationId !== 'string' || organizationId === '') {
      logger.warn('Dropped WebSocket message without organization id', { type: message.type });
      return;
    }

    const messageStr = JSON.stringify(message);
    let sent = 0;
    let failed = 0;

    this.clients.forEach((identity, client) => {
      if (identity.organizationId === organizationId && client.readyState === WebSocket.OPEN) {
        try {
          client.send(messageStr);
          sent++;
        } catch (error) {
          logger.error('Failed to send message to client', { error });
          failed++;
        }
      }
    });

    logger.debug('Delivered message', {
      type: message.type,
      organizationId,
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
  async notifyPatternUpdate(
    organizationId: string,
    patternId: string,
    action: 'created' | 'updated' | 'deleted',
    pattern?: unknown
  ): Promise<void> {
    const message: WebSocketMessage = {
      type: 'pattern_update',
      organizationId,
      data: { patternId, action, pattern },
      timestamp: new Date().toISOString(),
    };

    await this.publish(message);
    this.deliver(message);
  }

  /**
   * Notify pattern approved
   */
  async notifyPatternApproved(organizationId: string, patternId: string, approver: string, pattern: unknown): Promise<void> {
    const message: WebSocketMessage = {
      type: 'pattern_approved',
      organizationId,
      data: { patternId, approver, pattern },
      timestamp: new Date().toISOString(),
    };

    await this.publish(message);
    this.deliver(message);
  }

  /**
   * Notify new pattern learned
   */
  async notifyPatternLearned(organizationId: string, pattern: unknown): Promise<void> {
    const message: WebSocketMessage = {
      type: 'pattern_learned',
      organizationId,
      data: { pattern },
      timestamp: new Date().toISOString(),
    };

    await this.publish(message);
    this.deliver(message);
  }

  /**
   * Notify discovery session update
   */
  async notifySessionUpdate(organizationId: string, sessionId: string, status: string, session?: unknown): Promise<void> {
    const message: WebSocketMessage = {
      type: 'session_update',
      organizationId,
      data: { sessionId, status, session },
      timestamp: new Date().toISOString(),
    };

    await this.publish(message);
    this.deliver(message);
  }

  /**
   * Notify cost alert
   */
  async notifyCostAlert(organizationId: string, message: string, currentCost: number, budget: number): Promise<void> {
    const wsMessage: WebSocketMessage = {
      type: 'cost_alert',
      organizationId,
      data: { message, currentCost, budget },
      timestamp: new Date().toISOString(),
    };

    await this.publish(wsMessage);
    this.deliver(wsMessage);
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
      this.httpServer?.off('upgrade', this.onUpgrade);
      this.httpServer = null;
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      this.clients.forEach((_identity, client) => {
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
