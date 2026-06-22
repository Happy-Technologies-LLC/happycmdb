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
    // connector-core is ESM-only; map it to its TS source so ts-jest transpiles
    // it to CJS (Jest cannot require the ESM dist). The .js strip lets Jest
    // resolve the package's internal ESM `./x.js` specifiers to their .ts source.
    '^@happy-technologies/connector-core$':
      '<rootDir>/../../node_modules/@happy-technologies/connector-core/src/index.ts',
    '^@happy-technologies/connector-core/view$':
      '<rootDir>/../../node_modules/@happy-technologies/connector-core/src/view.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@cmdb/common(.*)$': '<rootDir>/../common/src$1',
    '^@cmdb/database(.*)$': '<rootDir>/../database/src$1',
    '^@cmdb/event-processor(.*)$': '<rootDir>/../event-processor/src$1',
  },
  // Prefer TS source over any committed .js artifacts, and resolve the stripped
  // connector-core specifiers to their .ts files.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        // Force CJS output: the package tsconfig is NodeNext, which makes
        // ts-jest emit `export`/`import` that Jest's CJS runtime cannot load
        // (notably connector-core's mapped ESM source). Mirrors the root configs.
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
      },
    }],
  },
  // Transform connector-core's mapped TS source; leave the rest of node_modules
  // untransformed.
  transformIgnorePatterns: ['/node_modules/(?!@happy-technologies/connector-core/)'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  globals: {
    'ts-jest': {
      isolatedModules: true,
    },
  },
  testTimeout: 10000,
};
