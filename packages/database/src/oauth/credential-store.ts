// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CmdbOAuthCredentialStore: Postgres-backed CredentialStore (migration 002).
 *
 * Persists the encrypted OAuth token bundle for an oauth2 credential in the
 * `credentials.oauth_metadata` column, keyed by the credential id (the
 * substrate's sourceId). The OAuth app config (client id/secret) is supplied
 * out-of-band by env; only the sealed token bundle lands here. Plaintext tokens
 * never touch this column.
 */
import type { Pool } from 'pg';

import type { CredentialStore, StoredCredential } from '@happy-technologies/connector-core';

type OAuthMetadata = { provider: string; bundle_ciphertext: string; updated_at: string };
type CredentialOAuthRow = { oauth_metadata: OAuthMetadata | null };

export class CmdbOAuthCredentialStore implements CredentialStore {
  constructor(private readonly pool: Pool) {}

  async load(sourceId: string): Promise<StoredCredential | null> {
    const result = await this.pool.query<CredentialOAuthRow>(
      `SELECT oauth_metadata FROM credentials WHERE id = $1`,
      [sourceId]
    );
    const row = result.rows[0];
    if (row === undefined || row.oauth_metadata === null) {
      return null;
    }
    const meta = row.oauth_metadata;
    if (meta.bundle_ciphertext === '' || meta.provider === '') {
      return null;
    }
    return { ciphertext: meta.bundle_ciphertext, provider: meta.provider };
  }

  async save(sourceId: string, ciphertext: string, provider: string): Promise<void> {
    const metadata: OAuthMetadata = {
      provider,
      bundle_ciphertext: ciphertext,
      updated_at: new Date().toISOString(),
    };
    const result = await this.pool.query(
      `UPDATE credentials SET oauth_metadata = $2, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [sourceId, JSON.stringify(metadata)]
    );
    if (result.rowCount === 0) {
      throw new Error(`cannot persist OAuth tokens: no credential for source ${sourceId}`);
    }
  }

  async delete(sourceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE credentials SET oauth_metadata = NULL, updated_at = NOW() WHERE id = $1`,
      [sourceId]
    );
  }
}
