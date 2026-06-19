// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for API Key Authentication endpoints
 */

import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { authRoutes } from '../../src/rest/routes/auth.routes';

describe('API Key Authentication Integration Tests', () => {
  let app: Express;
  let authToken: string;
  let userId: string;
  // Username must satisfy the login schema (Joi `.alphanum()`), so no hyphen.
  const testUsername = 'testuserapikey';
  const testPassword = 'TestPassword123!';
  const testUserId = randomUUID();

  beforeAll(async () => {
    // The auth controller resolves users from Neo4j (:User nodes) and stores API
    // keys in PostgreSQL. Build a minimal app mounting the real auth routes at
    // the same path the server uses.
    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRoutes);

    // Seed the test user into the Neo4j user store with a bcrypt password hash.
    const passwordHash = await bcrypt.hash(testPassword, 10);
    const session = getNeo4jClient().getSession();
    try {
      await session.run(
        `CREATE (u:User {
          _id: $id,
          _username: $username,
          _email: $email,
          _passwordHash: $passwordHash,
          _role: $role,
          _enabled: true,
          _createdAt: datetime(),
          _updatedAt: datetime()
        }) RETURN u`,
        {
          id: testUserId,
          username: testUsername,
          email: `${testUsername}@example.com`,
          passwordHash,
          role: 'admin',
        }
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const pgClient = getPostgresClient();

    // Delete test API keys created during the suite.
    await pgClient.query('DELETE FROM api_keys WHERE user_id = $1', [testUserId]);

    // Remove the seeded Neo4j user.
    const session = getNeo4jClient().getSession();
    try {
      await session.run('MATCH (u:User {_id: $id}) DETACH DELETE u', { id: testUserId });
    } finally {
      await session.close();
    }

    // Close database connections.
    await pgClient.close();
    await getNeo4jClient().close();
  });

  describe('POST /api/v1/auth/login', () => {
    it('should login and get access token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          _username: testUsername,
          _password: testPassword,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data._accessToken).toBeDefined();
      expect(response.body.data._user._id).toBeDefined();

      authToken = response.body.data._accessToken;
      userId = response.body.data._user._id;
    });
  });

  describe('POST /api/v1/auth/api-key', () => {
    let apiKey: string;
    let apiKeyId: string;

    it('should generate a new API key', async () => {
      const response = await request(app)
        .post('/api/v1/auth/api-key')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          _name: 'Test API Key',
          expiresInDays: 30,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data._apiKey).toBeDefined();
      expect(response.body.data._id).toBeDefined();
      expect(response.body.data._name).toBe('Test API Key');
      expect(response.body.data.expiresAt).toBeDefined();

      apiKey = response.body.data._apiKey;
      apiKeyId = response.body.data._id;

      // Verify API key is 64 characters (32 bytes in hex)
      expect(apiKey).toHaveLength(64);
    });

    it('should reject API key generation without authentication', async () => {
      await request(app)
        .post('/api/v1/auth/api-key')
        .send({
          _name: 'Unauthorized Key',
        })
        .expect(401);
    });

    it('should allow authentication with the generated API key', async () => {
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('X-API-Key', apiKey)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.userId).toBe(userId);
    });

    it('should update last_used_at when API key is used', async () => {
      const pgClient = getPostgresClient();

      // Get initial last_used_at
      const beforeResult = await pgClient.query(
        'SELECT last_used_at FROM api_keys WHERE id = $1',
        [apiKeyId]
      );
      const beforeLastUsed = beforeResult.rows[0]?.last_used_at;

      // last_used_at is written by Postgres NOW() server-side, so the clock
      // cannot be faked; a small real delay guarantees a distinct timestamp.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1000);
      await promise;

      // Use the API key
      await request(app)
        .get('/api/v1/auth/me')
        .set('X-API-Key', apiKey)
        .expect(200);

      // Get updated last_used_at
      const afterResult = await pgClient.query(
        'SELECT last_used_at FROM api_keys WHERE id = $1',
        [apiKeyId]
      );
      const afterLastUsed = afterResult.rows[0]?.last_used_at;

      // Verify last_used_at was updated
      if (beforeLastUsed) {
        expect(new Date(afterLastUsed).getTime()).toBeGreaterThan(
          new Date(beforeLastUsed).getTime()
        );
      } else {
        expect(afterLastUsed).toBeDefined();
      }
    });
  });

  describe('GET /api/v1/auth/api-keys', () => {
    it('should list all API keys for the current user', async () => {
      const response = await request(app)
        .get('/api/v1/auth/api-keys')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);

      // Verify API key structure
      const firstKey = response.body.data[0];
      expect(firstKey._id).toBeDefined();
      expect(firstKey._name).toBeDefined();
      expect(firstKey._role).toBeDefined();
      expect(firstKey._createdAt).toBeDefined();

      // Verify sensitive data is not included
      expect(firstKey._key).toBeUndefined();
      expect(firstKey._keyHash).toBeUndefined();
    });

    it('should reject listing API keys without authentication', async () => {
      await request(app)
        .get('/api/v1/auth/api-keys')
        .expect(401);
    });
  });

  describe('DELETE /api/v1/auth/api-key/:keyId', () => {
    let apiKeyToRevoke: string;
    let apiKeyIdToRevoke: string;

    beforeAll(async () => {
      // Create a new API key to revoke
      const response = await request(app)
        .post('/api/v1/auth/api-key')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          _name: 'Key to Revoke',
        })
        .expect(200);

      apiKeyToRevoke = response.body.data._apiKey;
      apiKeyIdToRevoke = response.body.data._id;
    });

    it('should revoke an API key', async () => {
      const response = await request(app)
        .delete(`/api/v1/auth/api-key/${apiKeyIdToRevoke}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('revoked');
    });

    it('should not allow authentication with revoked API key', async () => {
      await request(app)
        .get('/api/v1/auth/me')
        .set('X-API-Key', apiKeyToRevoke)
        .expect(401);
    });

    it('should verify API key is soft-deleted in database', async () => {
      const pgClient = getPostgresClient();

      const result = await pgClient.query(
        'SELECT revoked_at, enabled FROM api_keys WHERE id = $1',
        [apiKeyIdToRevoke]
      );

      expect(result.rows[0].revoked_at).not.toBeNull();
      expect(result.rows[0].enabled).toBe(false);
    });

    it('should reject revocation without authentication', async () => {
      await request(app)
        .delete(`/api/v1/auth/api-key/${apiKeyIdToRevoke}`)
        .expect(401);
    });
  });

  describe('API Key Expiration', () => {
    it('should reject expired API keys', async () => {
      const pgClient = getPostgresClient();

      // Create an API key
      const createResponse = await request(app)
        .post('/api/v1/auth/api-key')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          _name: 'Expired Key',
          expiresInDays: 1,
        })
        .expect(200);

      const expiredKeyId = createResponse.body.data._id;
      const expiredKey = createResponse.body.data._apiKey;

      // Manually set expiration to the past
      await pgClient.query(
        "UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1",
        [expiredKeyId]
      );

      // Try to use expired key
      await request(app)
        .get('/api/v1/auth/me')
        .set('X-API-Key', expiredKey)
        .expect(401);
    });
  });

  describe('API Key Security', () => {
    it('should store API keys as SHA-256 hashes', async () => {
      const pgClient = getPostgresClient();

      // Create an API key
      const response = await request(app)
        .post('/api/v1/auth/api-key')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          _name: 'Security Test Key',
        })
        .expect(200);

      const plainKey = response.body.data._apiKey;
      const keyId = response.body.data._id;

      // Calculate expected hash
      const expectedHash = createHash('sha256').update(plainKey).digest('hex');

      // Verify hash in database
      const result = await pgClient.query(
        'SELECT key_hash FROM api_keys WHERE id = $1',
        [keyId]
      );

      expect(result.rows[0].key_hash).toBe(expectedHash);
      expect(result.rows[0].key_hash).not.toBe(plainKey);
    });

    it('should not return the plain API key after creation', async () => {
      // List API keys
      const response = await request(app)
        .get('/api/v1/auth/api-keys')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      // Verify no plain keys are returned
      response.body.data.forEach((key: Record<string, unknown>) => {
        expect(key._key).toBeUndefined();
        expect(key._keyHash).toBeUndefined();
      });
    });

    it('should reject invalid API key format', async () => {
      await request(app)
        .get('/api/v1/auth/me')
        .set('X-API-Key', 'invalid-key-format')
        .expect(401);
    });

    it('should reject non-existent API key', async () => {
      const fakeKey = 'a'.repeat(64); // Valid format but doesn't exist

      await request(app)
        .get('/api/v1/auth/me')
        .set('X-API-Key', fakeKey)
        .expect(401);
    });
  });
});
