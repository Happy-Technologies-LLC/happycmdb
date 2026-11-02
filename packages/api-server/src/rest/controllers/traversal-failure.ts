// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Response } from 'express';
import { CITraversalLimitError } from '@cmdb/database';

/**
 * HAP-562 bounded-traversal refusals: an exhausted node or adjacency-row
 * budget is 503 and a Neo4j statement timeout is 504, each with a fixed
 * body and never a truncated graph. Returns false for any other error.
 */
export function sendTraversalFailure(res: Response, error: unknown): boolean {
  if (error instanceof CITraversalLimitError) {
    res.status(503).json({ success: false, error: 'CI traversal resource limit exceeded' });
    return true;
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && (code.includes('TransactionTimedOut') || code.includes('Transaction.Terminated'))) {
    res.status(504).json({ success: false, error: 'CI traversal timed out' });
    return true;
  }
  return false;
}
