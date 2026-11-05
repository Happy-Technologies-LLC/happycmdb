// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1425 (PoR S4; Suite Contracts v2 common paging rule): the C1 list cursor, opaque to the caller and bound to the
 * tenant it was issued to: base64url(JSON position) "." base64url(HMAC-SHA256 over the tenant and that text). The key
 * is derived from the deployment's JWT signing secret, domain-separated (no new secret). A cursor that does not verify
 * for the caller's tenant byte for byte, does not parse, or is LIST_CURSOR_TTL_MS old decodes to null: the route's 404.
 */

import { createHmac, timingSafeEqual } from 'crypto';

import { loadConfig } from '@cmdb/common';

export const LIST_CURSOR_TTL_MS = 60 * 60 * 1000;

/** The keyset position after a page's last item: its sort timestamp (PostgreSQL text) and its service_id. */
export interface ListPosition { ts: string; id: string }

let key: Buffer | undefined;
function cursorKey(): Buffer {
  if (key === undefined) {
    const secret = loadConfig().auth.jwt.secret;
    if (secret === undefined || secret === '') {
      throw new Error('auth.jwt.secret is not configured; the C1 list cursor key derives from it');
    }
    key = createHmac('sha256', secret).update('happycmdb:c1-list-cursor:v1').digest();
  }
  return key;
}

const tag = (tenant: string, payload: string): string =>
  createHmac('sha256', cursorKey()).update(`${tenant}\n${payload}`).digest('base64url');

export function encodeListCursor(tenant: string, position: ListPosition, issuedAt = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ts: position.ts, id: position.id, iat: issuedAt })).toString('base64url');
  return `${payload}.${tag(tenant, payload)}`;
}

export function decodeListCursor(tenant: string, cursor: string, now = Date.now()): ListPosition | null {
  const parts = cursor.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, given] = parts as [string, string];
  // Compared as text, not decoded bytes: base64url decoding ignores a final character's spare bits.
  const expected = Buffer.from(tag(tenant, payload));
  const received = Buffer.from(given);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { ts, id, iat } = (body ?? {}) as Record<string, unknown>;
  if (typeof ts !== 'string' || typeof id !== 'string' || typeof iat !== 'number' || !(now - iat < LIST_CURSOR_TTL_MS)) {
    return null;
  }
  return { ts, id };
}
