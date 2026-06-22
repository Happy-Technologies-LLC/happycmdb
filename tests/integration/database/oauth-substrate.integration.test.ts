// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { Pool } from 'pg';
import { OAuthSubstrate } from '@happy-technologies/connector-core';
import {
  CmdbOAuthCredentialStore,
  CmdbOAuthStateStore,
  CmdbSecretCipher,
  ServiceNowOAuthClient,
  getPostgresClient,
  getUnifiedCredentialService,
  migratePlaintextCredentials,
} from '@cmdb/database';
import { getEncryptionService } from '@cmdb/common';

const CREATED_IDS: string[] = [];
const STATE_PREFIX = 'oauth-integration-state-';

function encryptedCredentialPayload(payload: Record<string, unknown>): { iv: string; encryptedData: string; authTag: string } {
  return getEncryptionService().encrypt(JSON.stringify(payload));
}

async function insertCredential(
  pool: Pool,
  protocol: string,
  payload: Record<string, unknown>,
  encrypted: boolean
): Promise<string> {
  const credentials = encrypted ? encryptedCredentialPayload(payload) : payload;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO credentials (name, description, protocol, scope, credentials, affinity, tags, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      `${protocol}-oauth-integration-${Date.now()}-${CREATED_IDS.length}`,
      null,
      protocol,
      protocol === 'basic' ? 'api' : 'api',
      credentials,
      {},
      [],
      'oauth-integration-test',
    ]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error('Failed to create credential fixture');
  }
  CREATED_IDS.push(id);
  return id;
}

type OAuthMetadataRow = {
  credentials_text: string;
  oauth_text: string | null;
};

describe('connector-core OAuth substrate CMDB bindings', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPostgresClient().pool;
  }, 120000);

  afterEach(async () => {
    await pool.query('DELETE FROM oauth_states WHERE state LIKE $1', [`${STATE_PREFIX}%`]);
    await pool.query('DELETE FROM credentials WHERE id = ANY($1)', [CREATED_IDS]);
    CREATED_IDS.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reads a legacy plaintext credential, then migrates it into an encrypted envelope', async () => {
    const id = await insertCredential(
      pool,
      'basic',
      { username: 'legacy-user', password: 'legacy-secret' },
      false
    );

    const service = getUnifiedCredentialService(pool);
    const before = await service.getById(id);

    expect(before?.credentials).toMatchObject({ username: 'legacy-user', password: 'legacy-secret' });

    const first = await migratePlaintextCredentials(pool);
    const second = await migratePlaintextCredentials(pool);

    expect(first.scanned).toBeGreaterThanOrEqual(1);
    expect(first.migrated).toBe(1);
    expect(second.migrated).toBe(0);

    const atRest = await pool.query<{ credentials_text: string }>(
      'SELECT credentials::text AS credentials_text FROM credentials WHERE id = $1',
      [id]
    );
    expect(atRest.rows[0]?.credentials_text).not.toContain('legacy-secret');

    const after = await service.getById(id);
    expect(after?.credentials).toMatchObject({ username: 'legacy-user', password: 'legacy-secret' });
  });

  it('stores OAuth state in Postgres as single-use state', async () => {
    const store = new CmdbOAuthStateStore(pool);
    const state = `${STATE_PREFIX}${Date.now()}`;

    await store.put(
      state,
      { sourceId: 'credential-id', providerId: 'servicenow', codeVerifier: 'pkce-verifier' },
      60_000
    );

    const first = await store.take(state);
    const second = await store.take(state);

    expect(first).toEqual({
      sourceId: 'credential-id',
      providerId: 'servicenow',
      codeVerifier: 'pkce-verifier',
    });
    expect(second).toBeNull();
  });

  it('authorizes, persists encrypted token metadata, and refreshes through the DB-backed substrate', async () => {
    const credentialId = await insertCredential(
      pool,
      'oauth2',
      {
        instance_url: 'https://dev12345.service-now.com',
        note: 'non-secret metadata only',
      },
      true
    );

    let tokenRequestCount = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokenRequestCount += 1;
      const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      if (body.get('grant_type') === 'authorization_code') {
        return new Response(
          JSON.stringify({
            access_token: 'sn-initial-access-secret',
            refresh_token: 'sn-refresh-secret',
            expires_in: -1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          access_token: 'sn-refreshed-access-secret',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const substrate = new OAuthSubstrate({
      clients: new Map([
        [
          'servicenow',
          new ServiceNowOAuthClient(
            {
              instanceUrl: 'https://dev12345.service-now.com',
              clientId: 'client-id',
              clientSecret: 'client-secret',
              redirectUri: 'https://cmdb.example.com/api/v1/credentials/oauth/callback',
            },
            fetchImpl
          ),
        ],
      ]),
      credentials: new CmdbOAuthCredentialStore(pool),
      cipher: new CmdbSecretCipher(),
      stateStore: new CmdbOAuthStateStore(pool),
    });

    const auth = await substrate.authorizationUrl({
      sourceId: credentialId,
      providerId: 'servicenow',
      scopes: ['useraccount'],
    });
    expect(auth.url).toContain('/oauth_auth.do');

    await substrate.handleCallback({ state: auth.state, code: 'auth-code' });

    const beforeResolve = await pool.query<OAuthMetadataRow>(
      `SELECT credentials::text AS credentials_text, oauth_metadata::text AS oauth_text
       FROM credentials WHERE id = $1`,
      [credentialId]
    );
    expect(beforeResolve.rows[0]?.credentials_text).not.toContain('client-secret');
    expect(beforeResolve.rows[0]?.oauth_text).not.toContain('sn-initial-access-secret');
    expect(beforeResolve.rows[0]?.oauth_text).not.toContain('sn-refresh-secret');

    const resolved = await substrate.resolve(credentialId);

    expect(tokenRequestCount).toBe(2);
    expect(resolved.headers['Authorization']).toBe('Bearer sn-refreshed-access-secret');

    const afterResolve = await pool.query<OAuthMetadataRow>(
      `SELECT credentials::text AS credentials_text, oauth_metadata::text AS oauth_text
       FROM credentials WHERE id = $1`,
      [credentialId]
    );
    expect(afterResolve.rows[0]?.oauth_text).not.toContain('sn-refreshed-access-secret');
    expect(afterResolve.rows[0]?.oauth_text).not.toContain('sn-refresh-secret');
  });

  it('continues to read encrypted basic credentials unchanged', async () => {
    const id = await insertCredential(
      pool,
      'basic',
      { username: 'basic-user', password: 'basic-secret' },
      true
    );

    const credential = await getUnifiedCredentialService(pool).getById(id);
    const atRest = await pool.query<{ credentials_text: string }>(
      'SELECT credentials::text AS credentials_text FROM credentials WHERE id = $1',
      [id]
    );

    expect(credential?.protocol).toBe('basic');
    expect(credential?.credentials).toMatchObject({ username: 'basic-user', password: 'basic-secret' });
    expect(atRest.rows[0]?.credentials_text).not.toContain('basic-secret');
  });
});
