// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { ServiceNowOAuthClient } from '../providers/servicenow';

const CONFIG = {
  instanceUrl: 'https://dev12345.service-now.com',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://cmdb.example.com/api/v1/credentials/oauth/callback',
};

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('ServiceNowOAuthClient', () => {
  it('builds an authorization URL with the expected query parameters', () => {
    const client = new ServiceNowOAuthClient(CONFIG);

    const url = client.createAuthorizationURL('state-abc', 'verifier-ignored', ['useraccount']);

    expect(url.origin + url.pathname).toBe('https://dev12345.service-now.com/oauth_auth.do');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toBe('useraccount');
  });

  it('exchanges an authorization code for normalized tokens', async () => {
    const client = new ServiceNowOAuthClient(
      CONFIG,
      jsonFetch(200, {
        access_token: 'access-xyz',
        refresh_token: 'refresh-xyz',
        expires_in: 1800,
        token_type: 'Bearer',
      })
    );

    const tokens = await client.validateAuthorizationCode('the-code', 'verifier-ignored');

    expect(tokens.accessToken).toBe('access-xyz');
    expect(tokens.refreshToken).toBe('refresh-xyz');
    expect(tokens.accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(tokens.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('refreshes an access token', async () => {
    const client = new ServiceNowOAuthClient(
      CONFIG,
      jsonFetch(200, { access_token: 'access-new', expires_in: 1800 })
    );

    const tokens = await client.refreshAccessToken('refresh-xyz');

    expect(tokens.accessToken).toBe('access-new');
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('throws on a non-2xx response without leaking the body', async () => {
    const client = new ServiceNowOAuthClient(
      CONFIG,
      jsonFetch(401, { error: 'invalid_grant', access_token: 'should-not-leak' })
    );

    await expect(client.validateAuthorizationCode('bad', 'verifier')).rejects.toThrow(
      /status 401/
    );
    await expect(client.validateAuthorizationCode('bad', 'verifier')).rejects.not.toThrow(
      /should-not-leak/
    );
  });
});
