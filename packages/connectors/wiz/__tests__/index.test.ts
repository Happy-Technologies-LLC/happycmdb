// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiz Cloud Security Connector Tests (v1.0)
 * Tests for multi-resource connector functionality
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import axios from 'axios';
import WizConnector from '../src/index';
import { ConnectorConfiguration } from '@cmdb/integration-framework';
import { logger } from '@cmdb/common';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as any;

describe('WizConnector - Multi-Resource Tests', () => {
  let connector: WizConnector;
  let mockAxiosInstance: any;
  let mockAuthPost: any;

  const baseConfig: ConnectorConfiguration = {
    name: 'Test Wiz Connector',
    type: 'wiz',
    enabled: true,
    connection: {
      auth_url: 'https://auth.app.wiz.io/oauth/token',
      client_id: 'test_client_id',
      client_secret: 'test_client_secret',
      api_url: 'https://api.us1.app.wiz.io/graphql',
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
        token_type: 'Bearer',
        expires_in: 3600,
      },
    });
    mockedAxios.post = mockAuthPost;

    connector = new WizConnector(baseConfig);
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
        'cloud_resources',
        'vulnerabilities',
        'issues',
        'identities',
        'relationships',
      ]);
    });

    it('should use default enabled resources', () => {
      const enabledResources = connector.getEnabledResources();
      expect(enabledResources).toEqual([
        'cloud_resources',
        'vulnerabilities',
        'issues',
        'identities',
        'relationships',
      ]);
    });

    it('should respect custom enabled resources', () => {
      const customConfig: ConnectorConfiguration = {
        ...baseConfig,
        enabled_resources: ['cloud_resources', 'vulnerabilities'],
      };
      const customConnector = new WizConnector(customConfig);
      expect(customConnector.getEnabledResources()).toEqual(['cloud_resources', 'vulnerabilities']);
    });

    it('should authenticate on initialization', async () => {
      await connector.initialize();
      expect(mockAuthPost).toHaveBeenCalledWith(
        'https://auth.app.wiz.io/oauth/token',
        expect.objectContaining({
          grant_type: 'client_credentials',
          client_id: 'test_client_id',
          client_secret: 'test_client_secret',
          audience: 'wiz-api',
        }),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
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
      await expect(connector.initialize()).rejects.toThrow('Wiz authentication failed');
    });
  });

  describe('Test Connection', () => {
    it('should successfully test connection', async () => {
      await connector.initialize();
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          data: {
            graphSearch: {
              totalCount: 100,
            },
          },
        },
      });

      const result = await connector.testConnection();
      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully connected');
      expect(result.details?.total_resources).toBe(100);
    });

    it('should handle connection failure with GraphQL errors', async () => {
      await connector.initialize();
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          errors: [{ message: 'Unauthorized', path: ['graphSearch'] }],
        },
      });

      const result = await connector.testConnection();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection test failed');
    });

    it('should handle connection failure with exception', async () => {
      await connector.initialize();
      mockAxiosInstance.post.mockRejectedValue(new Error('Connection refused'));

      const result = await connector.testConnection();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
    });
  });

  describe('Extract Cloud Resources', () => {
    beforeEach(async () => {
      await connector.initialize();
    });

    it('should extract cloud resources with GraphQL pagination', async () => {
      const mockNodes = [
        {
          entities: [
            {
              id: 'resource-1',
              name: 'web-server-prod-01',
              type: 'VirtualMachine',
              properties: {
                cloudPlatform: 'AWS',
                cloudProviderURL: 'https://console.aws.amazon.com/ec2/...',
                region: 'us-east-1',
                status: 'Running',
                nativeType: 'AWS::EC2::Instance',
                providerUniqueId: 'i-1234567890abcdef0',
                tags: {
                  Environment: 'Production',
                  Application: 'WebServer',
                },
                createdAt: '2024-01-01T10:00:00Z',
              },
            },
          ],
        },
        {
          entities: [
            {
              id: 'resource-2',
              name: 'database-prod-01',
              type: 'Database',
              properties: {
                cloudPlatform: 'Azure',
                cloudProviderURL: 'https://portal.azure.com/...',
                region: 'eastus',
                status: 'Active',
                nativeType: 'Microsoft.Sql/servers/databases',
                providerUniqueId: '/subscriptions/...',
                tags: {
                  Environment: 'Production',
                  Application: 'Database',
                },
                createdAt: '2024-01-02T12:00:00Z',
              },
            },
          ],
        },
      ];

      mockAxiosInstance.post.mockResolvedValue({
        data: {
          data: {
            graphSearch: {
              nodes: mockNodes,
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              totalCount: 2,
            },
          },
        },
      });

      const extractedData = await connector.extractResource('cloud_resources');

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('resource-1');
      expect(extractedData[0].source_type).toBe('wiz');
      expect(extractedData[0].data.name).toBe('web-server-prod-01');
      expect(extractedData[0].data.cloudPlatform).toBe('AWS');
      expect(extractedData[1].data.cloudPlatform).toBe('Azure');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          query: expect.stringContaining('graphSearch'),
          variables: expect.objectContaining({
            first: 500,
          }),
        })
      );
    });

    it('should apply cloud provider filters', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          data: {
            graphSearch: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 0,
            },
          },
        },
      });

      await connector.extractResource('cloud_resources', {
        cloud_providers_filter: ['AWS', 'GCP'],
        max_results: 100,
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          variables: expect.objectContaining({
            first: 100,
            filters: expect.objectContaining({
              cloudPlatform: ['AWS', 'GCP'],
            }),
          }),
        })
      );
    });
  });

  describe('Extract Vulnerabilities', () => {
    beforeEach(async () => {
      await connector.initialize();
    });

    it('should extract vulnerabilities with GraphQL pagination', async () => {
      const mockVulnerabilities = [
        {
          id: 'vuln-1',
          name: 'CVE-2024-1234',
          detailedName: 'Critical OpenSSL Vulnerability',
          description: 'Critical vulnerability in OpenSSL affecting multiple versions',
          severity: 'CRITICAL',
          cvssScore: 9.8,
          vendorSeverity: 'Critical',
          cveId: 'CVE-2024-1234',
          exploitabilityScore: 3.9,
          hasExploit: true,
          status: 'OPEN',
          resolution: 'Upgrade to OpenSSL 3.0.13 or later',
          fixedVersion: '3.0.13',
          detectedAt: '2024-01-10T08:00:00Z',
          affectedResource: {
            id: 'resource-1',
            name: 'web-server-prod-01',
            type: 'VirtualMachine',
          },
          packages: [
            {
              name: 'openssl',
              version: '3.0.0',
              fixedVersion: '3.0.13',
            },
          ],
        },
        {
          id: 'vuln-2',
          name: 'CVE-2024-5678',
          detailedName: 'High Apache Vulnerability',
          description: 'High severity vulnerability in Apache HTTP Server',
          severity: 'HIGH',
          cvssScore: 7.5,
          vendorSeverity: 'High',
          cveId: 'CVE-2024-5678',
          exploitabilityScore: 3.9,
          hasExploit: false,
          status: 'IN_PROGRESS',
          resolution: 'Upgrade to Apache 2.4.58 or later',
          fixedVersion: '2.4.58',
          detectedAt: '2024-01-12T10:00:00Z',
          affectedResource: {
            id: 'resource-1',
            name: 'web-server-prod-01',
            type: 'VirtualMachine',
          },
          packages: [
            {
              name: 'apache2',
              version: '2.4.50',
              fixedVersion: '2.4.58',
            },
          ],
        },
      ];

      mockAxiosInstance.post.mockResolvedValue({
        data: {
          data: {
            vulnerabilities: {
              nodes: mockVulnerabilities,
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              totalCount: 2,
            },
          },
        },
      });

      const extractedData = await connector.extractResource('vulnerabilities', {
        severity_filter: ['CRITICAL', 'HIGH'],
        status_filter: ['OPEN', 'IN_PROGRESS'],
        has_exploit_only: false,
      });

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('vuln-1');
      expect(extractedData[0].data.cveId).toBe('CVE-2024-1234');
      expect(extractedData[0].data.severity).toBe('CRITICAL');
      expect(extractedData[0].data.hasExploit).toBe(true);
      expect(extractedData[1].data.severity).toBe('HIGH');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          query: expect.stringContaining('vulnerabilities'),
          variables: expect.objectContaining({
            first: 500,
            filters: expect.objectContaining({
              severity: ['CRITICAL', 'HIGH'],
              status: ['OPEN', 'IN_PROGRESS'],
            }),
          }),
        })
      );
    });

    it('should filter vulnerabilities by exploit status', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          data: {
            vulnerabilities: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 0,
            },
          },
        },
      });

      await connector.extractResource('vulnerabilities', {
        has_exploit_only: true,
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          variables: expect.objectContaining({
            filters: expect.objectContaining({
              hasExploit: true,
            }),
          }),
        })
      );
    });
  });

  describe('Extract Security Issues', () => {
    beforeEach(async () => {
      await connector.initialize();
    });

    it('should extract security issues with GraphQL pagination', async () => {
      const mockIssues = [
        {
          id: 'issue-1',
          type: 'CONFIGURATION',
          control: {
            id: 'control-1',
            name: 'S3 Bucket Public Access',
            description: 'S3 bucket allows public access',
            severity: 'CRITICAL',
          },
          severity: 'CRITICAL',
          status: 'OPEN',
          createdAt: '2024-01-15T08:00:00Z',
          updatedAt: '2024-01-15T08:00:00Z',
          dueAt: '2024-01-22T08:00:00Z',
          statusChangedAt: '2024-01-15T08:00:00Z',
          entitySnapshot: {
            id: 'resource-3',
            name: 'prod-data-bucket',
            type: 'Storage',
            cloudPlatform: 'AWS',
          },
          notes: 'Critical security issue requiring immediate attention',
        },
        {
          id: 'issue-2',
          type: 'COMPLIANCE',
          control: {
            id: 'control-2',
            name: 'VM Encryption Not Enabled',
            description: 'Virtual machine disk encryption is not enabled',
            severity: 'HIGH',
          },
          severity: 'HIGH',
          status: 'IN_PROGRESS',
          createdAt: '2024-01-14T10:00:00Z',
          updatedAt: '2024-01-16T12:00:00Z',
          dueAt: '2024-01-28T10:00:00Z',
          statusChangedAt: '2024-01-16T12:00:00Z',
          entitySnapshot: {
            id: 'resource-1',
            name: 'web-server-prod-01',
            type: 'VirtualMachine',
            cloudPlatform: 'AWS',
          },
        },
      ];

      mockAxiosInstance.post.mockResolvedValue({
        data: {
          data: {
            issues: {
              nodes: mockIssues,
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              totalCount: 2,
            },
          },
        },
      });

      const extractedData = await connector.extractResource('issues', {
        severity_filter: ['CRITICAL', 'HIGH'],
        status_filter: ['OPEN', 'IN_PROGRESS'],
      });

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('issue-1');
      expect(extractedData[0].data.control.name).toBe('S3 Bucket Public Access');
      expect(extractedData[0].data.severity).toBe('CRITICAL');
      expect(extractedData[1].data.control.name).toBe('VM Encryption Not Enabled');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          query: expect.stringContaining('issues'),
          variables: expect.objectContaining({
            first: 500,
            filters: expect.objectContaining({
              severity: ['CRITICAL', 'HIGH'],
              status: ['OPEN', 'IN_PROGRESS'],
            }),
          }),
        })
      );
    });
  });

  describe('Extract Cloud Identities', () => {
    beforeEach(async () => {
      await connector.initialize();
    });

    it('should extract cloud identities with GraphQL pagination', async () => {
      const mockNodes = [
        {
          entities: [
            {
              id: 'identity-1',
              name: 'admin@company.com',
              type: 'User',
              properties: {
                cloudPlatform: 'AWS',
                cloudProviderURL: 'https://console.aws.amazon.com/iam/...',
                status: 'Active',
                createdAt: '2023-06-01T08:00:00Z',
                lastActiveAt: '2024-01-15T10:30:00Z',
                isHuman: true,
                hasConsoleAccess: true,
                hasMFA: true,
                effectivePermissions: [
                  { action: 's3:*', resource: '*' },
                  { action: 'ec2:*', resource: '*' },
                ],
                tags: {
                  Department: 'Engineering',
                  Role: 'Administrator',
                },
              },
            },
          ],
        },
        {
          entities: [
            {
              id: 'identity-2',
              name: 'app-service-account',
              type: 'ServiceAccount',
              properties: {
                cloudPlatform: 'GCP',
                cloudProviderURL: 'https://console.cloud.google.com/iam/...',
                status: 'Active',
                createdAt: '2024-01-01T12:00:00Z',
                lastActiveAt: '2024-01-16T08:00:00Z',
                isHuman: false,
                hasConsoleAccess: false,
                hasMFA: false,
                effectivePermissions: [
                  { action: 'storage.objects.get', resource: 'gs://prod-bucket/*' },
                ],
              },
            },
          ],
        },
      ];

      mockAxiosInstance.post.mockResolvedValue({
        data: {
          data: {
            graphSearch: {
              nodes: mockNodes,
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              totalCount: 2,
            },
          },
        },
      });

      const extractedData = await connector.extractResource('identities', {
        cloud_providers_filter: ['AWS', 'GCP'],
        identity_types_filter: ['USER', 'SERVICE_ACCOUNT'],
      });

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('identity-1');
      expect(extractedData[0].data.name).toBe('admin@company.com');
      expect(extractedData[0].data.isHuman).toBe(true);
      expect(extractedData[0].data.hasMFA).toBe(true);
      expect(extractedData[1].data.name).toBe('app-service-account');
      expect(extractedData[1].data.isHuman).toBe(false);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          query: expect.stringContaining('graphSearch'),
          variables: expect.objectContaining({
            first: 500,
            filters: expect.objectContaining({
              cloudPlatform: ['AWS', 'GCP'],
              type: ['USER', 'SERVICE_ACCOUNT'],
            }),
          }),
        })
      );
    });
  });

  describe('Transform Resources', () => {
    it('should transform cloud resource to CMDB CI', async () => {
      const resourceData = {
        id: 'resource-1',
        name: 'web-server-prod-01',
        type: 'VirtualMachine',
        cloudPlatform: 'AWS',
        cloudProviderURL: 'https://console.aws.amazon.com/ec2/...',
        region: 'us-east-1',
        subscriptionId: 'sub-123',
        subscriptionName: 'Production',
        status: 'Running',
        tags: {
          Environment: 'Production',
          Application: 'WebServer',
        },
        createdAt: '2024-01-01T10:00:00Z',
        nativeType: 'AWS::EC2::Instance',
        providerUniqueId: 'i-1234567890abcdef0',
      };

      const transformedCI = await connector.transformResource('cloud_resources', resourceData);

      expect(transformedCI.ci_type).toBe('cloud-resource');
      expect(transformedCI.name).toBe('web-server-prod-01');
      expect(transformedCI.environment).toBe('production');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.source).toBe('wiz');
      expect(transformedCI.source_id).toBe('resource-1');
      expect(transformedCI.confidence_score).toBe(95);
      expect(transformedCI.attributes.cloud_platform).toBe('AWS');
      expect(transformedCI.attributes.region).toBe('us-east-1');
      expect(transformedCI.attributes.tags).toEqual({
        Environment: 'Production',
        Application: 'WebServer',
      });
    });

    it('should transform vulnerability to CMDB CI', async () => {
      const vulnData = {
        id: 'vuln-1',
        name: 'CVE-2024-1234',
        detailedName: 'Critical OpenSSL Vulnerability',
        description: 'Critical vulnerability in OpenSSL',
        severity: 'CRITICAL',
        cvssScore: 9.8,
        vendorSeverity: 'Critical',
        cveId: 'CVE-2024-1234',
        exploitabilityScore: 3.9,
        hasExploit: true,
        status: 'OPEN',
        resolution: 'Upgrade to OpenSSL 3.0.13 or later',
        fixedVersion: '3.0.13',
        detectedAt: '2024-01-10T08:00:00Z',
        affectedResource: {
          id: 'resource-1',
          name: 'web-server-prod-01',
          type: 'VirtualMachine',
        },
        packages: [
          {
            name: 'openssl',
            version: '3.0.0',
            fixedVersion: '3.0.13',
          },
        ],
      };

      const transformedCI = await connector.transformResource('vulnerabilities', vulnData);

      expect(transformedCI.ci_type).toBe('vulnerability');
      expect(transformedCI.name).toBe('CVE-2024-1234');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.attributes.severity).toBe('CRITICAL');
      expect(transformedCI.attributes.cvss_score).toBe(9.8);
      expect(transformedCI.attributes.has_exploit).toBe(true);
      expect(transformedCI.attributes.affected_resource_id).toBe('resource-1');
      expect(transformedCI.confidence_score).toBe(90);
    });

    it('should transform security issue to CMDB CI', async () => {
      const issueData = {
        id: 'issue-1',
        type: 'CONFIGURATION',
        control: {
          id: 'control-1',
          name: 'S3 Bucket Public Access',
          description: 'S3 bucket allows public access',
          severity: 'CRITICAL',
        },
        severity: 'CRITICAL',
        status: 'OPEN',
        createdAt: '2024-01-15T08:00:00Z',
        updatedAt: '2024-01-15T08:00:00Z',
        dueAt: '2024-01-22T08:00:00Z',
        statusChangedAt: '2024-01-15T08:00:00Z',
        entitySnapshot: {
          id: 'resource-3',
          name: 'prod-data-bucket',
          type: 'Storage',
          cloudPlatform: 'AWS',
        },
        notes: 'Critical security issue requiring immediate attention',
      };

      const transformedCI = await connector.transformResource('issues', issueData);

      expect(transformedCI.ci_type).toBe('security-issue');
      expect(transformedCI.name).toBe('S3 Bucket Public Access');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.attributes.severity).toBe('CRITICAL');
      expect(transformedCI.attributes.control_name).toBe('S3 Bucket Public Access');
      expect(transformedCI.attributes.entity_snapshot_id).toBe('resource-3');
      expect(transformedCI.confidence_score).toBe(85);
    });

    it('should transform identity to CMDB CI', async () => {
      const identityData = {
        id: 'identity-1',
        name: 'admin@company.com',
        type: 'User',
        cloudPlatform: 'AWS',
        cloudProviderURL: 'https://console.aws.amazon.com/iam/...',
        status: 'Active',
        createdAt: '2023-06-01T08:00:00Z',
        lastActiveAt: '2024-01-15T10:30:00Z',
        isHuman: true,
        hasConsoleAccess: true,
        hasMFA: true,
        effectivePermissions: [
          { action: 's3:*', resource: '*' },
          { action: 'ec2:*', resource: '*' },
        ],
        tags: {
          Department: 'Engineering',
          Role: 'Administrator',
        },
      };

      const transformedCI = await connector.transformResource('identities', identityData);

      expect(transformedCI.ci_type).toBe('identity');
      expect(transformedCI.name).toBe('admin@company.com');
      expect(transformedCI.status).toBe('active');
      expect(transformedCI.attributes.identity_type).toBe('User');
      expect(transformedCI.attributes.cloud_platform).toBe('AWS');
      expect(transformedCI.attributes.is_human).toBe(true);
      expect(transformedCI.attributes.has_mfa).toBe(true);
      expect(transformedCI.confidence_score).toBe(90);
    });
  });

  describe('Status Mapping', () => {
    it('should map resource status correctly', async () => {
      const testCases = [
        { status: 'Active', expected: 'active' },
        { status: 'Running', expected: 'active' },
        { status: 'Available', expected: 'active' },
        { status: 'Stopped', expected: 'inactive' },
        { status: 'Terminated', expected: 'decommissioned' },
        { status: 'Deleting', expected: 'decommissioned' },
      ];

      for (const testCase of testCases) {
        const resourceData = {
          id: 'resource-1',
          name: 'test-resource',
          type: 'VirtualMachine',
          cloudPlatform: 'AWS',
          cloudProviderURL: '',
          region: 'us-east-1',
          status: testCase.status,
          tags: {},
          createdAt: '2024-01-01T10:00:00Z',
          nativeType: 'AWS::EC2::Instance',
          providerUniqueId: 'i-123',
        };

        const transformedCI = await connector.transformResource('cloud_resources', resourceData);
        expect(transformedCI.status).toBe(testCase.expected);
      }
    });

    it('should map vulnerability status correctly', async () => {
      const testCases = [
        { status: 'OPEN', expected: 'active' },
        { status: 'IN_PROGRESS', expected: 'active' },
        { status: 'RESOLVED', expected: 'inactive' },
        { status: 'REJECTED', expected: 'inactive' },
      ];

      for (const testCase of testCases) {
        const vulnData = {
          id: 'vuln-1',
          name: 'CVE-2024-1234',
          detailedName: 'Test Vulnerability',
          description: 'Test',
          severity: 'HIGH',
          hasExploit: false,
          status: testCase.status,
          detectedAt: '2024-01-10T08:00:00Z',
        };

        const transformedCI = await connector.transformResource('vulnerabilities', vulnData);
        expect(transformedCI.status).toBe(testCase.expected);
      }
    });

    it('should map issue status correctly', async () => {
      const testCases = [
        { status: 'OPEN', expected: 'active' },
        { status: 'IN_PROGRESS', expected: 'active' },
        { status: 'RESOLVED', expected: 'inactive' },
        { status: 'REJECTED', expected: 'inactive' },
      ];

      for (const testCase of testCases) {
        const issueData = {
          id: 'issue-1',
          type: 'CONFIGURATION',
          control: {
            id: 'control-1',
            name: 'Test Control',
            description: 'Test',
            severity: 'HIGH',
          },
          severity: 'HIGH',
          status: testCase.status,
          createdAt: '2024-01-15T08:00:00Z',
          updatedAt: '2024-01-15T08:00:00Z',
          statusChangedAt: '2024-01-15T08:00:00Z',
        };

        const transformedCI = await connector.transformResource('issues', issueData);
        expect(transformedCI.status).toBe(testCase.expected);
      }
    });
  });

  describe('Environment Inference', () => {
    it('should infer environment from tags', async () => {
      const testCases = [
        { tags: { Environment: 'Production' }, expected: 'production' },
        { tags: { environment: 'prod' }, expected: 'production' },
        { tags: { env: 'Staging' }, expected: 'staging' },
        { tags: { Environment: 'stg' }, expected: 'staging' },
        { tags: { environment: 'Development' }, expected: 'development' },
        { tags: { env: 'dev' }, expected: 'development' },
        { tags: { Environment: 'Test' }, expected: 'test' },
        { tags: { environment: 'qa' }, expected: 'test' },
        { tags: { Application: 'WebServer' }, expected: 'production' }, // Default
      ];

      for (const testCase of testCases) {
        const resourceData = {
          id: 'resource-1',
          name: 'test-resource',
          type: 'VirtualMachine',
          cloudPlatform: 'AWS',
          cloudProviderURL: '',
          region: 'us-east-1',
          status: 'Running',
          tags: testCase.tags,
          createdAt: '2024-01-01T10:00:00Z',
          nativeType: 'AWS::EC2::Instance',
          providerUniqueId: 'i-123',
        };

        const transformedCI = await connector.transformResource('cloud_resources', resourceData);
        expect(transformedCI.environment).toBe(testCase.expected);
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

    it('fails a GraphQL response with errors rather than reporting an empty successful extraction', async () => {
      await connector.initialize();
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          errors: [
            { message: 'Query timeout', path: ['graphSearch'] },
          ],
        },
      });

      await expect(connector.extractResource('cloud_resources')).rejects.toThrow('Connector extraction failed');
    });
  });

  describe('Pagination', () => {
    it('should handle multi-page results', async () => {
      await connector.initialize();

      // First page
      const firstPageResponse = {
        data: {
          data: {
            graphSearch: {
              nodes: [
                {
                  entities: [
                    {
                      id: 'resource-1',
                      name: 'resource-1',
                      type: 'VirtualMachine',
                      properties: {
                        cloudPlatform: 'AWS',
                        status: 'Running',
                        createdAt: '2024-01-01T10:00:00Z',
                        nativeType: 'AWS::EC2::Instance',
                        providerUniqueId: 'i-1',
                      },
                    },
                  ],
                },
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: 'cursor-1',
              },
              totalCount: 2,
            },
          },
        },
      };

      // Second page
      const secondPageResponse = {
        data: {
          data: {
            graphSearch: {
              nodes: [
                {
                  entities: [
                    {
                      id: 'resource-2',
                      name: 'resource-2',
                      type: 'VirtualMachine',
                      properties: {
                        cloudPlatform: 'AWS',
                        status: 'Running',
                        createdAt: '2024-01-02T10:00:00Z',
                        nativeType: 'AWS::EC2::Instance',
                        providerUniqueId: 'i-2',
                      },
                    },
                  ],
                },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              totalCount: 2,
            },
          },
        },
      };

      mockAxiosInstance.post
        .mockResolvedValueOnce(firstPageResponse)
        .mockResolvedValueOnce(secondPageResponse);

      const extractedData = await connector.extractResource('cloud_resources');

      expect(extractedData).toHaveLength(2);
      expect(extractedData[0].external_id).toBe('resource-1');
      expect(extractedData[1].external_id).toBe('resource-2');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('Sensitive failure output', () => {
    it('keeps provider OAuth response and request headers out of logs and errors', async () => {
      const secret = 'WIZ_AUTH_SENTINEL';
      const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
      mockAuthPost.mockRejectedValueOnce({
        message: secret,
        response: { data: { nested: { access_token: secret } } },
        config: { headers: { Authorization: secret } },
      });

      try {
        await expect(connector.initialize()).rejects.toMatchObject({
          message: 'Wiz authentication failed',
        });
        expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(log.mock.calls)).toContain('Wiz authentication failed');
      } finally {
        log.mockRestore();
      }
    });

    it('fails GraphQL extraction without logging its error objects or configured filters', async () => {
      const secret = 'WIZ_GRAPHQL_SENTINEL';
      const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      await connector.initialize();
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { errors: [{ message: secret, extensions: { token: secret } }] },
      });

      try {
        await expect(
          connector.extractResource('cloud_resources', { cloud_providers_filter: [secret] })
        ).rejects.toMatchObject({ message: 'Connector extraction failed' });
        expect(JSON.stringify([log.mock.calls, info.mock.calls])).not.toContain(secret);
        expect(JSON.stringify(log.mock.calls)).toContain('Wiz cloud resource extraction failed');
      } finally {
        log.mockRestore();
        info.mockRestore();
      }
    });
  });
});
