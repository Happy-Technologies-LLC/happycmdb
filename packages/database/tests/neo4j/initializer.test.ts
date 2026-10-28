// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j Schema Initializer Tests (TDD)
 *
 * Tests for Neo4j schema initialization including:
 * - Schema file reading and parsing
 * - Constraint creation (uniqueness)
 * - Index creation (performance)
 * - Full-text search index
 * - Idempotent execution (safe to run multiple times)
 * - Error handling
 */

import { initializeNeo4jSchema } from '../../src/neo4j/initializer';
import { Neo4jClient } from '../../src/neo4j/client';
import * as fs from 'fs';
import * as path from 'path';

// Mock dependencies
jest.mock('../../src/neo4j/client');
jest.mock('fs');

describe('Neo4j Schema Initializer', () => {
  let mockClient: jest.Mocked<Neo4jClient>;
  let mockSession: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock session
    mockSession = {
      _run: jest.fn().mockResolvedValue({ records: [] }),
      _close: jest.fn().mockResolvedValue(undefined),
    };

    // Setup mock client
    mockClient = {
      _getSession: jest.fn().mockReturnValue(mockSession),
      _verifyConnectivity: jest.fn().mockResolvedValue(undefined),
      _close: jest.fn().mockResolvedValue(undefined),
    } as any;
  });

  describe('Schema File Loading', () => {
    it('should load and parse schema.cypher file', async () => {
      const schemaCypher = `
        // Create constraints
        CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (c:CI) REQUIRE c.id IS UNIQUE;

        // Create indexes
        CREATE INDEX ci_type_idx IF NOT EXISTS FOR (c:CI) ON (c.type);
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      await initializeNeo4jSchema(mockClient);

      expect(fs.readFileSync).toHaveBeenCalled();
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE CONSTRAINT')
      );
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE INDEX')
      );
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should throw error if schema file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await expect(initializeNeo4jSchema(mockClient)).rejects.toThrow(
        'Schema file not found'
      );
    });

    it('should use custom schema file path if provided', async () => {
      const customPath = '/custom/path/schema.cypher';
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('// Empty schema');

      await initializeNeo4jSchema(mockClient, customPath);

      expect(fs.readFileSync).toHaveBeenCalledWith(customPath, 'utf-8');
    });
  });

  describe('Constraint Creation', () => {
    it('should create unique constraint on CI.id', async () => {
      const schemaCypher = `
        CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (c:CI) REQUIRE c.id IS UNIQUE;
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      await initializeNeo4jSchema(mockClient);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE CONSTRAINT ci_id_unique')
      );
    });

    it('should create the per-organization unique constraint on CI.external_id', async () => {
      const schemaCypher = `
        CREATE CONSTRAINT ci_org_external_id_unique IF NOT EXISTS
        FOR (c:CI) REQUIRE (c.organization_id, c.external_id) IS UNIQUE;
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      await initializeNeo4jSchema(mockClient);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('(c.organization_id, c.external_id) IS UNIQUE')
      );
    });

    it('should handle constraint already exists error gracefully', async () => {
      const schemaCypher = `
        CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (c:CI) REQUIRE c.id IS UNIQUE;
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      const alreadyExistsError = new Error('Constraint already exists');
      mockSession.run.mockRejectedValueOnce(alreadyExistsError);

      // Should not throw - idempotent behavior
      await expect(initializeNeo4jSchema(mockClient)).resolves.not.toThrow();
    });
  });

  describe('Index Creation', () => {
    it('should create indexes on CI properties', async () => {
      const schemaCypher = `
        CREATE INDEX ci_type_idx IF NOT EXISTS FOR (c:CI) ON (c.type);
        CREATE INDEX ci_status_idx IF NOT EXISTS FOR (c:CI) ON (c.status);
        CREATE INDEX ci_environment_idx IF NOT EXISTS FOR (c:CI) ON (c.environment);
        CREATE INDEX ci_name_idx IF NOT EXISTS FOR (c:CI) ON (c.name);
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      await initializeNeo4jSchema(mockClient);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('ci_type_idx')
      );
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('ci_status_idx')
      );
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('ci_environment_idx')
      );
      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('ci_name_idx')
      );
    });

    it('should create full-text search index', async () => {
      const schemaCypher = `
        CREATE FULLTEXT INDEX ci_fulltext_idx IF NOT EXISTS
        FOR (c:CI) ON EACH [c.name, c.metadata];
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      await initializeNeo4jSchema(mockClient);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE FULLTEXT INDEX')
      );
    });

    it('should skip index if already exists', async () => {
      const schemaCypher = `
        CREATE INDEX ci_type_idx IF NOT EXISTS FOR (c:CI) ON (c.type);
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      const alreadyExistsError = new Error('Index already exists');
      mockSession.run.mockRejectedValueOnce(alreadyExistsError);

      await expect(initializeNeo4jSchema(mockClient)).resolves.not.toThrow();
    });
  });

  describe('Statement Parsing', () => {
    it('should split statements by semicolon', async () => {
      const schemaCypher = `
        CREATE CONSTRAINT c1 FOR (c:CI) REQUIRE c.id IS UNIQUE;
        CREATE INDEX i1 FOR (c:CI) ON (c.type);
        CREATE INDEX i2 FOR (c:CI) ON (c.status);
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      await initializeNeo4jSchema(mockClient);

      expect(mockSession.run).toHaveBeenCalledTimes(3);
    });

    it('should filter out empty statements and comments', async () => {
      const schemaCypher = `
        // This is a comment
        CREATE CONSTRAINT c1 FOR (c:CI) REQUIRE c.id IS UNIQUE;

        // Another comment

        CREATE INDEX i1 FOR (c:CI) ON (c.type);
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      await initializeNeo4jSchema(mockClient);

      // Should only execute non-comment statements
      expect(mockSession.run).toHaveBeenCalledTimes(2);
    });

    it('should handle multi-line statements', async () => {
      const schemaCypher = `
        CREATE FULLTEXT INDEX ci_fulltext_idx IF NOT EXISTS
        FOR (c:CI)
        ON EACH [c.name, c.metadata];
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      await initializeNeo4jSchema(mockClient);

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE FULLTEXT INDEX')
      );
    });
  });

  describe('Schema Verification', () => {
    it('should verify schema after initialization', async () => {
      const schemaCypher = `
        CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (c:CI) REQUIRE c.id IS UNIQUE;
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      const mockConstraints = {
        _records: [{ get: () => 'ci_id_unique' }],
      };
      const mockIndexes = {
        _records: [{ get: () => 'ci_type_idx' }],
      };

      mockSession.run
        .mockResolvedValueOnce({ records: [] }) // constraint creation
        .mockResolvedValueOnce(mockConstraints) // SHOW CONSTRAINTS
        .mockResolvedValueOnce(mockIndexes); // SHOW INDEXES

      await initializeNeo4jSchema(mockClient);

      expect(mockSession.run).toHaveBeenCalledWith('SHOW CONSTRAINTS');
      expect(mockSession.run).toHaveBeenCalledWith('SHOW INDEXES');
    });
  });

  describe('Error Handling', () => {
    it('should close session on error', async () => {
      const schemaCypher = `
        CREATE CONSTRAINT invalid SYNTAX;
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      mockSession.run.mockRejectedValueOnce(new Error('Syntax error'));

      await expect(initializeNeo4jSchema(mockClient)).rejects.toThrow();

      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should throw error for non-idempotent failures', async () => {
      const schemaCypher = `
        CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (c:CI) REQUIRE c.id IS UNIQUE;
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      mockSession.run.mockRejectedValueOnce(new Error('Database connection lost'));

      await expect(initializeNeo4jSchema(mockClient)).rejects.toThrow(
        'Database connection lost'
      );
    });
  });

  describe('Idempotency', () => {
    it('should be safe to run multiple times', async () => {
      const schemaCypher = `
        CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (c:CI) REQUIRE c.id IS UNIQUE;
        CREATE INDEX ci_type_idx IF NOT EXISTS FOR (c:CI) ON (c.type);
      `;

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(schemaCypher);

      // First run - success
      await initializeNeo4jSchema(mockClient);

      // Second run - constraints/indexes already exist
      const alreadyExistsError = new Error('Already exists');
      mockSession.run
        .mockRejectedValueOnce(alreadyExistsError)
        .mockRejectedValueOnce(alreadyExistsError)
        .mockResolvedValueOnce({ records: [] }) // SHOW CONSTRAINTS
        .mockResolvedValueOnce({ records: [] }); // SHOW INDEXES

      await expect(initializeNeo4jSchema(mockClient)).resolves.not.toThrow();
    });
  });
});
