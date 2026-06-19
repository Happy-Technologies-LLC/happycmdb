/**
 * Secrets Manager
 * Integrates with AWS Secrets Manager, HashiCorp Vault, or falls back to environment variables
 * Implements caching with configurable TTL
 */

import { ConfigSchema } from '../config/config.schema';

export interface SecretsProvider {
  getSecret(key: string): Promise<string | null>;
  getSecrets(keys: string[]): Promise<Record<string, string>>;
  setSecret?(key: string, value: string): Promise<void>;
  deleteSecret?(key: string): Promise<void>;
}

interface CacheEntry {
  _value: string;
  _expiresAt: number;
}

export class SecretsManager {
  private provider: SecretsProvider;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtl: number;

  constructor(config: ConfigSchema['secrets'], provider?: SecretsProvider) {
    this.cacheTtl = config.cacheTtl * 1000; // Convert to milliseconds

    if (provider) {
      this.provider = provider;
    } else {
      // Auto-select provider based on config
      switch (config.provider) {
        case 'aws-secrets-manager':
          this.provider = new AWSSecretsProvider(config.awsSecretsManager!);
          break;
        case 'vault':
          this.provider = new VaultProvider(config.vault!);
          break;
        case 'env':
        default:
          this.provider = new EnvironmentProvider();
          break;
      }
    }
  }

  /**
   * Get a single secret
   */
  async getSecret(key: string): Promise<string | null> {
    // Check cache first
    const cached = this.getFromCache(key);
    if (cached !== null) {
      return cached;
    }

    // Fetch from provider
    const value = await this.provider.getSecret(key);

    if (value !== null) {
      this.setInCache(key, value);
    }

    return value;
  }

  /**
   * Get multiple secrets at once
   */
  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    const uncachedKeys: string[] = [];

    // Check cache first
    for (const key of keys) {
      const cached = this.getFromCache(key);
      if (cached !== null) {
        results[key] = cached;
      } else {
        uncachedKeys.push(key);
      }
    }

    // Fetch uncached secrets
    if (uncachedKeys.length > 0) {
      const fetched = await this.provider.getSecrets(uncachedKeys);

      for (const [key, value] of Object.entries(fetched)) {
        results[key] = value;
        this.setInCache(key, value);
      }
    }

    return results;
  }

  /**
   * Set a secret (if supported by provider)
   */
  async setSecret(key: string, value: string): Promise<void> {
    if (!this.provider.setSecret) {
      throw new Error('Current secrets provider does not support setting secrets');
    }

    await this.provider.setSecret(key, value);
    this.invalidateCache(key);
  }

  /**
   * Delete a secret (if supported by provider)
   */
  async deleteSecret(key: string): Promise<void> {
    if (!this.provider.deleteSecret) {
      throw new Error('Current secrets provider does not support deleting secrets');
    }

    await this.provider.deleteSecret(key);
    this.invalidateCache(key);
  }

  /**
   * Clear all cached secrets
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Invalidate a specific cached secret
   */
  invalidateCache(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Get secret from cache
   */
  private getFromCache(key: string): string | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    if (Date.now() > entry._expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry._value;
  }

  /**
   * Set secret in cache
   */
  private setInCache(key: string, value: string): void {
    this.cache.set(key, {
      _value: value,
      _expiresAt: Date.now() + this.cacheTtl,
    });
  }
}

/**
 * Environment Variables Provider
 */
class EnvironmentProvider implements SecretsProvider {
  async getSecret(key: string): Promise<string | null> {
    return process.env[key] || null;
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    for (const key of keys) {
      const value = process.env[key];
      if (value) {
        results[key] = value;
      }
    }

    return results;
  }
}

/**
 * AWS Secrets Manager Provider
 */
class AWSSecretsProvider implements SecretsProvider {
  private client: any; // AWS SDK SecretsManagerClient
  private region: string;
  private secretName?: string;

  constructor(config: NonNullable<ConfigSchema['secrets']['awsSecretsManager']>) {
    this.region = config.region;
    this.secretName = config.secretName;

    // Lazy load AWS SDK to avoid importing if not needed
    this.initializeClient();
  }

  private async initializeClient(): Promise<void> {
    if (this.client) return;

    try {
      // Dynamic import to avoid bundling AWS SDK if not used
      const { SecretsManagerClient } = await import(
        '@aws-sdk/client-secrets-manager'
      );

      this.client = new SecretsManagerClient({ region: this.region });
    } catch (error) {
      throw new Error(
        'AWS Secrets Manager SDK not installed. Run: npm install @aws-sdk/client-secrets-manager'
      );
    }
  }

  async getSecret(key: string): Promise<string | null> {
    await this.initializeClient();

    try {
      const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');

      const secretId = this.secretName || key;
      const command = new GetSecretValueCommand({ SecretId: secretId });
      const response = await this.client.send(command);

      if (response.SecretString) {
        // If secretName is provided, parse as JSON and return specific key
        if (this.secretName) {
          const secrets = JSON.parse(response.SecretString);
          return secrets[key] || null;
        }
        return response.SecretString;
      }

      return null;
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        return null;
      }
      throw error;
    }
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    await this.initializeClient();

    const results: Record<string, string> = {};

    if (this.secretName) {
      // Fetch all secrets at once from the named secret
      try {
        const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');

        const command = new GetSecretValueCommand({ SecretId: this.secretName });
        const response = await this.client.send(command);

        if (response.SecretString) {
          const allSecrets = JSON.parse(response.SecretString);

          for (const key of keys) {
            if (allSecrets[key]) {
              results[key] = allSecrets[key];
            }
          }
        }
      } catch (error: any) {
        if (error.name !== 'ResourceNotFoundException') {
          throw error;
        }
      }
    } else {
      // Fetch each secret individually
      for (const key of keys) {
        const value = await this.getSecret(key);
        if (value !== null) {
          results[key] = value;
        }
      }
    }

    return results;
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.initializeClient();

    const { PutSecretValueCommand, CreateSecretCommand } = await import(
      '@aws-sdk/client-secrets-manager'
    );

    try {
      const secretId = this.secretName || key;
      let secretString: string;

      if (this.secretName) {
        // Update existing named secret
        const existingValue = await this.getSecret(key);
        const secrets = existingValue ? JSON.parse(existingValue) : {};
        secrets[key] = value;
        secretString = JSON.stringify(secrets);
      } else {
        secretString = value;
      }

      const command = new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: secretString,
      });

      await this.client.send(command);
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        // Create new secret
        const secretId = this.secretName || key;
        const command = new CreateSecretCommand({
          Name: secretId,
          SecretString: this.secretName ? JSON.stringify({ [key]: value }) : value,
        });
        await this.client.send(command);
      } else {
        throw error;
      }
    }
  }

  async deleteSecret(key: string): Promise<void> {
    await this.initializeClient();

    const { DeleteSecretCommand } = await import('@aws-sdk/client-secrets-manager');

    const secretId = this.secretName || key;
    const command = new DeleteSecretCommand({
      SecretId: secretId,
      ForceDeleteWithoutRecovery: false, // 30-day recovery window
    });

    await this.client.send(command);
  }
}

/**
 * HashiCorp Vault Provider
 */
class VaultProvider implements SecretsProvider {
  private address: string;
  private token: string;
  private namespace?: string;
  private path: string;

  constructor(config: NonNullable<ConfigSchema['secrets']['vault']>) {
    if (!config.address || !config.token) {
      throw new Error('Vault address and token are required');
    }

    this.address = config.address;
    this.token = config.token;
    this.namespace = config.namespace;
    this.path = config.path;
  }

  async getSecret(key: string): Promise<string | null> {
    try {
      const url = `${this.address}/v1/${this.path}/${key}`;
      const headers: Record<string, string> = {
        'X-Vault-Token': this.token,
      };

      if (this.namespace) {
        headers['X-Vault-Namespace'] = this.namespace;
      }

      const response = await fetch(url, { headers });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Vault request failed: ${response.statusText}`);
      }

      const data = await response.json() as any;
      return data.data?.data?.value || data.data?.value || null;
    } catch (error) {
      throw new Error(`Failed to fetch secret from Vault: ${error}`);
    }
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    // Vault doesn't have bulk get, so fetch individually
    await Promise.all(
      keys.map(async (key) => {
        const value = await this.getSecret(key);
        if (value !== null) {
          results[key] = value;
        }
      })
    );

    return results;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const url = `${this.address}/v1/${this.path}/${key}`;
    const headers: Record<string, string> = {
      'X-Vault-Token': this.token,
      'Content-Type': 'application/json',
    };

    if (this.namespace) {
      headers['X-Vault-Namespace'] = this.namespace;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: { value } }),
    });

    if (!response.ok) {
      throw new Error(`Failed to set secret in Vault: ${response.statusText}`);
    }
  }

  async deleteSecret(key: string): Promise<void> {
    const url = `${this.address}/v1/${this.path}/${key}`;
    const headers: Record<string, string> = {
      'X-Vault-Token': this.token,
    };

    if (this.namespace) {
      headers['X-Vault-Namespace'] = this.namespace;
    }

    const response = await fetch(url, {
      method: 'DELETE',
      headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to delete secret from Vault: ${response.statusText}`);
    }
  }
}

// Singleton instance
let secretsManager: SecretsManager | null = null;

/**
 * Get secrets manager instance
 */
export function getSecretsManager(
  _config: ConfigSchema['secrets'],
  provider?: SecretsProvider
): SecretsManager {
  if (!secretsManager) {
    secretsManager = new SecretsManager(_config, provider);
  }
  return secretsManager;
}

/**
 * Initialize secrets manager (must be called before use)
 */
export function initializeSecretsManager(
  _config: ConfigSchema['secrets'],
  provider?: SecretsProvider
): SecretsManager {
  secretsManager = new SecretsManager(_config, provider);
  return secretsManager;
}
