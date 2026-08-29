// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j-backed Auth Repository
 *
 * Users live in Neo4j; API keys and per-user application settings live in
 * PostgreSQL. This repository is the single place that straddles both
 * stores for the auth domain, matching the split AuthService already
 * expects (see auth.service.ts's AuthRepository interface).
 *
 * Extracted out of routes/auth.routes.ts so route modules that only need
 * AuthMiddleware (e.g. settings.routes.ts, discovery.routes.ts) can share
 * one instance via auth-bootstrap.ts instead of each re-declaring this
 * class.
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import type { AuthRepository, UserProfileUpdate } from './auth.service';
import type { ApiKey, User } from './types';

/** Structural shape of a neo4j-driver Node sufficient for property reads here. */
interface Neo4jUserNode {
  properties: Record<string, unknown>;
}

export class Neo4jAuthRepository implements AuthRepository {
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();

  private mapUserNode(node: Neo4jUserNode): User {
    const props = node.properties;
    return {
      _id: props._id || props.id,
      _username: props._username || props.username,
      _email: props._email || props.email,
      _passwordHash: props._passwordHash || props.passwordHash,
      _role: props._role || props.role,
      _enabled: props._enabled !== undefined ? props._enabled : props.enabled,
      _createdAt: props._createdAt || props.createdAt,
      _updatedAt: props._updatedAt || props.updatedAt,
      lastLoginAt: props._lastLoginAt || props.lastLoginAt,
      _name: props._name || props.name,
      _avatar: props._avatar || props.avatar,
    } as User;
  }

  async findUserByUsername(username: string): Promise<User | null> {
    const session = this.neo4jClient.getSession();
    try {
      const result = await session.run(
        'MATCH (u:User) WHERE u._username = $username OR u.username = $username RETURN u',
        { username }
      );

      if (result.records.length === 0) {
        return null;
      }

      const node = result.records[0]?.get('u');
      if (!node) {
        return null;
      }
      return this.mapUserNode(node);
    } catch (error) {
      throw new Error(`Failed to find user by username: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await session.close();
    }
  }

  async findUserById(id: string): Promise<User | null> {
    const session = this.neo4jClient.getSession();
    try {
      const result = await session.run(
        'MATCH (u:User) WHERE u._id = $id OR u.id = $id RETURN u',
        { id }
      );

      if (result.records.length === 0) {
        return null;
      }

      const node = result.records[0]?.get('u');
      if (!node) {
        return null;
      }
      return this.mapUserNode(node);
    } catch (error) {
      throw new Error(`Failed to find user by ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await session.close();
    }
  }

  async updateUserLastLogin(userId: string): Promise<void> {
    const session = this.neo4jClient.getSession();
    try {
      await session.run(
        'MATCH (u:User) WHERE u._id = $userId OR u.id = $userId SET u._lastLoginAt = datetime(), u.lastLoginAt = datetime() RETURN u',
        { userId }
      );
    } catch (error) {
      throw new Error(`Failed to update user last login: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await session.close();
    }
  }

  async updateUser(id: string, updates: UserProfileUpdate): Promise<User> {
    const setClauses: string[] = ['u._updatedAt = datetime()', 'u.updatedAt = datetime()'];
    const params: Record<string, unknown> = { id };

    if (updates.name !== undefined) {
      setClauses.push('u._name = $name', 'u.name = $name');
      params['name'] = updates.name;
    }
    if (updates.avatar !== undefined) {
      setClauses.push('u._avatar = $avatar', 'u.avatar = $avatar');
      params['avatar'] = updates.avatar;
    }
    if (updates.passwordHash !== undefined) {
      setClauses.push('u._passwordHash = $passwordHash', 'u.passwordHash = $passwordHash');
      params['passwordHash'] = updates.passwordHash;
    }

    const session = this.neo4jClient.getSession();
    try {
      const result = await session.run(
        `MATCH (u:User) WHERE u._id = $id OR u.id = $id
         SET ${setClauses.join(', ')}
         RETURN u`,
        params
      );

      if (result.records.length === 0) {
        throw new Error('User not found');
      }

      const node = result.records[0]?.get('u');
      return this.mapUserNode(node);
    } catch (error) {
      throw new Error(`Failed to update user: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Deletes every record owned solely by this account: the Postgres rows
   * (API keys, application settings, discovery provider settings) go
   * first inside one transaction, then the Neo4j user node. If the
   * Postgres transaction fails we roll back and the account -- including
   * its ability to log in -- is untouched. The Neo4j identity is only
   * removed once its dependent Postgres data is confirmed gone, so a
   * mid-flight failure never leaves orphaned secrets tied to a deleted
   * user.
   */
  async deleteUserAccount(id: string): Promise<void> {
    const pgClient = await this.postgresClient.getClient();
    try {
      await pgClient.query('BEGIN');
      await pgClient.query('DELETE FROM discovery_provider_settings WHERE user_id = $1', [id]);
      await pgClient.query('DELETE FROM user_settings WHERE user_id = $1', [id]);
      await pgClient.query('DELETE FROM api_keys WHERE user_id = $1', [id]);
      await pgClient.query('COMMIT');
    } catch (error) {
      await pgClient.query('ROLLBACK');
      throw new Error(`Failed to delete account data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      pgClient.release();
    }

    const session = this.neo4jClient.getSession();
    try {
      await session.run('MATCH (u:User) WHERE u._id = $id OR u.id = $id DETACH DELETE u', { id });
    } catch (error) {
      throw new Error(`Failed to delete user account: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await session.close();
    }
  }

  async findApiKeyByKey(keyHash: string): Promise<ApiKey | null> {
    try {
      const result = await this.postgresClient.query(
        `SELECT id, user_id, key_hash, name, role, enabled, created_at, expires_at, last_used_at, revoked_at
         FROM api_keys
         WHERE key_hash = $1 AND enabled = TRUE AND revoked_at IS NULL`,
        [keyHash]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        _id: row.id,
        _userId: row.user_id,
        _keyHash: row.key_hash,
        _name: row.name,
        _role: row.role,
        _enabled: row.enabled,
        _createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
      } as ApiKey;
    } catch (error) {
      throw new Error(`Failed to find API key: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey> {
    try {
      const result = await this.postgresClient.query(
        `INSERT INTO api_keys (user_id, key_hash, name, role, enabled, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, user_id, key_hash, name, role, enabled, created_at, expires_at, last_used_at`,
        [
          apiKey._userId,
          apiKey._keyHash,
          apiKey._name,
          apiKey._role,
          apiKey._enabled !== undefined ? apiKey._enabled : true,
          apiKey.expiresAt || null,
        ]
      );

      const row = result.rows[0];
      return {
        _id: row.id,
        _userId: row.user_id,
        _keyHash: row.key_hash,
        _name: row.name,
        _role: row.role,
        _enabled: row.enabled,
        _createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
      } as ApiKey;
    } catch (error) {
      throw new Error(`Failed to create API key: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateApiKeyLastUsed(keyId: string): Promise<void> {
    try {
      await this.postgresClient.query(
        `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
        [keyId]
      );
    } catch (error) {
      throw new Error(`Failed to update API key last used: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteApiKey(userId: string, keyId: string): Promise<number> {
    try {
      // Soft delete by setting revoked_at timestamp.
      const result = await this.postgresClient.query(
        `UPDATE api_keys
         SET revoked_at = NOW(), enabled = FALSE
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [keyId, userId]
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw new Error(`Failed to delete API key: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    try {
      const result = await this.postgresClient.query(
        `SELECT id, user_id, name, role, enabled, created_at, expires_at, last_used_at
         FROM api_keys
         WHERE user_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC`,
        [userId]
      );

      return result.rows.map(row => ({
        _id: row.id,
        _userId: row.user_id,
        _name: row.name,
        _role: row.role,
        _enabled: row.enabled,
        _createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
      })) as Omit<ApiKey, '_key' | '_keyHash'>[];
    } catch (error) {
      throw new Error(`Failed to list API keys: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
