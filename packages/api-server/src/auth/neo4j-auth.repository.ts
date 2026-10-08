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
import neo4j from 'neo4j-driver';
import type {
  AuthRepository, CredentialEventInput, GuardedPasswordWrite, GuardedUserWrite, UserProfileUpdate,
} from './auth.service';
import type { ApiKey, User } from './types';

/** Structural shape of a neo4j-driver Node sufficient for property reads here. */
interface Neo4jUserNode {
  properties: Record<string, unknown>;
  elementId?: string;
}

/** Either spelling of the default-password marker set means marked (fail-closed). */
const MARKED = '(coalesce(u.defaultPasswordSuspect, false) OR coalesce(u._defaultPasswordSuspect, false))';

/** HP1-S6 changePassword write: lands only on the node read, at the authorizing generation, unmarked, still holding the verified hash. */
export const GUARDED_PASSWORD_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $elementId AND (u._id = $userId OR u.id = $userId)
  AND coalesce(u.credentialEpoch, 0) = $credentialEpoch
  AND NOT ${MARKED}
  AND coalesce(u._passwordHash, u.passwordHash) = $readHash
SET u._passwordHash = $newHash, u.passwordHash = $newHash, u._updatedAt = datetime(), u.updatedAt = datetime()
RETURN count(u) AS n`;

/** HP1-S6 deleteAccount first step: disables the account at the authorizing generation, unmarked. */
export const GUARDED_DISABLE_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $elementId AND (u._id = $userId OR u.id = $userId)
  AND coalesce(u.credentialEpoch, 0) = $credentialEpoch
  AND NOT ${MARKED}
SET u._enabled = false, u.enabled = false, u._updatedAt = datetime(), u.updatedAt = datetime()
RETURN count(u) AS n`;

/** Login marker setter: false → true only, so an already-marked account adds no audit row. */
export const MARK_DEFAULT_SUSPECT_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $elementId AND (u._id = $userId OR u.id = $userId)
  AND NOT ${MARKED}
SET u.defaultPasswordSuspect = true
RETURN count(u) AS n`;

/** Stored credentialEpoch → number: absent 0, a safe Neo4j Integer, otherwise NaN (refuses every credential). */
export function mapCredentialEpoch(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (neo4j.isInt(value)) {
    return neo4j.integer.inSafeRange(value) ? neo4j.integer.toNumber(value) : Number.NaN;
  }
  return Number.NaN;
}

function toCount(value: unknown): number {
  return neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value);
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
      _organizationId: props._organizationId ?? props.organizationId,
      _elementId: node.elementId,
      _platformAdmin: props._platformAdmin === true || props.platformAdmin === true,
      _seedProvenance: props.seedProvenance ?? props._seedProvenance ?? undefined,
      _defaultPasswordSuspect: props.defaultPasswordSuspect === true || props._defaultPasswordSuspect === true,
      _credentialEpoch: mapCredentialEpoch(props.credentialEpoch),
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

  async updatePasswordHashGuarded(write: GuardedPasswordWrite): Promise<boolean> {
    return this.guardedWrite(GUARDED_PASSWORD_CYPHER, {
      elementId: write.elementId ?? null, userId: write.userId, credentialEpoch: neo4j.int(write.credentialEpoch),
      readHash: write.readHash, newHash: write.newHash,
    });
  }

  async disableUserGuarded(write: GuardedUserWrite): Promise<boolean> {
    return this.guardedWrite(GUARDED_DISABLE_CYPHER, {
      elementId: write.elementId ?? null, userId: write.userId, credentialEpoch: neo4j.int(write.credentialEpoch),
    });
  }

  async markDefaultSuspect(user: User): Promise<boolean> {
    return this.guardedWrite(MARK_DEFAULT_SUSPECT_CYPHER, { elementId: user._elementId ?? null, userId: user._id });
  }

  async recordCredentialEvent(event: CredentialEventInput): Promise<void> {
    await this.postgresClient.query(
      'INSERT INTO auth_credential_events (user_id, event, actor) VALUES ($1, $2, $3)',
      [event.userId, event.event, event.actor]
    );
  }

  /** Runs one guarded statement returning `count(u) AS n`; true when exactly one node was written. */
  private async guardedWrite(cypher: string, params: Record<string, unknown>): Promise<boolean> {
    const session = this.neo4jClient.getSession();
    try {
      const result = await session.run(cypher, params);
      return toCount(result.records[0]?.get('n')) === 1;
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
   * user. With `elementId` (the node AuthService read and disabled), only
   * that node is deleted, never another node sharing the id.
   */
  async deleteUserAccount(id: string, elementId?: string): Promise<void> {
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
      if (elementId === undefined) {
        await session.run('MATCH (u:User) WHERE u._id = $id OR u.id = $id DETACH DELETE u', { id });
      } else {
        await session.run(
          'MATCH (u:User) WHERE elementId(u) = $elementId AND (u._id = $id OR u.id = $id) DETACH DELETE u',
          { id, elementId }
        );
      }
    } catch (error) {
      throw new Error(`Failed to delete user account: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await session.close();
    }
  }

  async findApiKeyByKey(keyHash: string): Promise<ApiKey | null> {
    try {
      const result = await this.postgresClient.query(
        `SELECT id, user_id, key_hash, name, role, enabled, created_at, expires_at, last_used_at, revoked_at, credential_epoch
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
        _credentialEpoch: row.credential_epoch,
      } as ApiKey;
    } catch (error) {
      throw new Error(`Failed to find API key: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey> {
    if (!Number.isSafeInteger(apiKey._credentialEpoch)) {
      throw new Error('Failed to create API key: authorizing credential generation required');
    }
    try {
      const result = await this.postgresClient.query(
        `INSERT INTO api_keys (user_id, key_hash, name, role, enabled, expires_at, credential_epoch)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, user_id, key_hash, name, role, enabled, created_at, expires_at, last_used_at, credential_epoch`,
        [
          apiKey._userId,
          apiKey._keyHash,
          apiKey._name,
          apiKey._role,
          apiKey._enabled !== undefined ? apiKey._enabled : true,
          apiKey.expiresAt || null,
          apiKey._credentialEpoch,
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
        _credentialEpoch: row.credential_epoch,
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
