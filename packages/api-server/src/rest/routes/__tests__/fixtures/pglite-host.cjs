// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Hosts an in-memory PGlite (PostgreSQL compiled to WASM) in a child process.
// PGlite loads its WASM via dynamic import(), which Jest's module VM rejects
// without --experimental-vm-modules; tests fork this file and send SQL over IPC
// (serialization: 'advanced', so Date values survive the hop).
const { PGlite } = require('@electric-sql/pglite');

const db = new PGlite();

process.on('message', async ({ id, op, sql, params }) => {
  try {
    // exec: simple protocol (several statements allowed); rows of the last statement.
    const rows = op === 'exec' ? ((await db.exec(sql)).at(-1)?.rows ?? []) : (await db.query(sql, params)).rows;
    process.send({ id, rows });
  } catch (error) {
    // Mirror pg's SQLSTATE and named CHECK constraint for response classification.
    process.send({ id, error: error.message, code: error.code, constraint: error.constraint });
  }
});
