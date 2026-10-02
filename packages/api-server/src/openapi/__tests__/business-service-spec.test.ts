// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI coverage for /api/v1/business-services: the operations in
 * openapi.yaml are compared with the routes actually mounted on the real
 * businessServiceRoutes Express router (enumerated from its layer stack), so
 * a route added without documentation, or a documented route that is no
 * longer mounted, fails here. The spec is loaded with yamljs, the loader the
 * /api-docs route uses.
 *
 * Substitutions (router construction only; no request is sent):
 * @cmdb/database -> stub clients; Neo4jAuthRepository -> empty class;
 * bcrypt -> {} (its native binding is only used for password hashing).
 */

import { randomBytes } from 'crypto';
import { join } from 'path';
import * as YAML from 'yamljs';

// Placeholder config so loadConfig() validates; no server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({}),
  getNeo4jClient: () => ({}),
  getAuditService: () => ({}),
}));
jest.mock('bcrypt', () => ({}));
jest.mock('../../auth/neo4j-auth.repository', () => ({ Neo4jAuthRepository: class {} }));

// Imported after mocks are registered (jest hoists jest.mock).
import { businessServiceRoutes } from '../../rest/routes/business-service.routes';

const MOUNT = '/business-services'; // server.ts: /api/v1 + this; spec servers carry /api/v1
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** "GET /business-services/{service_id}/cis" for every mounted route. */
function mountedOperations(): string[] {
  const ops: string[] = [];
  // Express's ILayer/IRoute typings omit route.methods, which is set at runtime.
  for (const layer of businessServiceRoutes.stack as unknown as RouteLayer[]) {
    if (!layer.route) continue; // router-level middleware (audit, requireOrganization)
    const path = (MOUNT + layer.route.path).replace(/\/$/, '').replace(/:(\w+)/g, '{$1}');
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) ops.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return ops.sort();
}

type Operation = { responses?: Record<string, unknown> };
const spec = YAML.load(join(__dirname, '../openapi.yaml')) as {
  paths: Record<string, Record<string, Operation>>;
};

function documentedOperations(): string[] {
  return Object.entries(spec.paths)
    .filter(([path]) => path === MOUNT || path.startsWith(`${MOUNT}/`))
    .flatMap(([path, item]) =>
      Object.keys(item).filter(m => METHODS.includes(m)).map(m => `${m.toUpperCase()} ${path}`))
    .sort();
}

describe('openapi.yaml: /business-services', () => {
  it('documents exactly the methods and paths mounted by businessServiceRoutes', () => {
    expect(documentedOperations()).toEqual(mountedOperations());
  });

  // Every route sits behind /api/v1 authenticate() (401) and the router's
  // requireOrganization() (403); every :service_id route can answer 404, and
  // the collection routes (no path parameter) cannot.
  it.each(mountedOperations())('%s documents its 401/403 (and, with a path parameter, 404) responses', op => {
    const [method, path] = op.split(' ');
    const responses = Object.keys(spec.paths[path]?.[method.toLowerCase()]?.responses ?? {});
    const expected = path.includes('{') ? ['401', '403', '404'] : ['401', '403'];
    expect(responses).toEqual(expect.arrayContaining(expected));
    if (!path.includes('{')) expect(responses).not.toContain('404');
  });
});
