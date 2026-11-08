// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh cookie of /api/v1/auth (HAP-1211 H1, B1/B4/B5/B6).
 *
 * The refresh JWT travels only in this HttpOnly cookie, never in a JSON body.
 * SameSite=Strict is the primary CSRF defence. Refresh also requires
 * AUTH_HEADER (logout does not: operator ruling Q1): a cross-origin request can only add it
 * after a CORS preflight, and the default cors() never allows credentials, so
 * such a request cannot carry the cookie. Nothing here logs the Cookie
 * header, the token or a Set-Cookie value.
 */

import type { NextFunction, Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';

export const REFRESH_COOKIE = 'cmdb_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const AUTH_HEADER = 'X-CMDB-Auth';
export const AUTH_HEADER_VALUE = '1';

/** A larger Cookie header is refused unread. */
const MAX_COOKIE_HEADER = 8192;
/** A compact JWS: three base64url segments. */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ATTRIBUTES = `Path=${REFRESH_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

/**
 * The request's cmdb_rt value; null when the Cookie header is absent or
 * oversized, has no cmdb_rt or more than one (no guessing which one wins),
 * or the value is not a compact JWS. Other cookies are ignored.
 */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER) return null;
  let value: string | null = null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    if (value !== null) return null;
    value = pair.slice(eq + 1).trim();
  }
  return value !== null && COMPACT_JWS.test(value) ? value : null;
}

/** Sets cmdb_rt to a freshly issued refresh JWT; Max-Age is that token's lifetime (exp − iat, the refresh TTL). */
export function setRefreshCookie(res: Response, refreshJwt: string): void {
  const claims = jwt.decode(refreshJwt);
  const lifetime = claims !== null && typeof claims === 'object' ? Number(claims.exp) - Number(claims.iat) : Number.NaN;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) throw new Error('Refresh lifetime unavailable');
  res.append('Set-Cookie', `${REFRESH_COOKIE}=${refreshJwt}; Max-Age=${lifetime}; ${ATTRIBUTES}`);
}

/** Expires cmdb_rt with the same attributes it was set with. */
export function clearRefreshCookie(res: Response): void {
  res.append('Set-Cookie', `${REFRESH_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${ATTRIBUTES}`);
}

/** CSRF guard of /auth/refresh: exactly `X-CMDB-Auth: 1`, else a fixed 403 before any token or store work. */
export function requireAuthHeader(req: Request, res: Response, next: NextFunction): void {
  if (req.get(AUTH_HEADER) === AUTH_HEADER_VALUE) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: 'Forbidden' });
}
