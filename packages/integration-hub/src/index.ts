// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Hub - Main Entry Point
 */

import express from 'express';
import cors from 'cors';
import { logger } from '@cmdb/common';
import { connectorsRouter } from './api/connectors.routes';
import { transformationRulesRouter } from './api/transformation-rules.routes';
import { getConnectorRegistry } from '@cmdb/integration-framework';
import { getIntegrationManager } from '@cmdb/integration-framework/dist/core/integration-manager';
import { getAuthMiddleware } from '@cmdb/api-server/auth/auth-bootstrap';
import { requireConnectorScope } from '@cmdb/api-server/auth/connector-scope';

export class IntegrationHubServer {
  private app: express.Application;
  private port: number;

  constructor(port: number = 3001) {
    this.app = express();
    this.port = port;
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Paths and query strings are untrusted connector data; log only the method.
    this.app.use((req, _res, next) => {
      logger.info('Integration Hub API request', { method: req.method });
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', service: 'integration-hub' });
    });

    // API routes
    this.app.use('/api/v1/connectors', getAuthMiddleware().authenticate(), requireConnectorScope, connectorsRouter);
    this.app.use('/api/v1/transformation-rules', transformationRulesRouter);

    // 404 handler
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Error handler
    this.app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error('Integration Hub API error');
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(): Promise<void> {
    // Initialize connector registry and integration manager
    const connectorRegistry = getConnectorRegistry();
    const integrationManager = getIntegrationManager();

    // Discover connectors from /packages/connectors directory
    const connectorsPath = process.env['CONNECTORS_PATH'] || '/app/packages/connectors';
    await connectorRegistry.discoverConnectors(connectorsPath);

    // Load connector configurations from database
    await integrationManager.loadConnectors();
    integrationManager.startScheduleReconciliation();

    // Start HTTP server
    this.app.listen(this.port, () => {
      logger.info('Integration Hub started', { port: this.port });
    });
  }
}

// Export for use as library
export * from './api/connectors.routes';
export * from './api/transformation-rules.routes';

// Start server when executed directly
if (require.main === module) {
  const port = parseInt(process.env['INTEGRATION_HUB_PORT'] || '3001', 10);
  const server = new IntegrationHubServer(port);
  server.start().catch(() => {
    logger.error('Failed to start Integration Hub');
    process.exit(1);
  });
}
