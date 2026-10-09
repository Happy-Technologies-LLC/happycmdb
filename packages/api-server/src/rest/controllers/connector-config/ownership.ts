// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Request } from 'express';
import type { Pool } from 'pg';
import type { TokenPayload } from '../../../auth/types';
import { connectorPredicate, scopeValues, PUBLIC_CONFIG, PUBLIC_RUN } from '../../../auth/connector-scope';

function user(req: Request): TokenPayload | undefined {
  return (req as Request & { user?: TokenPayload }).user;
}

export function ownedConfig(pool: Pool, req: Request, id: string, includeCredentialReference = false) {
  return pool.query(
    `SELECT ${PUBLIC_CONFIG}${includeCredentialReference ? ', credential_id' : ''} FROM connector_configurations
     WHERE id = $1 AND ${connectorPredicate('connector_configurations', 2)}`,
    [id, ...scopeValues(user(req))]
  );
}

export function ownedRun(pool: Pool, req: Request, id: string) {
  return pool.query(
    `SELECT ${PUBLIC_RUN} FROM connector_run_history
     WHERE id = $1 AND ${connectorPredicate('connector_run_history', 2)}`,
    [id, ...scopeValues(user(req))]
  );
}

export function requestScopeValues(req: Request): [string | null, boolean] {
  return scopeValues(user(req));
}
