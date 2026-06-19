// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential API Integration Tests
 *
 * Tests the full CRUD lifecycle of the unified (protocol-based) credential
 * management endpoints. Verifies encryption, redaction, and validation against
 * the real running API (underscore-prefixed response envelope, non-underscore
 * request bodies / entity fields).
 */

import request from 'supertest';
import express from 'express';
import { json } from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import { unifiedCredentialRoutes } from '../../src/rest/routes/unified-credential.routes';
import { getPostgresClient } from '@cmdb/database';
import { getEncryptionService } from '@cmdb/common';

interface EncryptedData {
  iv: string;
  encryptedData: string;
  authTag: string;
}

// Setup Express app for testing
const app = express();
app.use(json());

// Mock user middleware
app.use((req: express.Request, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: 'test-user-123' };
  next();
});

// The router declares its paths under `/credentials`, so it is mounted at the
// `/api/v1` prefix (matching the real server) to expose `/api/v1/credentials`.
app.use('/api/v1', unifiedCredentialRoutes);

describe('Credential API Integration Tests', () => {
  let credentialId: string;

  afterAll(async () => {
    // Cleanup: remove any credentials created by this suite.
    try {
      const pool = getPostgresClient().pool;
      await pool.query(`DELETE FROM credentials WHERE created_by = $1`, ['test-user-123']);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('POST /api/v1/credentials', () => {
    it('should create a new AWS credential', async () => {
      const response = await request(app)
        .post('/api/v1/credentials')
        .send({
          name: 'Test AWS Credential',
          description: 'AWS credentials for testing',
          protocol: 'aws_iam',
          scope: 'cloud_provider',
          credentials: {
            access_key_id: 'AKIAIOSFODNN7EXAMPLE',
            secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            region: 'us-east-1',
          },
          tags: ['test', 'aws'],
        });

      expect(response.status).toBe(201);
      expect(response.body._success).toBe(true);
      expect(response.body._data).toHaveProperty('id');
      expect(response.body._data.name).toBe('Test AWS Credential');
      expect(response.body._data.protocol).toBe('aws_iam');
      expect(response.body._data.scope).toBe('cloud_provider');

      // The entire credentials payload is redacted before returning.
      expect(response.body._data.credentials).toBe('***REDACTED***');

      credentialId = response.body._data.id;
    });

    it('should create an SSH credential', async () => {
      const response = await request(app)
        .post('/api/v1/credentials')
        .send({
          name: 'Test SSH Credential',
          protocol: 'ssh_password',
          scope: 'ssh',
          credentials: {
            username: 'admin',
            password: 'super-secret-password',
          },
        });

      expect(response.status).toBe(201);
      expect(response.body._success).toBe(true);
      expect(response.body._data.protocol).toBe('ssh_password');
      expect(response.body._data.credentials).toBe('***REDACTED***');

      // Cleanup
      await request(app).delete(`/api/v1/credentials/${response.body._data.id}`);
    });

    it('should reject invalid protocol', async () => {
      const response = await request(app)
        .post('/api/v1/credentials')
        .send({
          name: 'Invalid Credential',
          protocol: 'invalid-type',
          scope: 'api',
          credentials: {},
        });

      expect(response.status).toBe(400);
      expect(response.body._success).toBe(false);
      expect(response.body._error).toBe('Validation Error');
    });

    it('should reject missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/credentials')
        .send({
          protocol: 'aws_iam',
          credentials: {},
        });

      expect(response.status).toBe(400);
      expect(response.body._success).toBe(false);
      expect(response.body._error).toBe('Validation Error');
    });
  });

  describe('GET /api/v1/credentials/:id', () => {
    it('should get credential by ID with redacted credentials', async () => {
      const response = await request(app).get(`/api/v1/credentials/${credentialId}`);

      expect(response.status).toBe(200);
      expect(response.body._success).toBe(true);
      expect(response.body._data.id).toBe(credentialId);
      expect(response.body._data.name).toBe('Test AWS Credential');

      // Credentials are redacted.
      expect(response.body._data.credentials).toBe('***REDACTED***');
    });

    it('should return 404 for non-existent credential', async () => {
      const response = await request(app).get(`/api/v1/credentials/${uuidv4()}`);

      expect(response.status).toBe(404);
      expect(response.body._success).toBe(false);
      expect(response.body._error).toBe('Not Found');
    });
  });

  describe('GET /api/v1/credentials', () => {
    it('should list credentials without sensitive data', async () => {
      const response = await request(app).get('/api/v1/credentials');

      expect(response.status).toBe(200);
      expect(response.body._success).toBe(true);
      expect(Array.isArray(response.body._data)).toBe(true);
      expect(typeof response.body._count).toBe('number');
      expect(response.body._count).toBe(response.body._data.length);

      // Summaries never include the credentials payload.
      response.body._data.forEach((cred: Record<string, unknown>) => {
        expect(cred).not.toHaveProperty('credentials');
        expect(cred).toHaveProperty('id');
        expect(cred).toHaveProperty('name');
        expect(cred).toHaveProperty('protocol');
      });
    });

    it('should include the created credential in the list', async () => {
      const response = await request(app).get('/api/v1/credentials');

      expect(response.status).toBe(200);
      const found = response.body._data.find(
        (c: { id: string }) => c.id === credentialId
      );
      expect(found).toBeDefined();
      expect(found.protocol).toBe('aws_iam');
    });
  });

  describe('PUT /api/v1/credentials/:id', () => {
    it('should update credential name', async () => {
      const response = await request(app)
        .put(`/api/v1/credentials/${credentialId}`)
        .send({
          name: 'Updated AWS Credential',
        });

      expect(response.status).toBe(200);
      expect(response.body._success).toBe(true);
      expect(response.body._data.name).toBe('Updated AWS Credential');
    });

    it('should update credential tags', async () => {
      const response = await request(app)
        .put(`/api/v1/credentials/${credentialId}`)
        .send({
          tags: ['updated', 'test'],
        });

      expect(response.status).toBe(200);
      expect(response.body._success).toBe(true);
      expect(response.body._data.tags).toEqual(['updated', 'test']);
    });

    it('should update credentials and re-encrypt', async () => {
      const response = await request(app)
        .put(`/api/v1/credentials/${credentialId}`)
        .send({
          credentials: {
            access_key_id: 'AKIAIOSFODNN7NEWKEY',
            secret_access_key: 'new-secret-key-value',
            region: 'us-west-2',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body._success).toBe(true);

      // Updated credentials are still redacted in the response.
      expect(response.body._data.credentials).toBe('***REDACTED***');
    });

    it('should return 404 for non-existent credential', async () => {
      const response = await request(app)
        .put(`/api/v1/credentials/${uuidv4()}`)
        .send({ name: 'Test' });

      expect(response.status).toBe(404);
      expect(response.body._success).toBe(false);
      expect(response.body._error).toBe('Not Found');
    });
  });

  describe('POST /api/v1/credentials/:id/validate', () => {
    it('should validate a well-formed credential structure', async () => {
      const response = await request(app)
        .post(`/api/v1/credentials/${credentialId}/validate`);

      expect(response.status).toBe(200);
      expect(response.body._success).toBe(true);
      expect(response.body._data.valid).toBe(true);
    });

    it('should detect an invalid credential structure', async () => {
      // Create a credential missing the required secret_access_key.
      const createResponse = await request(app)
        .post('/api/v1/credentials')
        .send({
          name: 'Invalid AWS Credential',
          protocol: 'aws_iam',
          scope: 'cloud_provider',
          credentials: {
            access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          },
        });

      const validateResponse = await request(app)
        .post(`/api/v1/credentials/${createResponse.body._data.id}/validate`);

      expect(validateResponse.status).toBe(200);
      expect(validateResponse.body._success).toBe(true);
      expect(validateResponse.body._data.valid).toBe(false);
      expect(validateResponse.body._data.message).toContain('Missing AWS');

      // Cleanup
      await request(app).delete(`/api/v1/credentials/${createResponse.body._data.id}`);
    });
  });

  describe('DELETE /api/v1/credentials/:id', () => {
    it('should delete credential', async () => {
      const response = await request(app).delete(`/api/v1/credentials/${credentialId}`);

      expect(response.status).toBe(204);

      // Verify credential is deleted.
      const getResponse = await request(app).get(`/api/v1/credentials/${credentialId}`);
      expect(getResponse.status).toBe(404);

      credentialId = ''; // Clear for cleanup
    });

    it('should return 404 for non-existent credential', async () => {
      const response = await request(app).delete(`/api/v1/credentials/${uuidv4()}`);

      expect(response.status).toBe(404);
      expect(response.body._success).toBe(false);
      expect(response.body._error).toBe('Not Found');
    });
  });

  describe('Encryption & Security', () => {
    it('should never return plain text credentials', async () => {
      // Create credential
      const createResponse = await request(app)
        .post('/api/v1/credentials')
        .send({
          name: 'Security Test Credential',
          protocol: 'api_key',
          scope: 'api',
          credentials: {
            key: 'super-secret-api-key',
            api_secret: 'super-secret-api-secret',
          },
        });

      const credId = createResponse.body._data.id;

      // Get credential
      const getResponse = await request(app).get(`/api/v1/credentials/${credId}`);

      // List credentials
      const listResponse = await request(app).get('/api/v1/credentials');

      // Update credential
      const updateResponse = await request(app)
        .put(`/api/v1/credentials/${credId}`)
        .send({ name: 'Updated Security Test' });

      // Every single-item response redacts the credentials payload entirely.
      expect(createResponse.body._data.credentials).toBe('***REDACTED***');
      expect(getResponse.body._data.credentials).toBe('***REDACTED***');
      expect(updateResponse.body._data.credentials).toBe('***REDACTED***');

      // List summaries do not include credentials at all.
      const listedCred = listResponse.body._data.find(
        (c: { id: string }) => c.id === credId
      );
      expect(listedCred).toBeDefined();
      expect(listedCred).not.toHaveProperty('credentials');

      // Cleanup
      await request(app).delete(`/api/v1/credentials/${credId}`);
    });

    it('should encrypt credentials in database', async () => {
      const response = await request(app)
        .post('/api/v1/credentials')
        .send({
          name: 'Encryption Test',
          protocol: 'ssh_password',
          scope: 'ssh',
          credentials: {
            username: 'testuser',
            password: 'testpassword',
          },
        });

      const credId = response.body._data.id;

      // Directly query the database to verify encryption at rest.
      const pool = getPostgresClient().pool;
      const result = await pool.query(
        'SELECT credentials FROM credentials WHERE id = $1',
        [credId]
      );

      const encryptedData = result.rows[0].credentials as EncryptedData;

      // Verify it's an EncryptedData structure.
      expect(encryptedData).toHaveProperty('iv');
      expect(encryptedData).toHaveProperty('encryptedData');
      expect(encryptedData).toHaveProperty('authTag');

      // Verify it's not plain text.
      expect(JSON.stringify(encryptedData)).not.toContain('testpassword');
      expect(JSON.stringify(encryptedData)).not.toContain('testuser');

      // Verify we can decrypt it.
      const encryptionService = getEncryptionService();
      const decrypted = JSON.parse(encryptionService.decrypt(encryptedData));
      expect(decrypted.username).toBe('testuser');
      expect(decrypted.password).toBe('testpassword');

      // Cleanup
      await request(app).delete(`/api/v1/credentials/${credId}`);
    });
  });
});
