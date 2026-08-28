// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Prefer TypeScript source over the stale compiled .js artifacts committed alongside it in
  // packages/*/src (e.g. @cmdb/database's src/index.js), which lag behind index.ts.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThresholds: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  moduleNameMapper: {
    // connector-core is ESM-only; map it to its TS source so ts-jest transpiles it to CJS
    // (Jest cannot require the ESM dist). The .js strip lets Jest resolve the package's
    // internal ESM `./x.js` specifiers to their .ts source. Needed because @cmdb/database's
    // index.ts (mapped below) transitively imports the connector-core-backed OAuth substrate.
    '^@happy-technologies/connector-core$':
      '<rootDir>/../../node_modules/@happy-technologies/connector-core/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@cmdb/common(.*)$': '<rootDir>/../common/src$1',
    '^@cmdb/database(.*)$': '<rootDir>/../database/src$1',
    '^@cmdb/discovery-engine(.*)$': '<rootDir>/src$1',
  },
  // Transform connector-core's TS source (mapped above); leave the rest of node_modules
  // untransformed.
  transformIgnorePatterns: ['/node_modules/(?!@happy-technologies/connector-core/)'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        isolatedModules: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
    }],
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
};
