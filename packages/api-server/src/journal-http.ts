// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1 v16 §3.6 request validation and §4.4 reserved keys for journaled
 * writers (400 before any journal or data query), and the one mapping of
 * journal outcomes to REST/GraphQL responses.
 */
import type { NextFunction, Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import {
  isStorableString, JournalAbortedError, JournalConflictError, JournalGapError, JournalTargetMissingError,
  JournalUnavailableError, PlanUnrepresentableError,
} from '@cmdb/database';
import type { AuthenticatedRequest } from './middleware/auth.middleware';
import { CIGapError } from './read-admission';

/** The verified JWT/API-key user id: the journal actor (never a client header). */
export function requestActor(req: Request): string {
  const actor = (req as AuthenticatedRequest).user?._userId;
  if (!actor) throw new Error('Journaled handler reached without authentication');
  return actor;
}
export class RequestShapeError extends Error {
  constructor() { super('Invalid request'); }
}

const RESERVED: Record<string, true> = { id: true, organization_id: true, organizationid: true, op_id: true, reconciliation_op_id: true };
/** v16 §4.4 norm(k) = lowercase(k without leading underscores). */
export function isReservedKey(key: string): boolean {
  return RESERVED[key.replace(/^_+/, '').toLowerCase()] === true;
}

/** §3.6 limits on strings (member names too), depth, collections, size; returns JSON bytes, summed once bottom-up. */
export function assertRequestShape(value: unknown, depth = 0): number {
  if (depth > 32) throw new RequestShapeError();
  let size = value !== null && typeof value === 'object' ? 0 : Buffer.byteLength(JSON.stringify(value) ?? '');
  if (typeof value === 'string') {
    if (!isStorableString(value)) throw new RequestShapeError();
  } else if (Array.isArray(value)) {
    if (value.length > 1000) throw new RequestShapeError();
    size = value.reduce((total: number, member) => total + assertRequestShape(member, depth + 1),
      Math.max(value.length, 1) + 1);
  } else if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 1000) throw new RequestShapeError();
    size = Math.max(entries.length, 1) + 1;
    for (const [key, member] of entries) {
      if (key.length < 1 || key.length > 255 || !isStorableString(key)) throw new RequestShapeError();
      const bytes = assertRequestShape(member, depth + 1);
      if (bytes > 65_536) throw new RequestShapeError();
      size += Buffer.byteLength(JSON.stringify(key)) + 1 + bytes;
    }
  }
  if (depth === 0 && size > 1_048_576) throw new RequestShapeError();
  return size;
}

export function assertCIId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length < 1 || id.length > 255 || !isStorableString(id)) throw new RequestShapeError();
}

/** Reserved member names at any depth (metadata, relationship properties). */
export function assertNoReservedMembers(value: unknown): void {
  if (Array.isArray(value)) value.forEach(assertNoReservedMembers);
  else if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) {
      if (isReservedKey(key)) throw new RequestShapeError();
      assertNoReservedMembers(member);
    }
  }
}

/** Neo4j-storable property map: null, boolean, finite number, string, or a homogeneous array of those. */
export function assertStorableProperties(props: Record<string, unknown>): void {
  for (const value of Object.values(props)) {
    const members = Array.isArray(value) ? value : [value];
    const kinds = new Set(members.map(member => member === null ? 'null' : typeof member));
    if (kinds.size > 1 || [...kinds].some(kind => !['null', 'boolean', 'number', 'string'].includes(kind)) ||
      members.some(member => typeof member === 'number' && !Number.isFinite(member))) throw new RequestShapeError();
  }
}

/**
 * Route guard for journaled CI writes, run on the raw body before Joi strips
 * unknown keys: path ids, §3.6 shape, top-level reserved keys (a client `id` included:
 * CI ids are server-issued, T5), reserved names inside metadata and relationship properties.
 */
export function journalRequestGuard(options: { relationship?: boolean; merge?: boolean; resolve?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      for (const param of Object.values(req.params)) if (param !== undefined) assertCIId(param);
      const body: Record<string, unknown> = req.body ?? {};
      assertRequestShape(body);
      if (Object.keys(body).some(isReservedKey)) throw new RequestShapeError();
      assertNoReservedMembers(body['metadata']);
      // Merge attributes become graph properties; reserved names there are dropped by the engine (§4.4).
      if (options.merge) assertStorableProperties((body['attributes'] ?? {}) as Record<string, unknown>);
      // A merge resolution writes merged_data as the field's graph value (v16 §7.4).
      if (options.resolve) assertStorableProperties({ merged: body['merged_data'] ?? null });
      if (options.relationship) {
        assertCIId(body['from_id']);
        assertCIId(body['to_id']);
        const props = body['properties'] ?? {};
        if (typeof props !== 'object' || props === null || Array.isArray(props)) throw new RequestShapeError();
        assertNoReservedMembers(props);
        assertStorableProperties(props as Record<string, unknown>);
      }
      next();
    } catch {
      res.status(400).json({ success: false, error: 'Bad Request', message: 'Invalid request' });
    }
  };
}

/** Maps a journal outcome to its sanitized REST response. False when `error` is not one. */
export function sendJournalError(res: Response, error: unknown): boolean {
  if (error instanceof JournalGapError || error instanceof CIGapError) {
    res.status(409).json({ success: false, error: 'Conflict', message: 'CI is temporarily unavailable' });
  } else if (error instanceof JournalUnavailableError) {
    res.status(503).json({ success: false, error: 'Service Unavailable', message: 'CI write temporarily unavailable',
      ...(error.correlationId ? { correlation_id: error.correlationId } : {}) });
  } else if (error instanceof JournalAbortedError) {
    res.status(409).json({ success: false, error: 'Conflict', message: 'CI could not be reconciled' });
  } else if (error instanceof JournalConflictError) {
    res.status(409).json({ success: false, error: 'Conflict', message: error.reason });
  } else if (error instanceof PlanUnrepresentableError) {
    res.status(422).json({ success: false, error: 'Unprocessable Entity', message: 'CI cannot be changed through the audited path' });
  } else if (error instanceof JournalTargetMissingError) {
    res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
  } else if (error instanceof RequestShapeError) {
    res.status(400).json({ success: false, error: 'Bad Request', message: 'Invalid request' });
  } else {
    return false;
  }
  return true;
}

/** GraphQL form of sendJournalError; null when `error` is not a journal outcome. */
export function journalGraphQLError(error: unknown): GraphQLError | null {
  const [code, message] =
    error instanceof JournalGapError || error instanceof CIGapError ? ['CONFLICT', 'CI is temporarily unavailable']
    : error instanceof JournalUnavailableError ? ['SERVICE_UNAVAILABLE', 'CI write temporarily unavailable']
    : error instanceof JournalAbortedError ? ['CONFLICT', 'CI could not be reconciled']
    : error instanceof JournalConflictError ? ['CONFLICT', error.reason]
    : error instanceof PlanUnrepresentableError ? ['UNPROCESSABLE_ENTITY', 'CI cannot be changed through the audited path']
    : error instanceof JournalTargetMissingError ? ['NOT_FOUND', 'CI not found']
    : error instanceof RequestShapeError ? ['BAD_USER_INPUT', 'Invalid request']
    : [null, null];
  return code ? new GraphQLError(message!, { extensions: { code } }) : null;
}
