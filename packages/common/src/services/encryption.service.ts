// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Encryption Service
 *
 * Provides secure encryption/decryption of sensitive data using AES-256-GCM.
 * This service is used to encrypt discovery credentials before storing them in PostgreSQL.
 *
 * Security Features:
 * - AES-256-GCM authenticated encryption
 * - Unique IV (Initialization Vector) for each encryption operation
 * - PBKDF2 key derivation from environment variable
 * - Authentication tag verification to detect tampering
 *
 * Environment Variables:
 * - CREDENTIAL_ENCRYPTION_KEY: Master encryption key (required, min 32 chars)
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';

/**
 * Encrypted data structure for AES-256-GCM
 */
export interface EncryptedData {
  iv: string;           // Initialization Vector (base64)
  encryptedData: string; // Encrypted data (base64)
  authTag: string;      // Authentication tag (base64)
}

/**
 * Encryption Service - Handles AES-256-GCM encryption/decryption
 */
export class EncryptionService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly ivLength = 12; // 96 bits for GCM mode
  private readonly keyLength = 32; // 256 bits for AES-256
  private readonly encryptionKey: Buffer;

  constructor(masterKey?: string) {
    const key = masterKey || process.env['CREDENTIAL_ENCRYPTION_KEY'];

    if (!key) {
      throw new Error(
        'CREDENTIAL_ENCRYPTION_KEY environment variable is required for encryption service'
      );
    }

    if (key.length < 32) {
      throw new Error(
        'CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters long'
      );
    }

    // Derive encryption key using PBKDF2
    // Using a fixed salt is acceptable here because the master key should be unique per deployment
    const salt = 'happycmdb-cmdb-encryption-salt';
    this.encryptionKey = pbkdf2Sync(key, salt, 100000, this.keyLength, 'sha256');
  }

  /**
   * Encrypt plaintext string using AES-256-GCM
   *
   * @param plaintext - The data to encrypt
   * @returns EncryptedData object containing IV, encrypted data, and auth tag
   * @throws Error if encryption fails
   */
  encrypt(plaintext: string): EncryptedData {
    try {
      // Generate a unique IV for this encryption
      const iv = randomBytes(this.ivLength);

      // Create cipher with AES-256-GCM
      const cipher = createCipheriv(this.algorithm, this.encryptionKey, iv);

      // Encrypt the data
      let encrypted = cipher.update(plaintext, 'utf8', 'base64');
      encrypted += cipher.final('base64');

      // Get the authentication tag
      const authTag = cipher.getAuthTag();

      return {
        iv: iv.toString('base64'),
        encryptedData: encrypted,
        authTag: authTag.toString('base64'),
      };
    } catch (error) {
      throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Decrypt encrypted data using AES-256-GCM
   *
   * @param encrypted - The EncryptedData object to decrypt
   * @returns Decrypted plaintext string
   * @throws Error if decryption fails or authentication tag doesn't match (tampering detected)
   */
  decrypt(encrypted: EncryptedData): string {
    try {
      // Convert base64 strings back to buffers
      const iv = Buffer.from(encrypted.iv, 'base64');
      const authTag = Buffer.from(encrypted.authTag, 'base64');

      // Create decipher with AES-256-GCM
      const decipher = createDecipheriv(this.algorithm, this.encryptionKey, iv);

      // Set the authentication tag
      decipher.setAuthTag(authTag);

      // Decrypt the data
      let decrypted = decipher.update(encrypted.encryptedData, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      // This could be a decryption error OR an authentication failure (tampering)
      throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Encrypt a credential object (JSON serialization + encryption)
   *
   * @param credential - The credential object to encrypt
   * @returns Base64-encoded encrypted string suitable for database storage
   * @throws Error if encryption fails
   */
  encryptCredential(credential: any): string {
    try {
      // Serialize credential to JSON
      const json = JSON.stringify(credential);

      // Encrypt the JSON
      const encrypted = this.encrypt(json);

      // Encode the entire EncryptedData structure as JSON, then base64
      const encryptedJson = JSON.stringify(encrypted);
      return Buffer.from(encryptedJson).toString('base64');
    } catch (error) {
      throw new Error(
        `Failed to encrypt credential: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Decrypt a credential object (decryption + JSON deserialization)
   *
   * @param encryptedString - Base64-encoded encrypted credential from database
   * @returns Decrypted credential object
   * @throws Error if decryption or parsing fails
   */
  decryptCredential(encryptedString: string): any {
    try {
      // Decode base64 to get the EncryptedData JSON
      const encryptedJson = Buffer.from(encryptedString, 'base64').toString('utf8');

      // Parse the EncryptedData structure
      const encrypted: EncryptedData = JSON.parse(encryptedJson);

      // Decrypt the data
      const json = this.decrypt(encrypted);

      // Parse and return the credential object
      return JSON.parse(json);
    } catch (error) {
      throw new Error(
        `Failed to decrypt credential: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Redact sensitive values from credential objects for logging
   *
   * @param credential - Credential object to redact
   * @returns Redacted credential object safe for logging
   */
  redactCredential(credential: any): any {
    if (!credential || typeof credential !== 'object') {
      return credential;
    }

    const redacted = { ...credential };
    const sensitiveKeys = [
      'password',
      'secret',
      'key',
      'token',
      'passphrase',
      'private_key',
      'privateKey',
      'secretAccessKey',
      'clientSecret',
      'api_key',
      'apiKey',
    ];

    for (const [key, value] of Object.entries(redacted)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.some(sensitiveKey => lowerKey.includes(sensitiveKey))) {
        redacted[key] = typeof value === 'string' && value.length > 0 ? '***REDACTED***' : value;
      }
    }

    return redacted;
  }
}

// Singleton instance
let encryptionService: EncryptionService | null = null;

/**
 * Get the singleton EncryptionService instance
 *
 * @param masterKey - Optional master key (for testing). Uses env var in production.
 * @returns EncryptionService instance
 */
export function getEncryptionService(masterKey?: string): EncryptionService {
  if (!encryptionService || masterKey) {
    encryptionService = new EncryptionService(masterKey);
  }
  return encryptionService;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetEncryptionService(): void {
  encryptionService = null;
}
