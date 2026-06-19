/**
 * Jest Configuration for Unit Tests
 *
 * TDD London School: Fast, isolated unit tests with mocked dependencies
 * - Target: <100ms per test
 * - All external dependencies mocked
 * - Focus on behavior and interactions
 */

module.exports = {
  // Use ts-jest for TypeScript support
  preset: 'ts-jest',

  // Node environment for unit tests
  testEnvironment: 'node',

  // Display name
  displayName: {
    name: 'UNIT',
    color: 'green',
  },

  // Test file patterns - only unit tests
  testMatch: [
    '**/packages/**/src/**/__tests__/**/*.test.ts',
    '**/packages/**/tests/unit/**/*.test.ts',
    '**/tests/unit/**/*.test.ts',
  ],

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
    'integration',
    'e2e',
  ],

  // Coverage configuration
  collectCoverage: false, // Enable with --coverage flag
  coverageDirectory: '<rootDir>/coverage/unit',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!packages/*/src/**/*.test.ts',
    '!packages/*/src/**/*.spec.ts',
    '!packages/*/src/**/index.ts',
    '!packages/*/src/types/**',
    '!**/node_modules/**',
  ],

  // Coverage thresholds (80% target)
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },

  // Module path aliases — resolve every @cmdb/* workspace package to its TS source.
  // (dist/ is gitignored, so built output is absent in CI; mapping to src lets
  // ts-jest transform the source directly with no build step.)
  moduleNameMapper: {
    '^@cmdb/([^/]+)/(.*)$': '<rootDir>/packages/$1/src/$2',
    '^@cmdb/([^/]+)$': '<rootDir>/packages/$1/src',
    '^@test/utils$': '<rootDir>/tests/utils',
  },

  // Prefer TypeScript source over the stale compiled .js artifacts committed in
  // packages/*/src (those are incomplete in a clean checkout).
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],

  // Transform TypeScript files
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'commonjs',
          moduleResolution: 'node',
          isolatedModules: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          strict: false,
          noUnusedLocals: false,
          noUnusedParameters: false,
          noPropertyAccessFromIndexSignature: false,
          composite: false,
          incremental: false,
          declaration: false,
          declarationMap: false,
          sourceMap: false,
        },
      },
    ],
  },

  // Setup files
  setupFilesAfterEnv: ['<rootDir>/tests/setup/unit.setup.ts'],

  // Fast timeout for unit tests (5 seconds max)
  testTimeout: 5000,

  // Clear mocks between tests
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Verbose output
  verbose: true,

  // Reporters
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: './test-results/unit',
        outputName: 'junit.xml',
        classNameTemplate: '{classname}',
        titleTemplate: '{title}',
        ancestorSeparator: ' › ',
        usePathForSuiteName: true,
      },
    ],
  ],

  // Maximum number of workers (parallel test execution)
  maxWorkers: '50%',

  // Detect open handles
  detectOpenHandles: false,

  // Force exit
  forceExit: false,
};
