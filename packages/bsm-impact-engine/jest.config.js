// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/index.ts',
    '!src/types/**/*.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  moduleNameMapper: {
    '^@cmdb/unified-model(.*)$': '<rootDir>/../unified-model/src$1',
    '^@cmdb/database$': '<rootDir>/../database/src', // entry point only: never the source-owned grant (HAP-1608)
    '^@cmdb/event-streaming(.*)$': '<rootDir>/../event-streaming/src$1',
    '^@cmdb/common(.*)$': '<rootDir>/../common/src$1',
  },
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  testTimeout: 10000,
};
