// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Export classes for library usage
export { RestAPIServer } from './rest/server';
export { ciRoutes } from './rest/routes/ci.routes';
export { discoveryRoutes } from './rest/routes/discovery.routes';
export { relationshipRoutes } from './rest/routes/relationship.routes';
export { healthRoutes } from './rest/routes/health.routes';
export { reconciliationRoutes } from './rest/routes/reconciliation.routes';
export { CIController } from './rest/controllers/ci.controller';
export { ReconciliationController } from './rest/controllers/reconciliation.controller';

// Start server when executed as main module
import { RestAPIServer } from './rest/server';
import { logger } from '@cmdb/common';
import { getDiscoveryOrchestrator } from '@cmdb/discovery-engine';
import { getAnomalyDetectionEngine } from '@cmdb/ai-ml-engine';
import { loadConnectorsAtStartup } from './utils/connector-loader';
import { getWebSocketService } from './services/websocket.service';

const PORT = parseInt(process.env['PORT'] || '3000', 10);

async function startServer() {
  try {
    logger.info('Starting HappyCMDB API Server', { port: PORT });

    // Load built-in connectors into database
    logger.info('Loading built-in connectors...');
    await loadConnectorsAtStartup();
    logger.info('Built-in connectors loaded successfully');

    const server = new RestAPIServer(PORT);
    const httpServer = server.start();

    // Initialize WebSocket service for real-time updates
    const wsService = getWebSocketService();
    wsService.initialize(httpServer);
    logger.info('WebSocket service initialized');

    // Start discovery workers
    const discoveryOrchestrator = getDiscoveryOrchestrator();
    await discoveryOrchestrator.start();
    logger.info('Discovery workers started');

    // Start anomaly detection job
    const anomalyEngine = getAnomalyDetectionEngine();
    await anomalyEngine.loadConfiguration();

    // Run anomaly detection every hour
    const runAnomalyDetection = async () => {
      try {
        logger.info('Running scheduled anomaly detection');
        const anomalies = await anomalyEngine.detectAnomalies();
        logger.info(`Anomaly detection completed: ${anomalies.length} anomalies detected`);
      } catch (error) {
        logger.error('Error running scheduled anomaly detection', error);
      }
    };

    // Run initial detection after 5 minutes
    setTimeout(runAnomalyDetection, 5 * 60 * 1000);

    // Schedule periodic detection (every hour)
    setInterval(runAnomalyDetection, 60 * 60 * 1000);
    logger.info('Anomaly detection scheduler started (runs every hour)');

    logger.info('API Server started successfully', {
      port: PORT,
      env: process.env['NODE_ENV'] || 'development'
    });

    // Graceful shutdown
    const shutdown = (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Fatal error starting server', error);
    process.exit(1);
  }
}

// Start server
startServer();
