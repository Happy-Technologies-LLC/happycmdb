// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the connector-core OAuthSubstrate over CMDB's Postgres-backed bindings.
 *
 * Provider clients are registered only when their app credentials are present in
 * the environment, so a missing client yields a clear "no OAuth client for
 * provider" error rather than a half-built flow. ServiceNow is the first wired
 * provider; add more here as they are onboarded.
 */
import type { Pool } from 'pg';

import { OAuthSubstrate, type OAuthClient } from '@happy-technologies/connector-core';

import { getCmdbSecretCipher } from './cipher';
import { CmdbOAuthCredentialStore } from './credential-store';
import { ServiceNowOAuthClient } from './providers/servicenow';
import { CmdbOAuthStateStore } from './state-store';

export const SERVICENOW_PROVIDER_ID = 'servicenow';

function requiredEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : undefined;
}

export function createOAuthSubstrate(pool: Pool): OAuthSubstrate {
  const clients = new Map<string, OAuthClient>();

  const instanceUrl = requiredEnv('SERVICENOW_OAUTH_INSTANCE_URL');
  const clientId = requiredEnv('SERVICENOW_OAUTH_CLIENT_ID');
  const clientSecret = requiredEnv('SERVICENOW_OAUTH_CLIENT_SECRET');
  const redirectUri = requiredEnv('SERVICENOW_OAUTH_REDIRECT_URI');
  if (
    instanceUrl !== undefined &&
    clientId !== undefined &&
    clientSecret !== undefined &&
    redirectUri !== undefined
  ) {
    clients.set(
      SERVICENOW_PROVIDER_ID,
      new ServiceNowOAuthClient({ instanceUrl, clientId, clientSecret, redirectUri })
    );
  }

  return new OAuthSubstrate({
    clients,
    credentials: new CmdbOAuthCredentialStore(pool),
    cipher: getCmdbSecretCipher(),
    stateStore: new CmdbOAuthStateStore(pool),
  });
}

let substrate: OAuthSubstrate | null = null;

/** Lazy singleton over the shared pool; rebuildable in tests via resetOAuthSubstrate. */
export function getOAuthSubstrate(pool: Pool): OAuthSubstrate {
  if (substrate === null) {
    substrate = createOAuthSubstrate(pool);
  }
  return substrate;
}

export function resetOAuthSubstrate(): void {
  substrate = null;
}
