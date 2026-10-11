// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CrowdStrike Falcon Connector Tests (v1.0)
 * Tests for multi-resource connector functionality
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import axios from 'axios';
import CrowdStrikeConnector from './index';
import { ConnectorConfiguration } from '@cmdb/integration-framework';
import { logger } from '@cmdb/common';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as any;

describe('CrowdStrikeConnector - Multi-Resource Tests', () => {
  let connector: CrowdStrikeConnector;
  let mockAxiosInstance: any;
  let mockAuthPost: any;

  const baseConfig: ConnectorConfiguration = {
    name: 'Test CrowdStrike Connector',
    type: 'crowdstrike',
    enabled: true,
    connection: {
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      base_url: 'https://api.crowdstrike.com',
    },
  };

  beforeEach(() => {
    // Create mock axios instance
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: {
        request: {
          use: vi.fn((fn) => {
            // Store the interceptor for later use
            mockAxiosInstance._requestInterceptor = fn;
            return 0;
          }),
        },
        response: {
          use: vi.fn(),
        },
      },
    };

    // Mock axios.create to return our mock instance
    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    // Mock axios.post for OAuth token endpoint
    mockAuthPost = vi.fn().mockResolvedValue({
      data: {
        access_token: 'test_access_token',
        expires_in: 3600,
        token_type: 'bearer',
      },
    });
    mockedAxios.post = mockAuthPost;

    connector = new CrowdStrikeConnector(baseConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize with correct metadata', () => {
      expect(connector).toBeDefined();
      const resources = connector.getAvailableResources();
      expect(resources).toHaveLength(5);
      expect(resources.map(r => r.id)).toEqual([
        'devices',
        'detections',
        'vulnerabilities',
        'incidents',
        'relationships',
      ]);
    });

    it('should use default enabled resources', () => {
      const enabledResources = connector.getEnabledResources();
      expect(enabledResources).toEqual([
        'devices',
        'detections',
        'vulnerabilities',
        'relationships',
      ]);
    });

    it('should respect custom enabled resources', () => {
      const customConfig: ConnectorConfiguration = {
        ...baseConfig,
        enabled_resources: ['devices', 'detections'],
      };
      const customConnector = new CrowdStrikeConnector(customConfig);
      expect(customConnector.getEnabledResources()).toEqual(['devices', 'detections']);
    });

    it('should authenticate on initialization', async () => {
      await connector.initialize();
      expect(mockAuthPost).toHaveBeenCalledWith(
        'https://api.crowdstrike.com/oauth2/token',
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        })
      );
    });
  });

  describe('Authentication', () => {
    it('should obtain OAuth access token', async () => {
      await connector.initialize();
      expect(mockAuthPost).toHaveBeenCalled();
    });

    it('should handle authentication failure', async () => {
      mockAuthPost.mockRejectedValue(new Error('Invalid credentials'));
      await expect(connector.initialize()).rejects.toThrow('CrowdStrike authentication failed');
    });
  });

  describe('Test Connection', () => {
    it('should successfully test connection', async () => {
      await connector.initialize();
      mockAxiosInstance.get.mockResolvedValue({
        data: { resources: ['device-1'] },
      });

      const result = await connector.testConnection();
      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully connected');
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/devices/queries/devices/v1',
        expect.objectContaining({
          params: { limit: 1 },
        })
      );
    });

    it('should handle connection failure', async () => {
      await connector.initialize();
      mockAxiosInstance.get.mockRejectedValue(new Error('Connection refused'));

      const result = await connector.testConnection();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
    });
  });

  describe('Extract Devices', () => {
    beforeEach(async () => {
      await connector.initialize();
    });

    it('should extract devices with pagination', async () => {
      const mockDeviceIds = ['device-1', 'device-2', 'device-3'];
      const mockDevices = [
        {
          device_id: 'device-1',
          hostname: 'web-server-01',
          platform_name: 'Linux',
          os_version: 'Ubuntu 22.04',
          mac_address: '00:11:22:33:44:55',
          local_ip: '10.0.1.10',
          agent_version: '7.05.15406',
          last_seen: '2024-01-15T10:30:00Z',
          first_seen: '2023-06-01T08:00:00Z',
          status: 'normal',
          serial_number: 'SN001',
        },
        {
          device_id: 'device-2',
          hostname: 'web-server-02',
          platform_name: 'Windows',
          os_version: 'Windows Server 2022',
          local_ip: '10.0.1.11',
          agent_version: '7.05.15406',
          last_seen: '2024-01-15T10:25:00Z',
          first_seen: '2023-07-10T09:00:00Z',
          status: 'normal',
        },
        {
          device_id: 'device-3',
          hostname: 'mac-workstation-01',
          platform_name: 'Mac',
          os_version: 'macOS 14.2',
          local_ip: '10.0.2.50',
          agent_version: '7.05.15406',
          last_seen: '2024-01-15T10:20:00Z',
          first_seen: '2023-08-15T10:00:00Z',
          status: 'normal',
        },
      ];

      // Mock device IDs query
      mockAxiosInstance.get.mockResolvedValue({
        data: { resources: mockDeviceIds },
      });

      // Mock device details query
      mockAxiosInstance.post.mockResolvedValue({
        data: { resources: mockDevices },
      });

      const extractedData = await connector.extractResource('devices');

      expect(extractedData).toHaveLength(3);
      expect(extractedData[0].external_id).toBe('device-1');
      expect(extractedData[0].source_type).toBe('crowdstrike');
      expect(extractedData[0].data.hostname).toBe('web-server-01');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/devices/queries/devices/v1',
        expect.objectContaining({
          params: expect.objectContaining({
            limit: 500,
            offset: 0,
          }),
        })
      );

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/devices/entities/devices/v2',
        { ids: mockDeviceIds }
      );
    });

    it('should apply device filters', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: { resources: [] } });
      mockAxiosInstance.post.mockResolvedValue({ data: { resources: [] } });

      await connector.extractResource('devices', {
        status_filter: ['normal'],
        platform_filter: ['Linux'],
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/devices/queries/devices/v1',
        expect.objectContaining({
          params: expect.objectContaining({
            filter: expect.stringContaining('normal'),
          }),
        })
      );
    });
  });

  describe('Extract Detections', () => {
    beforeEach(async () => {
      await connector.initialize();
    });

    it('should extract detections with filters', async () => {
      const mockDetectionIds = ['det-1', 'det-2'];
      const mockDetections = [
        {
          detection_id: 'det-1',
          severity: 70,
          max_severity: 80,
          max_confidence: 90,
          status: 'new',
          tactic: 'Persistence',
          technique: 'Registry Run Keys',
          device: {
            device_id: 'device-1',
            hostname: 'web-server-01',
          },
          created_timestamp: '2024-01-15T09:00:00Z',
          behaviors: [{ behavior_id: 'beh-1' }],
        },
        {
          detection_id: 'det-2',
          severity: 90,
          max_severity: 95,
          max_confidence: 95,
          status: 'in_progress',
          tactic: 'Command and Control',
          technique: 'Web Service',
          device: {
            device_id: 'device-2',
            hostname: 'web-server-02',
          },
          created_timestamp: '2024-01-15T10:00:00Z',
          behaviors: [{ behavior_id: 'beh-2' }, { behavior_id: 'beh-3' }],
        },
      ];

      mockAxiosInstance.get.mockResolvedValue({
        data: { resources: mockDetectionIds },
      });

      mockAxiosInstance.post.mockResolvedValue({
        data: { resources: mockDetections },
      });

      const extractedData = await connector.extractResource('detections', {
        severity_filter: ['critical', 'high'],
        status_filter: ['new', 'in_progress'],
        days_back: 7,
      });

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('det-1');
      expect(extractedData[0].data.tactic).toBe('Persistence');
      expect(extractedData[1].data.max_confidence).toBe(95);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/detects/queries/detects/v1',
        expect.objectContaining({
          params: expect.objectContaining({
            limit: 1000,
            filter: expect.stringContaining('created_timestamp'),
          }),
        })
      );
    });
  });

  describe('Extract Vulnerabilities', () => {
    beforeEach(async () => {
      await connector.initialize();
    });

    it('should extract vulnerabilities from Spotlight', async () => {
      const mockVulnerabilities = [
        {
          id: 'vuln-1',
          cve: {
            id: 'CVE-2024-1234',
            description: 'Critical vulnerability in OpenSSL',
            base_score: 9.8,
            severity: 'critical',
            exploit_status: 1,
            exprt_rating: 'EXPLOITED_IN_THE_WILD',
          },
          aid: 'device-1',
          apps: [
            {
              product_name_version: 'OpenSSL 3.0.0',
              vendor: 'OpenSSL',
            },
          ],
          created_timestamp: '2024-01-10T12:00:00Z',
          updated_timestamp: '2024-01-15T08:00:00Z',
          status: 'open',
        },
        {
          id: 'vuln-2',
          cve: {
            id: 'CVE-2024-5678',
            description: 'High severity vulnerability in Apache',
            base_score: 7.5,
            severity: 'high',
            exploit_status: 2,
            exprt_rating: 'PUBLIC_POC',
          },
          aid: 'device-2',
          apps: [
            {
              product_name_version: 'Apache 2.4.50',
              vendor: 'Apache',
            },
          ],
          created_timestamp: '2024-01-12T14:00:00Z',
          updated_timestamp: '2024-01-14T10:00:00Z',
          status: 'open',
        },
      ];

      mockAxiosInstance.get.mockResolvedValue({
        data: { resources: mockVulnerabilities },
      });

      const extractedData = await connector.extractResource('vulnerabilities', {
        severity_filter: ['critical', 'high'],
      });

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('device-1-CVE-2024-1234');
      expect(extractedData[0].data.cve.base_score).toBe(9.8);
      expect(extractedData[1].data.cve.severity).toBe('high');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/spotlight/combined/vulnerabilities/v1',
        expect.objectContaining({
          params: expect.objectContaining({
            limit: 500,
          }),
        })
      );
    });
  });

  describe('Extract Incidents', () => {
    beforeEach(async () => {
      await connector.initialize();
    });

    it('should extract security incidents', async () => {
      const mockIncidentIds = ['inc-1', 'inc-2'];
      const mockIncidents = [
        {
          incident_id: 'inc-1',
          name: 'Ransomware Attack Detected',
          description: 'Potential ransomware activity detected on multiple hosts',
          status: 'in_progress',
          assigned_to: 'user-123',
          assigned_to_name: 'John Doe',
          severity: 90,
          tactics: ['Initial Access', 'Execution'],
          techniques: ['Phishing', 'User Execution'],
          hosts: [
            { device_id: 'device-1', hostname: 'web-server-01' },
            { device_id: 'device-2', hostname: 'web-server-02' },
          ],
          created: '2024-01-15T08:00:00Z',
          modified_timestamp: '2024-01-15T10:00:00Z',
          start: '2024-01-15T07:30:00Z',
        },
        {
          incident_id: 'inc-2',
          name: 'Suspicious Command Execution',
          description: 'Unusual command line activity detected',
          status: 'new',
          assigned_to: 'user-456',
          assigned_to_name: 'Jane Smith',
          severity: 70,
          tactics: ['Execution'],
          techniques: ['Command-Line Interface'],
          hosts: [{ device_id: 'device-3', hostname: 'mac-workstation-01' }],
          created: '2024-01-15T09:00:00Z',
          modified_timestamp: '2024-01-15T09:00:00Z',
          start: '2024-01-15T08:45:00Z',
        },
      ];

      mockAxiosInstance.get.mockResolvedValue({
        data: { resources: mockIncidentIds },
      });

      mockAxiosInstance.post.mockResolvedValue({
        data: { resources: mockIncidents },
      });

      const extractedData = await connector.extractResource('incidents', {
        status_filter: ['new', 'in_progress'],
        severity_filter: ['critical', 'high'],
        days_back: 30,
      });

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('inc-1');
      expect(extractedData[0].data.name).toBe('Ransomware Attack Detected');
      expect(extractedData[0].data.hosts).toHaveLength(2);
      expect(extractedData[1].data.severity).toBe(70);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/incidents/queries/incidents/v1',
        expect.objectContaining({
          params: expect.objectContaining({
            limit: 100,
            filter: expect.stringContaining('created'),
          }),
        })
      );
    });
  });

  describe('Transform Resources', () => {
    it('should transform device to CMDB CI', async () => {
      const deviceData = {
        device_id: 'device-1',
        hostname: 'web-server-01',
        platform_name: 'Linux',
        os_version: 'Ubuntu 22.04',
        mac_address: '00:11:22:33:44:55',
        local_ip: '10.0.1.10',
        external_ip: '203.0.113.10',
        agent_version: '7.05.15406',
        last_seen: '2024-01-15T10:30:00Z',
        first_seen: '2023-06-01T08:00:00Z',
        status: 'normal',
        product_type_desc: 'Server',
        system_manufacturer: 'Dell',
        system_product_name: 'PowerEdge R740',
        serial_number: 'SN001',
        tags: ['production', 'web-tier'],
      };

      const transformedCI = await connector.transformResource('devices', deviceData);

      expect(transformedCI.ci_type).toBe('server');
      expect(transformedCI.name).toBe('web-server-01');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.source).toBe('crowdstrike');
      expect(transformedCI.source_id).toBe('device-1');
      expect(transformedCI.confidence_score).toBe(95);
      expect(transformedCI.attributes.platform).toBe('Linux');
      expect(transformedCI.attributes.os_version).toBe('Ubuntu 22.04');
      expect(transformedCI.attributes.manufacturer).toBe('Dell');
      expect(transformedCI.attributes.tags).toEqual(['production', 'web-tier']);
    });

    it('should transform detection to CMDB CI', async () => {
      const detectionData = {
        detection_id: 'det-1',
        severity: 70,
        max_severity: 80,
        max_confidence: 90,
        status: 'new',
        tactic: 'Persistence',
        technique: 'Registry Run Keys',
        device: {
          device_id: 'device-1',
          hostname: 'web-server-01',
        },
        created_timestamp: '2024-01-15T09:00:00Z',
        behaviors: [{ behavior_id: 'beh-1' }],
      };

      const transformedCI = await connector.transformResource('detections', detectionData);

      expect(transformedCI.ci_type).toBe('detection');
      expect(transformedCI.name).toBe('Detection det-1');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.attributes.severity).toBe('high');
      expect(transformedCI.attributes.tactic).toBe('Persistence');
      expect(transformedCI.attributes.device_id).toBe('device-1');
      expect(transformedCI.attributes.hostname).toBe('web-server-01');
      expect(transformedCI.confidence_score).toBe(90);
    });

    it('should transform vulnerability to CMDB CI', async () => {
      const vulnData = {
        id: 'vuln-1',
        cve: {
          id: 'CVE-2024-1234',
          description: 'Critical vulnerability in OpenSSL',
          base_score: 9.8,
          severity: 'critical',
          exploit_status: 1,
          exprt_rating: 'EXPLOITED_IN_THE_WILD',
        },
        aid: 'device-1',
        apps: [
          {
            product_name_version: 'OpenSSL 3.0.0',
            vendor: 'OpenSSL',
          },
        ],
        created_timestamp: '2024-01-10T12:00:00Z',
        updated_timestamp: '2024-01-15T08:00:00Z',
        status: 'open',
      };

      const transformedCI = await connector.transformResource('vulnerabilities', vulnData);

      expect(transformedCI.ci_type).toBe('vulnerability');
      expect(transformedCI.name).toBe('CVE-2024-1234');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.attributes.cve_id).toBe('CVE-2024-1234');
      expect(transformedCI.attributes.severity).toBe('critical');
      expect(transformedCI.attributes.base_score).toBe(9.8);
      expect(transformedCI.attributes.device_id).toBe('device-1');
      expect(transformedCI.confidence_score).toBe(90);
    });

    it('should transform incident to CMDB CI', async () => {
      const incidentData = {
        incident_id: 'inc-1',
        name: 'Ransomware Attack Detected',
        description: 'Potential ransomware activity detected on multiple hosts',
        status: 'in_progress',
        assigned_to: 'user-123',
        assigned_to_name: 'John Doe',
        severity: 90,
        tactics: ['Initial Access', 'Execution'],
        techniques: ['Phishing', 'User Execution'],
        hosts: [
          { device_id: 'device-1', hostname: 'web-server-01' },
          { device_id: 'device-2', hostname: 'web-server-02' },
        ],
        created: '2024-01-15T08:00:00Z',
        modified_timestamp: '2024-01-15T10:00:00Z',
        start: '2024-01-15T07:30:00Z',
      };

      const transformedCI = await connector.transformResource('incidents', incidentData);

      expect(transformedCI.ci_type).toBe('incident');
      expect(transformedCI.name).toBe('Ransomware Attack Detected');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.attributes.severity).toBe('critical');
      expect(transformedCI.attributes.assigned_to_name).toBe('John Doe');
      expect(transformedCI.attributes.hosts).toHaveLength(2);
      expect(transformedCI.confidence_score).toBe(85);
    });
  });

  describe('Status Mapping', () => {
    it('should map device status correctly', async () => {
      const testCases = [
        { status: 'normal', expected: 'active' },
        { status: 'containment_pending', expected: 'maintenance' },
        { status: 'contained', expected: 'inactive' },
        { status: 'lift_containment_pending', expected: 'maintenance' },
      ];

      for (const testCase of testCases) {
        const deviceData = {
          device_id: 'device-1',
          hostname: 'test-host',
          platform_name: 'Linux',
          os_version: 'Ubuntu 22.04',
          agent_version: '7.05.15406',
          last_seen: '2024-01-15T10:30:00Z',
          first_seen: '2023-06-01T08:00:00Z',
          status: testCase.status,
        };

        const transformedCI = await connector.transformResource('devices', deviceData);
        expect(transformedCI.status).toBe(testCase.expected);
      }
    });

    it('should map detection status correctly', async () => {
      const testCases = [
        { status: 'new', expected: 'active' },
        { status: 'in_progress', expected: 'active' },
        { status: 'true_positive', expected: 'inactive' },
        { status: 'false_positive', expected: 'inactive' },
        { status: 'closed', expected: 'inactive' },
        { status: 'reopened', expected: 'active' },
      ];

      for (const testCase of testCases) {
        const detectionData = {
          detection_id: 'det-1',
          severity: 50,
          max_severity: 60,
          max_confidence: 80,
          status: testCase.status,
          tactic: 'Test',
          technique: 'Test',
          device: { device_id: 'device-1', hostname: 'test-host' },
          created_timestamp: '2024-01-15T09:00:00Z',
        };

        const transformedCI = await connector.transformResource('detections', detectionData);
        expect(transformedCI.status).toBe(testCase.expected);
      }
    });
  });

  describe('Severity Mapping', () => {
    it('should map numeric severity to string correctly', async () => {
      const testCases = [
        { severity: 90, expected: 'critical' },
        { severity: 70, expected: 'critical' },
        { severity: 60, expected: 'high' },
        { severity: 50, expected: 'high' },
        { severity: 40, expected: 'medium' },
        { severity: 30, expected: 'medium' },
        { severity: 20, expected: 'low' },
        { severity: 10, expected: 'low' },
        { severity: 5, expected: 'informational' },
      ];

      for (const testCase of testCases) {
        const detectionData = {
          detection_id: 'det-1',
          severity: testCase.severity,
          max_severity: testCase.severity,
          max_confidence: 80,
          status: 'new',
          tactic: 'Test',
          technique: 'Test',
          device: { device_id: 'device-1', hostname: 'test-host' },
          created_timestamp: '2024-01-15T09:00:00Z',
        };

        const transformedCI = await connector.transformResource('detections', detectionData);
        expect(transformedCI.attributes.severity).toBe(testCase.expected);
      }
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown resource', async () => {
      await connector.initialize();
      await expect(
        connector.extractResource('invalid_resource')
      ).rejects.toThrow('Unknown resource: invalid_resource');
    });

    it('should throw error for unsupported transformation', async () => {
      await expect(
        connector.transformResource('invalid_resource', {})
      ).rejects.toThrow('Unknown resource: invalid_resource');
    });
  });

  describe('Resource Configuration', () => {
    it('should use global connection config for devices', async () => {
      const configWithGlobal: ConnectorConfiguration = {
        ...baseConfig,
        connection: {
          ...baseConfig.connection,
          devices: {
            status: ['normal'],
            platform: ['Linux'],
          },
        },
      };

      const customConnector = new CrowdStrikeConnector(configWithGlobal);
      await customConnector.initialize();

      mockAxiosInstance.get.mockResolvedValue({ data: { resources: [] } });
      mockAxiosInstance.post.mockResolvedValue({ data: { resources: [] } });

      await customConnector.extractResource('devices');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/devices/queries/devices/v1',
        expect.objectContaining({
          params: expect.objectContaining({
            filter: expect.stringContaining('normal'),
          }),
        })
      );
    });
  });

  describe('Sensitive failure output', () => {
    it('keeps OAuth response bodies and Axios request headers out of logs and errors', async () => {
      const secret = 'CROWDSTRIKE_AUTH_SENTINEL';
      const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
      mockAuthPost.mockRejectedValueOnce({
        message: secret,
        response: { status: 401, data: { access_token: secret } },
        config: { headers: { Authorization: secret } },
      });

      try {
        await expect(connector.initialize()).rejects.toMatchObject({
          message: 'CrowdStrike authentication failed',
        });
        expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(log.mock.calls)).toContain('CrowdStrike authentication failed');
      } finally {
        log.mockRestore();
      }
    });

    it('keeps resource configuration and extraction errors out of logger metadata', async () => {
      const secret = 'CROWDSTRIKE_EXTRACT_SENTINEL';
      const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      await connector.initialize();
      mockAxiosInstance.get.mockRejectedValueOnce({
        message: secret,
        response: { data: { nested: { token: secret } } },
        config: { headers: { Authorization: secret } },
      });

      try {
        await expect(connector.extractResource('devices', { filter: secret })).rejects.toMatchObject({
          message: 'Connector extraction failed',
        });
        expect(JSON.stringify([log.mock.calls, info.mock.calls])).not.toContain(secret);
      } finally {
        log.mockRestore();
        info.mockRestore();
      }
    });
  });
});
