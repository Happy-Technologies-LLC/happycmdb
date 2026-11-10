// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Loader
 * Loads configuration from multiple sources with priority:
 * 1. Environment variables
 * 2. Config files (development.json, staging.json, production.json)
 * 3. .env files
 * 4. Default values from schema
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { configSchema, ConfigSchema } from './config.schema';
import * as dotenv from 'dotenv';
import { getLogger } from '../logging/logger';

const logger = getLogger();

export class ConfigurationLoader {
  private config: ConfigSchema | null = null;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || this.getDefaultConfigPath();
  }

  /**
   * Load and validate configuration
   */
  public load(): ConfigSchema {
    if (this.config) {
      return this.config;
    }

    // 1. Load .env file
    this.loadDotEnv();

    // 2. Load config file
    const fileConfig = this.loadConfigFile();

    // 3. Merge with environment variables
    const mergedConfig = this.mergeWithEnvVars(fileConfig);

    // 4. Validate configuration
    const { error, value } = configSchema.validate(mergedConfig, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((d) => `${d.path.join('.')}: ${d.message}`).join('\n');
      throw new Error(`Configuration validation failed:\n${errors}`);
    }

    this.config = value as ConfigSchema;
    return this.config;
  }

  /**
   * Get loaded configuration
   */
  public getConfig(): ConfigSchema {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
    return this.config;
  }

  /**
   * Reload configuration (useful for hot-reloading)
   */
  public reload(): ConfigSchema {
    this.config = null;
    return this.load();
  }

  /**
   * Load .env file
   */
  private loadDotEnv(): void {
    const env = process.env.NODE_ENV || 'development';
    const envFiles = [
      resolve(process.cwd(), `.env.${env}.local`),
      resolve(process.cwd(), `.env.${env}`),
      resolve(process.cwd(), '.env.local'),
      resolve(process.cwd(), '.env'),
    ];

    for (const envFile of envFiles) {
      if (existsSync(envFile)) {
        dotenv.config({ path: envFile });
        break;
      }
    }
  }

  /**
   * Load configuration file
   */
  private loadConfigFile(): Partial<ConfigSchema> {
    if (!existsSync(this.configPath)) {
      logger.warn(`Configuration file not found: ${this.configPath}`);
      return {};
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to parse configuration file: ${error}`);
    }
  }

  /**
   * Merge config with environment variables
   */
  private mergeWithEnvVars(fileConfig: Partial<ConfigSchema>): any {
    const env = process.env;

    return {
      env: (env['NODE_ENV'] as any) || fileConfig.env,

      server: {
        port: env['SERVER_PORT'] ? parseInt(env['SERVER_PORT'], 10) : fileConfig.server?.port,
        host: env['SERVER_HOST'] || fileConfig.server?.host,
        trustProxy: env['TRUST_PROXY'] ?? fileConfig.server?.trustProxy,
      },

      databases: {
        neo4j: {
          uri: env['NEO4J_URI'] || fileConfig.databases?.neo4j?.uri || '',
          username: env['NEO4J_USERNAME'] || fileConfig.databases?.neo4j?.username || '',
          password: env['NEO4J_PASSWORD'] || fileConfig.databases?.neo4j?.password || '',
          database: env['NEO4J_DATABASE'] || fileConfig.databases?.neo4j?.database,
          maxConnectionPoolSize: env['NEO4J_MAX_POOL_SIZE']
            ? parseInt(env['NEO4J_MAX_POOL_SIZE'], 10)
            : fileConfig.databases?.neo4j?.maxConnectionPoolSize,
          connectionTimeout: env['NEO4J_CONNECTION_TIMEOUT']
            ? parseInt(env['NEO4J_CONNECTION_TIMEOUT'], 10)
            : fileConfig.databases?.neo4j?.connectionTimeout,
        },

        postgres: {
          host: env['POSTGRES_HOST'] || fileConfig.databases?.postgres?.host || '',
          port: env['POSTGRES_PORT']
            ? parseInt(env['POSTGRES_PORT'], 10)
            : fileConfig.databases?.postgres?.port,
          database: env['POSTGRES_DB'] || fileConfig.databases?.postgres?.database || '',
          username: env['POSTGRES_USER'] || fileConfig.databases?.postgres?.username || '',
          password: env['POSTGRES_PASSWORD'] || fileConfig.databases?.postgres?.password || '',
          maxConnections: env['POSTGRES_MAX_CONNECTIONS']
            ? parseInt(env['POSTGRES_MAX_CONNECTIONS'], 10)
            : fileConfig.databases?.postgres?.maxConnections,
        },

        redis: {
          host: env['REDIS_HOST'] || fileConfig.databases?.redis?.host || '',
          port: env['REDIS_PORT'] ? parseInt(env['REDIS_PORT'], 10) : fileConfig.databases?.redis?.port,
          password: env['REDIS_PASSWORD'] || fileConfig.databases?.redis?.password,
          db: env['REDIS_DB'] ? parseInt(env['REDIS_DB'], 10) : fileConfig.databases?.redis?.db,
          maxRetriesPerRequest: env['REDIS_MAX_RETRIES']
            ? parseInt(env['REDIS_MAX_RETRIES'], 10)
            : fileConfig.databases?.redis?.maxRetriesPerRequest,
          enableReadyCheck:
            env['REDIS_ENABLE_READY_CHECK'] === 'true' ||
            fileConfig.databases?.redis?.enableReadyCheck,
          tls: env['REDIS_TLS'] === 'true'
            ? {
                enabled: true,
                rejectUnauthorized: env['REDIS_TLS_REJECT_UNAUTHORIZED'] !== 'false',
              }
            : fileConfig.databases?.redis?.tls,
        },

        kafka: {
          brokers: env['KAFKA_BROKERS']
            ? env['KAFKA_BROKERS'].split(',')
            : fileConfig.databases?.kafka?.brokers || [],
          clientId: env['KAFKA_CLIENT_ID'] || fileConfig.databases?.kafka?.clientId || '',
          groupId: env['KAFKA_GROUP_ID'] || fileConfig.databases?.kafka?.groupId || '',
          ssl: env['KAFKA_SSL'] === 'true' || fileConfig.databases?.kafka?.ssl || false,
          sasl: env['KAFKA_SASL_MECHANISM']
            ? {
                mechanism: env['KAFKA_SASL_MECHANISM'] as any,
                username: env['KAFKA_SASL_USERNAME'] || '',
                password: env['KAFKA_SASL_PASSWORD'] || '',
              }
            : fileConfig.databases?.kafka?.sasl,
        },
      },

      cloudProviders: {
        aws: {
          enabled: env['AWS_ENABLED'] === 'true' || fileConfig.cloudProviders?.aws?.enabled || false,
          region: env['AWS_REGION'] || fileConfig.cloudProviders?.aws?.region,
          accessKeyId: env['AWS_ACCESS_KEY_ID'] || fileConfig.cloudProviders?.aws?.accessKeyId,
          secretAccessKey:
            env['AWS_SECRET_ACCESS_KEY'] || fileConfig.cloudProviders?.aws?.secretAccessKey,
          assumeRoleArn: env['AWS_ASSUME_ROLE_ARN'] || fileConfig.cloudProviders?.aws?.assumeRoleArn,
        },

        azure: {
          enabled:
            env['AZURE_ENABLED'] === 'true' || fileConfig.cloudProviders?.azure?.enabled || false,
          subscriptionId:
            env['AZURE_SUBSCRIPTION_ID'] || fileConfig.cloudProviders?.azure?.subscriptionId,
          tenantId: env['AZURE_TENANT_ID'] || fileConfig.cloudProviders?.azure?.tenantId,
          clientId: env['AZURE_CLIENT_ID'] || fileConfig.cloudProviders?.azure?.clientId,
          clientSecret: env['AZURE_CLIENT_SECRET'] || fileConfig.cloudProviders?.azure?.clientSecret,
        },

        gcp: {
          enabled: env['GCP_ENABLED'] === 'true' || fileConfig.cloudProviders?.gcp?.enabled || false,
          projectId: env['GCP_PROJECT_ID'] || fileConfig.cloudProviders?.gcp?.projectId,
          keyFilePath: env['GCP_KEY_FILE_PATH'] || fileConfig.cloudProviders?.gcp?.keyFilePath,
        },
      },

      auth: {
        jwt: {
          secret: env['JWT_SECRET'] || fileConfig.auth?.jwt?.secret || '',
          accessTokenExpiresIn:
            env['JWT_ACCESS_TOKEN_EXPIRES_IN'] || fileConfig.auth?.jwt?.accessTokenExpiresIn || '15m',
          refreshTokenExpiresIn:
            env['JWT_REFRESH_TOKEN_EXPIRES_IN'] ||
            fileConfig.auth?.jwt?.refreshTokenExpiresIn ||
            '7d',
          issuer: env['JWT_ISSUER'] || fileConfig.auth?.jwt?.issuer,
          audience: env['JWT_AUDIENCE'] || fileConfig.auth?.jwt?.audience,
        },
        bcrypt: {
          rounds: env['BCRYPT_ROUNDS']
            ? parseInt(env['BCRYPT_ROUNDS'], 10)
            : fileConfig.auth?.bcrypt?.rounds,
        },
        apiKeys: {
          enabled: env['API_KEYS_ENABLED'] === 'true' || fileConfig.auth?.apiKeys?.enabled !== false,
          headerName: env['API_KEY_HEADER_NAME'] || fileConfig.auth?.apiKeys?.headerName || 'X-API-Key',
        },
      },

      rateLimit: {
        enabled: env['RATE_LIMIT_ENABLED'] !== 'false' && fileConfig.rateLimit?.enabled !== false,
        bypassHeader: env['RATE_LIMIT_BYPASS_HEADER'] || fileConfig.rateLimit?.bypassHeader,
        bypassSecret: env['RATE_LIMIT_BYPASS_SECRET'] || fileConfig.rateLimit?.bypassSecret,
        tierMultipliers: {
          standard: env['RATE_LIMIT_TIER_STANDARD_MULTIPLIER']
            ? parseInt(env['RATE_LIMIT_TIER_STANDARD_MULTIPLIER'], 10)
            : fileConfig.rateLimit?.tierMultipliers?.standard,
          premium: env['RATE_LIMIT_TIER_PREMIUM_MULTIPLIER']
            ? parseInt(env['RATE_LIMIT_TIER_PREMIUM_MULTIPLIER'], 10)
            : fileConfig.rateLimit?.tierMultipliers?.premium,
          enterprise: env['RATE_LIMIT_TIER_ENTERPRISE_MULTIPLIER']
            ? parseInt(env['RATE_LIMIT_TIER_ENTERPRISE_MULTIPLIER'], 10)
            : fileConfig.rateLimit?.tierMultipliers?.enterprise,
        },
        endpoints: {
          rest: {
            max: env['RATE_LIMIT_REST_MAX']
              ? parseInt(env['RATE_LIMIT_REST_MAX'], 10)
              : fileConfig.rateLimit?.endpoints?.rest?.max,
            windowMs: env['RATE_LIMIT_REST_WINDOW_MS']
              ? parseInt(env['RATE_LIMIT_REST_WINDOW_MS'], 10)
              : fileConfig.rateLimit?.endpoints?.rest?.windowMs,
          },
          graphql: {
            max: env['RATE_LIMIT_GRAPHQL_MAX']
              ? parseInt(env['RATE_LIMIT_GRAPHQL_MAX'], 10)
              : fileConfig.rateLimit?.endpoints?.graphql?.max,
            windowMs: env['RATE_LIMIT_GRAPHQL_WINDOW_MS']
              ? parseInt(env['RATE_LIMIT_GRAPHQL_WINDOW_MS'], 10)
              : fileConfig.rateLimit?.endpoints?.graphql?.windowMs,
          },
          health: {
            max: env['RATE_LIMIT_HEALTH_MAX']
              ? parseInt(env['RATE_LIMIT_HEALTH_MAX'], 10)
              : fileConfig.rateLimit?.endpoints?.health?.max,
            windowMs: env['RATE_LIMIT_HEALTH_WINDOW_MS']
              ? parseInt(env['RATE_LIMIT_HEALTH_WINDOW_MS'], 10)
              : fileConfig.rateLimit?.endpoints?.health?.windowMs,
          },
          auth: {
            max: env['RATE_LIMIT_AUTH_MAX']
              ? parseInt(env['RATE_LIMIT_AUTH_MAX'], 10)
              : fileConfig.rateLimit?.endpoints?.auth?.max,
            windowMs: env['RATE_LIMIT_AUTH_WINDOW_MS']
              ? parseInt(env['RATE_LIMIT_AUTH_WINDOW_MS'], 10)
              : fileConfig.rateLimit?.endpoints?.auth?.windowMs,
          },
          authAccount: {
            max: env['RATE_LIMIT_AUTH_ACCOUNT_MAX']
              ? parseInt(env['RATE_LIMIT_AUTH_ACCOUNT_MAX'], 10)
              : fileConfig.rateLimit?.endpoints?.authAccount?.max,
            windowMs: env['RATE_LIMIT_AUTH_ACCOUNT_WINDOW_MS']
              ? parseInt(env['RATE_LIMIT_AUTH_ACCOUNT_WINDOW_MS'], 10)
              : fileConfig.rateLimit?.endpoints?.authAccount?.windowMs,
          },
          authAccountGlobal: {
            max: env['RATE_LIMIT_AUTH_ACCOUNT_GLOBAL_MAX']
              ? parseInt(env['RATE_LIMIT_AUTH_ACCOUNT_GLOBAL_MAX'], 10)
              : fileConfig.rateLimit?.endpoints?.authAccountGlobal?.max,
            windowMs: env['RATE_LIMIT_AUTH_ACCOUNT_GLOBAL_WINDOW_MS']
              ? parseInt(env['RATE_LIMIT_AUTH_ACCOUNT_GLOBAL_WINDOW_MS'], 10)
              : fileConfig.rateLimit?.endpoints?.authAccountGlobal?.windowMs,
          },
          discovery: {
            max: env['RATE_LIMIT_DISCOVERY_MAX']
              ? parseInt(env['RATE_LIMIT_DISCOVERY_MAX'], 10)
              : fileConfig.rateLimit?.endpoints?.discovery?.max,
            windowMs: env['RATE_LIMIT_DISCOVERY_WINDOW_MS']
              ? parseInt(env['RATE_LIMIT_DISCOVERY_WINDOW_MS'], 10)
              : fileConfig.rateLimit?.endpoints?.discovery?.windowMs,
          },
          admin: {
            max: env['RATE_LIMIT_ADMIN_MAX']
              ? parseInt(env['RATE_LIMIT_ADMIN_MAX'], 10)
              : fileConfig.rateLimit?.endpoints?.admin?.max,
            windowMs: env['RATE_LIMIT_ADMIN_WINDOW_MS']
              ? parseInt(env['RATE_LIMIT_ADMIN_WINDOW_MS'], 10)
              : fileConfig.rateLimit?.endpoints?.admin?.windowMs,
          },
        },
        monitoring: {
          enabled: env['RATE_LIMIT_MONITORING_ENABLED'] !== 'false' &&
            fileConfig.rateLimit?.monitoring?.enabled !== false,
          logRateLimitHits: env['RATE_LIMIT_LOG_HITS'] !== 'false' &&
            fileConfig.rateLimit?.monitoring?.logRateLimitHits !== false,
        },
      },

      ssl: {
        enabled: env['SSL_ENABLED'] === 'true' || fileConfig.ssl?.enabled || false,
        keyPath: env['SSL_KEY_PATH'] || fileConfig.ssl?.keyPath,
        certPath: env['SSL_CERT_PATH'] || fileConfig.ssl?.certPath,
        caPath: env['SSL_CA_PATH'] || fileConfig.ssl?.caPath,
        redirectHttp: env['SSL_REDIRECT_HTTP'] !== 'false' && fileConfig.ssl?.redirectHttp !== false,
      },

      secrets: {
        provider: (env['SECRETS_PROVIDER'] as any) || fileConfig.secrets?.provider,
        awsSecretsManager: {
          region: env['AWS_SECRETS_REGION'] || fileConfig.secrets?.awsSecretsManager?.region,
          secretName: env['AWS_SECRET_NAME'] || fileConfig.secrets?.awsSecretsManager?.secretName,
        },
        vault: {
          address: env['VAULT_ADDR'] || fileConfig.secrets?.vault?.address,
          token: env['VAULT_TOKEN'] || fileConfig.secrets?.vault?.token,
          namespace: env['VAULT_NAMESPACE'] || fileConfig.secrets?.vault?.namespace,
          path: env['VAULT_PATH'] || fileConfig.secrets?.vault?.path,
        },
        cacheTtl: env['SECRETS_CACHE_TTL']
          ? parseInt(env['SECRETS_CACHE_TTL'], 10)
          : fileConfig.secrets?.cacheTtl,
      },

      logging: {
        level: (env['LOG_LEVEL'] as any) || fileConfig.logging?.level,
        format: (env['LOG_FORMAT'] as any) || fileConfig.logging?.format,
        colorize: env['LOG_COLORIZE'] === 'true' || fileConfig.logging?.colorize,
        auditEnabled: env['AUDIT_ENABLED'] !== 'false' && fileConfig.logging?.auditEnabled !== false,
        auditLevel: (env['AUDIT_LEVEL'] as any) || fileConfig.logging?.auditLevel,
      },

      security: fileConfig.security,
      validation: fileConfig.validation,
      discovery: fileConfig.discovery,
      monitoring: fileConfig.monitoring,
    };
  }

  /**
   * Get default config path based on environment
   */
  private getDefaultConfigPath(): string {
    const env = process.env['NODE_ENV'] || 'development';
    const configDir = resolve(process.cwd(), 'config');
    return resolve(configDir, `${env}.json`);
  }
}

// Singleton instance
let configLoader: ConfigurationLoader | null = null;

/**
 * Get configuration loader instance
 */
export function getConfigLoader(configPath?: string): ConfigurationLoader {
  if (!configLoader) {
    configLoader = new ConfigurationLoader(configPath);
  }
  return configLoader;
}

/**
 * Get loaded configuration (shorthand)
 */
export function getConfig(): ConfigSchema {
  return getConfigLoader().getConfig();
}

/**
 * Load configuration (shorthand)
 */
export function loadConfig(configPath?: string): ConfigSchema {
  return getConfigLoader(configPath).load();
}
