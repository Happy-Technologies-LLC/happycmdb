// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { DiscoveryDefinitionService } from '../../src/services/discovery-definition.service';
import { getPostgresClient, getUnifiedCredentialService, queueManager } from '@cmdb/database';
import { DiscoveryDefinitionInput } from '@cmdb/common';

// Mock the database client
jest.mock('@cmdb/database');

// Mock the logger
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('DiscoveryDefinitionService', () => {
  let service: DiscoveryDefinitionService;
  let mockPostgresClient: any;
  let mockClient: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Setup mock client
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };

    // Setup mock postgres client (uses getClient(), not connect())
    mockPostgresClient = {
      query: jest.fn(),
      getClient: jest.fn().mockResolvedValue(mockClient),
      pool: {},
    };

    (getPostgresClient as jest.Mock).mockReturnValue(mockPostgresClient);

    // Setup mock credential service
    (getUnifiedCredentialService as jest.Mock).mockReturnValue({
      getById: jest.fn().mockResolvedValue(null),
    });

    // Setup mock queue manager
    (queueManager as any).getQueue = jest.fn().mockReturnValue({
      add: jest.fn().mockResolvedValue(undefined),
    });

    service = new DiscoveryDefinitionService();
  });

  describe('createDefinition', () => {
    const mockInput: DiscoveryDefinitionInput = {
      name: 'AWS Production Discovery',
      description: 'Discovers all AWS resources in production',
      provider: 'aws',
      method: 'agentless',
      credential_id: 'cred-123',
      config: {
        regions: ['us-east-1', 'us-west-2'],
        filters: { environment: 'production' },
      },
      schedule: '0 */6 * * *',
      is_active: true,
      tags: ['aws', 'production'],
    };

    it('should create a discovery definition successfully', async () => {
      // Mock credential validation
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              credential_id: 'cred-123',
              provider: 'aws',
              is_active: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'def-123',
              name: mockInput.name,
              description: mockInput.description,
              provider: mockInput.provider,
              method: mockInput.method,
              credential_id: mockInput.credential_id,
              config: mockInput.config,
              schedule: mockInput.schedule,
              is_active: mockInput.is_active,
              tags: mockInput.tags,
              created_by: 'user-123',
              created_at: new Date('2025-01-01'),
              updated_at: new Date('2025-01-01'),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const result = await service.createDefinition(mockInput, 'user-123');

      expect(result).toMatchObject({
        id: 'def-123',
        name: mockInput.name,
        provider: mockInput.provider,
        is_active: true,
      });

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should throw error if credential not found', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // Credential not found

      await expect(service.createDefinition(mockInput, 'user-123')).rejects.toThrow(
        'Credential with ID cred-123 not found'
      );

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should throw error if credential is inactive', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              credential_id: 'cred-123',
              provider: 'aws',
              is_active: false,
            },
          ],
        });

      await expect(service.createDefinition(mockInput, 'user-123')).rejects.toThrow(
        'Credential cred-123 is not active'
      );
    });

    it('should throw error if provider mismatch', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              credential_id: 'cred-123',
              provider: 'azure', // Mismatch
              is_active: true,
            },
          ],
        });

      await expect(service.createDefinition(mockInput, 'user-123')).rejects.toThrow(
        "Provider mismatch: Definition provider 'aws' does not match credential provider 'azure'"
      );
    });

    it('should throw error for invalid cron expression', async () => {
      const invalidInput = {
        ...mockInput,
        schedule: 'invalid cron',
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              credential_id: 'cred-123',
              provider: 'aws',
              is_active: true,
            },
          ],
        });

      await expect(service.createDefinition(invalidInput, 'user-123')).rejects.toThrow(
        /Invalid cron expression/
      );
    });
  });

  describe('getDefinition', () => {
    it('should return a definition by ID', async () => {
      const mockDefinition = {
        id: 'def-123',
        name: 'AWS Discovery',
        provider: 'aws',
        method: 'agentless',
        credential_id: 'cred-123',
        config: { regions: ['us-east-1'] },
        is_active: true,
        tags: ['aws'],
        created_by: 'user-123',
        created_at: new Date('2025-01-01'),
        updated_at: new Date('2025-01-01'),
      };

      mockPostgresClient.query.mockResolvedValue({
        rows: [mockDefinition],
      });

      const result = await service.getDefinition('def-123');

      expect(result).toMatchObject({
        id: 'def-123',
        name: 'AWS Discovery',
        provider: 'aws',
      });
    });

    it('should return null if definition not found', async () => {
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      const result = await service.getDefinition('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('listDefinitions', () => {
    it('should list all definitions without filters', async () => {
      const mockDefinitions = [
        {
          id: 'def-1',
          name: 'AWS Discovery',
          provider: 'aws',
          is_active: true,
          tags: ['aws'],
          created_at: new Date('2025-01-01'),
        },
        {
          id: 'def-2',
          name: 'Azure Discovery',
          provider: 'azure',
          is_active: true,
          tags: ['azure'],
          created_at: new Date('2025-01-02'),
        },
      ];

      mockPostgresClient.query.mockResolvedValue({
        rows: mockDefinitions.map((d) => ({
          ...d,
          method: 'agentless',
          credential_id: 'cred-123',
          config: {},
          created_by: 'user-123',
          updated_at: d.created_at,
        })),
      });

      const result = await service.listDefinitions();

      expect(result).toHaveLength(2);
      expect(result[0].provider).toBe('aws');
      expect(result[1].provider).toBe('azure');
    });

    it('should filter by provider', async () => {
      mockPostgresClient.query.mockResolvedValue({
        rows: [
          {
            id: 'def-1',
            name: 'AWS Discovery',
            provider: 'aws',
            method: 'agentless',
            credential_id: 'cred-123',
            config: {},
            is_active: true,
            tags: ['aws'],
            created_by: 'user-123',
            created_at: new Date('2025-01-01'),
            updated_at: new Date('2025-01-01'),
          },
        ],
      });

      const result = await service.listDefinitions({ provider: 'aws' });

      expect(result).toHaveLength(1);
      expect(result[0].provider).toBe('aws');
      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE provider = $1'),
        ['aws']
      );
    });

    it('should filter by active status', async () => {
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await service.listDefinitions({ active: true });

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE is_active = $1'),
        [true]
      );
    });

    it('should filter by tags', async () => {
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await service.listDefinitions({ tags: ['production', 'aws'] });

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('tags && $1'),
        [['production', 'aws']]
      );
    });
  });

  describe('updateDefinition', () => {
    it('should update a definition successfully', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'def-123',
              credential_id: 'cred-123',
              provider: 'aws',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'def-123',
              name: 'Updated Name',
              description: 'Updated description',
              provider: 'aws',
              method: 'agentless',
              credential_id: 'cred-123',
              config: {},
              is_active: true,
              tags: [],
              created_by: 'user-123',
              created_at: new Date('2025-01-01'),
              updated_at: new Date('2025-01-02'),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const result = await service.updateDefinition('def-123', {
        name: 'Updated Name',
        description: 'Updated description',
      });

      expect(result.name).toBe('Updated Name');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should throw error if definition not found', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // Definition not found

      await expect(
        service.updateDefinition('non-existent', { name: 'New Name' })
      ).rejects.toThrow('Discovery definition non-existent not found');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should throw error if no fields to update', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'def-123',
              credential_id: 'cred-123',
              provider: 'aws',
            },
          ],
        });

      await expect(service.updateDefinition('def-123', {})).rejects.toThrow(
        'No fields to update'
      );
    });
  });

  describe('deleteDefinition', () => {
    it('should delete a definition successfully', async () => {
      mockPostgresClient.query.mockResolvedValue({ rowCount: 1 });

      await service.deleteDefinition('def-123');

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        'DELETE FROM discovery_definitions WHERE id = $1',
        ['def-123']
      );
    });

    it('should throw error if definition not found', async () => {
      mockPostgresClient.query.mockResolvedValue({ rowCount: 0 });

      await expect(service.deleteDefinition('non-existent')).rejects.toThrow(
        'Discovery definition non-existent not found'
      );
    });
  });

  describe('runDefinition', () => {
    it('does not schedule credential-backed discovery without verified organization', async () => {
      const mockDefinition = {
        id: 'def-123',
        name: 'AWS Discovery',
        provider: 'aws',
        method: 'agentless',
        credential_id: 'cred-123',
        config: { regions: ['us-east-1'] },
        is_active: true,
        tags: [],
        created_by: 'user-123',
        created_at: new Date('2025-01-01'),
        updated_at: new Date('2025-01-01'),
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [mockDefinition] }) // Get definition
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      await expect(service.runDefinition('def-123', 'user-123')).rejects.toBeInstanceOf(Error);
      expect(queueManager.getQueue).not.toHaveBeenCalled();
    });

    it('should throw error if definition is inactive', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'def-123',
              name: 'Inactive Discovery',
              provider: 'aws',
              method: 'agentless',
              is_active: false,
              tags: [],
              created_by: 'user-123',
              created_at: new Date('2025-01-01'),
              updated_at: new Date('2025-01-01'),
            },
          ],
        });

      await expect(service.runDefinition('def-123', 'user-123')).rejects.toThrow(
        'Discovery definition def-123 is not active'
      );
    });
  });

  describe('updateLastRun', () => {
    it('should update last run information', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // Update definition
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      await service.updateLastRun('def-123', 'job-123', 'completed', 42);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE discovery_definitions'),
        ['completed', 'job-123', 'def-123']
      );
    });
  });

  describe('getRunHistory', () => {
    it('should return run history for a definition', async () => {
      const mockHistory = [
        {
          job_id: 'job-1',
          status: 'completed',
          started_at: new Date('2025-01-01'),
        },
      ];

      mockPostgresClient.query.mockResolvedValue({ rows: mockHistory });

      const result = await service.getRunHistory('def-123');

      expect(result).toHaveLength(1);
      expect(result[0].job_id).toBe('job-1');
    });

    it('should pass definition ID as parameter', async () => {
      mockPostgresClient.query.mockResolvedValue({ rows: [] });

      await service.getRunHistory('def-123', 10);

      expect(mockPostgresClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        ['def-123']
      );
    });
  });
});
