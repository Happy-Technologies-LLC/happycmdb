// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh cookie of /api/v1/auth (HAP-1211 H1, B1/B4/B5/B6; H2 renamed it __Secure-cmdb_rt).
 *
 * The refresh JWT travels only in this HttpOnly cookie, never in a JSON body.
 * SameSite=Strict keeps the browser from sending this cookie on a cross-site request, so a cross-site
 * request cannot refresh with it. Refresh also requires AUTH_HEADER, and login sets the cookie only
 * when AUTH_HEADER is present (H2 gate F2: a cross-site form login cannot plant one).
 * A cross-origin request can only add the header after a CORS preflight, and the
 * default cors() never allows credentials, so such a request cannot carry the cookie.
 * Accepted residual (HAP-1297): logout requires neither AUTH_HEADER nor the cookie (operator ruling Q1), so a
 * cross-site POST can still sign a browser out. SameSite=Strict does not limit that: the request needs no
 * cookie to be answered with the expiring Set-Cookie. The impact is bounded by what logout does: it only
 * expires this cookie; it reads, issues and revokes nothing.
 * Nothing here logs the Cookie header, the token or a Set-Cookie value.
 */

import type { NextFunction, Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { SESSION_ABSOLUTE_CAP_SECONDS } from '../../auth/auth.service';

/** HAP-1211 H2: the __Secure- prefix makes browsers refuse this name from a non-https origin (no plain-http fixation). */
export const REFRESH_COOKIE = '__Secure-cmdb_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const AUTH_HEADER = 'X-CMDB-Auth';
export const AUTH_HEADER_VALUE = '1';

/** A larger Cookie header is refused unread. */
const MAX_COOKIE_HEADER = 8192;
/** A compact JWS: three base64url segments. */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ATTRIBUTES = `Path=${REFRESH_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

/**
 * The request's __Secure-cmdb_rt value; null when the Cookie header is absent or
 * oversized, has no __Secure-cmdb_rt or more than one (no guessing which one wins),
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

/**
 * Sets __Secure-cmdb_rt to a freshly issued refresh JWT. Max-Age is that token's lifetime (exp − iat, the refresh TTL),
 * clamped (HAP-1382 L4) to what is left at issue of the 7-day absolute cap from `_authTime` (never below 0): the cookie
 * never outlives the session /auth/refresh still accepts, whatever the refresh TTL or how often it was renewed.
 */
export function setRefreshCookie(res: Response, refreshJwt: string): void {
  const claims = jwt.decode(refreshJwt);
  const [exp, iat, authTime] = claims !== null && typeof claims === 'object'
    ? [Number(claims.exp), Number(claims.iat), Number(claims['_authTime'])] : [Number.NaN, Number.NaN, Number.NaN];
  const lifetime = exp - iat;
  const capLeft = authTime + SESSION_ABSOLUTE_CAP_SECONDS - iat;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || !Number.isSafeInteger(capLeft)) {
    throw new Error('Refresh lifetime unavailable');
  }
  res.append('Set-Cookie', `${REFRESH_COOKIE}=${refreshJwt}; Max-Age=${Math.max(0, Math.min(lifetime, capLeft))}; ${ATTRIBUTES}`);
}

/** Expires __Secure-cmdb_rt with the same attributes it was set with. */
export function clearRefreshCookie(res: Response): void {
  res.append('Set-Cookie', `${REFRESH_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${ATTRIBUTES}`);
}

/** True when the request carries exactly `X-CMDB-Auth: 1`, which only a same-origin script (or a preflighted request) can add. */
export function hasAuthHeader(req: Request): boolean {
  return req.get(AUTH_HEADER) === AUTH_HEADER_VALUE;
}

/** CSRF guard of /auth/refresh: exactly `X-CMDB-Auth: 1`, else a fixed 403 before any token or store work. */
export function requireAuthHeader(req: Request, res: Response, next: NextFunction): void {
  if (hasAuthHeader(req)) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: 'Forbidden' });
}
