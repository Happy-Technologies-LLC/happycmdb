// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// `node -r ts-source-register.cjs -r <this file> some-cli.ts`: replaces only the
// `driver()` factory of the real neo4j-driver so a CLI run as a real process
//   - prints the (uri, config) the shared Neo4jClient handed to the driver as
//     one stderr line `neo4j-driver-config {"uri":...,"config":{...}}`, and
//   - gets a driver whose sessions and transactions reject at once, so no
//     socket is opened and the driver's managed-transaction retry (about 30 s
//     on a refused connection) never starts.
'use strict';

const neo4j = require('neo4j-driver');

const unavailable = () => Promise.reject(new Error('stub neo4j driver: no connection'));

function stubSession() {
  return {
    run: unavailable,
    executeRead: unavailable,
    executeWrite: unavailable,
    beginTransaction: () => ({ run: unavailable, commit: unavailable, rollback: unavailable, isOpen: () => false }),
    close: () => Promise.resolve(),
  };
}

function stubDriver(uri, _auth, config) {
  process.stderr.write(`neo4j-driver-config ${JSON.stringify({ uri, config })}\n`);
  return {
    session: stubSession,
    verifyConnectivity: unavailable,
    close: () => Promise.resolve(),
  };
}

// `import neo4j from 'neo4j-driver'` compiled to CommonJS reads `.default.driver`.
for (const target of [neo4j, neo4j.default]) {
  Object.defineProperty(target, 'driver', { value: stubDriver, configurable: true, writable: true });
}
