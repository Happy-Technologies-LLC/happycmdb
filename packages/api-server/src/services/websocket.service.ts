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
 * Lifetime: a connection lasts no longer than its token (closed with 4001 at
 * the token's `exp`), and its user is re-read every REVERIFY_INTERVAL_MS:
 * missing or disabled => 4001, organization changed => 4003.
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

/** Close code: the client must re-authenticate (token expired, user disabled or removed). */
const CLOSE_REAUTHENTICATE = 4001;
/** Close code: the user's organization changed; a reconnect re-reads it. */
const CLOSE_ORGANIZATION_CHANGED = 4003;
/** How often open connections are re-checked against the user store. */
const REVERIFY_INTERVAL_MS = 2 * 60_000;
/** A re-check lookup slower than this fails closed (the store has no query timeout). */
const REVERIFY_LOOKUP_TIMEOUT_MS = 30_000;
/** Users looked up at once per re-check; the auth store's pool also serves REST authentication. */
const REVERIFY_CONCURRENCY = 8;
/** setTimeout's maximum delay; later expiries are caught by the periodic re-check. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Admission is local to an API instance; unauthenticated requests are never queued. */
const MAX_VERIFYING = 8;
const MAX_CONNECTIONS = 64;
const MAX_ORG_CONNECTIONS = 16;
const MAX_USER_CONNECTIONS = 4;
const VERIFY_TIMEOUT_MS = 30_000;

interface ClientIdentity {
  organizationId: string;
  userId: string;
  /** Token expiry (epoch ms); the connection is closed at that moment. */
  expiresAt: number | null;
  expiryTimer: NodeJS.Timeout | null;
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
function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403 | 503): void {
  if (socket.destroyed) return;
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 503: 'Service Unavailable' }[status];
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
  private reverifyInterval: NodeJS.Timeout | null = null;
  private reverifying = false;
  private reverifyController: AbortController | null = null;
  private authService: AuthService | null = null;
  private redis = getRedisClient();
  private clients = new Map<WebSocket, ClientIdentity>();
  private readonly PUBSUB_CHANNEL = 'ai:realtime';
  /** Pending sockets are cancelled on peer close and service shutdown. */
  private pendingUpgrades = new Map<Duplex, () => void>();
  /** Includes lookups whose peer already left; freed only when the lookup settles. */
  private verificationInFlight = 0;

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

    // A connection's identity was verified once, at upgrade. Re-check it so a
    // user who is disabled or moved to another organization stops receiving
    // the old organization's messages.
    this.reverifyInterval = setInterval(() => void this.reverifyClients(), REVERIFY_INTERVAL_MS);

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

    const wss = this.wss;
    // No queue of unverified sockets: both live handshakes and underlying DB
    // lookups (including disconnected peers' lookups) are capped. A DB lookup
    // cannot be cancelled by this service, so its slot is held until it settles.
    if (this.pendingUpgrades.size >= MAX_VERIFYING || this.verificationInFlight >= MAX_VERIFYING ||
        this.clients.size + this.pendingUpgrades.size >= MAX_CONNECTIONS) {
      rejectUpgrade(socket, 503);
      return;
    }

    const controller = new AbortController();
    const cancel = () => { controller.abort(); socket.destroy(); };
    this.pendingUpgrades.set(socket, cancel);
    socket.once('close', cancel);
    let timeout: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let identity: ClientIdentity;
    try {
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('peer closed'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('verification timed out')), VERIFY_TIMEOUT_MS);
      });
      this.verificationInFlight++;
      const verification = authService.verifyToken(token);
      void verification.then(
        () => { this.verificationInFlight--; },
        () => { this.verificationInFlight--; }
      );
      const payload = await Promise.race([verification, stopped, expired]);
      if (controller.signal.aborted || this.wss !== wss || socket.destroyed) return;
      const organizationId = organizationClaim(payload);
      if (organizationId === null) {
        logger.warn('WebSocket upgrade rejected', { status: 403, reason: 'organization claim required' });
        rejectUpgrade(socket, 403);
        return;
      }
      identity = {
        organizationId,
        userId: payload._userId,
        expiresAt: payload.exp === undefined ? null : payload.exp * 1000,
        expiryTimer: null,
      };
    } catch {
      if (!controller.signal.aborted && this.wss === wss) {
        // Neither the verification error nor the access token is logged.
        logger.warn('WebSocket upgrade rejected', { status: 401, reason: 'invalid or timed-out token' });
        rejectUpgrade(socket, 401);
      }
      return;
    } finally {
      clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      socket.off('close', cancel);
      this.pendingUpgrades.delete(socket);
    }

    if (this.wss !== wss || socket.destroyed) {
      socket.destroy();
      return;
    }
    let userConnections = 0;
    let orgConnections = 0;
    for (const client of this.clients.values()) {
      if (client.userId === identity.userId) userConnections++;
      if (client.organizationId === identity.organizationId) orgConnections++;
    }
    if (this.clients.size >= MAX_CONNECTIONS || orgConnections >= MAX_ORG_CONNECTIONS ||
        userConnections >= MAX_USER_CONNECTIONS) {
      rejectUpgrade(socket, 503);
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => this.registerClient(ws, identity));
  }

  private registerClient(ws: WebSocket, identity: ClientIdentity): void {
    logger.info('WebSocket client connected', { organizationId: identity.organizationId, userId: identity.userId });
    this.clients.set(ws, identity);

    // Access ends with the token: close at its expiry. The client reconnects with its current token.
    if (identity.expiresAt !== null) {
      const delay = identity.expiresAt - Date.now();
      if (delay <= MAX_TIMER_DELAY_MS) {
        identity.expiryTimer = setTimeout(
          () => this.closeClient(ws, CLOSE_REAUTHENTICATE, 'token expired'),
          Math.max(delay, 0)
        );
      }
    }

    // Send welcome message
    this.sendToClient(ws, {
      type: 'pattern_update' as const,
      data: { message: 'Connected to AI Discovery WebSocket' },
      timestamp: new Date().toISOString(),
    });

    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
      this.forgetClient(ws);
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error', { error });
      this.forgetClient(ws);
    });

    // Handle ping/pong for keepalive
    ws.on('pong', () => {
      // Client is alive
    });
  }

  private forgetClient(ws: WebSocket): void {
    const identity = this.clients.get(ws);
    if (identity?.expiryTimer) {
      clearTimeout(identity.expiryTimer);
    }
    this.clients.delete(ws);
  }

  /** Stop delivering to a connection at once and close it with `code`. */
  private closeClient(ws: WebSocket, code: number, reason: string): void {
    this.forgetClient(ws);
    logger.info('WebSocket client closed by server', { code, reason });
    ws.close(code, reason);
  }

  /**
   * Re-check every connection against the user store, with the lookup
   * verifyToken uses: an expired token or a missing/disabled user closes with
   * 4001, a changed organization with 4003. A lookup that fails or exceeds
   * REVERIFY_LOOKUP_TIMEOUT_MS closes with 1011 (fail closed; the client
   * reconnects and is verified again). One lookup per user, at most
   * REVERIFY_CONCURRENCY at a time, so a tick never floods the auth store.
   */
  private async reverifyClients(): Promise<void> {
    const authService = this.authService;
    if (authService === null || this.reverifying || this.wss === null) {
      return;
    }
    this.reverifying = true;
    const controller = new AbortController();
    this.reverifyController = controller;
    try {
      const connectionsByUser = new Map<string, Array<[WebSocket, ClientIdentity]>>();
      for (const [ws, identity] of this.clients) {
        if (identity.expiresAt !== null && Date.now() >= identity.expiresAt) {
          this.closeClient(ws, CLOSE_REAUTHENTICATE, 'token expired');
          continue;
        }
        const connections = connectionsByUser.get(identity.userId) ?? [];
        connections.push([ws, identity]);
        connectionsByUser.set(identity.userId, connections);
      }

      const users = [...connectionsByUser];
      let nextUser = 0;
      const worker = async (): Promise<void> => {
        while (!controller.signal.aborted && nextUser < users.length) {
          const [userId, connections] = users[nextUser++]!;
          await this.reverifyUser(authService, userId, connections, controller.signal);
        }
      };
      await Promise.all(Array.from({ length: Math.min(REVERIFY_CONCURRENCY, users.length) }, worker));
    } finally {
      if (this.reverifyController === controller) {
        this.reverifyController = null;
        this.reverifying = false;
      }
    }
  }

  private async reverifyUser(
    authService: AuthService,
    userId: string,
    connections: Array<[WebSocket, ClientIdentity]>,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) return;
    let timeout: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    let organizationId: string | undefined | null;
    try {
      const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('service closed'));
        signal.addEventListener('abort', abort, { once: true });
      });
      const user = await Promise.race([
        authService.findEnabledUser(userId),
        stopped,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('user lookup timed out')), REVERIFY_LOOKUP_TIMEOUT_MS);
        }),
      ]);
      organizationId = user === null ? null : user._organizationId;
    } catch {
      if (!signal.aborted) {
        for (const [ws, identity] of connections) {
          if (this.clients.get(ws) === identity) {
            this.closeClient(ws, 1011, 'identity re-check failed');
          }
        }
      }
      return;
    } finally {
      clearTimeout(timeout);
      if (abort) signal.removeEventListener('abort', abort);
    }

    for (const [ws, identity] of connections) {
      // The connection may have closed while the user was looked up.
      if (this.clients.get(ws) !== identity) {
        continue;
      }
      if (organizationId === null) {
        this.closeClient(ws, CLOSE_REAUTHENTICATE, 'user disabled');
      } else if (organizationId !== identity.organizationId) {
        this.closeClient(ws, CLOSE_ORGANIZATION_CHANGED, 'organization changed');
      }
    }
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
      if (this.reverifyInterval) {
        clearInterval(this.reverifyInterval);
        this.reverifyInterval = null;
      }
      this.reverifyController?.abort();
      this.reverifyController = null;
      this.reverifying = false;
      for (const cancel of this.pendingUpgrades.values()) cancel();
      this.pendingUpgrades.clear();
      [...this.clients.keys()].forEach(client => {
        this.forgetClient(client);
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
