// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptionService = void 0;
exports.getEncryptionService = getEncryptionService;
exports.resetEncryptionService = resetEncryptionService;
const crypto_1 = require("crypto");
class EncryptionService {
    algorithm = 'aes-256-gcm';
    ivLength = 12;
    keyLength = 32;
    encryptionKey;
    constructor(masterKey) {
        const key = masterKey || process.env['CREDENTIAL_ENCRYPTION_KEY'];
        if (!key) {
            throw new Error('CREDENTIAL_ENCRYPTION_KEY environment variable is required for encryption service');
        }
        if (key.length < 32) {
            throw new Error('CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters long');
        }
        const salt = 'happycmdb-cmdb-encryption-salt';
        this.encryptionKey = (0, crypto_1.pbkdf2Sync)(key, salt, 100000, this.keyLength, 'sha256');
    }
    encrypt(plaintext) {
        try {
            const iv = (0, crypto_1.randomBytes)(this.ivLength);
            const cipher = (0, crypto_1.createCipheriv)(this.algorithm, this.encryptionKey, iv);
            let encrypted = cipher.update(plaintext, 'utf8', 'base64');
            encrypted += cipher.final('base64');
            const authTag = cipher.getAuthTag();
            return {
                iv: iv.toString('base64'),
                encryptedData: encrypted,
                authTag: authTag.toString('base64'),
            };
        }
        catch (error) {
            throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    decrypt(encrypted) {
        try {
            const iv = Buffer.from(encrypted.iv, 'base64');
            const authTag = Buffer.from(encrypted.authTag, 'base64');
            const decipher = (0, crypto_1.createDecipheriv)(this.algorithm, this.encryptionKey, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encrypted.encryptedData, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
        catch (error) {
            throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    encryptCredential(credential) {
        try {
            const json = JSON.stringify(credential);
            const encrypted = this.encrypt(json);
            const encryptedJson = JSON.stringify(encrypted);
            return Buffer.from(encryptedJson).toString('base64');
        }
        catch (error) {
            throw new Error(`Failed to encrypt credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    decryptCredential(encryptedString) {
        try {
            const encryptedJson = Buffer.from(encryptedString, 'base64').toString('utf8');
            const encrypted = JSON.parse(encryptedJson);
            const json = this.decrypt(encrypted);
            return JSON.parse(json);
        }
        catch (error) {
            throw new Error(`Failed to decrypt credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    redactCredential(credential) {
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
exports.EncryptionService = EncryptionService;
let encryptionService = null;
function getEncryptionService(masterKey) {
    if (!encryptionService || masterKey) {
        encryptionService = new EncryptionService(masterKey);
    }
    return encryptionService;
}
function resetEncryptionService() {
    encryptionService = null;
}
//# sourceMappingURL=encryption.service.js.map