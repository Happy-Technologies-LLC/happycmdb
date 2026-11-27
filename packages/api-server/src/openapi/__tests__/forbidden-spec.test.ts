// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// The 403 responses of openapi.yaml for /cis, /business-services, /credentials, /credential-sets and the portfolio import against the
// body the role-contract refusals send (HAP-1930, forbiddenBody()): every documented example validates against the schema its response
// declares, none of those responses still describes the pre-HAP-1930 `MiddlewareError` body, and every credential operation declares a 403.
import { Media, Operation, Response, Schema, deref, spec, violations } from './spec-schema';

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

/** The refusals the router and the business-service routes still send without a `code`; founder question whether they get one. */
const BARE_BODIES: Record<string, string> = {
  agentRole: 'Credential management requires a human user',
  noVerifiedOwner: 'Verified credential owner required',
  ownerPrincipalAdminOnly: 'owner_principal_id can be set or changed only by an admin',
};
/** The one 403 whose `code` is not a ForbiddenError code (HAP-1613, the happylab-c4 tag rule); no other example may carry such a code. */
const C4_BODY = { success: false, error: 'Forbidden', code: 'c4_principal_admin_required', message: 'Only organization admins may manage the happylab-c4 credential tag' };

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
    const named = ['Forbidden', 'CIForbidden', 'BusinessServiceForbidden', 'BusinessServiceWriteForbidden', 'CredentialForbidden', 'CredentialReadForbidden', 'CredentialWriteForbidden'];
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

    it('closes the owner_principal_id refusal: the exact bare body validates, an extra key or another message does not', () => {
      const schema = mediaOf(spec.components.responses.BusinessServiceWriteForbidden!).schema!;
      const refusal = { success: false, error: 'Forbidden', message: BARE_BODIES.ownerPrincipalAdminOnly };
      expect(violations(schema, refusal)).toEqual([]);
      expect(violations(schema, { ...refusal, message: 'x' })).not.toEqual([]);
      expect(violations(schema, { ...refusal, code: 'PERMISSION_REQUIRED' })).not.toEqual([]);
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
        } else if (exampleName === 'c4PrincipalAdminRequired') {
          expect({ exampleName, body }).toEqual({ exampleName, body: C4_BODY });
        } else {
          const forbiddenCodes = spec.components.schemas.ForbiddenError!.properties!.code!.enum!;
          expect({ exampleName, isForbiddenCode: forbiddenCodes.includes(body.code) }).toEqual({ exampleName, isForbiddenCode: true });
        }
      }
    });
  });

  describe('a credential read is never refused for the write permission', () => {
    const reads = credentialOperations.filter(({ method }) => method === 'get');
    it('finds the GET credential operations', () => {
      expect(reads.length).toBeGreaterThan(0);
    });
    it.each(reads.map(({ name, operation }) => [name, operation.responses['403']!] as [string, Response]))('%s', (_name, response) => {
      const media = mediaOf(response);
      expect(Object.keys(media.examples ?? {})).not.toContain('permissionRequired');
      for (const [, value] of examplesOf(media)) expect((value as Record<string, unknown>).code).not.toBe('PERMISSION_REQUIRED');
    });
  });

  describe('every credential operation declares a 403', () => {
    it.each(credentialOperations.map(({ name, operation }) => [name, operation] as [string, Operation]))('%s', (_name, operation) => {
      expect(Object.keys(operation.responses)).toContain('403');
    });
  });
});
