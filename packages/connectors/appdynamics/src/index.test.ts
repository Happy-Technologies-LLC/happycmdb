// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AppDynamics Connector Tests
 */

import AppDynamicsConnector from './index';
import { ConnectorConfiguration } from '@cmdb/integration-framework';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AppDynamicsConnector', () => {
  let connector: AppDynamicsConnector;
  let config: ConnectorConfiguration;
  let mockAxiosInstance: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock axios instance
    mockAxiosInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    };

    mockedAxios.create.mockReturnValue(mockAxiosInstance as any);

    // Create test configuration
    config = {
      name: 'Test AppDynamics',
      type: 'appdynamics',
      enabled: true,
      connection: {
        controller_url: 'https://test.saas.appdynamics.com',
        account_name: 'testaccount',
        username: 'testuser',
        password: 'testpass',
      },
      enabled_resources: ['applications', 'tiers', 'nodes', 'backends'],
    };

    connector = new AppDynamicsConnector(config);
  });

  describe('Constructor', () => {
    it('should create connector with correct configuration', () => {
      expect(connector).toBeDefined();
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://test.saas.appdynamics.com',
        auth: {
          username: 'testuser@testaccount',
          password: 'testpass',
        },
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        timeout: 30000,
      });
    });

    it('should strip trailing slash from controller URL', () => {
      const configWithSlash = {
        ...config,
        connection: {
          ...config.connection,
          controller_url: 'https://test.saas.appdynamics.com/',
        },
      };

      const connectorWithSlash = new AppDynamicsConnector(configWithSlash);
      expect(connectorWithSlash).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await connector.initialize();
      expect(connector['isInitialized']).toBe(true);
    });
  });

  describe('testConnection', () => {
    it('should return success when connection is valid', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'App1', active: true },
          { id: 2, name: 'App2', active: true },
        ],
      });

      const result = await connector.testConnection();

      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully connected');
      expect(result.details?.applications_found).toBe(2);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/controller/rest/applications',
        { params: { output: 'json' } }
      );
    });

    it('should return failure when connection fails', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await connector.testConnection();

      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
    });

    it('should handle authentication errors', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 401,
          data: { error: 'Invalid credentials' },
        },
        message: 'Unauthorized',
      });

      const result = await connector.testConnection();

      expect(result.message).toBe('Connection failed');
      expect(result.details).toBeUndefined();
    });
  });

  describe('extractResource - applications', () => {
    it('should extract all applications', async () => {
      const mockApplications = [
        { id: 1, name: 'App1', description: 'Test App 1', active: true },
        { id: 2, name: 'App2', description: 'Test App 2', active: true },
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockApplications,
      });

      const result = await connector.extractResource('applications');

      expect(result).toHaveLength(2);
      expect(result[0].external_id).toBe('app-1');
      expect(result[0].data.name).toBe('App1');
      expect(result[0].source_type).toBe('appdynamics');
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/controller/rest/applications',
        { params: { output: 'json' } }
      );
    });

    it('should filter inactive applications by default', async () => {
      const mockApplications = [
        { id: 1, name: 'App1', active: true },
        { id: 2, name: 'App2', active: false },
        { id: 3, name: 'App3', active: true },
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockApplications,
      });

      const result = await connector.extractResource('applications');

      expect(result).toHaveLength(2);
      expect(result.find(r => r.data.name === 'App2')).toBeUndefined();
    });

    it('should include inactive applications when configured', async () => {
      const mockApplications = [
        { id: 1, name: 'App1', active: true },
        { id: 2, name: 'App2', active: false },
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockApplications,
      });

      const result = await connector.extractResource('applications', {
        include_inactive: true,
      });

      expect(result).toHaveLength(2);
    });
  });

  describe('extractResource - tiers', () => {
    it('should extract tiers for all applications', async () => {
      // Setup: First extract applications
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'App1', active: true },
          { id: 2, name: 'App2', active: true },
        ],
      });

      await connector.extractResource('applications');

      // Reset mock for tier extraction
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 10, name: 'Web-Tier', type: 'Application Server', numberOfNodes: 3 },
          { id: 11, name: 'DB-Tier', type: 'Database', numberOfNodes: 2 },
        ],
      });
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 20, name: 'API-Tier', type: 'Application Server', numberOfNodes: 5 },
        ],
      });

      const result = await connector.extractResource('tiers');

      expect(result).toHaveLength(3);
      expect(result[0].external_id).toBe('tier-1-10');
      expect(result[0].data.applicationName).toBe('App1');
      expect(result[0].data.name).toBe('Web-Tier');
    });

    it('should filter tiers by type', async () => {
      // Setup: First extract applications
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, name: 'App1', active: true }],
      });

      await connector.extractResource('applications');

      // Extract tiers with filter
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 10, name: 'Web-Tier', type: 'Application Server' },
          { id: 11, name: 'DB-Tier', type: 'Database' },
        ],
      });

      const result = await connector.extractResource('tiers', {
        tier_types: ['Application Server'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].data.name).toBe('Web-Tier');
    });
  });

  describe('extractResource - nodes', () => {
    it('should extract nodes for all applications', async () => {
      // Setup: First extract applications
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, name: 'App1', active: true }],
      });

      await connector.extractResource('applications');

      // Extract nodes
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          {
            id: 100,
            name: 'node1',
            type: 'Java',
            tierName: 'Web-Tier',
            tierId: 10,
            machineId: 50,
            machineName: 'server1',
            machineOSType: 'Linux',
            ipAddresses: { 'eth0': '10.0.1.10' },
          },
        ],
      });

      const result = await connector.extractResource('nodes');

      expect(result).toHaveLength(1);
      expect(result[0].external_id).toBe('node-1-100');
      expect(result[0].data.name).toBe('node1');
      expect(result[0].data.applicationName).toBe('App1');
    });

    it('should filter historical nodes by default', async () => {
      // Setup: First extract applications
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, name: 'App1', active: true }],
      });

      await connector.extractResource('applications');

      // Extract nodes (including historical)
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 100, name: 'node1', tierName: 'Web-Tier', machineId: 50 },
          { id: 101, name: 'node2' }, // Historical (no tier or machine)
        ],
      });

      const result = await connector.extractResource('nodes');

      expect(result).toHaveLength(1);
      expect(result[0].data.name).toBe('node1');
    });
  });

  describe('extractResource - backends', () => {
    it('should extract backends for all applications', async () => {
      // Setup: First extract applications
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, name: 'App1', active: true }],
      });

      await connector.extractResource('applications');

      // Extract backends
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          {
            id: 200,
            name: 'MySQL-DB',
            exitPointType: 'DB',
            tierId: 10,
            properties: [
              { name: 'HOST', value: 'mysql.example.com' },
              { name: 'PORT', value: '3306' },
            ],
          },
          {
            id: 201,
            name: 'External-API',
            exitPointType: 'HTTP',
            tierId: 10,
          },
        ],
      });

      const result = await connector.extractResource('backends');

      expect(result).toHaveLength(2);
      expect(result[0].external_id).toBe('backend-1-200');
      expect(result[0].data.name).toBe('MySQL-DB');
      expect(result[0].data.exitPointType).toBe('DB');
    });

    it('should filter backends by type', async () => {
      // Setup: First extract applications
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, name: 'App1', active: true }],
      });

      await connector.extractResource('applications');

      // Extract backends with filter
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 200, name: 'MySQL-DB', exitPointType: 'DB' },
          { id: 201, name: 'External-API', exitPointType: 'HTTP' },
        ],
      });

      const result = await connector.extractResource('backends', {
        backend_types: ['DB'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].data.name).toBe('MySQL-DB');
    });
  });

  describe('extractRelationships', () => {
    it('should infer relationships between nodes and tiers', async () => {
      // Setup: Extract applications, tiers, and nodes
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, name: 'App1', active: true }],
      });
      await connector.extractResource('applications');

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 10, name: 'Web-Tier', type: 'Application Server' }],
      });
      await connector.extractResource('tiers');

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 100, name: 'node1', tierId: 10, tierName: 'Web-Tier', machineId: 50 },
        ],
      });
      await connector.extractResource('nodes');

      // Extract relationships
      const relationships = await connector.extractRelationships();

      // Should have node->tier and tier->app relationships
      expect(relationships.length).toBeGreaterThanOrEqual(2);

      const nodeToTier = relationships.find(
        r => r.source_external_id === 'node-1-100' && r.target_external_id === 'tier-1-10'
      );
      expect(nodeToTier).toBeDefined();
      expect(nodeToTier?.relationship_type).toBe('BELONGS_TO');

      const tierToApp = relationships.find(
        r => r.source_external_id === 'tier-1-10' && r.target_external_id === 'app-1'
      );
      expect(tierToApp).toBeDefined();
      expect(tierToApp?.relationship_type).toBe('BELONGS_TO');
    });
  });

  describe('transformResource', () => {
    it('should transform application correctly', async () => {
      const sourceData = {
        id: 1,
        name: 'TestApp',
        description: 'Test Application',
        active: true,
      };

      const result = await connector.transformResource('applications', sourceData);

      expect(result.name).toBe('TestApp');
      expect(result.ci_type).toBe('application');
      expect(result.status).toBe('active');
      expect(result.source).toBe('appdynamics');
      expect(result.source_id).toBe('app-1');
      expect(result.confidence_score).toBe(95);
      expect(result.attributes.appdynamics_id).toBe(1);
    });

    it('should transform inactive application correctly', async () => {
      const sourceData = {
        id: 2,
        name: 'InactiveApp',
        active: false,
      };

      const result = await connector.transformResource('applications', sourceData);

      expect(result.status).toBe('inactive');
    });

    it('should transform tier correctly', async () => {
      const sourceData = {
        id: 10,
        name: 'Web-Tier',
        description: 'Web tier',
        type: 'Application Server',
        agentType: 'JAVA',
        numberOfNodes: 5,
        applicationId: 1,
        applicationName: 'TestApp',
      };

      const result = await connector.transformResource('tiers', sourceData);

      expect(result.name).toBe('TestApp - Web-Tier');
      expect(result.ci_type).toBe('service');
      expect(result.source_id).toBe('tier-1-10');
      expect(result.attributes.tier_type).toBe('Application Server');
      expect(result.attributes.number_of_nodes).toBe(5);
    });

    it('should transform node correctly', async () => {
      const sourceData = {
        id: 100,
        name: 'node1',
        type: 'Java',
        tierName: 'Web-Tier',
        tierId: 10,
        machineId: 50,
        machineName: 'server1.example.com',
        machineOSType: 'Linux',
        machineAgentVersion: '21.3.0',
        appAgentVersion: '21.3.0',
        ipAddresses: {
          'eth0': '10.0.1.10',
          'eth1': '192.168.1.10',
        },
        applicationId: 1,
        applicationName: 'TestApp',
      };

      const result = await connector.transformResource('nodes', sourceData);

      expect(result.name).toBe('node1');
      expect(result.ci_type).toBe('server');
      expect(result.source_id).toBe('node-1-100');
      expect(result.attributes.machine_name).toBe('server1.example.com');
      expect(result.identifiers.ip_address).toEqual(['10.0.1.10', '192.168.1.10']);
      expect(result.identifiers.hostname).toBe('node1');
    });

    it('should transform backend correctly', async () => {
      const sourceData = {
        id: 200,
        name: 'MySQL-DB',
        exitPointType: 'DB',
        tierId: 10,
        properties: [
          { name: 'HOST', value: 'mysql.example.com' },
          { name: 'PORT', value: '3306' },
        ],
        applicationId: 1,
        applicationName: 'TestApp',
      };

      const result = await connector.transformResource('backends', sourceData);

      expect(result.name).toBe('MySQL-DB');
      expect(result.ci_type).toBe('service');
      expect(result.source_id).toBe('backend-1-200');
      expect(result.attributes.service_type).toBe('database');
      expect(result.attributes.backend_type).toBe('DB');
      expect(result.attributes.properties).toEqual({
        'HOST': 'mysql.example.com',
        'PORT': '3306',
      });
    });
  });

  describe('Backend Type Mapping', () => {
    it('should map DB to database', async () => {
      const result = await connector.transformResource('backends', {
        id: 1,
        name: 'Test',
        exitPointType: 'DB',
        applicationId: 1,
        applicationName: 'App',
      });
      expect(result.attributes.service_type).toBe('database');
    });

    it('should map HTTP to web_service', async () => {
      const result = await connector.transformResource('backends', {
        id: 1,
        name: 'Test',
        exitPointType: 'HTTP',
        applicationId: 1,
        applicationName: 'App',
      });
      expect(result.attributes.service_type).toBe('web_service');
    });

    it('should map CACHE to cache', async () => {
      const result = await connector.transformResource('backends', {
        id: 1,
        name: 'Test',
        exitPointType: 'CACHE',
        applicationId: 1,
        applicationName: 'App',
      });
      expect(result.attributes.service_type).toBe('cache');
    });

    it('should map unknown types to external', async () => {
      const result = await connector.transformResource('backends', {
        id: 1,
        name: 'Test',
        exitPointType: 'UNKNOWN_TYPE',
        applicationId: 1,
        applicationName: 'App',
      });
      expect(result.attributes.service_type).toBe('external');
    });
  });

  describe('extractIdentifiers', () => {
    it('should extract identifiers for application', () => {
      const data = { id: 1, name: 'TestApp' };
      const result = connector.extractIdentifiers(data);

      expect(result.external_id).toBe('app-1');
      expect(result.custom_identifiers?.appdynamics_app_id).toBe('1');
      expect(result.custom_identifiers?.appdynamics_app_name).toBe('TestApp');
    });

    it('should extract identifiers for node with IP addresses', () => {
      const data = {
        id: 100,
        name: 'node1',
        applicationId: 1,
        machineId: 50,
        machineName: 'server1',
        ipAddresses: { 'eth0': '10.0.1.10', 'eth1': '192.168.1.10' },
      };
      const result = connector.extractIdentifiers(data);

      expect(result.external_id).toBe('node-1-100');
      expect(result.hostname).toBe('node1');
      expect(result.ip_address).toEqual(['10.0.1.10', '192.168.1.10']);
      expect(result.custom_identifiers?.appdynamics_node_id).toBe('100');
      expect(result.custom_identifiers?.machine_name).toBe('server1');
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors gracefully during extraction', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('API Error'));

      await expect(connector.extractResource('applications')).rejects.toThrow('API Error');
    });

    it('should handle unknown resource gracefully', async () => {
      await expect(connector.extractResource('unknown_resource')).rejects.toThrow(
        'Unknown resource'
      );
    });

    it('should handle unknown resource in transform gracefully', async () => {
      await expect(
        connector.transformResource('unknown_resource', {})
      ).rejects.toThrow('Unknown resource');
    });
  });

  describe('Resource Dependencies', () => {
    it('should have enabled resources defined', () => {
      const enabledResources = connector.getEnabledResources();
      expect(enabledResources).toEqual([
        'applications',
        'tiers',
        'nodes',
        'backends',
      ]);
    });

    it('should use default enabled resources when not specified', () => {
      const configWithoutResources = {
        ...config,
        enabled_resources: undefined,
      };
      const connectorWithDefaults = new AppDynamicsConnector(configWithoutResources);
      const enabledResources = connectorWithDefaults.getEnabledResources();

      expect(enabledResources).toEqual([
        'applications',
        'tiers',
        'nodes',
        'backends',
      ]);
    });
  });
});
