// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { assertIsolatedIntegrationTarget } from '../../setup/isolated-integration-target';

const isolated = {
  CMDB_TESTCONTAINERS_RUN_ID: '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  NEO4J_URI: 'bolt://localhost:32768',
  POSTGRES_HOST: 'localhost',
  POSTGRES_DB: 'cmdb_test',
  POSTGRES_PASSWORD: 'ambient-secret',
};

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    assertIsolatedIntegrationTarget(env);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('assertIsolatedIntegrationTarget (HAP-972)', () => {
  it('refuses an ambient target that the root Testcontainers run did not mark', () => {
    const { CMDB_TESTCONTAINERS_RUN_ID: _marker, ...ambient } = isolated;
    expect(refusal(ambient)).toMatch(/^HAP-972: refusing/);
  });

  it.each([
    ['a non-loopback Neo4j', { NEO4J_URI: 'bolt://neo4j.shared.example:7687' }],
    ['a Neo4j routing URI', { NEO4J_URI: 'neo4j://localhost:7687' }],
    ['a non-loopback Postgres', { POSTGRES_HOST: 'db.shared.example' }],
    ['a database other than cmdb_test', { POSTGRES_DB: 'cmdb_datamart' }],
  ])('refuses a marked run pointed at %s without echoing the environment', (_target, override) => {
    const env = { ...isolated, ...override };
    const message = refusal(env);
    expect(message).toMatch(/^HAP-972: refusing/);
    for (const value of Object.values(env)) expect(message).not.toContain(value);
  });

  it('accepts the loopback cmdb_test target marked by the root Testcontainers run', () => {
    expect(refusal(isolated)).toBe('');
  });
});
