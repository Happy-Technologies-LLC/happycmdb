/**
 * Integration Test Setup
 *
 * Setup for integration tests with real database connections.
 */

import { jest } from '@jest/globals';

// Global test configuration
beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Environment variables for integration tests
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

// Secrets required by services constructed at module load. The credential
// encryption service throws if CREDENTIAL_ENCRYPTION_KEY is unset, which would
// crash any api-server suite at import time. These are test-only values; the
// encryption key must be >= 32 characters.
process.env.CREDENTIAL_ENCRYPTION_KEY =
  process.env.CREDENTIAL_ENCRYPTION_KEY ||
  'test-encryption-key-minimum-32-chars-required-for-security';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-integration-tests';

// Global error handler
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection in integration test:', error);
});

// Allow console output in integration tests (for debugging)
// but can be silenced if needed
