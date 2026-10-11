// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// Run against built workspaces; Node resolves real package exports, not Jest aliases.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

test('compiled integration hub imports and constructs its real authenticated routes', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { IntegrationHubServer } = require('./dist/index.js');
    const app = Reflect.get(new IntegrationHubServer(), 'app');
    assert.equal(typeof IntegrationHubServer.prototype.start, 'function');
    require('supertest')(app).get('/health').then(response => {
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { status: 'ok', service: 'integration-hub' });
      process.exit(0);
    }).catch(error => { console.error(error); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname + '/..', timeout: 15_000, encoding: 'utf8',
    env: {
      ...process.env, JWT_SECRET: randomBytes(32).toString('hex'),
      NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
      POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
      REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
    },
  });
  assert.equal(result.status, 0, result.stderr);
});
