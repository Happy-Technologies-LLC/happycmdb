// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Same protocol as api-server's pglite-host.cjs, with the uuid-ossp contrib extension available: migration 001 runs
// CREATE EXTENSION "uuid-ossp", whose functions are extension members (staging-app-login-receipts-grant.test.ts relies on that).
const { PGlite } = require('@electric-sql/pglite');
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');

const db = new PGlite({ extensions: { uuid_ossp } });

process.on('message', async ({ id, op, sql, params }) => {
  try {
    const result = op === 'exec' ? (await db.exec(sql)).at(-1) : await db.query(sql, params);
    process.send({ id, rows: result?.rows ?? [], rowCount: result?.affectedRows });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
