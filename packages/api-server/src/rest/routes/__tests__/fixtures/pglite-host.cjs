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
    const rows = op === 'exec' ? (await db.exec(sql), []) : (await db.query(sql, params)).rows;
    process.send({ id, rows });
  } catch (error) {
    // code: the SQLSTATE (e.g. '23505'), which handlers map to 409/400 like the pg driver's.
    process.send({ id, error: error.message, code: error.code });
  }
});
