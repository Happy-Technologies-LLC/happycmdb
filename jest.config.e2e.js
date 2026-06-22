/**
 * Jest Configuration for E2E Tests
 *
 * Specialized configuration for end-to-end testing with:
 * - Extended timeouts for Docker and service startup
 * - Global setup and teardown
 * - Sequential test execution (no parallelization)
 * - Custom test environment
 */

module.exports = {
  // Use ts-jest for TypeScript support
  preset: 'ts-jest',

  // Node environment for E2E tests
  testEnvironment: 'node',

  // Test file patterns
  testMatch: ['**/tests/e2e/**/*.test.ts'],

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/build/',
  ],

  // Global setup and teardown
  globalSetup: '<rootDir>/tests/e2e/setup.ts',
  globalTeardown: '<rootDir>/tests/e2e/teardown.ts',

  // Extended timeout for E2E tests (5 minutes default)
  testTimeout: 300000,

  // Run tests sequentially (not in parallel) to avoid Docker conflicts
  maxWorkers: 1,

  // Module path aliases — resolve every @cmdb/* workspace package to its TS source.
  moduleNameMapper: {
    // connector-core is ESM-only; map it to its TS source so ts-jest transpiles
    // it to CJS (Jest cannot require the ESM dist). The .js strip lets Jest
    // resolve the package's internal ESM `./x.js` specifiers to their .ts source.
    '^@happy-technologies/connector-core$':
      '<rootDir>/node_modules/@happy-technologies/connector-core/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@cmdb/([^/]+)/(.*)$': '<rootDir>/packages/$1/src/$2',
    '^@cmdb/([^/]+)$': '<rootDir>/packages/$1/src',
  },

  // Prefer TypeScript source over stale compiled .js artifacts in packages/*/src.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],

  // Coverage configuration (optional for E2E)
  collectCoverage: false, // Enable with --coverage flag
  coverageDirectory: '<rootDir>/coverage/e2e',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!packages/*/src/**/*.test.ts',
    '!packages/*/src/**/*.spec.ts',
    '!**/node_modules/**',
  ],

  // Verbose output
  verbose: true,

  // Display individual test results
  displayName: {
    name: 'E2E',
    color: 'cyan',
  },

  // Detect open handles (useful for debugging)
  detectOpenHandles: false, // Enable for debugging: --detectOpenHandles

  // Force exit after tests complete
  forceExit: true,

  // Reporters
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: './test-results/e2e',
        outputName: 'junit.xml',
        classNameTemplate: '{classname}',
        titleTemplate: '{title}',
        ancestorSeparator: ' › ',
        usePathForSuiteName: true,
      },
    ],
  ],

  // Transform TypeScript files
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          isolatedModules: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
        },
      },
    ],
  },

  // Transform connector-core's TS source (mapped above); leave the rest of
  // node_modules untransformed.
  transformIgnorePatterns: ['/node_modules/(?!@happy-technologies/connector-core/)'],

  // Setup files to run before each test file
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/jest.setup.js'],
};
