// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Microsoft Intune Connector Tests (v1.0)
 * Tests for multi-resource Intune connector functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import IntuneConnector from './index';
import { ConnectorConfiguration } from '@cmdb/integration-framework';
import { logger } from '@cmdb/common';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as any;

describe('IntuneConnector - Multi-Resource Tests', () => {
  let connector: IntuneConnector;
  let mockAuthInstance: any;
  let mockGraphInstance: any;

  const baseConfig: ConnectorConfiguration = {
    name: 'Test Intune Connector',
    type: 'intune',
    enabled: true,
    connection: {
      tenant_id: '12345678-1234-1234-1234-123456789abc',
      client_id: 'abcdef12-3456-7890-abcd-ef1234567890',
      client_secret: 'test_secret_value',
    },
  };

  beforeEach(() => {
    // Create mock auth instance (for OAuth token endpoint)
    mockAuthInstance = {
      get: vi.fn(),
      post: vi.fn(),
    };

    // Create mock Graph API instance
    mockGraphInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    // Mock axios.create to return appropriate instances
    mockedAxios.create.mockImplementation((config: any) => {
      if (config.baseURL?.includes('login.microsoftonline.com')) {
        return mockAuthInstance;
      }
      return mockGraphInstance;
    });

    // Mock successful token response
    mockAuthInstance.post.mockResolvedValue({
      data: {
        access_token: 'mock_access_token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    });

    // Add request interceptor mock
    mockGraphInstance.interceptors = {
      request: {
        use: vi.fn((callback: any) => {
          // Store the interceptor for later use
          mockGraphInstance._requestInterceptor = callback;
          return 0;
        }),
      },
    };

    connector = new IntuneConnector(baseConfig);
  });

  describe('Initialization', () => {
    it('should initialize with correct metadata', async () => {
      expect(connector).toBeDefined();
      const resources = connector.getAvailableResources();
      expect(resources).toHaveLength(6);
      expect(resources.map(r => r.id)).toEqual([
        'devices',
        'applications',
        'compliance_policies',
        'configuration_profiles',
        'users',
        'relationships',
      ]);
    });

    it('should use default enabled resources', () => {
      const enabledResources = connector.getEnabledResources();
      expect(enabledResources).toEqual([
        'devices',
        'applications',
        'compliance_policies',
        'configuration_profiles',
        'relationships',
      ]);
    });

    it('should respect custom enabled resources', () => {
      const customConfig: ConnectorConfiguration = {
        ...baseConfig,
        enabled_resources: ['devices', 'users'],
      };
      const customConnector = new IntuneConnector(customConfig);
      expect(customConnector.getEnabledResources()).toEqual(['devices', 'users']);
    });

    it('should obtain OAuth token on initialization', async () => {
      await connector.initialize();

      expect(mockAuthInstance.post).toHaveBeenCalledWith(
        '/oauth2/v2.0/token',
        expect.any(URLSearchParams),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        })
      );
    });
  });

  describe('Test Connection', () => {
    it('should successfully test connection', async () => {
      mockGraphInstance.get.mockResolvedValue({
        data: {
          value: [{ displayName: 'Test Organization' }],
        },
      });

      const result = await connector.testConnection();
      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully connected');
      expect(result.details?.organization).toBe('Test Organization');
    });

    it('should handle connection failure', async () => {
      mockAuthInstance.post.mockRejectedValue({
        message: 'Invalid credentials',
        response: {
          data: { error: 'invalid_client' },
        },
      });

      const result = await connector.testConnection();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
    });
  });

  describe('Extract Devices', () => {
    it('should extract managed devices', async () => {
      const mockDevices = [
        {
          id: 'device-1',
          deviceName: 'iPhone-001',
          operatingSystem: 'iOS',
          osVersion: '17.0',
          manufacturer: 'Apple',
          model: 'iPhone 15',
          serialNumber: 'SN001',
          complianceState: 'compliant',
          managedDeviceOwnerType: 'company',
          lastSyncDateTime: '2025-10-10T10:00:00Z',
          userPrincipalName: 'user1@example.com',
        },
        {
          id: 'device-2',
          deviceName: 'Android-002',
          operatingSystem: 'Android',
          osVersion: '14',
          manufacturer: 'Samsung',
          model: 'Galaxy S24',
          serialNumber: 'SN002',
          complianceState: 'noncompliant',
          managedDeviceOwnerType: 'personal',
          lastSyncDateTime: '2025-10-09T15:30:00Z',
          userPrincipalName: 'user2@example.com',
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: {
          value: mockDevices,
        },
      });

      const extractedData = await connector.extractResource('devices');

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('device-1');
      expect(extractedData[0].source_type).toBe('intune_device');
      expect(extractedData[0].data.deviceName).toBe('iPhone-001');
      expect(mockGraphInstance.get).toHaveBeenCalledWith('/deviceManagement/managedDevices');
    });

    it('should filter devices by compliance state', async () => {
      const mockDevices = [
        {
          id: 'device-1',
          deviceName: 'iPhone-001',
          complianceState: 'compliant',
          managedDeviceOwnerType: 'company',
        },
        {
          id: 'device-2',
          deviceName: 'Android-002',
          complianceState: 'noncompliant',
          managedDeviceOwnerType: 'personal',
        },
        {
          id: 'device-3',
          deviceName: 'iPad-003',
          complianceState: 'inGracePeriod',
          managedDeviceOwnerType: 'company',
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockDevices },
      });

      const extractedData = await connector.extractResource('devices', {
        compliance_state: ['compliant', 'inGracePeriod'],
      });

      expect(extractedData).toHaveLength(2);
      expect(extractedData.map(d => d.external_id)).toEqual(['device-1', 'device-3']);
    });

    it('should filter devices by ownership type', async () => {
      const mockDevices = [
        {
          id: 'device-1',
          complianceState: 'compliant',
          managedDeviceOwnerType: 'company',
        },
        {
          id: 'device-2',
          complianceState: 'compliant',
          managedDeviceOwnerType: 'personal',
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockDevices },
      });

      const extractedData = await connector.extractResource('devices', {
        ownership: ['company'],
      });

      expect(extractedData).toHaveLength(1);
      expect(extractedData[0].external_id).toBe('device-1');
    });

    it('should handle pagination for devices', async () => {
      const batch1 = [
        { id: 'device-1', deviceName: 'Device-1' },
        { id: 'device-2', deviceName: 'Device-2' },
      ];

      const batch2 = [
        { id: 'device-3', deviceName: 'Device-3' },
      ];

      mockGraphInstance.get
        .mockResolvedValueOnce({
          data: {
            value: batch1,
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$skip=2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            value: batch2,
          },
        });

      const extractedData = await connector.extractResource('devices');

      expect(extractedData).toHaveLength(3);
      expect(mockGraphInstance.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('Extract Applications', () => {
    it('should extract managed applications', async () => {
      const mockApps = [
        {
          id: 'app-1',
          displayName: 'Microsoft Teams',
          publisher: 'Microsoft',
          '@odata.type': '#microsoft.graph.iosStoreApp',
          isFeatured: true,
          isAssigned: true,
        },
        {
          id: 'app-2',
          displayName: 'Slack',
          publisher: 'Slack Technologies',
          '@odata.type': '#microsoft.graph.androidStoreApp',
          isFeatured: false,
          isAssigned: true,
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockApps },
      });

      const extractedData = await connector.extractResource('applications');

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('app-1');
      expect(extractedData[0].source_type).toBe('intune_app');
      expect(mockGraphInstance.get).toHaveBeenCalledWith('/deviceAppManagement/mobileApps');
    });

    it('should filter applications by platform', async () => {
      const mockApps = [
        {
          id: 'app-1',
          displayName: 'iOS App',
          '@odata.type': '#microsoft.graph.iosStoreApp',
        },
        {
          id: 'app-2',
          displayName: 'Android App',
          '@odata.type': '#microsoft.graph.androidStoreApp',
        },
        {
          id: 'app-3',
          displayName: 'Windows App',
          '@odata.type': '#microsoft.graph.win32LobApp',
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockApps },
      });

      const extractedData = await connector.extractResource('applications', {
        platform: ['iOS', 'Android'],
      });

      expect(extractedData).toHaveLength(2);
      expect(extractedData.map(d => d.external_id)).toEqual(['app-1', 'app-2']);
    });
  });

  describe('Extract Compliance Policies', () => {
    it('should extract compliance policies', async () => {
      const mockPolicies = [
        {
          id: 'policy-1',
          displayName: 'iOS Compliance Policy',
          description: 'Compliance requirements for iOS devices',
          '@odata.type': '#microsoft.graph.iosCompliancePolicy',
          version: 1,
        },
        {
          id: 'policy-2',
          displayName: 'Android Compliance Policy',
          description: 'Compliance requirements for Android devices',
          '@odata.type': '#microsoft.graph.androidCompliancePolicy',
          version: 2,
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockPolicies },
      });

      const extractedData = await connector.extractResource('compliance_policies');

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('policy-1');
      expect(extractedData[0].source_type).toBe('intune_compliance_policy');
      expect(mockGraphInstance.get).toHaveBeenCalledWith(
        '/deviceManagement/deviceCompliancePolicies'
      );
    });
  });

  describe('Extract Configuration Profiles', () => {
    it('should extract configuration profiles', async () => {
      const mockProfiles = [
        {
          id: 'config-1',
          displayName: 'iOS Device Restrictions',
          description: 'Restricts certain iOS device features',
          '@odata.type': '#microsoft.graph.iosDeviceRestrictionsConfiguration',
          version: 1,
        },
        {
          id: 'config-2',
          displayName: 'Windows Security Baseline',
          description: 'Security baseline for Windows devices',
          '@odata.type': '#microsoft.graph.windowsSecurityBaselineConfiguration',
          version: 3,
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockProfiles },
      });

      const extractedData = await connector.extractResource('configuration_profiles');

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('config-1');
      expect(extractedData[0].source_type).toBe('intune_config_profile');
      expect(mockGraphInstance.get).toHaveBeenCalledWith(
        '/deviceManagement/deviceConfigurations'
      );
    });
  });

  describe('Extract Users', () => {
    it('should extract users', async () => {
      const mockUsers = [
        {
          id: 'user-1',
          userPrincipalName: 'user1@example.com',
          displayName: 'John Doe',
          mail: 'john.doe@example.com',
          jobTitle: 'Engineer',
          department: 'IT',
          accountEnabled: true,
        },
        {
          id: 'user-2',
          userPrincipalName: 'user2@example.com',
          displayName: 'Jane Smith',
          mail: 'jane.smith@example.com',
          jobTitle: 'Manager',
          department: 'Sales',
          accountEnabled: true,
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockUsers },
      });

      const extractedData = await connector.extractResource('users');

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('user-1');
      expect(extractedData[0].source_type).toBe('intune_user');
      expect(mockGraphInstance.get).toHaveBeenCalledWith('/users');
    });

    it('should filter to users with devices', async () => {
      const mockUsers = [
        {
          id: 'user-1',
          userPrincipalName: 'user1@example.com',
          displayName: 'John Doe',
          registeredDevices: [{ id: 'device-1' }],
        },
        {
          id: 'user-2',
          userPrincipalName: 'user2@example.com',
          displayName: 'Jane Smith',
          registeredDevices: [],
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockUsers },
      });

      const extractedData = await connector.extractResource('users', {
        has_devices: true,
      });

      expect(extractedData).toHaveLength(1);
      expect(extractedData[0].external_id).toBe('user-1');
    });
  });

  describe('Transform Resources', () => {
    it('should transform device with device-specific attributes', async () => {
      const deviceData = {
        id: 'device-1',
        deviceName: 'iPhone-001',
        operatingSystem: 'iOS',
        osVersion: '17.0',
        manufacturer: 'Apple',
        model: 'iPhone 15',
        serialNumber: 'SN001',
        imei: '123456789012345',
        complianceState: 'compliant',
        managedDeviceOwnerType: 'company',
        lastSyncDateTime: '2025-10-10T10:00:00Z',
        userPrincipalName: 'user1@example.com',
        isEncrypted: true,
        isSupervised: true,
      };

      const transformedCI = await connector.transformResource('devices', deviceData);

      expect(transformedCI.ci_type).toBe('mobile-device');
      expect(transformedCI.name).toBe('iPhone-001');
      expect(transformedCI.status).toBe('active'); // compliant maps to active
      expect(transformedCI.attributes.operating_system).toBe('iOS');
      expect(transformedCI.attributes.compliance_state).toBe('compliant');
      expect(transformedCI.attributes.ownership_type).toBe('company');
      expect(transformedCI.confidence_score).toBe(95);
      expect(transformedCI.source).toBe('intune');
    });

    it('should transform Windows device as virtual-machine', async () => {
      const deviceData = {
        id: 'device-2',
        deviceName: 'LAPTOP-001',
        operatingSystem: 'Windows',
        osVersion: '11',
        manufacturer: 'Dell',
        model: 'Latitude 7400',
        serialNumber: 'SN002',
        complianceState: 'compliant',
      };

      const transformedCI = await connector.transformResource('devices', deviceData);

      expect(transformedCI.ci_type).toBe('virtual-machine'); // Windows treated as VM
    });

    it('should transform application with app-specific attributes', async () => {
      const appData = {
        id: 'app-1',
        displayName: 'Microsoft Teams',
        description: 'Team collaboration app',
        publisher: 'Microsoft',
        '@odata.type': '#microsoft.graph.iosStoreApp',
        isFeatured: true,
        isAssigned: true,
        bundleId: 'com.microsoft.teams',
      };

      const transformedCI = await connector.transformResource('applications', appData);

      expect(transformedCI.ci_type).toBe('application');
      expect(transformedCI.name).toBe('Microsoft Teams');
      expect(transformedCI.attributes.publisher).toBe('Microsoft');
      expect(transformedCI.attributes.platform).toBe('iOS');
      expect(transformedCI.confidence_score).toBe(90);
    });

    it('should transform compliance policy', async () => {
      const policyData = {
        id: 'policy-1',
        displayName: 'iOS Compliance Policy',
        description: 'Compliance requirements for iOS devices',
        '@odata.type': '#microsoft.graph.iosCompliancePolicy',
        version: 1,
        scheduledActionsForRule: [{ id: 'action-1' }],
      };

      const transformedCI = await connector.transformResource('compliance_policies', policyData);

      expect(transformedCI.ci_type).toBe('policy');
      expect(transformedCI.name).toBe('iOS Compliance Policy');
      expect(transformedCI.attributes.platform).toBe('iOS');
      expect(transformedCI.attributes.scheduled_actions_count).toBe(1);
      expect(transformedCI.confidence_score).toBe(100);
    });

    it('should transform configuration profile', async () => {
      const configData = {
        id: 'config-1',
        displayName: 'iOS Device Restrictions',
        description: 'Restricts certain iOS device features',
        '@odata.type': '#microsoft.graph.iosDeviceRestrictionsConfiguration',
        version: 2,
      };

      const transformedCI = await connector.transformResource('configuration_profiles', configData);

      expect(transformedCI.ci_type).toBe('configuration');
      expect(transformedCI.name).toBe('iOS Device Restrictions');
      expect(transformedCI.attributes.platform).toBe('iOS');
      expect(transformedCI.attributes.version).toBe(2);
      expect(transformedCI.confidence_score).toBe(100);
    });

    it('should transform user', async () => {
      const userData = {
        id: 'user-1',
        userPrincipalName: 'john.doe@example.com',
        displayName: 'John Doe',
        mail: 'john.doe@example.com',
        jobTitle: 'Engineer',
        department: 'IT',
        accountEnabled: true,
        registeredDevices: [{ id: 'device-1' }, { id: 'device-2' }],
      };

      const transformedCI = await connector.transformResource('users', userData);

      expect(transformedCI.ci_type).toBe('user');
      expect(transformedCI.name).toBe('John Doe');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.attributes.user_principal_name).toBe('john.doe@example.com');
      expect(transformedCI.attributes.registered_devices_count).toBe(2);
      expect(transformedCI.confidence_score).toBe(100);
    });

    it('should map device compliance states to CMDB status', async () => {
      const testCases = [
        { complianceState: 'compliant', expectedStatus: 'active' },
        { complianceState: 'noncompliant', expectedStatus: 'inactive' },
        { complianceState: 'conflict', expectedStatus: 'maintenance' },
        { complianceState: 'inGracePeriod', expectedStatus: 'active' },
        { complianceState: 'unknown', expectedStatus: 'active' },
      ];

      for (const testCase of testCases) {
        const deviceData = {
          id: 'test-device',
          deviceName: 'Test Device',
          complianceState: testCase.complianceState,
        };

        const transformedCI = await connector.transformResource('devices', deviceData);
        expect(transformedCI.status).toBe(testCase.expectedStatus);
      }
    });
  });

  describe('Extract Relationships', () => {
    it('should extract device-to-user relationships', async () => {
      const mockDevices = [
        {
          id: 'device-1',
          userId: 'user-1',
          userPrincipalName: 'user1@example.com',
        },
        {
          id: 'device-2',
          userId: 'user-2',
          userPrincipalName: 'user2@example.com',
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockDevices },
      });

      const relationships = await connector.extractRelationships();

      expect(relationships.length).toBeGreaterThanOrEqual(2);

      const deviceUserRels = relationships.filter(r => r.relationship_type === 'ASSIGNED_TO');
      expect(deviceUserRels).toHaveLength(2);
      expect(deviceUserRels[0].source_external_id).toBe('device-1');
      expect(deviceUserRels[0].target_external_id).toBe('user-1');
    });

    it('should extract compliance policy relationships', async () => {
      mockGraphInstance.get
        .mockResolvedValueOnce({
          data: {
            value: [{ id: 'device-1' }],
          },
        })
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'policy-1',
                displayName: 'Test Policy',
                assignments: [
                  {
                    id: 'assignment-1',
                    target: {
                      '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget',
                      groupId: 'group-1',
                    },
                  },
                ],
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: { value: [] },
        });

      const relationships = await connector.extractRelationships();

      const policyRels = relationships.filter(r => r.relationship_type === 'APPLIES_TO');
      expect(policyRels.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown resource', async () => {
      await expect(
        connector.extractResource('invalid_resource')
      ).rejects.toThrow('Unknown resource: invalid_resource');
    });

    it('should handle OAuth token failure gracefully', async () => {
      mockAuthInstance.post.mockRejectedValue({
        message: 'Invalid client credentials',
        response: {
          data: { error: 'invalid_client' },
        },
      });

      await expect(connector.initialize()).rejects.toThrow('OAuth authentication failed');
    });

    it('should handle API errors during extraction', async () => {
      mockGraphInstance.get.mockRejectedValue({
        message: 'Unauthorized',
        response: {
          status: 401,
          data: { error: 'invalid_token' },
        },
      });

      await expect(connector.extractResource('devices')).rejects.toThrow();
    });
  });

  describe('Resource Configuration', () => {
    it('should use resource-specific configuration for devices', async () => {
      const configWithResources: ConnectorConfiguration = {
        ...baseConfig,
        enabled_resources: ['devices'],
        resource_configs: {
          devices: {
            compliance_state: ['compliant'],
            ownership: ['company'],
            last_sync_days: 7,
          },
        },
      };

      const customConnector = new IntuneConnector(configWithResources);

      // Mock devices response
      const mockDevices = [
        {
          id: 'device-1',
          deviceName: 'iPhone-001',
          complianceState: 'compliant',
          managedDeviceOwnerType: 'company',
          lastSyncDateTime: new Date().toISOString(),
        },
        {
          id: 'device-2',
          deviceName: 'Android-002',
          complianceState: 'noncompliant',
          managedDeviceOwnerType: 'personal',
          lastSyncDateTime: new Date().toISOString(),
        },
      ];

      mockGraphInstance.get.mockResolvedValue({
        data: { value: mockDevices },
      });

      const extractedData = await customConnector.extractResource(
        'devices',
        configWithResources.resource_configs!.devices
      );

      // Should filter to only compliant company devices
      expect(extractedData).toHaveLength(1);
      expect(extractedData[0].external_id).toBe('device-1');
    });
  });

  describe('Platform Detection', () => {
    it('should correctly detect platform from OData type', async () => {
      const testCases = [
        { odataType: '#microsoft.graph.iosStoreApp', expectedPlatform: 'iOS' },
        { odataType: '#microsoft.graph.androidStoreApp', expectedPlatform: 'Android' },
        { odataType: '#microsoft.graph.win32LobApp', expectedPlatform: 'Windows' },
        { odataType: '#microsoft.graph.macOSLobApp', expectedPlatform: 'macOS' },
        { odataType: null, expectedPlatform: 'Unknown' },
      ];

      for (const testCase of testCases) {
        const appData = {
          id: 'test-app',
          displayName: 'Test App',
          '@odata.type': testCase.odataType,
        };

        const transformedCI = await connector.transformResource('applications', appData);
        expect(transformedCI.attributes.platform).toBe(testCase.expectedPlatform);
      }
    });
  });

  describe('Sensitive failure output', () => {
    it('does not expose OAuth error payloads or request headers', async () => {
      const secret = 'INTUNE_AUTH_SENTINEL';
      const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
      mockAuthInstance.post.mockRejectedValueOnce({
        message: secret,
        response: { status: 401, data: { nested: { token: secret } } },
        config: { headers: { Authorization: secret } },
      });

      try {
        await expect(connector.initialize()).rejects.toMatchObject({
          message: 'OAuth authentication failed',
        });
        expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(log.mock.calls)).toContain('Intune access token');
      } finally {
        log.mockRestore();
      }
    });

    it('does not expose a configured secret, next-page URL or Axios extraction failure', async () => {
      const secret = 'INTUNE_EXTRACT_SENTINEL';
      const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      mockGraphInstance.get.mockRejectedValueOnce({
        message: secret,
        response: { data: { nested: { token: secret } } },
        config: { headers: { Authorization: secret }, url: `https://${secret}/page` },
      });

      try {
        await expect(connector.extractResource('devices', { secret })).rejects.toMatchObject({
          message: 'Connector extraction failed',
        });
        expect(JSON.stringify([log.mock.calls, info.mock.calls])).not.toContain(secret);
        expect(JSON.stringify(log.mock.calls)).toContain('Intune resource extraction failed');
      } finally {
        log.mockRestore();
        info.mockRestore();
      }
    });
  });

  describe('Sensitive relationship failures', () => {
    it('keeps device identifiers and provider error bodies out of warnings', async () => {
      const secret = 'INTUNE_RELATIONSHIP_SENTINEL';
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      mockGraphInstance.get
        .mockResolvedValueOnce({ data: { value: [{ id: secret }] } })
        .mockRejectedValueOnce({
          message: secret,
          response: { data: { token: secret } },
          config: { headers: { Authorization: secret } },
        })
        .mockResolvedValueOnce({ data: { value: [] } })
        .mockResolvedValueOnce({ data: { value: [] } });

      try {
        await connector.extractRelationships();
        expect(JSON.stringify(warn.mock.calls)).toContain('Failed to get detected apps for device');
        expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
