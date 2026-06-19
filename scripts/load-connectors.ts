#!/usr/bin/env ts-node
/**
 * Load Connectors Script
 *
 * Standalone script to load connector metadata into PostgreSQL
 * Can be run during deployment or manually to register connectors
 *
 * Usage:
 *   npx ts-node scripts/load-connectors.ts
 *   node scripts/load-connectors.js (if compiled)
 */

import { ConnectorLoader } from '../packages/api-server/src/utils/connector-loader';
import { logger } from '../packages/common/src/logger';

async function main() {
  try {
    logger.info('=== HappyCMDB Connector Loader ===');

    const loader = new ConnectorLoader();

    // Clear existing connectors if --clear flag is passed
    if (process.argv.includes('--clear')) {
      logger.info('Clearing existing connector registrations...');
      await loader.clearAllConnectors();
      logger.info('Existing connectors cleared');
    }

    // Load all connectors
    await loader.loadAllConnectors();

    logger.info('=== Connector loading completed successfully ===');
    process.exit(0);

  } catch (error) {
    logger.error('Fatal error loading connectors', error);
    process.exit(1);
  }
}

main();
