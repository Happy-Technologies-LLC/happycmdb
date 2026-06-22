// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CmdbOAuthStateStore: Postgres-backed OAuthStateStore (migration 002).
 *
 * Backs the authorize -> redirect -> callback round trip across nodes (the
 * connector-core in-memory default only works single-instance). Rows are
 * single-use (taken on callback) and short-lived (TTL set by the substrate).
 * `data` holds the ephemeral PendingAuth (sourceId, providerId, single-use
 * code verifier), never a long-lived credential.
 */
import type { Pool } from 'pg';

import type { OAuthStateStore, PendingAuth } from '@happy-technologies/connector-core';

type OAuthStateRow = { data: PendingAuth; expires_at: Date | string };

export class CmdbOAuthStateStore implements OAuthStateStore {
  constructor(private readonly pool: Pool) {}

  async put(state: string, data: PendingAuth, ttlMs: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.pool.query(
      `INSERT INTO oauth_states (state, data, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (state) DO UPDATE
         SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [state, JSON.stringify(data), expiresAt]
    );
  }

  async take(state: string): Promise<PendingAuth | null> {
    const result = await this.pool.query<OAuthStateRow>(
      `DELETE FROM oauth_states WHERE state = $1 RETURNING data, expires_at`,
      [state]
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }
    return row.data;
  }
}
