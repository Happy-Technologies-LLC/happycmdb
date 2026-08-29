// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/database/src/redis/schedule-config-store.ts

/**
 * Shared Redis-backed schedule configuration store.
 *
 * Every process that owns a scheduler (the API server and any BullMQ worker process) gets its
 * own in-memory scheduler instance, but they must all agree on the same cron/enabled/config
 * truth for a given schedule. This store persists that truth as a single JSON blob per
 * (kind, id) pair under a versioned key in the Redis instance BullMQ already requires, so no new
 * datastore is introduced.
 */

import { getRedisClient } from './client';
import { logger } from '@cmdb/common';

const SCHEDULE_KEY_PREFIX = 'cmdb:schedule-config:v1';

export interface PersistedScheduleConfig {
  cronExpression: string;
  enabled: boolean;
  config: unknown;
  updatedAt: string;
}

export interface ScheduleConfigDefaults {
  cronExpression: string;
  enabled: boolean;
  config: unknown;
}

function buildKey(kind: string, id: string): string {
  return `${SCHEDULE_KEY_PREFIX}:${kind}:${id}`;
}

export class ScheduleConfigStore {
  /**
   * Load the persisted config for (kind, id). Returns null when nothing has been persisted yet;
   * callers should seed defaults with seedIfAbsent() before relying on the result.
   */
  async load(kind: string, id: string): Promise<PersistedScheduleConfig | null> {
    const raw = await getRedisClient().get(buildKey(kind, id));
    return raw ? (JSON.parse(raw) as PersistedScheduleConfig) : null;
  }

  /**
   * Seed the default config for (kind, id) exactly once across every process sharing this Redis
   * instance. Backed by SET ... NX, which is atomic, so concurrent seeders from independent
   * processes race safely: only the first writer's defaults stick, every later caller reads back
   * whatever was actually persisted.
   */
  async seedIfAbsent(
    kind: string,
    id: string,
    defaults: ScheduleConfigDefaults
  ): Promise<PersistedScheduleConfig> {
    const key = buildKey(kind, id);
    const record: PersistedScheduleConfig = {
      cronExpression: defaults.cronExpression,
      enabled: defaults.enabled,
      config: defaults.config,
      updatedAt: new Date().toISOString(),
    };

    const claimed = await getRedisClient().setNX(key, JSON.stringify(record));
    if (claimed) {
      logger.info(`Seeded default schedule config for ${kind}:${id}`);
      return record;
    }

    const existing = await this.load(kind, id);
    if (!existing) {
      throw new Error(
        `Failed to load schedule config for ${kind}:${id} immediately after a concurrent seed`
      );
    }
    return existing;
  }

  /**
   * Apply a partial update (cron/enabled/config) to the persisted config and return the
   * resulting full record. Fields omitted from the patch keep their previously persisted value.
   */
  async update(
    kind: string,
    id: string,
    patch: Partial<{ cronExpression: string; enabled: boolean; config: unknown }>
  ): Promise<PersistedScheduleConfig> {
    const key = buildKey(kind, id);
    const existing = await this.load(kind, id);
    const record: PersistedScheduleConfig = {
      cronExpression: patch.cronExpression ?? existing?.cronExpression ?? '',
      enabled: patch.enabled ?? existing?.enabled ?? false,
      config: patch.config !== undefined ? patch.config : existing?.config,
      updatedAt: new Date().toISOString(),
    };

    await getRedisClient().set(key, JSON.stringify(record));
    return record;
  }
}

let store: ScheduleConfigStore | null = null;

export function getScheduleConfigStore(): ScheduleConfigStore {
  if (!store) {
    store = new ScheduleConfigStore();
  }
  return store;
}
