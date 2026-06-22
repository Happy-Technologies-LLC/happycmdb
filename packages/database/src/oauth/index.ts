// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HappyCMDB bindings for the connector-core OAuth/credential substrate.
 * Product-specific crypto, storage, and provider clients live here; the
 * substrate orchestration itself comes from @happy-technologies/connector-core.
 */
export { CmdbSecretCipher, getCmdbSecretCipher } from './cipher';
export { CmdbOAuthCredentialStore } from './credential-store';
export { CmdbOAuthStateStore } from './state-store';
export { ServiceNowOAuthClient } from './providers/servicenow';
export type { ServiceNowOAuthConfig } from './providers/servicenow';
export {
  createOAuthSubstrate,
  getOAuthSubstrate,
  resetOAuthSubstrate,
  SERVICENOW_PROVIDER_ID,
} from './substrate';
