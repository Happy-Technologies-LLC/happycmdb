// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { join } from 'path';
import * as YAML from 'yamljs';

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ query: async () => ({ rows: [] }) }),
}));

import { COVERAGE_NOTE, IMPACT_BASIS, RUNTIME_BLAST_RADIUS, impactEnvelope } from '../../rest/impact-envelope';

// HAP-2028: openapi.yaml declares exactly what the four impact reads send.
type Schema = {
  $ref?: string; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>;
};
const spec = YAML.load(join(__dirname, '../openapi.yaml')) as {
  paths: Record<string, { get: { responses: Record<string, { content: { 'application/json': { schema: Schema } } }> } }>;
  components: { schemas: Record<string, Schema> };
};
const resolve = (schema: Schema): Schema => {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace('#/components/schemas/', '');
  const target = spec.components.schemas[name];
  if (!target) throw new Error(`Unresolved ${schema.$ref}`);
  return resolve(target);
};
const body = (path: string): Schema => resolve(spec.paths[path]!.get.responses['200']!.content['application/json'].schema);

const OPERATIONS = ['/cis/{id}/impact', '/cis/{id}/dependencies', '/impact/graph/{rootCiId}', '/business-services/{service_id}/context'];

describe.each(OPERATIONS)('openapi.yaml %s (HAP-2028)', path => {
  it('declares the basis, runtime_blast_radius and coverage the controller sends', async () => {
    const schema = body(path);
    const props = schema.properties!;
    const sent = await impactEnvelope('11111111-1111-4111-8111-111111111111', ['ci-1']);

    expect(schema.required).toEqual(expect.arrayContaining(['basis', 'runtime_blast_radius', 'coverage']));
    expect(resolve(props.basis!).enum).toEqual([IMPACT_BASIS]);
    expect(resolve(props.runtime_blast_radius!).enum).toEqual([RUNTIME_BLAST_RADIUS]);
    const coverage = resolve(props.coverage!);
    expect(Object.keys(coverage.properties!).sort()).toEqual(Object.keys(sent.coverage).sort());
    expect(coverage.required!.sort()).toEqual(Object.keys(sent.coverage).sort());
    expect(resolve(coverage.properties!.runtime_observed_receipts_in_scope!).enum).toEqual([sent.coverage.runtime_observed_receipts_in_scope]);
    expect(sent.coverage.note).toBe(COVERAGE_NOTE);
  });
});
