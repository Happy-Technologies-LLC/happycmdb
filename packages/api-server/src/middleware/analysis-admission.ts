// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { logger } from '@cmdb/common';
import { requestOrganizationId, type AuthenticatedRequest } from './auth.middleware';
import { errorLogFields } from '../utils/log-error';

const WINDOW_MS = 60_000;
const MAX_LIMITER_KEYS = 2048;
const limits = new Map<string, { start: number; count: number; active: number }>();

type AnalysisResult = { status: number; body: unknown };
type AnalysisPolicy = {
  scope: 'architecture' | 'impact';
  timeoutMs: number;
  withDeadline: <T>(deadline: number, operation: () => Promise<T>) => Promise<T>;
  deadlineError: () => Error;
  failure: (error: unknown) => { status: number; message: string } | null;
  internalError: string;
};

/** Bound verified principal and tenant work before DB access; hold slots after a timed-out response. */
export async function executeBoundedAnalysis(
  req: Request, res: Response, operation: () => Promise<AnalysisResult>, policy: AnalysisPolicy
): Promise<void> {
  const now = Date.now();
  const org = requestOrganizationId(req);
  const principal = (req as AuthenticatedRequest).user!._userId;
  const keys = [
    JSON.stringify([policy.scope, 'org', org]),
    JSON.stringify([policy.scope, 'user', org, principal]),
  ];
  const buckets: Array<{ start: number; count: number; active: number }> = [];
  const throttled = { success: false, error: `${policy.scope === 'architecture' ? 'Architecture' : 'Impact'} analysis rate limit exceeded` };
  for (const [index, key] of keys.entries()) {
    let entry = limits.get(key);
    if (!entry) {
      if (limits.size >= MAX_LIMITER_KEYS) {
        for (const [oldKey, old] of limits) {
          if (old.active === 0 && now - old.start >= WINDOW_MS) limits.delete(oldKey);
        }
      }
      if (limits.size >= MAX_LIMITER_KEYS) {
        res.status(429).json(throttled);
        return;
      }
      entry = { start: now, count: 0, active: 0 };
      limits.set(key, entry);
    }
    if (now - entry.start >= WINDOW_MS) {
      entry.start = now;
      entry.count = 0;
    }
    buckets.push(entry);
    if (entry.count >= (index === 0 ? 40 : 10) || entry.active >= (index === 0 ? 2 : 1)) {
      res.status(429).json(throttled);
      return;
    }
  }
  for (const bucket of buckets) {
    bucket.count++;
    bucket.active++;
  }
  const deadline = now + policy.timeoutMs;
  const work = policy.withDeadline(deadline, operation).finally(() => {
    for (const bucket of buckets) bucket.active--;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(policy.deadlineError()), policy.timeoutMs);
    });
    const result = await Promise.race([work, timeout]);
    if (Date.now() >= deadline) throw policy.deadlineError();
    res.status(result.status).json(result.body);
  } catch (error) {
    logger.error(`${policy.scope === 'architecture' ? 'Architecture' : 'Impact'} analysis failed`, {
      error: errorLogFields(error),
    });
    const failure = policy.failure(error);
    if (failure) res.status(failure.status).json({ success: false, error: failure.message });
    else res.status(500).json({ success: false, error: policy.internalError });
  } finally {
    clearTimeout(timer);
  }
}
