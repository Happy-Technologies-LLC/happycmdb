// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Swagger API Documentation Routes
 *
 * Serves OpenAPI 3.0 specification and Swagger UI interface
 */

import { Router, Request, Response } from 'express';
import * as swaggerUi from 'swagger-ui-express';
import * as YAML from 'yamljs';
import * as path from 'path';
import { logger } from '@cmdb/common';

export const swaggerRoutes = Router();

// Load OpenAPI specification
const openApiSpecPath = path.join(__dirname, '../../openapi/openapi.yaml');
let swaggerDocument: any;

try {
  swaggerDocument = YAML.load(openApiSpecPath);
  logger.info('OpenAPI specification loaded successfully', { path: openApiSpecPath });
} catch (error) {
  logger.error('Failed to load OpenAPI specification', { error, path: openApiSpecPath });
  swaggerDocument = {
    openapi: '3.0.0',
    info: {
      title: 'HappyCMDB API',
      version: '2.0.0',
      description: 'API documentation is currently unavailable. Please check server logs.',
    },
    paths: {},
  };
}

// Swagger UI options
const swaggerOptions: swaggerUi.SwaggerUiOptions = {
  customCss: `
    .swagger-ui .topbar {
      display: none;
    }
    .swagger-ui .info .title {
      font-size: 36px;
      color: #2c3e50;
    }
    .swagger-ui .info .description {
      font-size: 14px;
      line-height: 1.6;
    }
    .swagger-ui .scheme-container {
      background: #f7f7f7;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
    }
  `,
  customSiteTitle: 'HappyCMDB API Documentation',
  customfavIcon: '/favicon.ico',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
    docExpansion: 'none', // 'list' | 'full' | 'none'
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 1,
    displayOperationId: true,
  },
};

/**
 * Serve Swagger UI at /api-docs
 */
swaggerRoutes.use('/', swaggerUi.serve);
swaggerRoutes.get('/', swaggerUi.setup(swaggerDocument, swaggerOptions));

/**
 * Serve raw OpenAPI JSON at /api-docs/openapi.json
 */
swaggerRoutes.get('/openapi.json', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerDocument);
});

/**
 * Serve raw OpenAPI YAML at /api-docs/openapi.yaml
 */
swaggerRoutes.get('/openapi.yaml', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/yaml');
  const yamlContent = YAML.stringify(swaggerDocument, 10, 2);
  res.send(yamlContent);
});

/**
 * Health check for API documentation
 */
swaggerRoutes.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    openapi_version: swaggerDocument.openapi || 'unknown',
    api_version: swaggerDocument.info?.version || 'unknown',
    paths_count: Object.keys(swaggerDocument.paths || {}).length,
    schemas_count: Object.keys(swaggerDocument.components?.schemas || {}).length,
  });
});
