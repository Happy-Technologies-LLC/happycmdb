// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Rubrik CDM Connector (v1.0)
 * Data protection and backup management integration
 * Supports clusters, protected VMs, physical hosts, and SLA domains
 */

import axios, { AxiosInstance } from 'axios';
import https from 'https';
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
 * Rubrik API Response Types
 */
interface RubrikCluster {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  timezone: {
    timezone: string;
  };
  geolocation?: {
    address: string;
  };
  acceptedEulaVersion?: string;
  latestEulaVersion?: string;
}

interface RubrikVM {
  id: string;
  name: string;
  configuredSlaDomainId: string;
  configuredSlaDomainName?: string;
  effectiveSlaDomainId: string;
  effectiveSlaDomainName?: string;
  primaryClusterId: string;
  vmwareToolsInstalled: boolean;
  guestOsName?: string;
  ipAddress?: string;
  powerStatus?: string;
  isRelic: boolean;
  slaAssignment: string;
  snapshotConsistencyMandate?: string;
  agentStatus?: {
    agentStatus: string;
    disconnectReason?: string;
  };
  infraPath?: Array<{
    id: string;
    name: string;
  }>;
  objectType: string;
}

interface RubrikPhysicalHost {
  id: string;
  name: string;
  hostname: string;
  configuredSlaDomainId: string;
  configuredSlaDomainName?: string;
  effectiveSlaDomainId: string;
  effectiveSlaDomainName?: string;
  primaryClusterId: string;
  operatingSystem: string;
  operatingSystemType: string;
  status: string;
  connectivity: string;
  compressionEnabled?: boolean;
  isRelic: boolean;
  agentId?: string;
  ipAddress?: string;
}

interface RubrikSLADomain {
  id: string;
  name: string;
  frequencies: Record<string, any>;
  allowedBackupWindows?: any[];
  firstFullAllowedBackupWindows?: any[];
  localRetentionLimit?: number;
  archivalSpecs?: any[];
  replicationSpecs?: any[];
  numDbs?: number;
  numFilesets?: number;
  numHypervVms?: number;
  numMssqlDbs?: number;
  numOracleDbs?: number;
  numVms?: number;
  numWindowsVolumeGroups?: number;
  numLinuxHosts?: number;
  numShares?: number;
  numWindowsHosts?: number;
  numManagedVolumes?: number;
  isDefault: boolean;
  uiColor?: string;
}

interface RubrikPaginatedResponse<T> {
  hasMore: boolean;
  data: T[];
  total?: number;
}

export default class RubrikConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private clusterUrl: string;
  private apiVersion: string;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.clusterUrl = config.connection['cluster_url'];
    this.apiVersion = config.connection['api_version'] || 'v1';

    const verifySSL = config.connection['verify_ssl'] !== false;

    this.client = axios.create({
      baseURL: `${this.clusterUrl}/api/${this.apiVersion}`,
      auth: {
        username: config.connection['username'],
        password: config.connection['password'],
      },
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 60000,
      httpsAgent: new https.Agent({
        rejectUnauthorized: verifySSL,
      }),
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Rubrik CDM connector');
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying cluster info
      const response = await this.client.get('/cluster/me');

      return {
        success: true,
        message: 'Successfully connected to Rubrik cluster',
        details: {
          cluster_url: this.clusterUrl,
          cluster_name: response.data.name,
          cluster_version: response.data.version,
          api_version: this.apiVersion,
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

    logger.info('Starting Rubrik resource extraction');

    switch (resourceId) {
      case 'clusters':
        return this.extractClusters(resourceConfig);
      case 'vms':
        return this.extractVMs(resourceConfig);
      case 'physical_hosts':
        return this.extractPhysicalHosts(resourceConfig);
      case 'sla_domains':
        return this.extractSLADomains(resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Extract cluster information
   */
  private async extractClusters(_resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      logger.info('Extracting Rubrik cluster information');

      // Get cluster details
      const response = await this.client.get('/cluster/me');
      const cluster: RubrikCluster = response.data;

      extractedData.push({
        external_id: cluster.id,
        data: cluster,
        source_type: 'rubrik',
        extracted_at: new Date(),
      });

      logger.info('Rubrik cluster extraction completed', {
        total_records: extractedData.length,
      });

    } catch (error) {
      logger.error('Rubrik cluster extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract protected VMs
   */
  private async extractVMs(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 500;
    let offset = 0;
    let hasMore = true;

    // Build query parameters
    const params: any = {
      limit: batchSize,
    };

    if (resourceConfig?.['primary_cluster_id']) {
      params.primary_cluster_id = resourceConfig['primary_cluster_id'];
    }

    if (resourceConfig?.['sla_domain_id']) {
      params.effective_sla_domain_id = resourceConfig['sla_domain_id'];
    }

    if (resourceConfig?.['is_relic'] !== undefined) {
      params.is_relic = resourceConfig['is_relic'];
    }

    logger.info('Extracting Rubrik protected VMs');

    while (hasMore) {
      try {
        params.offset = offset;

        const response = await this.client.get<RubrikPaginatedResponse<RubrikVM>>(
          '/vmware/vm',
          { params }
        );

        const vms = response.data.data || [];

        for (const vm of vms) {
          extractedData.push({
            external_id: vm.id,
            data: vm,
            source_type: 'rubrik',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of Rubrik VMs', {
          batch_size: vms.length,
          total_extracted: extractedData.length,
        });

        hasMore = response.data.hasMore;
        offset += batchSize;

      } catch (error) {
        logger.error('Rubrik VM extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('Rubrik VM extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract protected physical hosts
   */
  private async extractPhysicalHosts(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 500;
    let offset = 0;
    let hasMore = true;

    // Build query parameters
    const params: any = {
      limit: batchSize,
    };

    if (resourceConfig?.['primary_cluster_id']) {
      params.primary_cluster_id = resourceConfig['primary_cluster_id'];
    }

    if (resourceConfig?.['operating_system']) {
      params.operating_system_type = resourceConfig['operating_system'];
    }

    logger.info('Extracting Rubrik physical hosts');

    while (hasMore) {
      try {
        params.offset = offset;

        const response = await this.client.get<RubrikPaginatedResponse<RubrikPhysicalHost>>(
          '/host',
          { params }
        );

        const hosts = response.data.data || [];

        for (const host of hosts) {
          extractedData.push({
            external_id: host.id,
            data: host,
            source_type: 'rubrik',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of Rubrik physical hosts', {
          batch_size: hosts.length,
          total_extracted: extractedData.length,
        });

        hasMore = response.data.hasMore;
        offset += batchSize;

      } catch (error) {
        logger.error('Rubrik physical host extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('Rubrik physical host extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract SLA domains (backup policies)
   */
  private async extractSLADomains(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 100;
    let offset = 0;
    let hasMore = true;

    // Build query parameters
    const params: any = {
      limit: batchSize,
    };

    if (resourceConfig?.['primary_cluster_id']) {
      params.primary_cluster_id = resourceConfig['primary_cluster_id'];
    }

    logger.info('Extracting Rubrik SLA domains');

    while (hasMore) {
      try {
        params.offset = offset;

        const response = await this.client.get<RubrikPaginatedResponse<RubrikSLADomain>>(
          '/sla_domain',
          { params }
        );

        const slaDomains = response.data.data || [];

        for (const slaDomain of slaDomains) {
          extractedData.push({
            external_id: slaDomain.id,
            data: slaDomain,
            source_type: 'rubrik',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of Rubrik SLA domains', {
          batch_size: slaDomains.length,
          total_extracted: extractedData.length,
        });

        hasMore = response.data.hasMore;
        offset += batchSize;

      } catch (error) {
        logger.error('Rubrik SLA domain extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('Rubrik SLA domain extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract relationships (VM/host to SLA domain mappings)
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      logger.info('Inferring Rubrik relationships from extracted data');

      // Relationships are inferred during transformation based on SLA domain assignments
      // This method would be called if we need explicit relationship extraction

      logger.info('Rubrik relationships will be inferred during transformation');

    } catch (error) {
      logger.error('Rubrik relationship extraction failed');
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

    switch (resourceId) {
      case 'clusters':
        return this.transformCluster(sourceData);
      case 'vms':
        return this.transformVM(sourceData);
      case 'physical_hosts':
        return this.transformPhysicalHost(sourceData);
      case 'sla_domains':
        return this.transformSLADomain(sourceData);
      default:
        throw new Error(`Unsupported resource transformation: ${resourceId}`);
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.id,
      hostname: data.hostname || data.name,
      ip_address: data.ipAddress ? [data.ipAddress] : undefined,
      custom_identifiers: {
        rubrik_id: data.id,
        rubrik_object_type: data.objectType || data.operatingSystemType,
      },
    };
  }

  /**
   * Transform Rubrik cluster to CMDB CI
   */
  private transformCluster(cluster: RubrikCluster): TransformedCI {
    return {
      name: cluster.name,
      ci_type: 'server',
      environment: 'production',
      status: 'active',
      attributes: {
        cluster_id: cluster.id,
        version: cluster.version,
        api_version: cluster.apiVersion,
        timezone: cluster.timezone?.timezone,
        location: cluster.geolocation?.address,
        eula_version: cluster.acceptedEulaVersion,
        product_type: 'Rubrik CDM',
      },
      identifiers: {
        external_id: cluster.id,
        hostname: cluster.name,
        custom_identifiers: {
          rubrik_cluster_id: cluster.id,
        },
      },
      source: 'rubrik',
      source_id: cluster.id,
      confidence_score: 100, // Rubrik is authoritative for backup data
    };
  }

  /**
   * Transform Rubrik VM to CMDB CI
   */
  private transformVM(vm: RubrikVM): TransformedCI {
    return {
      name: vm.name,
      ci_type: 'virtual-machine',
      environment: 'production',
      status: this.mapVMStatus(vm.powerStatus),
      attributes: {
        vm_id: vm.id,
        guest_os: vm.guestOsName,
        ip_address: vm.ipAddress,
        power_status: vm.powerStatus,
        vmware_tools_installed: vm.vmwareToolsInstalled,
        is_relic: vm.isRelic,
        sla_assignment: vm.slaAssignment,
        configured_sla_domain_id: vm.configuredSlaDomainId,
        configured_sla_domain_name: vm.configuredSlaDomainName,
        effective_sla_domain_id: vm.effectiveSlaDomainId,
        effective_sla_domain_name: vm.effectiveSlaDomainName,
        primary_cluster_id: vm.primaryClusterId,
        agent_status: vm.agentStatus?.agentStatus,
        agent_disconnect_reason: vm.agentStatus?.disconnectReason,
        snapshot_consistency: vm.snapshotConsistencyMandate,
        infra_path: vm.infraPath,
        object_type: vm.objectType,
      },
      identifiers: this.extractIdentifiers(vm),
      source: 'rubrik',
      source_id: vm.id,
      confidence_score: 95, // High confidence from backup system
    };
  }

  /**
   * Transform Rubrik physical host to CMDB CI
   */
  private transformPhysicalHost(host: RubrikPhysicalHost): TransformedCI {
    return {
      name: host.name,
      ci_type: 'server',
      environment: 'production',
      status: this.mapHostStatus(host.status, host.connectivity),
      attributes: {
        host_id: host.id,
        hostname: host.hostname,
        operating_system: host.operatingSystem,
        operating_system_type: host.operatingSystemType,
        ip_address: host.ipAddress,
        status: host.status,
        connectivity: host.connectivity,
        compression_enabled: host.compressionEnabled,
        is_relic: host.isRelic,
        configured_sla_domain_id: host.configuredSlaDomainId,
        configured_sla_domain_name: host.configuredSlaDomainName,
        effective_sla_domain_id: host.effectiveSlaDomainId,
        effective_sla_domain_name: host.effectiveSlaDomainName,
        primary_cluster_id: host.primaryClusterId,
        agent_id: host.agentId,
      },
      identifiers: this.extractIdentifiers(host),
      source: 'rubrik',
      source_id: host.id,
      confidence_score: 95, // High confidence from backup agent
    };
  }

  /**
   * Transform Rubrik SLA domain to CMDB CI
   */
  private transformSLADomain(slaDomain: RubrikSLADomain): TransformedCI {
    return {
      name: slaDomain.name,
      ci_type: 'policy',
      environment: 'production',
      status: 'active',
      attributes: {
        sla_domain_id: slaDomain.id,
        is_default: slaDomain.isDefault,
        frequencies: slaDomain.frequencies,
        local_retention_limit: slaDomain.localRetentionLimit,
        archival_specs: slaDomain.archivalSpecs,
        replication_specs: slaDomain.replicationSpecs,
        num_vms: slaDomain.numVms,
        num_dbs: slaDomain.numDbs,
        num_filesets: slaDomain.numFilesets,
        num_hyperv_vms: slaDomain.numHypervVms,
        num_mssql_dbs: slaDomain.numMssqlDbs,
        num_oracle_dbs: slaDomain.numOracleDbs,
        num_windows_volume_groups: slaDomain.numWindowsVolumeGroups,
        num_linux_hosts: slaDomain.numLinuxHosts,
        num_windows_hosts: slaDomain.numWindowsHosts,
        num_shares: slaDomain.numShares,
        num_managed_volumes: slaDomain.numManagedVolumes,
        ui_color: slaDomain.uiColor,
        allowed_backup_windows: slaDomain.allowedBackupWindows,
        first_full_allowed_backup_windows: slaDomain.firstFullAllowedBackupWindows,
      },
      identifiers: {
        external_id: slaDomain.id,
        custom_identifiers: {
          rubrik_sla_domain_id: slaDomain.id,
        },
      },
      source: 'rubrik',
      source_id: slaDomain.id,
      confidence_score: 100, // SLA domains are authoritative
    };
  }

  /**
   * Map VM power status to CMDB status
   */
  private mapVMStatus(powerStatus?: string): string {
    if (!powerStatus) return 'active';

    const mapping: Record<string, string> = {
      'PoweredOn': 'active',
      'PoweredOff': 'inactive',
      'Suspended': 'maintenance',
    };

    return mapping[powerStatus] || 'active';
  }

  /**
   * Map physical host status to CMDB status
   */
  private mapHostStatus(status: string, connectivity: string): string {
    // If connectivity is bad, mark as inactive regardless of status
    if (connectivity === 'Disconnected' || connectivity === 'Error') {
      return 'inactive';
    }

    const statusMapping: Record<string, string> = {
      'Ok': 'active',
      'Warning': 'active',
      'Error': 'inactive',
      'Unavailable': 'inactive',
    };

    return statusMapping[status] || 'active';
  }

  /**
   * Infer relationships from extracted data
   * VMs and physical hosts link to their SLA domains
   */
  inferRelationships(extractedData: ExtractedData[]): ExtractedRelationship[] {
    const relationships: ExtractedRelationship[] = [];

    for (const data of extractedData) {
      const record = data.data;

      // Check if this is a VM or physical host with an SLA domain assignment
      if (record['effectiveSlaDomainId']) {
        relationships.push({
          source_external_id: record['id'],
          target_external_id: record['effectiveSlaDomainId'],
          relationship_type: 'PROTECTED_BY',
          properties: {
            sla_domain_name: record['effectiveSlaDomainName'],
            sla_assignment: record['slaAssignment'],
            configured_sla_domain_id: record['configuredSlaDomainId'],
          },
        });
      }

      // Link to primary cluster
      if (record['primaryClusterId']) {
        relationships.push({
          source_external_id: record['id'],
          target_external_id: record['primaryClusterId'],
          relationship_type: 'MANAGED_BY',
          properties: {
            cluster_role: 'primary',
          },
        });
      }
    }

    logger.info('Inferred Rubrik relationships', {
      count: relationships.length,
    });

    return relationships;
  }
}
