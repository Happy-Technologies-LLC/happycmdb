// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket Hook
 * Provides real-time updates for AI patterns and discovery sessions
 *
 * The /ws upgrade is authenticated: the session's access token travels in a
 * `bearer.<token>` Sec-WebSocket-Protocol entry next to WS_PROTOCOL, the only
 * subprotocol the server selects (browsers cannot set headers on a
 * WebSocket, and tokens are kept out of URLs). Without a session no socket is
 * opened; when the token changes the socket is replaced with one carrying the
 * new token. The server delivers only the caller's organization's messages.
 */

import { useContext, useEffect, useRef, useState, useCallback } from 'react';
import AuthContext from '@/contexts/AuthContext';
import { logger } from '@/utils/logger';

const WS_PROTOCOL = 'cmdb.v1';
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface WebSocketMessage {
  type: 'pattern_update' | 'pattern_approved' | 'pattern_learned' | 'session_update' | 'cost_alert';
  data: any;
  timestamp: string;
}

export interface UseWebSocketOptions {
  reconnect?: boolean;
  reconnectInterval?: number;
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    reconnect = true,
    reconnectInterval = 5000,
    onMessage,
    onConnect,
    onDisconnect,
    onError,
  } = options;

  const token = useContext(AuthContext)?.token ?? null;
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = useRef(true);
  // Closes since the last successful open; drives the reconnect backoff.
  const failedAttemptsRef = useRef(0);

  // Callbacks are read through a ref so callers passing inline functions do
  // not replace (and re-authenticate) the socket on every render.
  const callbacksRef = useRef({ onMessage, onConnect, onDisconnect, onError });
  useEffect(() => {
    callbacksRef.current = { onMessage, onConnect, onDisconnect, onError };
  });

  const connect = useCallback(() => {
    if (!token) {
      return;
    }

    try {
      // Determine WebSocket URL
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = process.env.REACT_APP_API_HOST || window.location.host.replace(':3001', ':3000');
      const wsUrl = `${protocol}//${host}/ws`;

      logger.info('Connecting to WebSocket', { url: wsUrl });

      const ws = new WebSocket(wsUrl, [WS_PROTOCOL, `bearer.${token}`]);

      ws.onopen = () => {
        logger.info('WebSocket connected');
        failedAttemptsRef.current = 0;
        setIsConnected(true);
        callbacksRef.current.onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          logger.debug('WebSocket message received', { type: message.type });
          setLastMessage(message);
          callbacksRef.current.onMessage?.(message);
        } catch (error) {
          logger.error('Failed to parse WebSocket message', { error });
        }
      };

      ws.onclose = () => {
        callbacksRef.current.onDisconnect?.();
        // Only the current socket reconnects. One closed by disconnect()
        // (unmount, token change, logout) never does: its reconnect would
        // reuse the token it was opened with.
        if (wsRef.current !== ws) {
          return;
        }
        logger.info('WebSocket disconnected');
        setIsConnected(false);
        wsRef.current = null;

        // Attempt reconnection if enabled. A refused upgrade (401 expired
        // token, 403 no organization) looks like a network drop, so back off.
        if (reconnect && shouldReconnectRef.current) {
          const delay = Math.min(reconnectInterval * 2 ** failedAttemptsRef.current, MAX_RECONNECT_DELAY_MS);
          failedAttemptsRef.current += 1;
          logger.info(`Reconnecting in ${delay}ms...`);
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      };

      ws.onerror = (error) => {
        logger.error('WebSocket error', { error });
        callbacksRef.current.onError?.(error);
      };

      wsRef.current = ws;
    } catch (error) {
      logger.error('Failed to create WebSocket connection', { error });
    }
  }, [token, reconnect, reconnectInterval]);

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
  }, []);

  const send = useCallback((data: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return true;
    }
    logger.warn('WebSocket not connected, cannot send message');
    return false;
  }, []);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    lastMessage,
    send,
    disconnect,
    reconnect: connect,
  };
}

/**
 * Hook for listening to specific WebSocket message types
 */
export function useWebSocketSubscription<T = any>(
  messageType: WebSocketMessage['type'],
  callback: (data: T) => void,
  deps: React.DependencyList = []
) {
  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.type === messageType) {
        callback(message.data);
      }
    },
    [messageType, callback, ...deps]
  );

  return useWebSocket({
    onMessage: handleMessage,
  });
}
