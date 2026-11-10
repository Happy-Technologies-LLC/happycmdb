/**
 * Environment Variables Type Declarations
 *
 * Provides type-safe access to process.env variables
 */

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      // Application
      NODE_ENV?: 'development' | 'production' | 'test';
      PORT?: string;
      LOG_LEVEL?: string;

      // Neo4j
      NEO4J_URI?: string;
      NEO4J_USERNAME?: string;
      NEO4J_PASSWORD?: string;

      // PostgreSQL
      POSTGRES_HOST?: string;
      POSTGRES_PORT?: string;
      POSTGRES_DB?: string;
      POSTGRES_USER?: string;
      POSTGRES_PASSWORD?: string;

      // Redis
      REDIS_HOST?: string;
      REDIS_PORT?: string;
      REDIS_PASSWORD?: string;

      // API Configuration
      API_KEY?: string;
      JWT_SECRET?: string;

      // Cloud Providers
      AWS_REGION?: string;
      AWS_ACCESS_KEY_ID?: string;
      AWS_SECRET_ACCESS_KEY?: string;
      AZURE_SUBSCRIPTION_ID?: string;
      AZURE_TENANT_ID?: string;
      AZURE_CLIENT_ID?: string;
      AZURE_CLIENT_SECRET?: string;
      GCP_PROJECT_ID?: string;
      GCP_CREDENTIALS_PATH?: string;
    }
  }
}

export {};
