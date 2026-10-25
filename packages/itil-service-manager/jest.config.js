// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    // connector-core is ESM-only; map it to its TS source so ts-jest transpiles it to CJS
    // (Jest cannot require the ESM dist). The .js strip lets Jest resolve the package's
    // internal ESM `./x.js` specifiers to their .ts source. Needed because @cmdb/database's
    // index.ts (mapped below) transitively imports the connector-core-backed OAuth substrate.
    '^@happy-technologies/connector-core$':
      '<rootDir>/../../node_modules/@happy-technologies/connector-core/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@cmdb/(.*)$': '<rootDir>/../$1/src',
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
