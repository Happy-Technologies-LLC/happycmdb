// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Schema Validation
 * Uses Joi for runtime validation of configuration
 */

import Joi from 'joi';

export const configSchema = Joi.object({
  // Environment
  env: Joi.string()
    .valid('development', 'staging', 'production', 'test')
    .default('development'),

  // Server Configuration
  server: Joi.object({
    port: Joi.number().port().default(3000),
    host: Joi.string().default('0.0.0.0'),
    trustProxy: Joi.boolean().default(false),
  }).required(),

  // Database Configuration
  databases: Joi.object({
    neo4j: Joi.object({
      uri: Joi.string().uri().required(),
      username: Joi.string().required(),
      password: Joi.string().required(),
      database: Joi.string().default('neo4j'),
      maxConnectionPoolSize: Joi.number().default(50),
      connectionTimeout: Joi.number().default(30000),
    }).required(),

    postgres: Joi.object({
      host: Joi.string().required(),
      port: Joi.number().port().default(5432),
      database: Joi.string().required(),
      username: Joi.string().required(),
      password: Joi.string().required(),
      maxConnections: Joi.number().default(20),
      ssl: Joi.object({
        enabled: Joi.boolean().default(false),
        rejectUnauthorized: Joi.boolean().default(true),
        ca: Joi.string().optional(),
        cert: Joi.string().optional(),
        key: Joi.string().optional(),
      }).default(),
    }).required(),

    redis: Joi.object({
      host: Joi.string().required(),
      port: Joi.number().port().default(6379),
      password: Joi.string().optional(),
      db: Joi.number().default(0),
      maxRetriesPerRequest: Joi.number().default(3),
      enableReadyCheck: Joi.boolean().default(true),
      tls: Joi.object({
        enabled: Joi.boolean().default(false),
        rejectUnauthorized: Joi.boolean().default(true),
      }).optional(),
    }).required(),

    kafka: Joi.object({
      brokers: Joi.array().items(Joi.string()).required(),
      clientId: Joi.string().default('happycmdb'),
      groupId: Joi.string().default('cmdb-consumers'),
      ssl: Joi.boolean().default(false),
      sasl: Joi.object({
        mechanism: Joi.string().valid('plain', 'scram-sha-256', 'scram-sha-512').optional(),
        username: Joi.string().optional(),
        password: Joi.string().optional(),
      }).optional(),
    }).required(),
  }).required(),

  // Cloud Provider Credentials
  cloudProviders: Joi.object({
    aws: Joi.object({
      enabled: Joi.boolean().default(false),
      region: Joi.string().default('us-east-1'),
      accessKeyId: Joi.string().when('enabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
      secretAccessKey: Joi.string().when('enabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
      assumeRoleArn: Joi.string().optional(),
    }).default(),

    azure: Joi.object({
      enabled: Joi.boolean().default(false),
      subscriptionId: Joi.string().when('enabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
      tenantId: Joi.string().when('enabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
      clientId: Joi.string().when('enabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
      clientSecret: Joi.string().when('enabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
    }).default(),

    gcp: Joi.object({
      enabled: Joi.boolean().default(false),
      projectId: Joi.string().when('enabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
      keyFilePath: Joi.string().when('enabled', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
    }).default(),
  }).default(),

  // Authentication & Authorization
  auth: Joi.object({
    jwt: Joi.object({
      secret: Joi.string().min(32).required(),
      accessTokenExpiresIn: Joi.string().default('15m'),
      refreshTokenExpiresIn: Joi.string().default('7d'),
      issuer: Joi.string().default('happycmdb'),
      audience: Joi.string().default('cmdb-api'),
    }).required(),

    bcrypt: Joi.object({
      rounds: Joi.number().min(10).max(15).default(12),
    }).default(),

    apiKeys: Joi.object({
      enabled: Joi.boolean().default(true),
      headerName: Joi.string().default('X-API-Key'),
    }).default(),
  }).required(),

  // Rate Limiting
  rateLimit: Joi.object({
    enabled: Joi.boolean().default(true),

    // Internal service bypass
    bypassHeader: Joi.string().default('X-Internal-Service'),
    bypassSecret: Joi.string().optional(),

    // Tier multipliers for API keys
    tierMultipliers: Joi.object({
      standard: Joi.number().default(5),
      premium: Joi.number().default(10),
      enterprise: Joi.number().default(20),
    }).default(),

    endpoints: Joi.object({
      // REST API - 1000 req/hour per IP (anonymous)
      rest: Joi.object({
        max: Joi.number().default(1000),
        windowMs: Joi.number().default(3600000), // 1 hour
      }).default(),

      // GraphQL - 500 req/hour per IP (anonymous)
      graphql: Joi.object({
        max: Joi.number().default(500),
        windowMs: Joi.number().default(3600000), // 1 hour
      }).default(),

      // Health endpoints - unlimited
      health: Joi.object({
        max: Joi.number().default(0), // 0 = unlimited
        windowMs: Joi.number().default(60000),
      }).default(),

      // Authentication - 20 req/hour per IP
      auth: Joi.object({
        max: Joi.number().default(20),
        windowMs: Joi.number().default(3600000), // 1 hour
      }).default(),

      // Discovery endpoints
      discovery: Joi.object({
        max: Joi.number().default(100),
        windowMs: Joi.number().default(3600000),
      }).default(),

      // Admin endpoints
      admin: Joi.object({
        max: Joi.number().default(200),
        windowMs: Joi.number().default(3600000),
      }).default(),
    }).default(),

    // Monitoring
    monitoring: Joi.object({
      enabled: Joi.boolean().default(true),
      logRateLimitHits: Joi.boolean().default(true),
    }).default(),
  }).default(),

  // CORS Configuration
  cors: Joi.object({
    enabled: Joi.boolean().default(true),
    origins: Joi.array()
      .items(Joi.string().uri())
      .default(['http://localhost:3000']),
    credentials: Joi.boolean().default(true),
    maxAge: Joi.number().default(86400), // 24 hours
  }).default(),

  // SSL/TLS Configuration
  ssl: Joi.object({
    enabled: Joi.boolean().default(false),
    keyPath: Joi.string().when('enabled', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
    certPath: Joi.string().when('enabled', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
    caPath: Joi.string().optional(),
    redirectHttp: Joi.boolean().default(true),
  }).default(),

  // Secrets Management
  secrets: Joi.object({
    provider: Joi.string()
      .valid('env', 'aws-secrets-manager', 'vault')
      .default('env'),

    awsSecretsManager: Joi.object({
      region: Joi.string().default('us-east-1'),
      secretName: Joi.string().optional(),
    }).optional(),

    vault: Joi.object({
      address: Joi.string().uri().optional(),
      token: Joi.string().optional(),
      namespace: Joi.string().optional(),
      path: Joi.string().default('secret/cmdb'),
    }).optional(),

    cacheTtl: Joi.number().default(300), // 5 minutes
  }).default(),

  // Logging Configuration
  logging: Joi.object({
    level: Joi.string()
      .valid('error', 'warn', 'info', 'debug', 'verbose')
      .default('info'),
    format: Joi.string().valid('json', 'simple').default('json'),
    colorize: Joi.boolean().default(false),
    auditEnabled: Joi.boolean().default(true),
    auditLevel: Joi.string()
      .valid('error', 'warn', 'info', 'debug', 'verbose')
      .default('info'),
  }).default(),

  // Security Headers
  security: Joi.object({
    helmet: Joi.object({
      enabled: Joi.boolean().default(true),
      contentSecurityPolicy: Joi.object({
        enabled: Joi.boolean().default(true),
        directives: Joi.object().optional(),
      }).default(),
      hsts: Joi.object({
        enabled: Joi.boolean().default(true),
        maxAge: Joi.number().default(31536000), // 1 year
        includeSubDomains: Joi.boolean().default(true),
        preload: Joi.boolean().default(true),
      }).default(),
    }).default(),

    csrf: Joi.object({
      enabled: Joi.boolean().default(false),
      ignoredRoutes: Joi.array().items(Joi.string()).default([]),
    }).default(),
  }).default(),

  // Input Validation
  validation: Joi.object({
    stripUnknown: Joi.boolean().default(true),
    abortEarly: Joi.boolean().default(false),
    sanitizeInput: Joi.boolean().default(true),
  }).default(),

  // Discovery Configuration
  discovery: Joi.object({
    enabled: Joi.boolean().default(true),
    interval: Joi.number().default(3600000), // 1 hour
    batchSize: Joi.number().default(100),
    maxRetries: Joi.number().default(3),
    retryDelay: Joi.number().default(2000),
  }).default(),

  // Metrics & Monitoring
  monitoring: Joi.object({
    enabled: Joi.boolean().default(true),
    metricsPort: Joi.number().port().default(9090),
    healthCheckPath: Joi.string().default('/health'),
  }).default(),
}).required();

export type ConfigSchema = {
  env: 'development' | 'staging' | 'production' | 'test';
  server: {
    port: number;
    host: string;
    trustProxy: boolean;
  };
  databases: {
    neo4j: {
      uri: string;
      username: string;
      password: string;
      database: string;
      maxConnectionPoolSize: number;
      connectionTimeout: number;
    };
    postgres: {
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
      maxConnections: number;
      ssl?: {
        enabled: boolean;
        rejectUnauthorized: boolean;
        ca?: string;
        cert?: string;
        key?: string;
      };
    };
    redis: {
      host: string;
      port: number;
      password?: string;
      db: number;
      maxRetriesPerRequest: number;
      enableReadyCheck: boolean;
      tls?: {
        enabled: boolean;
        rejectUnauthorized: boolean;
      };
    };
    kafka: {
      brokers: string[];
      clientId: string;
      groupId: string;
      ssl: boolean;
      sasl?: {
        mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
        username: string;
        password: string;
      };
    };
  };
  cloudProviders: {
    aws: {
      enabled: boolean;
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      assumeRoleArn?: string;
    };
    azure: {
      enabled: boolean;
      subscriptionId?: string;
      tenantId?: string;
      clientId?: string;
      clientSecret?: string;
    };
    gcp: {
      enabled: boolean;
      projectId?: string;
      keyFilePath?: string;
    };
  };
  auth: {
    jwt: {
      secret: string;
      accessTokenExpiresIn: string;
      refreshTokenExpiresIn: string;
      issuer: string;
      audience: string;
    };
    bcrypt: {
      rounds: number;
    };
    apiKeys: {
      enabled: boolean;
      headerName: string;
    };
  };
  rateLimit: {
    enabled: boolean;
    bypassHeader: string;
    bypassSecret?: string;
    tierMultipliers: {
      standard: number;
      premium: number;
      enterprise: number;
    };
    endpoints: {
      rest: { max: number; windowMs: number };
      graphql: { max: number; windowMs: number };
      health: { max: number; windowMs: number };
      auth: { max: number; windowMs: number };
      discovery: { max: number; windowMs: number };
      admin: { max: number; windowMs: number };
    };
    monitoring: {
      enabled: boolean;
      logRateLimitHits: boolean;
    };
  };
  cors: {
    enabled: boolean;
    origins: string[];
    credentials: boolean;
    maxAge: number;
  };
  ssl: {
    enabled: boolean;
    keyPath?: string;
    certPath?: string;
    caPath?: string;
    redirectHttp: boolean;
  };
  secrets: {
    provider: 'env' | 'aws-secrets-manager' | 'vault';
    awsSecretsManager?: {
      region: string;
      secretName?: string;
    };
    vault?: {
      address?: string;
      token?: string;
      namespace?: string;
      path: string;
    };
    cacheTtl: number;
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug' | 'verbose';
    format: 'json' | 'simple';
    colorize: boolean;
    auditEnabled: boolean;
    auditLevel: 'error' | 'warn' | 'info' | 'debug' | 'verbose';
  };
  security: {
    helmet: {
      enabled: boolean;
      contentSecurityPolicy: {
        enabled: boolean;
        directives?: Record<string, any>;
      };
      hsts: {
        enabled: boolean;
        maxAge: number;
        includeSubDomains: boolean;
        preload: boolean;
      };
    };
    csrf: {
      enabled: boolean;
      ignoredRoutes: string[];
    };
  };
  validation: {
    stripUnknown: boolean;
    abortEarly: boolean;
    sanitizeInput: boolean;
  };
  discovery: {
    enabled: boolean;
    interval: number;
    batchSize: number;
    maxRetries: number;
    retryDelay: number;
  };
  monitoring: {
    enabled: boolean;
    metricsPort: number;
    healthCheckPath: string;
  };
};
