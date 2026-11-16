// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Response } from 'express';
import { CITraversalLimitError } from '@cmdb/database';

/**
 * HAP-562 bounded-traversal refusals: an exhausted node or adjacency-row
 * budget is 503 and a statement timeout is 504, each with a fixed body and
 * never a truncated graph. A timeout is a Neo4j transaction deadline or, since
 * HAP-2071, the PostgreSQL statement_timeout (SQLSTATE 57014) of the impact
 * envelope's lineage read: the response then carries no coverage envelope.
 * Returns false for any other error.
 */
export function sendTraversalFailure(res: Response, error: unknown): boolean {
  if (error instanceof CITraversalLimitError) {
    res.status(503).json({ success: false, error: 'CI traversal resource limit exceeded' });
    return true;
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && (code === '57014' || code.includes('TransactionTimedOut') || code.includes('Transaction.Terminated'))) {
    res.status(504).json({ success: false, error: 'CI traversal timed out' });
    return true;
  }
  return false;
}
