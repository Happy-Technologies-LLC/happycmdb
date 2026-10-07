// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Veeam Backup & Replication Connector (v1.0)
 * Multi-resource integration with Veeam Enterprise Manager REST API
 * Supports backup servers, protected VMs, backup jobs, and repositories
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '@cmdb/common';
import {
  BaseIntegrationConnector,
  ConnectorConfiguration,
  ConnectorMetadata,
  TestResult,
  ExtractedData,
  ExtractedRelationship,
  TransformedCI,
  IdentificationAttributes,
} from '@cmdb/integration-framework';
import * as connectorMetadata from '../connector.json';

/**
 * Veeam Session Token Response
 */
interface VeeamSessionResponse {
  SessionId: string;
  ExpiresAt: string;
}

/**
 * Veeam Backup Server
 */
interface VeeamBackupServer {
  UID: string;
  Name: string;
  Description?: string;
  Port: number;
  Version: string;
  Links?: Array<{ Rel: string; Href: string; Type: string }>;
}

/**
 * Veeam Protected VM
 */
interface VeeamProtectedVM {
  UID: string;
  Name: string;
  Path?: string;
  Type: string;
  Platform?: string;
  VmHostName?: string;
  VmHostId?: string;
  ViType?: string;
  Links?: Array<{ Rel: string; Href: string; Type: string }>;
}

/**
 * Veeam Backup Job
 */
interface VeeamBackupJob {
  UID: string;
  Name: string;
  JobType: string;
  Description?: string;
  ScheduleEnabled: boolean;
  ScheduleConfigured: boolean;
  NextRun?: string;
  BackupServerUid?: string;
  Links?: Array<{ Rel: string; Href: string; Type: string }>;
}

/**
 * Veeam Repository
 */
interface VeeamRepository {
  UID: string;
  Name: string;
  Description?: string;
  Type: string;
  Path?: string;
  Capacity?: number;
  FreeSpace?: number;
  BackupServerUid?: string;
  Links?: Array<{ Rel: string; Href: string; Type: string }>;
}

/**
 * Veeam Enterprise Manager Connector
 */
export default class VeeamConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private enterpriseManagerUrl: string;
  private username: string;
  private password: string;
  private verifySSL: boolean;
  private sessionToken: string | null = null;
  private sessionExpiry: Date | null = null;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.enterpriseManagerUrl = config.connection['enterprise_manager_url'];
    this.username = config.connection['username'];
    this.password = config.connection['password'];
    this.verifySSL = config.connection['verify_ssl'] ?? false;

    // Create base axios instance
    this.client = axios.create({
      baseURL: this.enterpriseManagerUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      // Disable SSL verification if configured (common for self-signed certs)
      httpsAgent: this.verifySSL ? undefined : new (require('https').Agent)({
        rejectUnauthorized: false,
      }),
    });

    // Add request interceptor to inject session token
    this.client.interceptors.request.use(async (config) => {
      // Ensure we have a valid session token
      await this.ensureSessionToken();

      if (this.sessionToken) {
        config.headers['X-RestSvcSessionId'] = this.sessionToken;
      }

      return config;
    });

    // Add response interceptor for session expiry
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401) {
          logger.warn('Veeam session expired, re-authenticating');
          this.sessionToken = null;
          this.sessionExpiry = null;

          // Retry the request with new session
          await this.ensureSessionToken();
          error.config.headers['X-RestSvcSessionId'] = this.sessionToken;
          return this.client.request(error.config);
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Ensure we have a valid session token
   */
  private async ensureSessionToken(): Promise<void> {
    // Check if we have a valid token
    if (this.sessionToken && this.sessionExpiry && this.sessionExpiry > new Date()) {
      return;
    }

    // Acquire new session token
    try {
      logger.info('Acquiring Veeam session token');

      const response = await axios.post<VeeamSessionResponse>(
        `${this.enterpriseManagerUrl}/api/sessionMngr/?v=latest`,
        null,
        {
          auth: {
            username: this.username,
            password: this.password,
          },
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          httpsAgent: this.verifySSL ? undefined : new (require('https').Agent)({
            rejectUnauthorized: false,
          }),
        }
      );

      this.sessionToken = response.headers['x-restsvcsessionid'] || response.data.SessionId;

      // Sessions typically expire in 15 minutes, set to 14 minutes to be safe
      this.sessionExpiry = new Date(Date.now() + 14 * 60 * 1000);

      logger.info('Veeam session token acquired');

    } catch (error: any) {
      logger.error('Failed to acquire Veeam session token');
      throw new Error('Veeam authentication failed');
    }
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Veeam connector');

    // Test authentication by acquiring session token
    await this.ensureSessionToken();

    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying backup servers (always exists)
      await this.ensureSessionToken();

      await this.client.get('/api/backupServers');

      return {
        success: true,
        message: 'Successfully connected to Veeam Enterprise Manager',
        details: {
          enterprise_manager: this.enterpriseManagerUrl,
          session_valid: this.sessionToken !== null,
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  /**
   * Extract data for a specific resource
   */
  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    logger.info('Starting Veeam resource extraction');

    // Route to appropriate extraction method
    switch (resourceId) {
      case 'backup_servers':
        return this.extractBackupServers(resourceConfig);
      case 'protected_vms':
        return this.extractProtectedVMs(resourceConfig);
      case 'backup_jobs':
        return this.extractBackupJobs(resourceConfig);
      case 'repositories':
        return this.extractRepositories(resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Extract Backup Servers
   */
  private async extractBackupServers(config?: Record<string, any>): Promise<ExtractedData[]> {
    const endpoint = config?.['endpoint'] || '/api/backupServers';
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.client.get(endpoint);
      const servers: VeeamBackupServer[] = response.data.Refs || response.data;

      for (const server of servers) {
        extractedData.push({
          external_id: server.UID,
          data: server,
          source_type: 'veeam',
          extracted_at: new Date(),
        });
      }

      logger.info('Veeam backup servers extracted', {
        count: extractedData.length,
      });

    } catch (error) {
      logger.error('Veeam backup server extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract Protected VMs
   */
  private async extractProtectedVMs(config?: Record<string, any>): Promise<ExtractedData[]> {
    const endpoint = config?.['endpoint'] || '/api/query';
    const queryType = config?.['query_type'] || 'Vm';
    const filter = config?.['filter'] || 'IsTemplate==false';
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.client.get(endpoint, {
        params: {
          type: queryType,
          filter: filter,
        },
      });

      const vms: VeeamProtectedVM[] = response.data.Refs || response.data;

      for (const vm of vms) {
        extractedData.push({
          external_id: vm.UID,
          data: vm,
          source_type: 'veeam',
          extracted_at: new Date(),
        });
      }

      logger.info('Veeam protected VMs extracted', {
        count: extractedData.length,
      });

    } catch (error) {
      logger.error('Veeam protected VM extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract Backup Jobs
   */
  private async extractBackupJobs(config?: Record<string, any>): Promise<ExtractedData[]> {
    const endpoint = config?.['endpoint'] || '/api/jobs';
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.client.get(endpoint);
      const jobs: VeeamBackupJob[] = response.data.Refs || response.data;

      for (const job of jobs) {
        extractedData.push({
          external_id: job.UID,
          data: job,
          source_type: 'veeam',
          extracted_at: new Date(),
        });
      }

      logger.info('Veeam backup jobs extracted', {
        count: extractedData.length,
      });

    } catch (error) {
      logger.error('Veeam backup job extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract Repositories
   */
  private async extractRepositories(config?: Record<string, any>): Promise<ExtractedData[]> {
    const endpoint = config?.['endpoint'] || '/api/repositories';
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.client.get(endpoint);
      const repos: VeeamRepository[] = response.data.Refs || response.data;

      for (const repo of repos) {
        extractedData.push({
          external_id: repo.UID,
          data: repo,
          source_type: 'veeam',
          extracted_at: new Date(),
        });
      }

      logger.info('Veeam repositories extracted', {
        count: extractedData.length,
      });

    } catch (error) {
      logger.error('Veeam repository extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract relationships between Veeam resources
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Get all backup jobs to infer relationships
      const jobsData = await this.extractBackupJobs();

      for (const jobData of jobsData) {
        const job = jobData.data as VeeamBackupJob;

        // Backup jobs link to backup servers
        if (job.BackupServerUid) {
          relationships.push({
            source_external_id: job.UID,
            target_external_id: job.BackupServerUid,
            relationship_type: 'RUNS_ON',
            properties: {
              job_type: job.JobType,
            },
          });
        }
      }

      // Get all repositories to infer relationships
      const reposData = await this.extractRepositories();

      for (const repoData of reposData) {
        const repo = repoData.data as VeeamRepository;

        // Repositories link to backup servers
        if (repo.BackupServerUid) {
          relationships.push({
            source_external_id: repo.UID,
            target_external_id: repo.BackupServerUid,
            relationship_type: 'MANAGED_BY',
            properties: {
              repo_type: repo.Type,
            },
          });
        }
      }

      // Infer relationships between protected VMs and backup jobs by querying job details
      // This would require additional API calls to /api/jobs/{jobId}/includes
      // For now, we'll implement basic relationships

      logger.info('Veeam relationships extracted', {
        count: relationships.length,
      });

    } catch (error) {
      logger.error('Veeam relationship extraction failed');
      // Don't throw - relationships are optional
    }

    return relationships;
  }

  /**
   * Infer relationships between protected VMs and backup jobs
   * This is a helper method that can be called during transformation
   * Note: Currently placeholder implementation - requires additional API calls
   */
  inferRelationships(
    sourceResourceId: string,
    _sourceData: any,
    _allExtractedData: Map<string, ExtractedData[]>
  ): ExtractedRelationship[] {
    const relationships: ExtractedRelationship[] = [];

    // Protected VMs can be linked to backup jobs if we have job details
    if (sourceResourceId === 'protected_vms') {
      // This is a simplified version - in production, you would query
      // /api/jobs/{jobId}/includes to get the actual VM-to-job mappings
      // const vm = sourceData as VeeamProtectedVM;
      // const jobs = allExtractedData.get('backup_jobs') || [];
    }

    // Backup jobs link to repositories where backups are stored
    if (sourceResourceId === 'backup_jobs') {
      // Simplified - in production, query job details to get target repository
      // For now, we create relationships in extractRelationships()
      // const job = sourceData as VeeamBackupJob;
      // const repos = allExtractedData.get('repositories') || [];
    }

    return relationships;
  }

  /**
   * Transform source data to CMDB format for a specific resource
   */
  async transformResource(
    resourceId: string,
    sourceData: any
  ): Promise<TransformedCI> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    // Route to appropriate transformation method
    switch (resourceId) {
      case 'backup_servers':
        return this.transformBackupServer(sourceData);
      case 'protected_vms':
        return this.transformProtectedVM(sourceData);
      case 'backup_jobs':
        return this.transformBackupJob(sourceData);
      case 'repositories':
        return this.transformRepository(sourceData);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Transform Backup Server to CI
   */
  private transformBackupServer(data: VeeamBackupServer): TransformedCI {
    return {
      name: data.Name,
      ci_type: 'server',
      environment: 'production', // Veeam backup servers are typically production
      status: 'active',
      attributes: {
        description: data.Description,
        port: data.Port,
        version: data.Version,
        product: 'Veeam Backup & Replication',
        role: 'backup-server',
      },
      identifiers: this.extractIdentifiers(data),
      source: 'veeam',
      source_id: data.UID,
      confidence_score: 95, // High confidence from Veeam Enterprise Manager
    };
  }

  /**
   * Transform Protected VM to CI
   */
  private transformProtectedVM(data: VeeamProtectedVM): TransformedCI {
    return {
      name: data.Name,
      ci_type: 'virtual-machine',
      environment: this.inferEnvironment(data.Name),
      status: 'active',
      attributes: {
        path: data.Path,
        type: data.Type,
        platform: data.Platform,
        vm_host_name: data.VmHostName,
        vm_host_id: data.VmHostId,
        vi_type: data.ViType,
        backup_protected: true,
      },
      identifiers: this.extractIdentifiers(data),
      source: 'veeam',
      source_id: data.UID,
      confidence_score: 90, // High confidence for VMs under backup
    };
  }

  /**
   * Transform Backup Job to CI
   */
  private transformBackupJob(data: VeeamBackupJob): TransformedCI {
    return {
      name: data.Name,
      ci_type: 'application',
      environment: 'production',
      status: data.ScheduleEnabled ? 'active' : 'inactive',
      attributes: {
        job_type: data.JobType,
        description: data.Description,
        schedule_enabled: data.ScheduleEnabled,
        schedule_configured: data.ScheduleConfigured,
        next_run: data.NextRun,
        backup_server_uid: data.BackupServerUid,
        application_type: 'backup-job',
      },
      identifiers: this.extractIdentifiers(data),
      source: 'veeam',
      source_id: data.UID,
      confidence_score: 100, // Authoritative from Veeam
    };
  }

  /**
   * Transform Repository to CI
   */
  private transformRepository(data: VeeamRepository): TransformedCI {
    return {
      name: data.Name,
      ci_type: 'storage',
      environment: 'production',
      status: 'active',
      attributes: {
        description: data.Description,
        type: data.Type,
        path: data.Path,
        capacity_bytes: data.Capacity,
        free_space_bytes: data.FreeSpace,
        used_space_bytes: data.Capacity && data.FreeSpace ? data.Capacity - data.FreeSpace : undefined,
        backup_server_uid: data.BackupServerUid,
        storage_type: 'backup-repository',
      },
      identifiers: this.extractIdentifiers(data),
      source: 'veeam',
      source_id: data.UID,
      confidence_score: 100, // Authoritative from Veeam
    };
  }

  /**
   * Extract identification attributes
   */
  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.UID,
      hostname: data.Name,
      custom_identifiers: {
        veeam_uid: data.UID,
        veeam_type: data.Type || data.JobType || 'unknown',
      },
    };
  }

  /**
   * Infer environment from resource name
   */
  private inferEnvironment(name: string): string {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('prod')) return 'production';
    if (nameLower.includes('stag')) return 'staging';
    if (nameLower.includes('dev')) return 'development';
    if (nameLower.includes('test') || nameLower.includes('qa')) return 'test';

    // Default to production for backup-protected resources
    return 'production';
  }

  /**
   * Cleanup resources (close session if needed)
   */
  override async cleanup(): Promise<void> {
    if (this.sessionToken) {
      try {
        // Logout to invalidate session
        await this.client.delete('/api/sessionMngr');
        logger.info('Veeam session closed');
      } catch (error) {
        logger.warn('Failed to close Veeam session');
      }

      this.sessionToken = null;
      this.sessionExpiry = null;
    }
  }
}
