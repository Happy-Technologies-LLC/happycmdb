// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { resetEncryptionService } from '@cmdb/common';
import {
  InMemoryOAuthStateStore,
  OAuthSubstrate,
  type CredentialStore,
  type OAuthClient,
  type OAuthTokens,
  type StoredCredential,
} from '@happy-technologies/connector-core';

import { CmdbSecretCipher } from '../cipher';

const KEY = 'unit-test-encryption-key-with-32+-characters';

/** In-memory CredentialStore standing in for CmdbOAuthCredentialStore (DB-free). */
class MemoryCredentialStore implements CredentialStore {
  readonly map = new Map<string, StoredCredential>();

  load(sourceId: string): Promise<StoredCredential | null> {
    return Promise.resolve(this.map.get(sourceId) ?? null);
  }

  save(sourceId: string, ciphertext: string, provider: string): Promise<void> {
    this.map.set(sourceId, { ciphertext, provider });
    return Promise.resolve();
  }

  delete(sourceId: string): Promise<void> {
    this.map.delete(sourceId);
    return Promise.resolve();
  }
}

/** Deterministic OAuth client: first token is already expired to force a refresh. */
class FakeClient implements OAuthClient {
  refreshCount = 0;

  createAuthorizationURL(state: string): URL {
    return new URL(`https://idp.example.com/authorize?state=${state}`);
  }

  validateAuthorizationCode(): Promise<OAuthTokens> {
    return Promise.resolve({
      accessToken: 'access-initial',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
  }

  refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    this.refreshCount += 1;
    return Promise.resolve({
      accessToken: `access-refreshed-${this.refreshCount}`,
      refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    });
  }
}

describe('OAuthSubstrate wired with CmdbSecretCipher', () => {
  beforeAll(() => {
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = KEY;
    resetEncryptionService();
  });

  afterAll(() => {
    delete process.env['CREDENTIAL_ENCRYPTION_KEY'];
    resetEncryptionService();
  });

  function build(): { substrate: OAuthSubstrate; store: MemoryCredentialStore; client: FakeClient } {
    const store = new MemoryCredentialStore();
    const client = new FakeClient();
    const substrate = new OAuthSubstrate({
      clients: new Map([['demo', client]]),
      credentials: store,
      cipher: new CmdbSecretCipher(),
      stateStore: new InMemoryOAuthStateStore(),
    });
    return { substrate, store, client };
  }

  it('persists the token bundle encrypted and resolves a bearer token', async () => {
    const { substrate, store } = build();

    const { url, state } = await substrate.authorizationUrl({
      sourceId: 'cred-1',
      providerId: 'demo',
      scopes: [],
    });
    expect(url).toContain(state);

    await substrate.handleCallback({ state, code: 'auth-code' });

    const stored = store.map.get('cred-1');
    expect(stored).toBeDefined();
    expect(stored!.provider).toBe('demo');
    // At rest the bundle is sealed: neither token appears in the ciphertext.
    expect(stored!.ciphertext).not.toContain('access-initial');
    expect(stored!.ciphertext).not.toContain('refresh-1');
  });

  it('refreshes a near-expiry token on resolve and re-seals the new bundle', async () => {
    const { substrate, store, client } = build();
    const { state } = await substrate.authorizationUrl({
      sourceId: 'cred-1',
      providerId: 'demo',
      scopes: [],
    });
    await substrate.handleCallback({ state, code: 'auth-code' });

    const resolved = await substrate.resolve('cred-1');

    expect(client.refreshCount).toBe(1);
    expect(resolved.token).toBe('access-refreshed-1');
    expect(resolved.headers['Authorization']).toBe('Bearer access-refreshed-1');
    expect(store.map.get('cred-1')!.ciphertext).not.toContain('access-refreshed-1');
  });

  it('rejects an unknown or expired state', async () => {
    const { substrate } = build();

    await expect(substrate.handleCallback({ state: 'nope', code: 'x' })).rejects.toThrow();
  });
});
