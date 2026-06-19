/**
 * Database Helpers for E2E Tests
 *
 * Direct database access for test verification and cleanup.
 * Connection details are read from environment variables set by globalSetup.
 */

import neo4j, { Driver, Session } from 'neo4j-driver';

/**
 * Neo4j Test Helper — thin wrapper for test-level queries and cleanup.
 */
export class Neo4jTestHelper {
  private driver: Driver;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  async executeQuery<T = Record<string, unknown>>(
    query: string,
    params?: Record<string, unknown>
  ): Promise<T[]> {
    const session: Session = this.driver.session();
    try {
      const result = await session.run(query, params);
      return result.records.map(record => record.toObject()) as T[];
    } finally {
      await session.close();
    }
  }

  async getCIById(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.executeQuery(
      'MATCH (ci:CI {id: $id}) RETURN ci',
      { id }
    );
    if (result.length === 0) return null;
    const row = result[0] as Record<string, { properties: Record<string, unknown> }>;
    return row.ci.properties;
  }

  async getRelationships(ciId: string): Promise<Record<string, unknown>[]> {
    return this.executeQuery(
      `MATCH (from:CI {id: $ciId})-[r]->(to:CI)
       RETURN type(r) as type, to.id as to_id, properties(r) as properties`,
      { ciId }
    );
  }

  async clearAllData(): Promise<void> {
    await this.executeQuery('MATCH (n) DETACH DELETE n');
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

/**
 * Create database helpers using env vars exported by the E2E globalSetup.
 */
export function createDatabaseHelpers(): { neo4j: Neo4jTestHelper } {
  return {
    neo4j: new Neo4jTestHelper(
      process.env['NEO4J_URI'] || 'bolt://localhost:7687',
      process.env['NEO4J_USERNAME'] || 'neo4j',
      process.env['NEO4J_PASSWORD'] || 'testpassword'
    ),
  };
}
