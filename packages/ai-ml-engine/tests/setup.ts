// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jest Test Setup
 * Global test configuration and mocks
 */

// Mock database clients
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
  getRedisClient: jest.fn(),
}));

// Mock event producer
jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: jest.fn(),
  EventType: {
    RECONCILIATION_CONFLICT: 'reconciliation_conflict',
  },
}));

// Mock logger
jest.mock('@cmdb/common', () => ({
  // The real validator: a mocked-out one would make every incarnation check vacuous or throw.
  ciIncarnationId: jest.requireActual('@cmdb/common/utils/ci-incarnation').ciIncarnationId,
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
