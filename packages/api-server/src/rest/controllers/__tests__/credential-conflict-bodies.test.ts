// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1734: the credential and credential-set controllers pick 409/400 by error class or SQLSTATE, never by message
 * text, and answer with fixed client text. An error whose text quotes SECRET and merely contains "already exists" is
 * not a conflict; a unique violation is, and its constraint detail never reaches the body.
 */
import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import { CredentialInUseError, DuplicateCredentialNameError } from '@cmdb/common';
import { CredentialSetService } from '../../../../../database/src/postgres/credential-set.service';

process.env['CREDENTIAL_ENCRYPTION_KEY'] = randomBytes(32).toString('hex');

const SECRET = 'credential_sets_org_name_key Key (name)=(prod-root-pw) hunter2';
const ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ORG = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

type Row = Record<string, unknown>;
/** Scripted pg client: the first rule whose pattern matches the SQL answers; a function result is thrown. */
let script: Array<{ pattern: RegExp; answer: Row[] | (() => never) }> = [];
const pool = {
  connect: async () => ({
    query: async (text: string) => {
      const rule = script.find(r => r.pattern.test(text));
      if (!rule) return { rows: [] };
      if (typeof rule.answer === 'function') return rule.answer();
      return { rows: rule.answer };
    },
    release: () => undefined,
  }),
};
const credentialServiceStub: { create?: () => Promise<unknown>; update?: () => Promise<unknown>; delete?: () => Promise<unknown> } = {};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool }),
  getCredentialSetService: (p: unknown) => new CredentialSetService(p as never),
  getUnifiedCredentialService: () => credentialServiceStub,
}));
jest.mock('@cmdb/common', () => ({ ...jest.requireActual('@cmdb/common'), logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } }));

import { CredentialSetController } from '../credential-set.controller';
import { UnifiedCredentialController } from '../unified-credential.controller';

function request(body: Record<string, unknown> = {}): Request {
  return {
    params: { id: ID }, query: {}, body, headers: {}, ip: '127.0.0.1',
    user: { _userId: ID, _username: 'alice', _role: 'admin', _type: 'access', _organizationId: ORG },
  } as unknown as Request;
}
function response() {
  const out = { status: 0, body: undefined as unknown };
  const res = { status: (code: number) => { out.status = code; return res; }, json: (b: unknown) => { out.body = b; return res; }, send: () => res };
  return { res: res as unknown as Response, out };
}
const fail = (error: unknown) => () => { throw error; };
const uniqueViolation = () => Object.assign(new Error(`duplicate key value violates unique constraint "credential_sets_org_name_key" ${SECRET}`), { code: '23505' });
const fkViolation = () => Object.assign(new Error(`update or delete on table "credentials" violates foreign key constraint ${SECRET} already exists`), { code: '23503' });
const alreadyExistsButNotAConflict = () => new Error(`relation "tmp_${SECRET}" already exists`);

const setInput = { name: 'ops-set', credential_ids: [ID] };
const OWNED_CREDENTIALS = { pattern: /FROM credentials WHERE id = ANY/, answer: [{ id: ID }] as Row[] };

async function run(controller: object, handler: string, body: Record<string, unknown>) {
  const { res, out } = response();
  await (controller as Record<string, (q: Request, s: Response) => Promise<void>>)[handler]!(request(body), res);
  return { status: out.status, body: out.body, text: JSON.stringify(out.body) };
}

describe('CredentialSetController (real CredentialSetService over a scripted pool)', () => {
  const controller = () => new CredentialSetController();

  it('create: a unique violation is a fixed 409 that names only the requested name, never the constraint detail', async () => {
    script = [OWNED_CREDENTIALS, { pattern: /INSERT INTO credential_sets/, answer: fail(uniqueViolation()) }];
    const r = await run(controller(), 'create', setInput);
    expect([r.status, r.body]).toEqual([409, { success: false, error: 'Conflict', message: "Credential set with name 'ops-set' already exists" }]);
    expect(r.text).not.toContain('hunter2');
    expect(r.text).not.toContain('credential_sets_org_name_key');
  });

  it('create: without a request name the 409 carries the fixed nameless sentence', async () => {
    script = [OWNED_CREDENTIALS, { pattern: /INSERT INTO credential_sets/, answer: fail(uniqueViolation()) }];
    const r = await run(controller(), 'create', { ...setInput, name: undefined });
    expect([r.status, r.body]).toEqual([409, { success: false, error: 'Conflict', message: 'Credential set name already exists' }]);
  });

  it('create: a non-conflict error that contains "already exists" is a 500 without its text', async () => {
    script = [OWNED_CREDENTIALS, { pattern: /INSERT INTO credential_sets/, answer: fail(alreadyExistsButNotAConflict()) }];
    const r = await run(controller(), 'create', setInput);
    expect([r.status, r.body]).toEqual([500, { success: false, error: 'Failed to create credential set', message: 'Internal error' }]);
    expect(r.text).not.toContain('hunter2');
  });

  it('create: credential IDs that do not exist stay a 400 with the same sentence', async () => {
    script = [{ pattern: /FROM credentials WHERE id = ANY/, answer: [] }];
    const r = await run(controller(), 'create', setInput);
    expect([r.status, r.body]).toEqual([400, { success: false, error: 'Bad Request', message: 'One or more credential IDs do not exist' }]);
  });

  it('update: unique violation is a fixed 409; "already exists" text alone is a 500', async () => {
    script = [{ pattern: /FROM credential_sets WHERE id = \$1/, answer: [{ id: ID }] }, { pattern: /UPDATE credential_sets/, answer: fail(uniqueViolation()) }];
    const conflict = await run(controller(), 'update', { name: 'renamed' });
    expect([conflict.status, conflict.body]).toEqual([409, { success: false, error: 'Conflict', message: "Credential set with name 'renamed' already exists" }]);
    expect(conflict.text).not.toContain('hunter2');

    script = [{ pattern: /FROM credential_sets WHERE id = \$1/, answer: [{ id: ID }] }, { pattern: /UPDATE credential_sets/, answer: fail(alreadyExistsButNotAConflict()) }];
    const other = await run(controller(), 'update', { name: 'renamed' });
    expect([other.status, other.body]).toEqual([500, { success: false, error: 'Failed to update credential set', message: 'Internal error' }]);
    expect(other.text).not.toContain('hunter2');
  });

  it('delete: a set used by discovery definitions is a 409 with the curated sentence and count', async () => {
    script = [{ pattern: /SELECT id FROM credential_sets/, answer: [{ id: ID }] }, { pattern: /COUNT\(\*\)/, answer: [{ count: '2' }] }];
    const r = await run(controller(), 'delete', {});
    expect([r.status, r.body]).toEqual([409, { success: false, error: 'Conflict', message: 'Cannot delete credential set: it is currently used by 2 discovery definition(s)' }]);
  });

  it('delete: a foreign-key violation is a fixed 409; "already exists" text alone is a 500', async () => {
    script = [{ pattern: /SELECT id FROM credential_sets/, answer: [{ id: ID }] }, { pattern: /COUNT\(\*\)/, answer: [{ count: '0' }] }, { pattern: /DELETE FROM credential_sets/, answer: fail(fkViolation()) }];
    const fk = await run(controller(), 'delete', {});
    expect([fk.status, fk.body]).toEqual([409, { success: false, error: 'Conflict', message: 'Cannot delete credential set: it is currently in use' }]);
    expect(fk.text).not.toContain('hunter2');

    script = [{ pattern: /SELECT id FROM credential_sets/, answer: [{ id: ID }] }, { pattern: /COUNT\(\*\)/, answer: [{ count: '0' }] }, { pattern: /DELETE FROM credential_sets/, answer: fail(alreadyExistsButNotAConflict()) }];
    const other = await run(controller(), 'delete', {});
    expect([other.status, other.body]).toEqual([500, { success: false, error: 'Failed to delete credential set', message: 'Internal error' }]);
  });
});

describe('UnifiedCredentialController', () => {
  const controller = () => new UnifiedCredentialController();
  const body = { name: 'svc-root', protocol: 'ssh', credentials: { username: 'u', password: 'p' } };
  const dependencyFails = (handler: 'create' | 'update' | 'delete', error: unknown) => {
    credentialServiceStub[handler] = async () => { throw error; };
  };

  it.each(['create', 'update'] as const)('%s: unique violation is a fixed 409 without constraint detail; the typed duplicate keeps its sentence', async (handler) => {
    dependencyFails(handler, uniqueViolation());
    const raw = await run(controller(), handler, body);
    expect([raw.status, raw.body]).toEqual([409, { success: false, error: 'Conflict', message: "Credential with name 'svc-root' already exists for this user" }]);
    expect(raw.text).not.toContain('hunter2');

    dependencyFails(handler, new DuplicateCredentialNameError());
    const typed = await run(controller(), handler, body);
    expect([typed.status, typed.body]).toEqual([raw.status, raw.body]);
  });

  it.each(['create', 'update'] as const)('%s: a non-conflict error containing "already exists" is a 500 without its text', async (handler) => {
    dependencyFails(handler, alreadyExistsButNotAConflict());
    const r = await run(controller(), handler, body);
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('hunter2');
    expect(r.text).not.toContain('already exists');
  });

  it('delete: in-use keeps its curated sentence; FK violation is a fixed 409; "currently used" text alone is a 500', async () => {
    dependencyFails('delete', new CredentialInUseError({ discoveryDefinitions: 1, connectorConfigurations: 3 }));
    const inUse = await run(controller(), 'delete', {});
    expect([inUse.status, inUse.body]).toEqual([409, { success: false, error: 'Conflict', message: 'Cannot delete credential: it is currently used by 1 discovery definition(s) and 3 connector configuration(s)' }]);

    dependencyFails('delete', fkViolation());
    const fk = await run(controller(), 'delete', {});
    expect([fk.status, fk.body]).toEqual([409, { success: false, error: 'Conflict', message: 'Cannot delete credential: it is currently in use' }]);
    expect(fk.text).not.toContain('hunter2');

    dependencyFails('delete', new Error(`pool exhausted, connection currently used ${SECRET}`));
    const other = await run(controller(), 'delete', {});
    expect(other.status).toBe(500);
    expect(other.text).not.toContain('hunter2');
  });
});
