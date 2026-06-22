// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/database/src/index.ts

// Neo4j exports
export { Neo4jClient, getNeo4jClient } from './neo4j/client';
export { initializeNeo4jSchema } from './neo4j/initializer';

// PostgreSQL exports
export { PostgresClient, getPostgresClient } from './postgres/client';
export { runMigrations, getMigrationStatus } from './postgres/migrator';
export type { MigrationStatus } from './postgres/migrator';
export { AuditService, getAuditService } from './postgres/audit.service';
export {
  UnifiedCredentialService,
  getUnifiedCredentialService
} from './postgres/unified-credential.service';
export type { CredentialFilters } from './postgres/unified-credential.service';
export {
  CredentialSetService,
  getCredentialSetService
} from './postgres/credential-set.service';
export {
  migratePlaintextCredentials
} from './postgres/credential-services/migrate-plaintext';

// Data Mart exports
export { DataMartClient, getDataMartClient, resetDataMartClient } from './clients/datamart.client';

// Redis exports
export { RedisClient, getRedisClient } from './redis/client';

// BullMQ exports
export { QueueManager, queueManager, QUEUE_NAMES } from './bullmq/queue-manager';

// OAuth substrate exports (connector-core bindings)
export {
  CmdbSecretCipher,
  getCmdbSecretCipher,
  CmdbOAuthCredentialStore,
  CmdbOAuthStateStore,
  ServiceNowOAuthClient,
  createOAuthSubstrate,
  getOAuthSubstrate,
  resetOAuthSubstrate,
  SERVICENOW_PROVIDER_ID,
} from './oauth/index';
export type { ServiceNowOAuthConfig } from './oauth/index';
