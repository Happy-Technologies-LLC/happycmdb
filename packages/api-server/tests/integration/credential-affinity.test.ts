// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential Affinity Integration Tests
 *
 * Tests the unified credential affinity matching algorithm and credential set
 * selection strategies (sequential, parallel, adaptive) with real database connections.
 */

import { Pool } from 'pg';
import { getPostgresClient } from '@cmdb/database';
import { CredentialSetService } from '@cmdb/database/postgres/credential-set.service';
import {
  UnifiedCredential,
  UnifiedCredentialInput,
  CredentialSetInput,
  CredentialMatchContext,
  CredentialSet,
} from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';
import { getEncryptionService } from '@cmdb/common';

describe('Credential Affinity Integration Tests', () => {
  let pool: Pool;
  let credentialSetService: CredentialSetService;
  const createdCredentialIds: string[] = [];
  const createdSetIds: string[] = [];

  beforeAll(async () => {
    // Connect to the global Postgres container (canonical schema already loaded).
    pool = getPostgresClient().pool;

    // Initialize service
    credentialSetService = new CredentialSetService(pool);
  }, 120000);

  afterAll(async () => {
    // Cleanup created resources
    for (const setId of createdSetIds) {
      try {
        await credentialSetService.delete(setId);
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    for (const credId of createdCredentialIds) {
      try {
        await pool.query('DELETE FROM credentials WHERE id = $1', [credId]);
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    await pool.end();
  });

  afterEach(async () => {
    // Clean up after each test
    await pool.query('DELETE FROM credential_sets WHERE id = ANY($1)', [createdSetIds]);
    await pool.query('DELETE FROM credentials WHERE id = ANY($1)', [createdCredentialIds]);
    createdSetIds.length = 0;
    createdCredentialIds.length = 0;
  });

  describe('Credential Affinity Matching', () => {
    it('should match credential by network CIDR', async () => {
      // Create credential with network affinity
      const credentialId = await createCredential(pool, {
        name: 'Production SSH Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: {
          username: 'admin',
          password: 'secure-password',
        },
        affinity: {
          networks: ['10.0.0.0/8', '192.168.1.0/24'],
          priority: 8,
        },
        tags: ['production', 'ssh'],
      });
      createdCredentialIds.push(credentialId);

      // Create credential set
      const set = await credentialSetService.create(
        {
          name: 'Test Credential Set',
          credential_ids: [credentialId],
          strategy: 'adaptive',
        },
        'test-user'
      );
      createdSetIds.push(set.id);

      // Select credentials with matching network context
      const matchingContext: CredentialMatchContext = {
        ip: '10.50.100.25',
        hostname: 'prod-server-01',
        required_protocol: 'ssh_password',
        required_scope: 'ssh',
      };

      const credentials = await credentialSetService.selectCredentials(
        set.id,
        matchingContext
      );

      expect(credentials).toHaveLength(1);
      expect(credentials[0].id).toBe(credentialId);
      expect(credentials[0].name).toBe('Production SSH Credential');
    }, 60000);

    it('should match credential by hostname pattern', async () => {
      // Create credential with hostname pattern
      const credentialId = await createCredential(pool, {
        name: 'Database Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: {
          username: 'dbadmin',
          password: 'db-password',
        },
        affinity: {
          hostname_patterns: ['db-*', '*.database.local'],
          os_types: ['linux'],
          priority: 9,
        },
        tags: ['database'],
      });
      createdCredentialIds.push(credentialId);

      const set = await credentialSetService.create(
        {
          name: 'Database Credential Set',
          credential_ids: [credentialId],
          strategy: 'adaptive',
        },
        'test-user'
      );
      createdSetIds.push(set.id);

      // Test with matching hostname
      const context: CredentialMatchContext = {
        hostname: 'db-prod-01.database.local',
        os_type: 'linux',
        required_protocol: 'ssh_password',
      };

      const credentials = await credentialSetService.selectCredentials(set.id, context);

      expect(credentials).toHaveLength(1);
      expect(credentials[0].affinity.hostname_patterns).toContain('db-*');
    }, 60000);

    it('should match credential by multiple affinity criteria', async () => {
      // Create credential with multiple affinity criteria
      const credentialId = await createCredential(pool, {
        name: 'AWS Production Credential',
        protocol: 'aws_iam',
        scope: 'cloud_provider',
        credentials: {
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          region: 'us-east-1',
        },
        affinity: {
          cloud_providers: ['aws'],
          environments: ['production'],
          priority: 10,
        },
        tags: ['aws', 'production'],
      });
      createdCredentialIds.push(credentialId);

      const set = await credentialSetService.create(
        {
          name: 'AWS Credential Set',
          credential_ids: [credentialId],
          strategy: 'adaptive',
        },
        'test-user'
      );
      createdSetIds.push(set.id);

      // Test with matching context
      const context: CredentialMatchContext = {
        cloud_provider: 'aws',
        environment: 'production',
        required_protocol: 'aws_iam',
      };

      const credentials = await credentialSetService.selectCredentials(set.id, context);

      expect(credentials).toHaveLength(1);
      expect(credentials[0].affinity.cloud_providers).toContain('aws');
      expect(credentials[0].affinity.environments).toContain('production');
    }, 60000);
  });

  describe('Credential Set Selection Strategies', () => {
    it('should apply sequential strategy with correct ordering', async () => {
      // Create multiple credentials
      const cred1 = await createCredential(pool, {
        name: 'Admin Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'admin', password: 'admin-pass' },
        affinity: { priority: 5 },
        tags: ['admin'],
      });
      createdCredentialIds.push(cred1);

      const cred2 = await createCredential(pool, {
        name: 'Root Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'root', password: 'root-pass' },
        affinity: { priority: 3 },
        tags: ['root'],
      });
      createdCredentialIds.push(cred2);

      const cred3 = await createCredential(pool, {
        name: 'Service Account',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'service', password: 'service-pass' },
        affinity: { priority: 1 },
        tags: ['service'],
      });
      createdCredentialIds.push(cred3);

      // Create credential set with sequential strategy
      const set = await credentialSetService.create(
        {
          name: 'Sequential Test Set',
          credential_ids: [cred1, cred2, cred3],
          strategy: 'sequential',
          stop_on_success: true,
        },
        'test-user'
      );
      createdSetIds.push(set.id);

      const context: CredentialMatchContext = {
        hostname: 'test-server',
        required_protocol: 'ssh_password',
      };

      const credentials = await credentialSetService.selectCredentials(set.id, context);

      // Should return credentials in set order
      expect(credentials).toHaveLength(3);
      expect(credentials[0].id).toBe(cred1);
      expect(credentials[1].id).toBe(cred2);
      expect(credentials[2].id).toBe(cred3);
    }, 60000);

    it('should apply parallel strategy', async () => {
      // Create multiple credentials
      const cred1 = await createCredential(pool, {
        name: 'Parallel Cred 1',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'user1', password: 'pass1' },
        affinity: {},
        tags: ['parallel'],
      });
      createdCredentialIds.push(cred1);

      const cred2 = await createCredential(pool, {
        name: 'Parallel Cred 2',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'user2', password: 'pass2' },
        affinity: {},
        tags: ['parallel'],
      });
      createdCredentialIds.push(cred2);

      // Create credential set with parallel strategy
      const set = await credentialSetService.create(
        {
          name: 'Parallel Test Set',
          credential_ids: [cred1, cred2],
          strategy: 'parallel',
          stop_on_success: false,
        },
        'test-user'
      );
      createdSetIds.push(set.id);

      const context: CredentialMatchContext = {
        hostname: 'test-server',
      };

      const credentials = await credentialSetService.selectCredentials(set.id, context);

      // Should return all credentials
      expect(credentials).toHaveLength(2);
      expect(credentials.map(c => c.id)).toContain(cred1);
      expect(credentials.map(c => c.id)).toContain(cred2);
    }, 60000);

    it('should apply adaptive strategy with affinity ranking', async () => {
      // Create credentials with different affinity scores
      const cred1 = await createCredential(pool, {
        name: 'Low Affinity Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'user1', password: 'pass1' },
        affinity: {
          networks: ['172.16.0.0/12'],
          priority: 3,
        },
        tags: ['low-affinity'],
      });
      createdCredentialIds.push(cred1);

      const cred2 = await createCredential(pool, {
        name: 'High Affinity Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'user2', password: 'pass2' },
        affinity: {
          networks: ['10.0.0.0/8'],
          hostname_patterns: ['prod-*'],
          environments: ['production'],
          priority: 10,
        },
        tags: ['high-affinity'],
      });
      createdCredentialIds.push(cred2);

      const cred3 = await createCredential(pool, {
        name: 'Medium Affinity Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'user3', password: 'pass3' },
        affinity: {
          hostname_patterns: ['prod-*'],
          priority: 6,
        },
        tags: ['medium-affinity'],
      });
      createdCredentialIds.push(cred3);

      // Create credential set with adaptive strategy
      const set = await credentialSetService.create(
        {
          name: 'Adaptive Test Set',
          credential_ids: [cred1, cred2, cred3],
          strategy: 'adaptive',
          stop_on_success: true,
        },
        'test-user'
      );
      createdSetIds.push(set.id);

      // Context that matches cred2 best
      const context: CredentialMatchContext = {
        ip: '10.50.100.25',
        hostname: 'prod-server-01',
        environment: 'production',
        required_protocol: 'ssh_password',
      };

      const credentials = await credentialSetService.selectCredentials(set.id, context);

      // Should rank cred2 highest due to best affinity match
      expect(credentials).toHaveLength(3);
      expect(credentials[0].id).toBe(cred2); // Highest affinity score
      expect(credentials[0].name).toBe('High Affinity Credential');
    }, 60000);
  });

  describe('Multi-Credential Matching Scenarios', () => {
    it('should handle credential matching with same host but different protocols', async () => {
      // Create SSH credential
      const sshCred = await createCredential(pool, {
        name: 'SSH Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'admin', password: 'ssh-pass' },
        affinity: {
          networks: ['10.0.0.0/8'],
        },
        tags: ['ssh'],
      });
      createdCredentialIds.push(sshCred);

      // Create WinRM credential
      const winrmCred = await createCredential(pool, {
        name: 'WinRM Credential',
        protocol: 'winrm',
        scope: 'ssh',
        credentials: { username: 'admin', password: 'winrm-pass' },
        affinity: {
          networks: ['10.0.0.0/8'],
        },
        tags: ['winrm'],
      });
      createdCredentialIds.push(winrmCred);

      // Create set with both credentials
      const set = await credentialSetService.create(
        {
          name: 'Multi-Protocol Set',
          credential_ids: [sshCred, winrmCred],
          strategy: 'adaptive',
        },
        'test-user'
      );
      createdSetIds.push(set.id);

      // Test SSH context
      const sshContext: CredentialMatchContext = {
        ip: '10.50.100.25',
        required_protocol: 'ssh_password',
      };

      const sshCredentials = await credentialSetService.selectCredentials(set.id, sshContext);

      // Should prefer SSH credential
      expect(sshCredentials[0].protocol).toBe('ssh_password');

      // Test WinRM context
      const winrmContext: CredentialMatchContext = {
        ip: '10.50.100.25',
        required_protocol: 'winrm',
      };

      const winrmCredentials = await credentialSetService.selectCredentials(set.id, winrmContext);

      // Should prefer WinRM credential
      expect(winrmCredentials[0].protocol).toBe('winrm');
    }, 60000);

    it('should handle credential affinity with overlapping networks', async () => {
      // Create credentials with overlapping networks
      const cred1 = await createCredential(pool, {
        name: 'Broad Network Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'broad', password: 'broad-pass' },
        affinity: {
          networks: ['10.0.0.0/8'],
          priority: 5,
        },
        tags: ['broad'],
      });
      createdCredentialIds.push(cred1);

      const cred2 = await createCredential(pool, {
        name: 'Specific Network Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'specific', password: 'specific-pass' },
        affinity: {
          networks: ['10.50.0.0/16'],
          priority: 5,
        },
        tags: ['specific'],
      });
      createdCredentialIds.push(cred2);

      const set = await credentialSetService.create(
        {
          name: 'Overlapping Network Set',
          credential_ids: [cred1, cred2],
          strategy: 'adaptive',
        },
        'test-user'
      );
      createdSetIds.push(set.id);

      const context: CredentialMatchContext = {
        ip: '10.50.100.25',
        required_protocol: 'ssh_password',
      };

      const credentials = await credentialSetService.selectCredentials(set.id, context);

      // Both credentials should match, but order may vary based on affinity calculation
      expect(credentials).toHaveLength(2);
      expect(credentials.map(c => c.id)).toContain(cred1);
      expect(credentials.map(c => c.id)).toContain(cred2);
    }, 60000);
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle empty credential set', async () => {
      const cred = await createCredential(pool, {
        name: 'Test Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'test', password: 'test-pass' },
        affinity: {},
        tags: [],
      });
      createdCredentialIds.push(cred);

      // Attempt to create set with empty credential_ids
      await expect(
        credentialSetService.create(
          {
            name: 'Empty Set',
            credential_ids: [],
            strategy: 'sequential',
          },
          'test-user'
        )
      ).rejects.toThrow('Credential set must contain at least one credential');
    }, 60000);

    it('should handle missing credential in set', async () => {
      const cred = await createCredential(pool, {
        name: 'Valid Credential',
        protocol: 'ssh_password',
        scope: 'ssh',
        credentials: { username: 'valid', password: 'valid-pass' },
        affinity: {},
        tags: [],
      });
      createdCredentialIds.push(cred);

      // Attempt to create set with invalid credential ID
      await expect(
        credentialSetService.create(
          {
            name: 'Invalid Set',
            credential_ids: [cred, uuidv4()],
            strategy: 'sequential',
          },
          'test-user'
        )
      ).rejects.toThrow('The following credential IDs do not exist');
    }, 60000);

    it('should handle non-existent credential set', async () => {
      const context: CredentialMatchContext = {
        hostname: 'test-server',
      };

      await expect(
        credentialSetService.selectCredentials(uuidv4(), context)
      ).rejects.toThrow('Credential set with ID');
    }, 60000);
  });
});

/**
 * Helper: Create credential with encryption
 */
async function createCredential(
  pool: Pool,
  input: UnifiedCredentialInput
): Promise<string> {
  const encryptionService = getEncryptionService();
  const id = uuidv4();

  // Encrypt credentials
  const encryptedCredentials = encryptionService.encrypt(
    JSON.stringify(input.credentials)
  );

  await pool.query(
    `INSERT INTO credentials (
      id, name, description, protocol, scope, credentials, affinity, tags, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.name,
      input.description || null,
      input.protocol,
      input.scope,
      encryptedCredentials,
      input.affinity || {},
      input.tags || [],
      'test-user',
    ]
  );

  return id;
}
