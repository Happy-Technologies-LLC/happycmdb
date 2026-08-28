// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/server.ts

import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { json } from 'body-parser';
import { getNeo4jClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { typeDefs } from './schema/typeDefs';
import { analyticsTypeDefs } from './schema/analytics.schema';
import { connectorTypeDefs } from './schema/connector.schema';
import { reconciliationTypeDefs } from './schema/reconciliation.schema';
import { itilTypeDefs } from './schema/itil.schema';
import { loadConfig } from '@cmdb/common';
import { getAuthService } from '../auth/auth-bootstrap';
import { authenticateGraphQLContext } from '../middleware/auth.middleware';
import { resolvers } from './resolvers';
import { createCILoader, createRelationshipLoader, createDependentLoader } from './dataloaders/ci-loader';
import { GraphQLContext } from './resolvers';
import { GraphQLFormattedError } from 'graphql';

/**
 * Create and configure Apollo Server with Express
 */
export async function createGraphQLServer(app: express.Application) {
  // Create HTTP server
  const httpServer = http.createServer(app);

  // Get Neo4j client singleton
  const neo4jClient = getNeo4jClient();

  // Shared auth service/config for resolving the bearer token or API key on
  // every request into a real authenticated identity.
  const authService = getAuthService();
  const apiKeyHeader = loadConfig().auth.apiKeys.headerName;

  // Create Apollo Server with schema and resolvers
  const server = new ApolloServer<GraphQLContext>({
    typeDefs: [typeDefs, analyticsTypeDefs, connectorTypeDefs, reconciliationTypeDefs, itilTypeDefs],
    resolvers,
    plugins: [
      // Proper shutdown for HTTP server
      ApolloServerPluginDrainHttpServer({ httpServer }),
      // GraphQL Playground in development mode
      process.env['NODE_ENV'] === 'production'
        ? ApolloServerPluginLandingPageLocalDefault({ footer: false })
        : ApolloServerPluginLandingPageLocalDefault({
            embed: true,
            includeCookies: true,
          }),
    ],
    // Custom error formatting
    formatError: (formattedError: GraphQLFormattedError, _error: any) => {
      // Log the error for debugging
      logger.error('GraphQL Error:', {
        message: formattedError.message,
        code: formattedError.extensions?.['code'],
        path: formattedError.path,
      });

      // Don't expose internal error details in production
      if (process.env['NODE_ENV'] === 'production') {
        // Remove sensitive error details
        if (formattedError.extensions?.['code'] === 'INTERNAL_SERVER_ERROR') {
          return {
            message: 'An internal server error occurred',
            extensions: {
              code: 'INTERNAL_SERVER_ERROR',
            },
          };
        }
      }

      return formattedError;
    },
    // Introspection and playground in development
    introspection: process.env['NODE_ENV'] !== 'production',
  });

  // Start Apollo Server
  await server.start();

  // Apply middleware with context factory
  app.use(
    '/graphql',
    cors<cors.CorsRequest>(),
    json(),
    expressMiddleware(server, {
      context: async ({ req }): Promise<GraphQLContext> => {
        // Create fresh DataLoaders for each request (prevents caching across requests)
        const loaders = {
          _ciLoader: createCILoader(neo4jClient),
          _relationshipLoader: createRelationshipLoader(neo4jClient),
          _dependentLoader: createDependentLoader(neo4jClient),
        };

        const { user } = await authenticateGraphQLContext(authService, apiKeyHeader, req);

        return {
          _neo4jClient: neo4jClient,
          _loaders: loaders,
          user,
        };
      },
    })
  );

  logger.info('GraphQL server configured at /graphql');

  return { server, httpServer };
}

/**
 * Initialize and start GraphQL server
 * @param port - Port number to listen on
 */
export async function startGraphQLServer(port: number = 4000) {
  const app = express();

  // Apply middleware
  app.use(cors());
  app.use(json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'cmdb-graphql-api' });
  });

  // Create GraphQL server
  const { httpServer } = await createGraphQLServer(app);

  // Start HTTP server
  await new Promise<void>((resolve) => {
    httpServer.listen({ port }, () => {
      logger.info(`GraphQL Server ready at http://localhost:${port}/graphql`);
      resolve();
    });
  });

  return httpServer;
}

/**
 * Graceful shutdown handler
 */
export async function shutdownGraphQLServer(httpServer: http.Server) {
  logger.info('Shutting down GraphQL server...');

  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => {
      if (err) {
        logger.error('Error during server shutdown:', err);
        reject(err);
      } else {
        logger.info('GraphQL server shut down successfully');
        resolve();
      }
    });
  });

  // Close database connections
  const neo4jClient = getNeo4jClient();
  await neo4jClient.close();
  logger.info('Database connections closed');
}
