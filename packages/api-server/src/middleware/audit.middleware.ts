// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response, NextFunction } from 'express';

// The CI journal is the authoritative change history. Until a journal-bound
// audit writer exists, never derive an actor or before-state from HTTP input.
export function auditMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

export function relationshipAuditMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
