// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot migrator that re-encrypts legacy plaintext credential rows in place.
 * A row is considered plaintext when its `credentials` JSONB value is not an
 * AES-256-GCM envelope (i.e. lacks string `iv`, `encryptedData`, and `authTag`).
 */

import { Pool } from 'pg';
import { getEncryptionService, logger } from '@cmdb/common';

type CredentialRow = {
  id: string;
  credentials: unknown;
};

function isEncryptionEnvelope(
  raw: unknown
): raw is { iv: string; encryptedData: string; authTag: string } {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj['iv'] === 'string' &&
    typeof obj['encryptedData'] === 'string' &&
    typeof obj['authTag'] === 'string'
  );
}

export async function migratePlaintextCredentials(
  pool: Pool
): Promise<{ scanned: number; migrated: number }> {
  const encryptionService = getEncryptionService();
  const result = await pool.query<CredentialRow>(
    'SELECT id, credentials FROM credentials'
  );

  let scanned = 0;
  let migrated = 0;

  for (const row of result.rows) {
    scanned += 1;
    if (isEncryptionEnvelope(row.credentials)) {
      continue;
    }

    const envelope = encryptionService.encrypt(JSON.stringify(row.credentials));
    await pool.query(
      'UPDATE credentials SET credentials = $2, updated_at = NOW() WHERE id = $1',
      [row.id, envelope]
    );
    migrated += 1;
  }

  logger.info('Plaintext credential migration complete', { scanned, migrated });

  return { scanned, migrated };
}
