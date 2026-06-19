// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configSchema = void 0;
const tslib_1 = require("tslib");
const joi_1 = tslib_1.__importDefault(require("joi"));
exports.configSchema = joi_1.default.object({
    env: joi_1.default.string()
        .valid('development', 'staging', 'production', 'test')
        .default('development'),
    server: joi_1.default.object({
        port: joi_1.default.number().port().default(3000),
        host: joi_1.default.string().default('0.0.0.0'),
        trustProxy: joi_1.default.boolean().default(false),
    }).required(),
    databases: joi_1.default.object({
        neo4j: joi_1.default.object({
            uri: joi_1.default.string().uri().required(),
            username: joi_1.default.string().required(),
            password: joi_1.default.string().required(),
            database: joi_1.default.string().default('neo4j'),
            maxConnectionPoolSize: joi_1.default.number().default(50),
            connectionTimeout: joi_1.default.number().default(30000),
        }).required(),
        postgres: joi_1.default.object({
            host: joi_1.default.string().required(),
            port: joi_1.default.number().port().default(5432),
            database: joi_1.default.string().required(),
            username: joi_1.default.string().required(),
            password: joi_1.default.string().required(),
            maxConnections: joi_1.default.number().default(20),
            ssl: joi_1.default.object({
                enabled: joi_1.default.boolean().default(false),
                rejectUnauthorized: joi_1.default.boolean().default(true),
                ca: joi_1.default.string().optional(),
                cert: joi_1.default.string().optional(),
                key: joi_1.default.string().optional(),
            }).default(),
        }).required(),
        redis: joi_1.default.object({
            host: joi_1.default.string().required(),
            port: joi_1.default.number().port().default(6379),
            password: joi_1.default.string().optional(),
            db: joi_1.default.number().default(0),
            maxRetriesPerRequest: joi_1.default.number().default(3),
            enableReadyCheck: joi_1.default.boolean().default(true),
            tls: joi_1.default.object({
                enabled: joi_1.default.boolean().default(false),
                rejectUnauthorized: joi_1.default.boolean().default(true),
            }).optional(),
        }).required(),
        kafka: joi_1.default.object({
            brokers: joi_1.default.array().items(joi_1.default.string()).required(),
            clientId: joi_1.default.string().default('happycmdb'),
            groupId: joi_1.default.string().default('cmdb-consumers'),
            ssl: joi_1.default.boolean().default(false),
            sasl: joi_1.default.object({
                mechanism: joi_1.default.string().valid('plain', 'scram-sha-256', 'scram-sha-512').optional(),
                username: joi_1.default.string().optional(),
                password: joi_1.default.string().optional(),
            }).optional(),
        }).required(),
    }).required(),
    cloudProviders: joi_1.default.object({
        aws: joi_1.default.object({
            enabled: joi_1.default.boolean().default(false),
            region: joi_1.default.string().default('us-east-1'),
            accessKeyId: joi_1.default.string().when('enabled', {
                is: true,
                then: joi_1.default.required(),
                otherwise: joi_1.default.optional(),
            }),
            secretAccessKey: joi_1.default.string().when('enabled', {
                is: true,
                then: joi_1.default.required(),
                otherwise: joi_1.default.optional(),
            }),
            assumeRoleArn: joi_1.default.string().optional(),
        }).default(),
        azure: joi_1.default.object({
            enabled: joi_1.default.boolean().default(false),
            subscriptionId: joi_1.default.string().when('enabled', {
                is: true,
                then: joi_1.default.required(),
                otherwise: joi_1.default.optional(),
            }),
            tenantId: joi_1.default.string().when('enabled', {
                is: true,
                then: joi_1.default.required(),
                otherwise: joi_1.default.optional(),
            }),
            clientId: joi_1.default.string().when('enabled', {
                is: true,
                then: joi_1.default.required(),
                otherwise: joi_1.default.optional(),
            }),
            clientSecret: joi_1.default.string().when('enabled', {
                is: true,
                then: joi_1.default.required(),
                otherwise: joi_1.default.optional(),
            }),
        }).default(),
        gcp: joi_1.default.object({
            enabled: joi_1.default.boolean().default(false),
            projectId: joi_1.default.string().when('enabled', {
                is: true,
                then: joi_1.default.required(),
                otherwise: joi_1.default.optional(),
            }),
            keyFilePath: joi_1.default.string().when('enabled', {
                is: true,
                then: joi_1.default.required(),
                otherwise: joi_1.default.optional(),
            }),
        }).default(),
    }).default(),
    auth: joi_1.default.object({
        jwt: joi_1.default.object({
            secret: joi_1.default.string().min(32).required(),
            accessTokenExpiresIn: joi_1.default.string().default('15m'),
            refreshTokenExpiresIn: joi_1.default.string().default('7d'),
            issuer: joi_1.default.string().default('happycmdb'),
            audience: joi_1.default.string().default('cmdb-api'),
        }).required(),
        bcrypt: joi_1.default.object({
            rounds: joi_1.default.number().min(10).max(15).default(12),
        }).default(),
        apiKeys: joi_1.default.object({
            enabled: joi_1.default.boolean().default(true),
            headerName: joi_1.default.string().default('X-API-Key'),
        }).default(),
    }).required(),
    rateLimit: joi_1.default.object({
        enabled: joi_1.default.boolean().default(true),
        bypassHeader: joi_1.default.string().default('X-Internal-Service'),
        bypassSecret: joi_1.default.string().optional(),
        tierMultipliers: joi_1.default.object({
            standard: joi_1.default.number().default(5),
            premium: joi_1.default.number().default(10),
            enterprise: joi_1.default.number().default(20),
        }).default(),
        endpoints: joi_1.default.object({
            rest: joi_1.default.object({
                max: joi_1.default.number().default(1000),
                windowMs: joi_1.default.number().default(3600000),
            }).default(),
            graphql: joi_1.default.object({
                max: joi_1.default.number().default(500),
                windowMs: joi_1.default.number().default(3600000),
            }).default(),
            health: joi_1.default.object({
                max: joi_1.default.number().default(0),
                windowMs: joi_1.default.number().default(60000),
            }).default(),
            auth: joi_1.default.object({
                max: joi_1.default.number().default(20),
                windowMs: joi_1.default.number().default(3600000),
            }).default(),
            discovery: joi_1.default.object({
                max: joi_1.default.number().default(100),
                windowMs: joi_1.default.number().default(3600000),
            }).default(),
            admin: joi_1.default.object({
                max: joi_1.default.number().default(200),
                windowMs: joi_1.default.number().default(3600000),
            }).default(),
        }).default(),
        monitoring: joi_1.default.object({
            enabled: joi_1.default.boolean().default(true),
            logRateLimitHits: joi_1.default.boolean().default(true),
        }).default(),
    }).default(),
    cors: joi_1.default.object({
        enabled: joi_1.default.boolean().default(true),
        origins: joi_1.default.array()
            .items(joi_1.default.string().uri())
            .default(['http://localhost:3000']),
        credentials: joi_1.default.boolean().default(true),
        maxAge: joi_1.default.number().default(86400),
    }).default(),
    ssl: joi_1.default.object({
        enabled: joi_1.default.boolean().default(false),
        keyPath: joi_1.default.string().when('enabled', {
            is: true,
            then: joi_1.default.required(),
            otherwise: joi_1.default.optional(),
        }),
        certPath: joi_1.default.string().when('enabled', {
            is: true,
            then: joi_1.default.required(),
            otherwise: joi_1.default.optional(),
        }),
        caPath: joi_1.default.string().optional(),
        redirectHttp: joi_1.default.boolean().default(true),
    }).default(),
    secrets: joi_1.default.object({
        provider: joi_1.default.string()
            .valid('env', 'aws-secrets-manager', 'vault')
            .default('env'),
        awsSecretsManager: joi_1.default.object({
            region: joi_1.default.string().default('us-east-1'),
            secretName: joi_1.default.string().optional(),
        }).optional(),
        vault: joi_1.default.object({
            address: joi_1.default.string().uri().optional(),
            token: joi_1.default.string().optional(),
            namespace: joi_1.default.string().optional(),
            path: joi_1.default.string().default('secret/cmdb'),
        }).optional(),
        cacheTtl: joi_1.default.number().default(300),
    }).default(),
    logging: joi_1.default.object({
        level: joi_1.default.string()
            .valid('error', 'warn', 'info', 'debug', 'verbose')
            .default('info'),
        format: joi_1.default.string().valid('json', 'simple').default('json'),
        colorize: joi_1.default.boolean().default(false),
        auditEnabled: joi_1.default.boolean().default(true),
        auditLevel: joi_1.default.string()
            .valid('error', 'warn', 'info', 'debug', 'verbose')
            .default('info'),
    }).default(),
    security: joi_1.default.object({
        helmet: joi_1.default.object({
            enabled: joi_1.default.boolean().default(true),
            contentSecurityPolicy: joi_1.default.object({
                enabled: joi_1.default.boolean().default(true),
                directives: joi_1.default.object().optional(),
            }).default(),
            hsts: joi_1.default.object({
                enabled: joi_1.default.boolean().default(true),
                maxAge: joi_1.default.number().default(31536000),
                includeSubDomains: joi_1.default.boolean().default(true),
                preload: joi_1.default.boolean().default(true),
            }).default(),
        }).default(),
        csrf: joi_1.default.object({
            enabled: joi_1.default.boolean().default(false),
            ignoredRoutes: joi_1.default.array().items(joi_1.default.string()).default([]),
        }).default(),
    }).default(),
    validation: joi_1.default.object({
        stripUnknown: joi_1.default.boolean().default(true),
        abortEarly: joi_1.default.boolean().default(false),
        sanitizeInput: joi_1.default.boolean().default(true),
    }).default(),
    discovery: joi_1.default.object({
        enabled: joi_1.default.boolean().default(true),
        interval: joi_1.default.number().default(3600000),
        batchSize: joi_1.default.number().default(100),
        maxRetries: joi_1.default.number().default(3),
        retryDelay: joi_1.default.number().default(2000),
    }).default(),
    monitoring: joi_1.default.object({
        enabled: joi_1.default.boolean().default(true),
        metricsPort: joi_1.default.number().port().default(9090),
        healthCheckPath: joi_1.default.string().default('/health'),
    }).default(),
}).required();
//# sourceMappingURL=config.schema.js.map