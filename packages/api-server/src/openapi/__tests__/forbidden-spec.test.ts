// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// The 403 responses of openapi.yaml for /cis, /business-services, /credentials, /credential-sets and the portfolio import against the
// body the role-contract refusals send (HAP-1930, forbiddenBody()): every documented example validates against the schema its response
// declares, none of those responses still describes the pre-HAP-1930 `MiddlewareError` body, and every credential operation declares a 403.
import { join } from 'path';
import * as YAML from 'yamljs';

type Schema = {
  $ref?: string; type?: string; nullable?: boolean; required?: string[]; additionalProperties?: boolean;
  properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; anyOf?: Schema[]; oneOf?: Schema[];
};
type Media = { schema?: Schema; example?: unknown; examples?: Record<string, { value: unknown }> };
type Response = { $ref?: string; content?: { 'application/json': Media } };
type Operation = { operationId?: string; responses: Record<string, Response> };
const spec = YAML.load(join(__dirname, '../openapi.yaml')) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, Response> };
};

/** Follows `$ref` (any `#/a/b/c` pointer into the spec) until a node that is not one. */
function deref<T extends { $ref?: string }>(node: T): T {
  if (!node.$ref) return node;
  return deref(node.$ref.replace('#/', '').split('/').reduce<any>((at, key) => at[key], spec));
}

/**
 * A small JSON-schema check, enough for the keywords the 403 schemas use: $ref, type, nullable, enum, required, properties,
 * additionalProperties: false, items, anyOf and oneOf (exactly one branch). ajv is only a transitive dependency of the lint stack
 * (v6), so it is not imported here. Returns the violations; empty means the value satisfies the schema.
 */
function violations(schema: Schema, value: unknown, at = '$'): string[] {
  const node = deref(schema);
  if (value === null && node.nullable) return [];
  const found: string[] = [];
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (node.type && !(node.type === kind || (node.type === 'integer' && Number.isInteger(value)))) found.push(`${at}: expected ${node.type}, got ${kind}`);
  if (node.enum && !node.enum.includes(value)) found.push(`${at}: ${JSON.stringify(value)} is not in the enum`);
  if (kind === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of node.required ?? []) if (!(key in object)) found.push(`${at}: missing ${key}`);
    for (const [key, child] of Object.entries(node.properties ?? {})) if (key in object) found.push(...violations(child, object[key], `${at}.${key}`));
    if (node.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in (node.properties ?? {}))) found.push(`${at}: unexpected ${key}`);
  }
  if (kind === 'array' && node.items) (value as unknown[]).forEach((item, index) => found.push(...violations(node.items!, item, `${at}[${index}]`)));
  if (node.anyOf && !node.anyOf.some(branch => violations(branch, value, at).length === 0)) found.push(`${at}: matches no anyOf branch`);
  if (node.oneOf) {
    const matched = node.oneOf.filter(branch => violations(branch, value, at).length === 0).length;
    if (matched !== 1) found.push(`${at}: matches ${matched} oneOf branches, exactly 1 required`);
  }
  return found;
}

/** Every schema `$ref` reachable from a schema node, following anyOf, oneOf and items but not into the referenced schemas. */
function referenced(schema: Schema): string[] {
  return [
    ...(schema.$ref ? [schema.$ref] : []),
    ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.items ? [schema.items] : [])].flatMap(referenced),
  ];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const operations = (include: (path: string) => boolean): Array<{ name: string; path: string; method: string; operation: Operation }> =>
  Object.entries(spec.paths)
    .filter(([path]) => include(path))
    .flatMap(([path, item]) => METHODS.filter(method => item[method]).map(method => ({ name: `${method.toUpperCase()} ${path}`, path, method, operation: item[method]! })));

const credentialOperations = operations(path => /^\/(credentials|credential-sets)(\/|$)/.test(path));
const refusingOperations = [
  ...operations(path => /^\/(cis|business-services|credentials|credential-sets)(\/|$)/.test(path)),
  ...operations(path => path === '/portfolio/imports'),
].filter(({ operation }) => operation.responses['403']);

/** The two refusals the router and the business-service routes still send without a `code`; founder question whether they get one. */
const BARE_BODIES: Record<string, string> = {
  agentRole: 'Credential management requires a human user',
  noVerifiedOwner: 'Verified credential owner required',
  ownerPrincipalAdminOnly: 'owner_principal_id can be set or changed only by an admin',
};

const examplesOf = (media: Media): Array<[string, unknown]> => [
  ...(media.example === undefined ? [] : [['example', media.example] as [string, unknown]]),
  ...Object.entries(media.examples ?? {}).map(([name, example]) => [name, example.value] as [string, unknown]),
];
const mediaOf = (response: Response): Media => deref(response).content!['application/json'];

describe('403 responses in openapi.yaml', () => {
  it('finds the operations it guards', () => {
    expect(refusingOperations.length).toBeGreaterThan(0);
    expect(credentialOperations.length).toBeGreaterThan(0);
  });

  describe('every example validates against the schema its response declares', () => {
    const named = ['Forbidden', 'CIForbidden', 'BusinessServiceForbidden', 'BusinessServiceWriteForbidden', 'CredentialForbidden'];
    const responses: Array<[string, Response]> = [
      ...named.map(name => [`components/responses/${name}`, spec.components.responses[name]!] as [string, Response]),
      ...refusingOperations.map(({ name, operation }) => [name, operation.responses['403']!] as [string, Response]),
    ];

    it.each(responses)('%s', (_name, response) => {
      const media = mediaOf(response);
      const examples = examplesOf(media);
      expect(examples.length).toBeGreaterThan(0);
      for (const [exampleName, value] of examples) expect({ exampleName, violations: violations(media.schema!, value) }).toEqual({ exampleName, violations: [] });
    });

    it('rejects a bare body carrying a code that ForbiddenError does not define', () => {
      const body = { ...JSON.parse(JSON.stringify(mediaOf(spec.components.responses.CredentialForbidden!).examples!.noVerifiedOwner!.value)), code: 'NO_SUCH_CODE' };
      expect(violations(mediaOf(spec.components.responses.CredentialForbidden!).schema!, body)).not.toEqual([]);
    });
  });

  describe('no 403 still describes the pre-HAP-1930 body', () => {
    it.each(refusingOperations.map(({ name, operation }) => [name, operation.responses['403']!] as [string, Response]))('%s', (_name, response) => {
      const media = mediaOf(response);
      expect(referenced(media.schema!)).not.toContain('#/components/schemas/MiddlewareError');
      for (const [exampleName, value] of examplesOf(media)) {
        const body = value as Record<string, unknown>;
        if (exampleName in BARE_BODIES) {
          expect({ exampleName, body }).toEqual({ exampleName, body: { success: false, error: 'Forbidden', message: BARE_BODIES[exampleName] } });
        } else {
          expect({ exampleName, code: typeof body.code }).toEqual({ exampleName, code: 'string' });
        }
      }
    });
  });

  describe('every credential operation declares a 403', () => {
    it.each(credentialOperations.map(({ name, operation }) => [name, operation] as [string, Operation]))('%s', (_name, operation) => {
      expect(Object.keys(operation.responses)).toContain('403');
    });
  });
});
