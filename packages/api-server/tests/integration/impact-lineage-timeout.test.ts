// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-2080, real PostgreSQL: the impact envelope's lineage read runs `set_config('statement_timeout', $1, true)` in a
// `transaction` and a timeout is SQLSTATE 57014. PGlite does not enforce statement_timeout, so only a real server proves
// the cancel, the int4 ceiling behind MAX_IMPACT_LINEAGE_TIMEOUT_MS, and that the pool client comes back.
import { getPostgresClient } from '@cmdb/database';
import { MAX_IMPACT_LINEAGE_TIMEOUT_MS } from '../../src/rest/impact-envelope';

const setTimeoutMs = (client: { query: (text: string, params: unknown[]) => Promise<unknown> }, ms: number) =>
  client.query("SELECT set_config('statement_timeout', $1, true)", [String(ms)]);

it('cancels a lineage-like statement that outlasts the transaction statement_timeout with 57014 and releases the connection', async () => {
  const postgres = getPostgresClient();
  const started = Date.now();

  await expect(postgres.transaction(async client => {
    await setTimeoutMs(client, 50);
    return client.query('SELECT pg_sleep(5)');
  })).rejects.toMatchObject({ code: '57014' });

  expect(Date.now() - started).toBeLessThan(2500); // cancelled by the timeout, not run to completion
  expect(postgres.pool.totalCount - postgres.pool.idleCount).toBe(0); // no pool client left checked out
  // SET LOCAL ended with the rolled-back transaction: the next checkout has no inherited timeout.
  expect((await postgres.query("SELECT current_setting('statement_timeout') AS t")).rows[0].t).not.toBe('50ms');
});

it('accepts the largest int4 statement_timeout and rejects one millisecond more', async () => {
  const postgres = getPostgresClient();

  await expect(postgres.transaction(client => setTimeoutMs(client, MAX_IMPACT_LINEAGE_TIMEOUT_MS))).resolves.toBeDefined();
  await expect(postgres.transaction(client => setTimeoutMs(client, MAX_IMPACT_LINEAGE_TIMEOUT_MS + 1))).rejects.toMatchObject({
    code: '22023', // invalid_parameter_value: not a timeout, so the route would answer 500
  });
});
