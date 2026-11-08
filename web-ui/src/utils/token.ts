// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JWT Token utility functions
 *
 * HAP-1211 H2: the access token lives only in this module's memory, never in Web Storage, so a script injected
 * into the origin cannot read a stored copy. A reload or a new tab restores it from the httpOnly refresh cookie
 * (lib/session.ts). Subscribers (AuthContext, and through it useWebSocket) see every change.
 */

import { logClientError } from './logger';

interface DecodedToken {
  id: string;
  email: string;
  roles: string[];
  iat: number;
  exp: number;
}

type TokenListener = (token: string | null) => void;

let accessToken: string | null = null;
const listeners = new Set<TokenListener>();

const publish = (next: string | null): void => {
  accessToken = next;
  listeners.forEach((listener) => listener(next));
};

/** The current in-memory access token, or null when signed out. */
export const getToken = (): string | null => accessToken;

/**
 * Replaces the access token with one the server issued. Anything but a non-empty string (a malformed 200) throws
 * and leaves the current token in place.
 */
export const setToken = (token: unknown): string => {
  if (typeof token !== 'string' || token.length === 0) throw new Error('Malformed access token');
  publish(token);
  return token;
};

/** Forgets the access token (sign-out, or a refused refresh). */
export const removeToken = (): void => publish(null);

/** Calls `listener` on every token change until the returned unsubscribe runs. */
export const subscribeToken = (listener: TokenListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Decodes a JWT token without verification
 * Returns null if token is invalid
 */
export const decodeToken = (token: string): DecodedToken | null => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));

    return decoded as DecodedToken;
  } catch (error) {
    logClientError('Token decode failed', error);
    return null;
  }
};

/**
 * Checks if a JWT token is expired
 * Returns true if expired or invalid
 */
export const isTokenExpired = (token: string): boolean => {
  const decoded = decodeToken(token);

  if (!decoded || !decoded.exp) {
    return true;
  }

  // exp is in seconds, Date.now() is in milliseconds
  const expirationTime = decoded.exp * 1000;
  const currentTime = Date.now();

  return currentTime >= expirationTime;
};

/**
 * Checks if the token contains at least one of the specified roles
 * @param token - JWT token string
 * @param roles - Array of roles to check against
 * @returns true if user has at least one of the specified roles
 */
export const hasRole = (token: string, roles: string[]): boolean => {
  const decoded = decodeToken(token);

  if (!decoded || !decoded.roles || !Array.isArray(decoded.roles)) {
    return false;
  }

  return roles.some(role => decoded.roles.includes(role));
};

/**
 * Gets user info from the current stored token
 */
export const getUserFromToken = (): DecodedToken | null => {
  const token = getToken();

  if (!token || isTokenExpired(token)) {
    return null;
  }

  return decodeToken(token);
};
