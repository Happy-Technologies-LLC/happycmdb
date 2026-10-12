// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response, NextFunction } from 'express';
import { logger } from '@cmdb/common';
import { optionalRequestOrganizationId, requestOrganizationId, type AuthenticatedRequest } from './auth.middleware';
import { errorLogFields } from '../utils/log-error';

const WINDOW_MS = 60_000;
const MAX_LIMITER_KEYS = 2048;
const limits = new Map<string, { start: number; count: number; active: number }>();
// GraphQL's cardinality must not fill the impact/architecture limiter table.
const graphqlLimits = new Map<string, { start: number; count: number; active: number }>();
const graphQLWork = new WeakMap<Request, {
  started: boolean; completed: boolean; closed: boolean; release: () => void;
}>();

type AnalysisResult = { status: number; body: unknown };
type AnalysisPolicy = {
  scope: 'architecture' | 'impact' | 'dashboard';
  timeoutMs: number;
  withDeadline: <T>(deadline: number, operation: () => Promise<T>) => Promise<T>;
  deadlineError: () => Error;
  failure: (error: unknown) => { status: number; message: string } | null;
  internalError: string;
};

/** Shared verified-principal/tenant admission, with GraphQL consuming only concurrency slots. */
function reserveWorkSlots(
  scope: 'architecture' | 'impact' | 'dashboard' | 'graphql', org: string, principal: string,
  rateLimited: boolean
): (() => void) | null {
  const now = Date.now();
  const store = scope === 'graphql' ? graphqlLimits : limits;
  const keys = [
    JSON.stringify([scope, 'org', org]),
    JSON.stringify([scope, 'user', org, principal]),
  ];
  const buckets: Array<{ start: number; count: number; active: number }> = [];
  for (const [index, key] of keys.entries()) {
    let entry = store.get(key);
    if (!entry) {
      if (store.size >= MAX_LIMITER_KEYS) {
        for (const [oldKey, old] of store) {
          if (old.active === 0 && now - old.start >= WINDOW_MS) store.delete(oldKey);
        }
      }
      if (store.size >= MAX_LIMITER_KEYS) return null;
      entry = { start: now, count: 0, active: 0 };
      store.set(key, entry);
    }
    if (now - entry.start >= WINDOW_MS) {
      entry.start = now;
      entry.count = 0;
    }
    buckets.push(entry);
    if ((rateLimited && entry.count >= (index === 0 ? 40 : 10))
      || entry.active >= (index === 0 ? 2 : 1)) return null;
  }
  for (const bucket of buckets) {
    if (rateLimited) bucket.count++;
    bucket.active++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const bucket of buckets) bucket.active--;
  };
}

/** Authenticate first; keep resolver-level FORBIDDEN parity for a missing tenant claim. */
export function admitGraphQLRequest(req: Request, res: Response, next: NextFunction): void {
  // Authentication may finish after the client has already closed the socket.
  if (res.destroyed || res.writableEnded) return;
  // Apollo rejects a bodyless POST without invoking request hooks; GET queries use the URL.
  if (!req.body && req.method !== 'GET') {
    next();
    return;
  }
  // A verified identity without an organization still consumes principal/tenant slots;
  // use a non-UUID bucket rather than allowing unbounded work before resolver denial.
  const org = optionalRequestOrganizationId(req) ?? 'missing-organization-claim';
  const principal = (req as AuthenticatedRequest).user!._userId;
  const release = reserveWorkSlots('graphql', org, principal, false);
  if (!release) {
    res.status(429).json({ errors: [{
      message: 'GraphQL concurrent request limit exceeded', extensions: { code: 'TOO_MANY_REQUESTS' },
    }] });
    return;
  }
  const work = { started: false, completed: false, closed: false, release };
  graphQLWork.set(req, work);
  const onClosed = () => {
    work.closed = true;
    // A pre-operation disconnect has no running resolver work to protect.
    // The Apollo start hook refuses any later attempt to execute on this socket.
    if (work.completed || !work.started) release();
  };
  res.once('finish', onClosed);
  res.once('close', onClosed);
  next();
}

/** Refuse operation work that starts after the client disconnected and freed its slot. */
export function graphQLWorkStarted(req: Request): boolean {
  const work = graphQLWork.get(req);
  if (!work || work.closed) return false;
  work.started = true;
  return true;
}

/** Do not free a disconnected client's slot while its GraphQL resolvers still run. */
export function graphQLWorkCompleted(req: Request): void {
  const work = graphQLWork.get(req);
  if (!work) return;
  work.completed = true;
  if (work.closed) work.release();
}

/** Bound verified principal and tenant work before DB access; hold slots after a timed-out response. */
export async function executeBoundedAnalysis(
  req: Request, res: Response, operation: () => Promise<AnalysisResult>, policy: AnalysisPolicy
): Promise<void> {
  const now = Date.now();
  const org = requestOrganizationId(req);
  const principal = (req as AuthenticatedRequest).user!._userId;
  const release = reserveWorkSlots(policy.scope, org, principal, true);
  if (!release) {
    res.status(429).json({ success: false,
      error: `${policy.scope[0]!.toUpperCase()}${policy.scope.slice(1)} analysis rate limit exceeded` });
    return;
  }
  const deadline = now + policy.timeoutMs;
  const work = policy.withDeadline(deadline, operation).finally(release);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(policy.deadlineError()), policy.timeoutMs);
    });
    const result = await Promise.race([work, timeout]);
    if (Date.now() >= deadline) throw policy.deadlineError();
    res.status(result.status).json(result.body);
  } catch (error) {
    logger.error(`${policy.scope[0]!.toUpperCase()}${policy.scope.slice(1)} analysis failed`, {
      error: errorLogFields(error),
    });
    const failure = policy.failure(error);
    if (failure) res.status(failure.status).json({ success: false, error: failure.message });
    else res.status(500).json({ success: false, error: policy.internalError });
  } finally {
    clearTimeout(timer);
  }
}
