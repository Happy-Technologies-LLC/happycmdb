// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ServiceNowOAuthClient: a connector-core OAuthClient for ServiceNow's OAuth 2.0
 * authorization-code grant. No third-party OAuth library: ServiceNow's endpoints
 * are simple form-encoded POSTs, and it does not use PKCE (the code verifier is
 * accepted but ignored). fetch is injectable for tests. Response bodies are
 * never logged: they carry tokens.
 */
import type { OAuthClient, OAuthTokens } from '@happy-technologies/connector-core';

export type ServiceNowOAuthConfig = {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type ServiceNowTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export class ServiceNowOAuthClient implements OAuthClient {
  constructor(
    private readonly config: ServiceNowOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  createAuthorizationURL(state: string, _codeVerifier: string, scopes: string[]): URL {
    const url = new URL(`${this.config.instanceUrl}/oauth_auth.do`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('state', state);
    if (scopes.length > 0) {
      url.searchParams.set('scope', scopes.join(' '));
    }
    return url;
  }

  validateAuthorizationCode(code: string, _codeVerifier: string): Promise<OAuthTokens> {
    return this.requestTokens(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      })
    );
  }

  refreshAccessToken(refreshToken: string, _scopes?: string[]): Promise<OAuthTokens> {
    return this.requestTokens(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      })
    );
  }

  private async requestTokens(body: URLSearchParams): Promise<OAuthTokens> {
    const response = await this.fetchImpl(`${this.config.instanceUrl}/oauth_token.do`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(`ServiceNow OAuth token request failed with status ${response.status}`);
    }
    const json = (await response.json()) as ServiceNowTokenResponse;
    const tokens: OAuthTokens = { accessToken: json.access_token };
    if (json.refresh_token !== undefined) {
      tokens.refreshToken = json.refresh_token;
    }
    if (json.expires_in !== undefined) {
      tokens.accessTokenExpiresAt = new Date(Date.now() + json.expires_in * 1000);
    }
    return tokens;
  }
}
