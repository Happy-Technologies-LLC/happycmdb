// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { join } from 'path';
import { readFileSync } from 'fs';
import * as YAML from 'yamljs';
import { fork } from 'child_process';
import type { Request, Response } from 'express';

const ORG = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
// PGlite runs in a forked host: it cannot be loaded inside the jest VM.
const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<{ rows: Record<string, unknown>[] }>>();
host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, unknown>[]; error?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(new Error(error));
  else call.resolve({ rows });
});
const mockSql = (text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') => {
  const id = serial++;
  const call = Promise.withResolvers<{ rows: Record<string, unknown>[] }>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
};
jest.mock('@cmdb/database', () => {
  class Stub extends Error {}
  return {
    getNeo4jClient: () => ({ getCI: async () => ({ _incarnation_id: '11111111-1111-4111-8111-111111111111' }) }),
    getPostgresClient: () => ({ query: async (text: string, params: unknown[]) => mockSql(text, params) }),
    isStorableString: () => true, ADMISSION_LOCK_KEY: 1, JournalAbortedError: Stub, JournalConflictError: Stub, JournalGapError: Stub,
    JournalTargetMissingError: Stub, JournalUnavailableError: Stub, PlanUnrepresentableError: Stub,
  };
});
jest.mock('../../middleware/auth.middleware', () => ({ requestOrganizationId: () => ORG }));

import { schemas } from '@cmdb/common';
import { RelationshipController } from '../../rest/controllers/relationship.controller';

// HAP-2029: openapi.yaml declares what the evidence read sends, what the table accepts and what the route validates.
type Schema = { enum?: unknown[]; required?: string[]; properties?: Record<string, Schema> };
type Parameter = { name: string; required?: boolean; schema: { maximum?: number; default?: number; enum?: string[] } };
const spec = YAML.load(join(__dirname, '../openapi.yaml')) as {
  paths: Record<string, { get: { parameters: Parameter[]; responses: Record<string, unknown> } }>;
  components: { schemas: Record<string, Schema> };
};
const migration = readFileSync(join(__dirname, '../../../../database/src/postgres/migrations/054_relationship_evidence_receipts.sql'), 'utf8');
const receipt = spec.components.schemas['RelationshipEvidenceReceipt']!;
const INSERT = `INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, from_incarnation_id, to_incarnation_id,
  relationship_type, evidence_class, polarity, source_name, method, observed_at, observer, observer_type, correlation_id)
  VALUES ('${ORG}', 'a', 'b', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'USES',
  $1, $2, 'api', 'api', now(), 'o', $3, gen_random_uuid())`;

beforeAll(async () => {
  await mockSql(`CREATE TABLE ci_reconciliation_operations (id int);
    CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now()); ${migration}`, [], 'exec');
});
afterAll(() => { host.kill(); });

describe('openapi.yaml /relationships/evidence (HAP-2029)', () => {
  it('declares every field of a receipt the controller sends, all required, and nothing else', async () => {
    await mockSql(INSERT, ['declared', 'supports', 'user']);
    let sent: { data: { receipts: Array<Record<string, unknown>> } } | undefined;
    const res = { json: (body: typeof sent) => { sent = body; }, status: () => res } as unknown as Response;
    await new RelationshipController().listEvidence({ query: { from_id: 'a', to_id: 'b', type: 'USES', limit: 50, offset: 0 } } as unknown as Request, res);
    const keys = Object.keys(sent!.data.receipts[0]!).sort();
    expect(keys).toContain('receipt_id');
    expect(Object.keys(receipt.properties!).sort()).toEqual(keys);
    expect([...receipt.required!].sort()).toEqual(keys);
  });

  it('declares the class, polarity and observer type values the table accepts, and no others', async () => {
    const probe = ['declared', 'static_observed', 'runtime_observed', 'inferred', 'supports', 'contradicts', 'user', 'system', 'service', 'api_key', 'bogus'];
    const accepted = async (column: 'evidence_class' | 'polarity' | 'observer_type') => {
      const out: string[] = [];
      for (const value of probe) {
        const row = { evidence_class: 'declared', polarity: 'supports', observer_type: 'user', [column]: value };
        if (await mockSql(INSERT, [row.evidence_class, row.polarity, row.observer_type]).then(() => true, () => false)) out.push(value);
      }
      return out;
    };
    for (const column of ['evidence_class', 'polarity', 'observer_type'] as const) {
      expect((await accepted(column)).sort()).toEqual([...(receipt.properties![column]!.enum as string[])].sort());
    }
  });

  it('declares required from_id, to_id and type, the limit cap and defaults the route enforces, and the 404 and 400 answers', () => {
    const operation = spec.paths['/relationships/evidence']!.get;
    const parameter = (name: string) => operation.parameters.find(candidate => candidate.name === name)!;
    expect(operation.parameters.filter(candidate => candidate.required).map(candidate => candidate.name).sort()).toEqual(['from_id', 'to_id', 'type']);
    expect([parameter('limit').schema.maximum, parameter('limit').schema.default, parameter('offset').schema.default]).toEqual([200, 50, 0]);
    expect(Object.keys(operation.responses).sort()).toEqual(['200', '400', '401', '404']);
    const routeTypes = (schemas.relationshipType.describe() as { allow: string[] }).allow;
    expect([...parameter('type').schema.enum!].sort()).toEqual([...routeTypes].sort());
  });
});
