// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { getPostgresClient } from './client';
import { runMigrations } from './migrator';

async function main(): Promise<void> {
  const migrationsDir = process.argv[2];
  if (!migrationsDir) {
    throw new Error('Migration directory argument is required');
  }

  const client = getPostgresClient();
  try {
    await runMigrations(client, migrationsDir);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
