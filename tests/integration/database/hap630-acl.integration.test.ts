// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Hosted disposable PG15/Timescale ACL acceptance. Run only in the dedicated
 * CI job: metabase_readonly is cluster-wide and other suites also use it. */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const root = join(__dirname, '../../..');
const secretTables = ['api_keys', 'credentials', 'credential_sets', 'discovery_definitions',
  'connector_configurations', 'system_config'];
const secretViews = ['active_api_keys', 'credential_summaries',
  'credential_set_summaries', 'discovery_definitions_with_credentials'];
const privateTables = ['ci_reconciliation_operations', 'ci_reconciliation_epochs'];
const reporting = ['public.recent_audit_activity', 'cmdb.v_ci_discovery_summary'];
const poolFor = (database?: string) => new Pool({
  host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
  database: database || process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'],
  password: process.env['POSTGRES_PASSWORD'],
});
const migration = () => readFileSync(join(root,
  'packages/database/src/postgres/migrations/032_secret_table_public_grants.sql'), 'utf8');
const initSql = readFileSync(join(root, 'infrastructure/scripts/init-postgres.sql'), 'utf8');
const biSetup = () => {
  const sql = readFileSync(join(root, 'infrastructure/database/metabase-init.sql'), 'utf8');
  return sql.slice(sql.indexOf('-- Only audited reporting views'),
    sql.indexOf('-- Create Helper Functions for Metabase'));
};

/** Top-level statements, `--` comments dropped, dollar-quoted bodies and string literals kept whole. */
function statements(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length;) {
    const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 40));
    if (tag) {
      const end = text.indexOf(tag[0], i + tag[0].length);
      const stop = end < 0 ? text.length : end + tag[0].length;
      cur += text.slice(i, stop);
      i = stop;
    } else if (text[i] === "'") {
      let j = i + 1;
      while (j < text.length && (text[j] !== "'" || text[j + 1] === "'")) j += text[j] === "'" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j + 1;
    } else if (text[i] === ';') {
      out.push(cur.trim());
      cur = '';
      i += 1;
    } else {
      cur += text[i];
      i += 1;
    }
  }
  return [...out, cur.trim()].filter(Boolean);
}

let db: Pool;

async function asRole(pool: Pool, role: string, sql: string, denied: boolean) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    if (denied) await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    else await expect(client.query(sql)).resolves.toMatchObject({ command: 'SELECT' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function deniedPrivileges(pool: Pool, role: string) {
  for (const table of secretTables) {
    const key = table === 'system_config' ? 'config_key' : 'id';
    for (const [privilege, sql] of [
      ['SELECT', `SELECT * FROM public.${table} LIMIT 1`],
      ['INSERT', `INSERT INTO public.${table} DEFAULT VALUES`],
      ['UPDATE', `UPDATE public.${table} SET ${key} = ${key} WHERE false`],
      ['DELETE', `DELETE FROM public.${table} WHERE false`],
    ]) {
      const { rows } = await pool.query(`SELECT has_table_privilege($1, $2, $3) AS allowed`,
        [role, `public.${table}`, privilege]);
      expect(rows[0].allowed).toBe(false);
      await asRole(pool, role, sql, true);
    }
  }
  for (const view of [...secretViews, ...privateTables]) {
    const { rows } = await pool.query(`SELECT has_table_privilege($1, $2, 'SELECT') AS allowed`,
      [role, `public.${view}`]);
    expect(rows[0].allowed).toBe(false);
    await asRole(pool, role, `SELECT * FROM public.${view} LIMIT 1`, true);
  }
}

async function appOperations(pool: Pool, role?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (role) await client.query(`SET LOCAL ROLE ${role}`);
    const key = await client.query(`INSERT INTO api_keys (user_id, key_hash, name, role)
      VALUES ('hap630', repeat('a', 64), 'test', 'agent') RETURNING id`);
    const credential = await client.query(`INSERT INTO credentials
      (name, protocol, scope, credentials, created_by)
      VALUES ('hap630', 'api_key', 'api', '{"key":"disposable"}', 'hap630') RETURNING id`);
    const set = await client.query(`INSERT INTO credential_sets (name, credential_ids, created_by)
      VALUES ('hap630', ARRAY[$1]::uuid[], 'hap630') RETURNING id`, [credential.rows[0].id]);
    await client.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.rows[0].id]);
    await client.query('UPDATE credentials SET validation_status = $1 WHERE id = $2',
      ['valid', credential.rows[0].id]);
    expect((await client.query('SELECT credentials FROM credentials WHERE id = $1',
      [credential.rows[0].id])).rows[0].credentials.key).toBe('disposable');
    expect((await client.query('SELECT id FROM credential_summaries WHERE id = $1',
      [credential.rows[0].id])).rows[0].id).toBe(credential.rows[0].id);
    await client.query('DELETE FROM credential_sets WHERE id = $1', [set.rows[0].id]);
    await client.query('DELETE FROM credentials WHERE id = $1', [credential.rows[0].id]);
    await client.query('DELETE FROM api_keys WHERE id = $1', [key.rows[0].id]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

if (process.env['HAP630_ACCEPTANCE'] !== '1') {
  it.skip('HAP-630 runs in its isolated hosted real-store job', () => {});
}

if (process.env['HAP630_ACCEPTANCE'] === '1') {
  beforeAll(async () => {
    db = poolFor();
    await db.query('CREATE ROLE hap630_nonowner LOGIN');
    await db.query('GRANT USAGE ON SCHEMA public TO hap630_nonowner');
    await db.query('CREATE ROLE metabase_readonly LOGIN');
    await db.query('CREATE ROLE cmdb_user LOGIN');
  });
  afterAll(async () => {
    if (!db) return;
    await db.query('DROP OWNED BY hap630_nonowner, metabase_readonly, cmdb_user');
    await db.query('DROP ROLE hap630_nonowner, metabase_readonly, cmdb_user');
    await db.end();
  });

  if (process.env['HAP630_BASELINE'] === '1') {
    it('rejects the base PUBLIC ACL: a new non-owner must not SELECT api_keys', async () => {
      // This same consumer-visible requirement MUST fail at the base SHA.
      await asRole(db, 'hap630_nonowner', 'SELECT * FROM public.api_keys LIMIT 1', true);
    });
  } else {
    describe('HAP-630 effective privileges', () => {
      it('migrator-built schema denies a new non-owner; owner still operates credentials and API keys', async () => {
        await deniedPrivileges(db, 'hap630_nonowner');
        await appOperations(db);
      });

      it('fresh initdb and both BI initialization orders never regrant secrets or S1 private tables', async () => {
        for (const [database, biBeforeMigration] of [
          ['hap630_bi_before', true], ['hap630_bi_after', false],
        ] as const) {
          await db.query(`CREATE DATABASE ${database}`);
          const fresh = poolFor(database);
          try {
            await fresh.query('GRANT USAGE ON SCHEMA public TO hap630_nonowner, metabase_readonly, cmdb_user');
            // Previous bootstrap default grants may predate the fresh initializer.
            if (!biBeforeMigration) await fresh.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
              GRANT SELECT ON TABLES TO metabase_readonly`);
            await fresh.query(initSql);
            await deniedPrivileges(fresh, 'hap630_nonowner');
            await appOperations(fresh, 'cmdb_user');
            if (biBeforeMigration) {
              // Model an already-provisioned legacy BI reader on an existing DB.
              await fresh.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase_readonly');
              await fresh.query('GRANT SELECT ON ALL TABLES IN SCHEMA cmdb TO metabase_readonly');
              await fresh.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
                GRANT SELECT ON TABLES TO metabase_readonly`);
              await fresh.query(migration());
              await deniedPrivileges(fresh, 'metabase_readonly');
              await fresh.query(biSetup());
            } else {
              await deniedPrivileges(fresh, 'metabase_readonly');
              await fresh.query(migration());
              await fresh.query(biSetup());
              await deniedPrivileges(fresh, 'metabase_readonly');
            }
            for (const view of reporting) {
              const { rows } = await fresh.query(`SELECT has_table_privilege('metabase_readonly', $1, 'SELECT') AS allowed`,
                [view]);
              expect(rows[0].allowed).toBe(true);
              await asRole(fresh, 'metabase_readonly', `SELECT * FROM ${view} LIMIT 1`, false);
            }
            await deniedPrivileges(fresh, 'metabase_readonly');
            await appOperations(fresh, 'cmdb_user');
            await fresh.query('CREATE TABLE public.hap630_future_probe (id int)');
            const future = await fresh.query(`SELECT has_table_privilege(
              'metabase_readonly', 'public.hap630_future_probe', 'SELECT') AS allowed`);
            expect(future.rows[0].allowed).toBe(false);
            await asRole(fresh, 'metabase_readonly', 'SELECT * FROM public.hap630_future_probe', true);
          } finally {
            await fresh.end();
            await db.query(`DROP DATABASE ${database} WITH (FORCE)`);
          }
        }
        await db.query(biSetup()); // BI after the real 001–032 migration path.
        await deniedPrivileges(db, 'metabase_readonly');
        for (const view of reporting) await asRole(db, 'metabase_readonly',
          `SELECT * FROM ${view} LIMIT 1`, false);
        await db.query(readFileSync(join(root, 'infrastructure/database/views/cost-analysis.sql'), 'utf8'));
        await asRole(db, 'metabase_readonly', 'SELECT * FROM v_cost_by_tower LIMIT 1', false);
        // HAP-659: BI reads the bounded views (no ci.metadata) and never v_top_cost_drivers, which carries it.
        for (const view of ['v_top_cost_drivers_bi', 'v_underutilized_resources']) {
          await asRole(db, 'metabase_readonly', `SELECT * FROM ${view} LIMIT 1`, false);
          const { rows } = await db.query(`SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'metadata'`, [view]);
          expect(rows[0].n).toBe(0);
        }
        await asRole(db, 'metabase_readonly', 'SELECT * FROM v_top_cost_drivers LIMIT 1', true);
        await asRole(db, 'metabase_readonly', 'SELECT * FROM cmdb.dim_ci LIMIT 1', true);
      }, 180000);

      // HAP-659 review B1/B2: the BI grant on a per-CI cost view depends on the view's shape, not only its name.
      it('cost views: an old-shape view present before BI setup, or left by a failed CREATE, is never readable by BI', async () => {
        const costSql = readFileSync(join(root, 'infrastructure/database/views/cost-analysis.sql'), 'utf8');
        const mig050 = readFileSync(join(root,
          'packages/database/src/postgres/migrations/050_bi_cost_view_grants.sql'), 'utf8');
        const stale = 'CREATE VIEW v_top_cost_drivers_bi AS SELECT ci_id, metadata FROM cmdb.dim_ci';
        const grantStale = 'GRANT SELECT ON v_top_cost_drivers_bi TO metabase_readonly';
        const drop = 'DROP VIEW IF EXISTS v_top_cost_drivers_bi, v_underutilized_resources CASCADE';
        const canRead = async (view: string) => (await db.query(
          `SELECT has_table_privilege('metabase_readonly', $1, 'SELECT') AS allowed`, [view])).rows[0].allowed;
        // psql without ON_ERROR_STOP: each top-level statement runs; a failure only prints an error.
        const loose = async (sql: string) => {
          const errors: string[] = [];
          for (const statement of statements(sql)) {
            try { await db.query(statement); } catch (error) { errors.push((error as Error).message); }
          }
          return errors;
        };
        try {
          await db.query(costSql); // v_top_cost_drivers exists, with ci.metadata
          // B1: old shapes present, then BI setup runs.
          await db.query(drop);
          await db.query(stale);
          await db.query(grantStale);
          await db.query(biSetup());
          expect(await canRead('v_top_cost_drivers_bi')).toBe(false);
          await asRole(db, 'metabase_readonly', 'SELECT * FROM v_top_cost_drivers_bi LIMIT 1', true);
          expect(await canRead('v_top_cost_drivers')).toBe(false);
          await asRole(db, 'metabase_readonly', 'SELECT * FROM v_top_cost_drivers LIMIT 1', true);
          // B2: the stale view makes the CREATE fail; the file still runs to its end, as psql would run it.
          await db.query(grantStale);
          const errors = await loose(costSql);
          expect(errors.some(e => /cannot (change name of|drop columns from) view/.test(e))).toBe(true);
          expect(await canRead('v_top_cost_drivers_bi')).toBe(false);
          await asRole(db, 'metabase_readonly', 'SELECT * FROM v_top_cost_drivers_bi LIMIT 1', true);
          await asRole(db, 'metabase_readonly', 'SELECT * FROM v_top_cost_drivers LIMIT 1', true);
          // 050 (post-restore re-grant) refuses the stale shape too, and grants the bounded shape.
          await db.query(grantStale);
          await db.query(mig050);
          expect(await canRead('v_top_cost_drivers_bi')).toBe(false);
          await db.query(drop);
          await db.query(costSql);
          await db.query('REVOKE ALL ON v_top_cost_drivers_bi, v_underutilized_resources FROM metabase_readonly');
          expect(await canRead('v_top_cost_drivers_bi')).toBe(false);
          await db.query(mig050);
          for (const view of ['v_top_cost_drivers_bi', 'v_underutilized_resources']) {
            expect(await canRead(view)).toBe(true);
            await asRole(db, 'metabase_readonly', `SELECT * FROM ${view} LIMIT 1`, false);
          }
          expect(await canRead('v_top_cost_drivers')).toBe(false);
        } finally {
          await db.query(drop);
          await db.query(costSql);
        }
      }, 180000);

      it('guarded manual down refuses wrong relation and removes exactly its ledger entry', async () => {
        const database = 'hap630_down';
        await db.query(`CREATE DATABASE ${database}`);
        const fresh = poolFor(database);
        try {
          await fresh.query(initSql);
          await fresh.query(`CREATE TABLE cmdb.schema_migrations (
            migration_name varchar(255) PRIMARY KEY, checksum varchar(64) NOT NULL)`);
          await fresh.query(migration());
          await fresh.query(`INSERT INTO cmdb.schema_migrations VALUES
            ('032_secret_table_public_grants.sql', 'disposable-proof')`);
          const down = readFileSync(join(root, 'packages/database/src/postgres/migrations/rollback',
            '032_secret_table_public_grants.down.sql'), 'utf8');
          await fresh.query('ALTER TABLE system_config RENAME TO hap630_wrong_kind');
          await expect(fresh.query(down)).rejects.toThrow('032 down wrong or missing');
          await fresh.query('ROLLBACK');
          expect((await fresh.query(`SELECT count(*)::int AS n FROM cmdb.schema_migrations
            WHERE migration_name = '032_secret_table_public_grants.sql'`)).rows[0].n).toBe(1);
          await fresh.query('ALTER TABLE hap630_wrong_kind RENAME TO system_config');
          await fresh.query(down);
          expect((await fresh.query(`SELECT count(*)::int AS n FROM cmdb.schema_migrations
            WHERE migration_name = '032_secret_table_public_grants.sql'`)).rows[0].n).toBe(0);
          expect((await fresh.query(`SELECT has_table_privilege('hap630_nonowner', 'api_keys', 'SELECT') AS allowed`))
            .rows[0].allowed).toBe(true);
          await fresh.query(migration());
          await fresh.query(`INSERT INTO cmdb.schema_migrations VALUES
            ('032_secret_table_public_grants.sql', 'disposable-proof')`);
          expect((await fresh.query(`SELECT has_table_privilege('hap630_nonowner', 'api_keys', 'SELECT') AS allowed`))
            .rows[0].allowed).toBe(false);
          await asRole(fresh, 'hap630_nonowner', 'SELECT * FROM api_keys LIMIT 1', true);
        } finally {
          await fresh.end();
          await db.query(`DROP DATABASE ${database} WITH (FORCE)`);
        }
      }, 120000);
    });
  }
}
