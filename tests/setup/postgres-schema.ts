// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { StartedTestContainer } from 'testcontainers';

/** Load the canonical schema and every migration, not only the initial tables. */
export async function loadPostgresSchema(
  container: StartedTestContainer,
  user: string,
  database: string
): Promise<void> {
  const directory = resolve(process.cwd(), 'packages/database/src/postgres/migrations');
  const files = readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  for (const file of files) {
    const target = `/tmp/${file}`;
    await container.copyContentToContainer([{
      content: readFileSync(resolve(directory, file), 'utf-8'), target,
    }]);
    // The initial schema has non-fatal legacy Timescale notices. Tenant and
    // journal migrations must abort on every SQL error, atomically.
    const guarded = /^0(28|29|30|31|32|33|34|35|36|37)_/.test(file);
    const load = await container.exec([
      'psql', '-v', `ON_ERROR_STOP=${guarded ? '1' : '0'}`,
      ...(guarded ? ['-1'] : []), '-U', user, '-d', database, '-f', target,
    ]);
    if (guarded && load.exitCode !== 0) {
      throw new Error(`Guarded migration ${file} failed: ${load.output}`);
    }
    if (!guarded && load.exitCode !== 0) {
      console.warn(`psql load of ${file} exited with code ${load.exitCode} (non-fatal notices expected)`);
    }
  }

  const check = await container.exec([
    'psql', '-U', user, '-d', database, '-tAc',
    "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('api_keys', 'oauth_states', 'ci_reconciliation_operations', 'ci_reconciliation_epochs')",
  ]);
  if (check.output.trim() !== '4') {
    throw new Error(`PostgreSQL schema load failed: required tables missing (psql output: ${check.output.trim()})`);
  }
}
