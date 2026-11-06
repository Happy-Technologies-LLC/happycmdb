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
    '^@cmdb/bsm-impact-engine(.*)$': '<rootDir>/../bsm-impact-engine/src$1',
    '^@cmdb/tbm-cost-engine(.*)$': '<rootDir>/../tbm-cost-engine/src$1',
    '^@cmdb/itil-service-manager(.*)$': '<rootDir>/../itil-service-manager/src$1',
    '^@cmdb/unified-model(.*)$': '<rootDir>/../unified-model/src$1',
    '^@cmdb/database$': '<rootDir>/../database/src', // entry point only: never the source-owned grant (HAP-1608)
    '^@cmdb/common(.*)$': '<rootDir>/../common/src$1',
  },
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  testTimeout: 10000,
};
