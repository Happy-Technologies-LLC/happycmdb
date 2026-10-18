// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded, shared public dependency readiness snapshot.
 */

import { getNeo4jClient } from '@cmdb/database';
import { getPostgresClient } from '@cmdb/database';
import { getRedisClient } from '@cmdb/database';
import type { Session } from 'neo4j-driver';

// Public root and readiness share one snapshot. TTL begins when the result is
// known; a deadline bounds HTTP latency, not the lifetime of driver operations.
const PUBLIC_CACHE_MS = 5000;
const PUBLIC_DEADLINE_MS = 2000;
type Dependency = 'neo4j' | 'postgres' | 'redis';

export class HealthCheckService {
  private cache?: { ready: boolean; expiresAt: number };
  private inFlight?: Promise<boolean>;
  private readonly pending: Partial<Record<Dependency, Promise<boolean>>> = {};

  checkPublicHealth(): Promise<boolean> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return Promise.resolve(this.cache.ready);
    }
    if (!this.inFlight) {
      const check = this.snapshot();
      this.inFlight = check.then(ready => {
        this.cache = { ready, expiresAt: Date.now() + PUBLIC_CACHE_MS };
        return ready;
      }).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async snapshot(): Promise<boolean> {
    // Start every dependency once. A previous physical operation still in
    // flight counts as unavailable; it must not acquire another connection.
    const work = Promise.all([
      this.probe('neo4j', () => this.checkNeo4j()),
      this.probe('postgres', () => this.checkPostgres()),
      this.probe('redis', () => this.checkRedis()),
    ]).then(results => results.every(Boolean));
    let timer: NodeJS.Timeout;
    const deadline = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), PUBLIC_DEADLINE_MS);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private probe(key: Dependency, run: () => Promise<boolean>): Promise<boolean> {
    if (this.pending[key]) return Promise.resolve(false);
    // Assign ownership before invoking the driver. Retain it through Neo4j
    // close and Redis get, even after a public response has timed out.
    const physical = Promise.resolve().then(run).catch(() => false);
    this.pending[key] = physical;
    void physical.then(() => {
      if (this.pending[key] === physical) delete this.pending[key];
    });
    return physical;
  }

  private async checkNeo4j(): Promise<boolean> {
    let session: Session | undefined;
    let healthy = false;
    try {
      session = getNeo4jClient().getSession();
      const result = await session.run('RETURN 1');
      healthy = result.records.length > 0;
    } catch {
      healthy = false;
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          healthy = false;
        }
      }
    }
    return healthy;
  }

  private async checkPostgres(): Promise<boolean> {
    const result = await getPostgresClient().query('SELECT 1');
    return result.rows.length > 0;
  }

  private async checkRedis(): Promise<boolean> {
    const redis = getRedisClient();
    await redis.set('__readiness_check__', 'test', 1);
    return (await redis.get('__readiness_check__')) === 'test';
  }
}
