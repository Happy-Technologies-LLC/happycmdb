// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/integration-example.ts

/**
 * Example integration of GraphQL server with Express application
 *
 * This file demonstrates how to integrate the GraphQL server into
 * the main API server application.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { json } from 'body-parser';
import { createGraphQLServer, shutdownGraphQLServer } from './server';
import { getNeo4jClient } from '@cmdb/database';
import { logger } from '@cmdb/common';

/**
 * Create and configure the complete API server with GraphQL
 */
async function createAPIServer() {
  const app = express();

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: process.env['NODE_ENV'] === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // CORS configuration
  app.use(
    cors({
      origin: process.env['CORS_ORIGIN'] || 'http://localhost:3000',
      credentials: true,
    })
  );

  // Compression middleware
  app.use(compression());

  // Body parsing middleware
  app.use(json());

  // Health check endpoint
  app.get('/health', async (_req, res) => {
    try {
      const neo4jClient = getNeo4jClient();
      await neo4jClient.verifyConnectivity();

      res.json({
        _status: 'healthy',
        _service: 'cmdb-api-server',
        _timestamp: new Date().toISOString(),
        _graphql: {
          _endpoint: '/graphql',
          _playground: process.env['NODE_ENV'] !== 'production',
        },
      });
    } catch (error) {
      res.status(503).json({
        _status: 'unhealthy',
        _service: 'cmdb-api-server',
        _error: 'Database connection failed',
      });
    }
  });

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      _service: 'HappyCMDB API',
      _version: '1.0.0',
      _endpoints: {
        _graphql: '/graphql',
        _health: '/health',
        _docs: '/graphql (GraphQL Playground in development)',
      },
    });
  });

  // Integrate GraphQL server
  const { server, httpServer } = await createGraphQLServer(app);

  // Error handling middleware
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Express error:', {
      _error: err.message,
      _stack: err.stack,
      _path: req.path,
      _method: req.method,
    });

    res.status(err.status || 500).json({
      _error: 'Internal server error',
      _message: process.env['NODE_ENV'] === 'production' ? 'An error occurred' : err.message,
    });
  });

  return { app, server, httpServer };
}

/**
 * Start the API server
 */
async function startServer() {
  try {
    const port = parseInt(process.env['PORT'] || '4000', 10);

    // Initialize Neo4j connection
    const neo4jClient = getNeo4jClient();
    await neo4jClient.verifyConnectivity();
    logger.info('Neo4j connection verified');

    // Create and start server
    const { httpServer } = await createAPIServer();

    await new Promise<void>((resolve) => {
      httpServer.listen(port, () => {
        logger.info(`🚀 API Server ready at http://localhost:${port}`);
        logger.info(`📊 GraphQL endpoint: http://localhost:${port}/graphql`);
        if (process.env['NODE_ENV'] !== 'production') {
          logger.info(`🎮 GraphQL Playground: http://localhost:${port}/graphql`);
        }
        resolve();
      });
    });

    // Graceful shutdown handlers
    const shutdown = async () => {
      logger.info('Received shutdown signal...');
      await shutdownGraphQLServer(httpServer);
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return httpServer;
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Example: Standalone server execution
 */
if (require.main === module) {
  startServer().catch((error) => {
    logger.error('Server startup failed:', error);
    process.exit(1);
  });
}

export { createAPIServer, startServer };
