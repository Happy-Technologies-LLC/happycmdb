// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express, { Express, Request, Response, NextFunction } from 'express';
import { Server as HTTPServer, STATUS_CODES } from 'http';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { json, urlencoded } from 'body-parser';
import { logger } from '@cmdb/common';
import { ciRoutes } from './routes/ci.routes';
import { discoveryRoutes } from './routes/discovery.routes';
import { discoveryDefinitionRoutes } from './routes/discovery-definition.routes';
import { discoveryAgentRoutes } from './routes/discovery-agent.routes';
import { relationshipRoutes } from './routes/relationship.routes';
import healthRoutes from '../health/health.routes';
import { searchRoutes } from './routes/search.routes';
import { analyticsRoutes } from './routes/analytics.routes';
import { authRoutes } from './routes/auth.routes';
import { anomalyRoutes } from './routes/anomaly.routes';
import jobsRoutes from './routes/jobs.routes';
import { connectorRoutes } from './routes/connector.routes';
import { connectorConfigRoutes } from './routes/connector-config.routes';
import { unifiedCredentialRoutes } from './routes/unified-credential.routes';
import { reconciliationRoutes } from './routes/reconciliation.routes';
import { dashboardRoutes } from './routes/dashboard.routes';
import { aiPatternRoutes } from './routes/ai-pattern.routes';
import { swaggerRoutes } from './routes/swagger.routes';
import { itilRoutes } from './routes/itil.routes';
import { businessServiceRoutes } from './routes/business-service.routes';
import { architectureRoutes } from './routes/architecture.routes';
import metricsRoutes from '../metrics/metrics.routes';
import { tbmRoutes } from './routes/tbm.routes';
import { settingsRoutes } from './routes/settings.routes';
import { driftRoutes, impactRoutes } from './routes/drift-impact.routes';
import { createRateLimitMetricsRoutes } from './routes/rate-limit-metrics.routes';
import { RateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { getRedisClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';
import { getAuthMiddleware } from '../auth/auth-bootstrap';

/**
 * Listen target read from the environment, shared by index.ts and tests.
 * PORT defaults to 3000. SERVER_HOST is read raw (not via loadConfig(), whose
 * Joi default '0.0.0.0' would replace Node's no-host dual-stack bind).
 */
export function listenTargetFromEnv(env: NodeJS.ProcessEnv): { port: number; host?: string } {
  return { port: parseInt(env['PORT'] || '3000', 10), host: env['SERVER_HOST'] };
}

type HttpError = { name?: unknown; message?: unknown; stack?: unknown; type?: unknown; status?: unknown; statusCode?: unknown };

/**
 * Status and fixed client-facing text for an error the caller caused, or null
 * for a server fault (500). Never derived from err.message, which can quote
 * the request body (JSON.parse) or the raw path parameter (Express decode).
 */
function classifyClientError(err: HttpError): { status: number; message: string } | null {
  if (err.type === 'entity.parse.failed') return { status: 400, message: 'Malformed request body' };
  if (err.type === 'entity.too.large') return { status: 413, message: 'Request body too large' };
  if (err instanceof URIError) return { status: 400, message: 'Malformed URL encoding' };
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499) {
    return { status, message: 'Request could not be processed' };
  }
  return null;
}

export class RestAPIServer {
  private app: Express;
  private port: number;
  private host: string | undefined;
  private httpServer: HTTPServer | null = null;

  /** `host` empty or omitted: listen without a host argument (Node's default bind). */
  constructor(port: number = 3000, host?: string) {
    this.app = express();
    this.port = port;
    this.host = host || undefined;
    this.setupMiddleware();
    this.setupRoutes();
    // Note: setupErrorHandling() is invoked from index.ts AFTER GraphQL is mounted,
    // so the catch-all 404/error handler does not shadow /graphql.
  }

  getApp(): Express {
    return this.app;
  }

  private setupMiddleware(): void {
    // CSP configuration to allow Swagger UI
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
          },
        },
      })
    );
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(json({ limit: '10mb' }));
    this.app.use(urlencoded({ extended: true, limit: '10mb' }));

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      logger.info('API Request', {
        _method: req.method,
        _path: req.path,
        _ip: req.ip,
      });
      next();
    });
  }

  private setupRoutes(): void {
    // API Documentation (no authentication required)
    this.app.use('/api-docs', swaggerRoutes);

    // API endpoints
    this.app.use('/api/v1/cmdb-health', healthRoutes);
    this.app.use('/api/v1/auth', authRoutes);

    // Every remaining /api/v1 route requires authentication (JWT bearer or
    // API key -- discovery agents authenticate with an agent-role API key
    // through the same check). Public endpoints (Swagger docs, health
    // check, and /api/v1/auth's own login/register/refresh routes) are all
    // mounted above this line and are therefore unaffected. Individual
    // routers layer `requirePermission()`/`requireRole()` on top for
    // write/admin gating; they must not call `.authenticate()` themselves
    // to avoid re-verifying the same credential twice per request.
    this.app.use('/api/v1', getAuthMiddleware().authenticate());
    this.app.use('/api/v1/cis', ciRoutes);
    this.app.use('/api/v1/discovery/definitions', discoveryDefinitionRoutes);
    this.app.use('/api/v1/discovery', discoveryRoutes);
    this.app.use('/api/v1/agents', discoveryAgentRoutes);
    this.app.use('/api/v1', unifiedCredentialRoutes);
    this.app.use('/api/v1/connectors', connectorRoutes);
    this.app.use('/api/v1/connector-configs', connectorConfigRoutes);
    this.app.use('/api/v1/relationships', relationshipRoutes);
    this.app.use('/api/v1/search', searchRoutes);
    this.app.use('/api/v1/analytics', analyticsRoutes);
    this.app.use('/api/v1/anomalies', anomalyRoutes);
    this.app.use('/api/v1/reconciliation', reconciliationRoutes);
    this.app.use('/api/v1/dashboards', dashboardRoutes);
    this.app.use('/api/v1/itil', itilRoutes);
    this.app.use('/api/v1/business-services', businessServiceRoutes);
    this.app.use('/api/v1/architecture', architectureRoutes);
    this.app.use('/api/v1/tbm', tbmRoutes);
    this.app.use('/api/v1/settings', settingsRoutes);
    this.app.use('/api/v1/drift', driftRoutes);
    this.app.use('/api/v1/impact', impactRoutes);
    this.app.use('/api/v1/ai', aiPatternRoutes);
    // Prometheus metrics (public, root path -> /metrics)
    this.app.use('/', metricsRoutes);
    // Rate-limit monitoring (admin)
    try {
      const config = loadConfig();
      const rateLimitMiddleware = new RateLimitMiddleware(
        getRedisClient().getConnection(),
        config.rateLimit
      );
      this.app.use(
        '/api/v1/metrics/rate-limits',
        getAuthMiddleware().requireRole('admin'),
        createRateLimitMetricsRoutes(rateLimitMiddleware)
      );
    } catch (err) {
      logger.warn('Rate-limit metrics routes not mounted', { error: (err as Error).message });
    }
    this.app.use('/api/v1', jobsRoutes);
  }

  setupErrorHandling(): void {
    this.app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
      const e: HttpError = typeof err === 'object' && err !== null ? (err as HttpError) : { message: String(err) };
      const clientError = classifyClientError(e);
      if (clientError) {
        // No message/stack: a JSON.parse message quotes the request body.
        logger.warn('API client error', {
          status: clientError.status,
          type: e.type,
          name: e.name,
          _method: req.method,
          _path: req.path,
        });
        res.status(clientError.status).json({
          _error: STATUS_CODES[clientError.status] ?? 'Client Error',
          _message: clientError.message,
        });
        return;
      }
      logger.error('API Error', { error: e.message, stack: e.stack });
      res.status(500).json({
        _error: 'Internal Server Error',
        _message: 'An unexpected error occurred',
      });
    });
  }

  start(): HTTPServer {
    const host = this.host;
    const onListening = () => {
      logger.info(`REST API Server listening on ${host ?? 'all interfaces'} port ${this.port}`);
    };
    this.httpServer =
      host === undefined
        ? this.app.listen(this.port, onListening)
        : this.app.listen(this.port, host, onListening);
    return this.httpServer;
  }

  getHttpServer(): HTTPServer | null {
    return this.httpServer;
  }
}
