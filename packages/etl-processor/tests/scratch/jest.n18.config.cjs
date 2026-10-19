// Founder-only scratch entry point: stores and schema are provisioned by run-n18-receipt.sh.
const { resolve } = require('path');
const base = require('../../../../jest.config.integration.js');

module.exports = {
  ...base,
  rootDir: resolve(__dirname, '../../../..'),
  globalSetup: undefined,
  globalTeardown: undefined,
  setupFilesAfterEnv: [],
  reporters: [
    'default',
    ['jest-junit', {
      ...base.reporters[1][1],
      outputDirectory: resolve(__dirname, '../../../../test-results/n18'),
      outputName: `${process.env.N18_RUN_NONCE || 'n18'}.junit.xml`,
    }],
  ],
  testMatch: ['**/packages/etl-processor/tests/scratch/hp1-s3-queue-persistence.test.ts'],
  maxWorkers: 1,
};
