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
import { getAuthMiddleware } from '../auth/auth-bootstrap';
import type { AuthenticatedRequest } from '../auth/types';
import { resolvers } from './resolvers';
import { createCILoader, createRelationshipLoader, createDependentLoader } from './dataloaders/ci-loader';
import { GraphQLContext } from './resolvers';
import { GraphQLFormattedError } from 'graphql';
import { admitGraphQLRequest, graphQLWorkCompleted, graphQLWorkStarted } from '../middleware/analysis-admission';
import { enforceGraphQLRequestLimits } from './request-admission';

/**
 * Create and configure Apollo Server with Express
 */
export async function createGraphQLServer(app: express.Application) {
  // Create HTTP server
  const httpServer = http.createServer(app);

  // Get Neo4j client singleton
  const neo4jClient = getNeo4jClient();

  const authMiddleware = getAuthMiddleware();
  // Apollo clones contextValue before invoking plugins; enumerable symbol survives that clone.
  const requestKey = Symbol('graphql-admission-request');

  // Create Apollo Server with schema and resolvers
  const server = new ApolloServer<GraphQLContext>({
    typeDefs: [typeDefs, analyticsTypeDefs, connectorTypeDefs, reconciliationTypeDefs, itilTypeDefs],
    resolvers,
    plugins: [
      // Proper shutdown for HTTP server
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async requestDidStart({ contextValue }) {
          const req = (contextValue as GraphQLContext & { [requestKey]?: express.Request })[requestKey];
          if (req && !graphQLWorkStarted(req)) throw new Error('GraphQL request disconnected');
          return {
            async didResolveOperation({ operation, document, schema, request }) {
              if (operation && document) {
                enforceGraphQLRequestLimits(operation, document, schema, request.variables);
              }
            },
            async willSendResponse({ contextValue }) {
              if (!contextValue) return;
              const req = (contextValue as GraphQLContext & { [requestKey]?: express.Request })[requestKey];
              if (req) graphQLWorkCompleted(req);
            },
          };
        },
      },
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
      if (formattedError.extensions?.['code'] === 'GRAPHQL_REQUEST_LIMIT_EXCEEDED') {
        return {
          message: 'GraphQL request limit exceeded',
          extensions: { code: 'GRAPHQL_REQUEST_LIMIT_EXCEEDED' },
        };
      }

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
    authMiddleware.authenticate(),
    admitGraphQLRequest,
    expressMiddleware(server, {
      context: async ({ req, res }): Promise<GraphQLContext> => {
        if (res.destroyed) throw new Error('GraphQL request disconnected');
        // Create fresh DataLoaders for each request (prevents caching across requests)
        const loaders = {
          _ciLoader: createCILoader(neo4jClient),
          _relationshipLoader: createRelationshipLoader(neo4jClient),
          _dependentLoader: createDependentLoader(neo4jClient),
        };

        const user = (req as AuthenticatedRequest).user!;

        const context = {
          _neo4jClient: neo4jClient,
          _loaders: loaders,
          user,
          [requestKey]: req,
        };
        return context;
      },
    })
  );

  logger.info('GraphQL server configured at /graphql');

  return { server, httpServer };
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
