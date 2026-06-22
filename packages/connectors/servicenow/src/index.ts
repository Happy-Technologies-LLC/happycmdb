// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ServiceNow CMDB Connector (v3.0)
 * Multi-resource bi-directional integration with ServiceNow CMDB
 * Supports servers, virtual machines, databases, applications, network devices, and relationships
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

export default class ServiceNowConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private instanceUrl: string;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.instanceUrl = config.connection['instance_url'];

    const authType = config.connection['auth_type'] as string | undefined;
    const accessToken = config.connection['access_token'] as string | undefined;

    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (authType === 'oauth2' && accessToken !== undefined && accessToken !== '') {
      this.client = axios.create({
        baseURL: `${this.instanceUrl}/api/now`,
        headers: {
          ...baseHeaders,
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 30000,
      });
    } else {
      this.client = axios.create({
        baseURL: `${this.instanceUrl}/api/now`,
        auth: {
          username: config.connection['username'],
          password: config.connection['password'],
        },
        headers: baseHeaders,
        timeout: 30000,
      });
    }
  }

  async initialize(): Promise<void> {
    logger.info('Initializing ServiceNow connector', {
      instance: this.instanceUrl,
      enabled_resources: this.getEnabledResources(),
    });
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying the system properties table (always exists)
      const response = await this.client.get('/table/sys_properties', {
        params: { sysparm_limit: 1 },
      });

      return {
        success: true,
        message: 'Successfully connected to ServiceNow',
        details: {
          instance: this.instanceUrl,
          available: response.data.result.length > 0,
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Connection failed: ${error.message}`,
        details: {
          instance: this.instanceUrl,
          error: error.response?.data || error.message,
        },
      };
    }
  }

  /**
   * Extract data for a specific resource (servers, virtual_machines, etc.)
   */
  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    // Get table name from resource config or use default
    const table = resourceConfig?.table ||
                 resource.configuration_schema?.properties?.table?.default;

    if (!table) {
      throw new Error(`No table configured for resource: ${resourceId}`);
    }

    // Get query filter if specified
    const query = resourceConfig?.query || '';

    // Get batch size from resource metadata
    const batchSize = resource.extraction?.batch_size || 1000;

    const extractedData: ExtractedData[] = [];
    let offset = 0;
    let hasMore = true;

    logger.info('Starting ServiceNow resource extraction', {
      resource: resourceId,
      table,
      query,
      batch_size: batchSize
    });

    while (hasMore) {
      try {
        const params: any = {
          sysparm_limit: batchSize,
          sysparm_offset: offset,
          sysparm_fields: this.getFieldsForResource(resourceId),
        };

        if (query) {
          params.sysparm_query = query;
        }

        const response = await this.client.get(`/table/${table}`, { params });
        const records = response.data.result;

        for (const record of records) {
          extractedData.push({
            external_id: record.sys_id,
            data: record,
            source_type: 'servicenow',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch from ServiceNow', {
          resource: resourceId,
          batch_size: records.length,
          total_extracted: extractedData.length,
        });

        hasMore = records.length === batchSize;
        offset += batchSize;

      } catch (error) {
        logger.error('ServiceNow resource extraction failed', {
          resource: resourceId,
          table,
          offset,
          error
        });
        throw error;
      }
    }

    logger.info('ServiceNow resource extraction completed', {
      resource: resourceId,
      table,
      total_records: extractedData.length,
    });

    return extractedData;
  }

  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Extract CI relationships from cmdb_rel_ci table
      const response = await this.client.get('/table/cmdb_rel_ci', {
        params: {
          sysparm_limit: 10000,
          sysparm_fields: 'parent,child,type',
        },
      });

      for (const rel of response.data.result) {
        relationships.push({
          source_external_id: rel.parent.value,
          target_external_id: rel.child.value,
          relationship_type: this.mapRelationType(rel.type?.display_value || 'RELATED_TO'),
          properties: {
            servicenow_type: rel.type?.display_value,
          },
        });
      }

      logger.info('ServiceNow relationships extracted', {
        count: relationships.length,
      });

    } catch (error) {
      logger.error('ServiceNow relationship extraction failed', { error });
      // Don't throw - relationships are optional
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

    const record = sourceData;

    // Base transformation common to all resources
    const transformedCI: TransformedCI = {
      name: record.name || record.sys_id,
      ci_type: resource.ci_type || this.mapCIType(record.sys_class_name),
      environment: this.extractEnvironment(record),
      status: this.mapStatus(record.operational_status),
      attributes: {
        asset_tag: record.asset_tag,
        install_status: record.install_status?.display_value,
        sys_class_name: record.sys_class_name,
        sys_created_on: record.sys_created_on,
        sys_updated_on: record.sys_updated_on,
      },
      identifiers: this.extractIdentifiers(record),
      source: 'servicenow',
      source_id: record.sys_id,
      confidence_score: 100, // ServiceNow is authoritative
    };

    // Resource-specific transformations
    switch (resourceId) {
      case 'servers':
        return this.transformServer(record, transformedCI);
      case 'virtual_machines':
        return this.transformVirtualMachine(record, transformedCI);
      case 'databases':
        return this.transformDatabase(record, transformedCI);
      case 'applications':
        return this.transformApplication(record, transformedCI);
      case 'network_devices':
        return this.transformNetworkDevice(record, transformedCI);
      default:
        return transformedCI;
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.sys_id,
      serial_number: data.serial_number,
      mac_address: data.mac_address ? [data.mac_address] : undefined,
      ip_address: data.ip_address ? [data.ip_address] : undefined,
      hostname: data.name,
      custom_identifiers: {
        asset_tag: data.asset_tag,
        sys_class_name: data.sys_class_name,
      },
    };
  }

  /**
   * Map ServiceNow CI class to CMDB CI type
   */
  private mapCIType(sysClassName: string): string {
    const mapping: Record<string, string> = {
      'cmdb_ci_server': 'server',
      'cmdb_ci_vm': 'virtual-machine',
      'cmdb_ci_computer': 'server',
      'cmdb_ci_netgear': 'network-device',
      'cmdb_ci_app': 'application',
      'cmdb_ci_db': 'database',
      'cmdb_ci_storage': 'storage',
      'cmdb_ci_lb': 'load-balancer',
    };

    return mapping[sysClassName] || 'server';
  }

  /**
   * Map ServiceNow operational status to CMDB status
   */
  private mapStatus(operationalStatus: any): string {
    const statusValue = operationalStatus?.value || operationalStatus;

    const mapping: Record<string, string> = {
      '1': 'active',      // Operational
      '2': 'inactive',    // Non-Operational
      '3': 'maintenance', // Repair in Progress
      '4': 'inactive',    // Retired
    };

    return mapping[statusValue] || 'active';
  }

  /**
   * Map ServiceNow relationship type to CMDB relationship type
   */
  private mapRelationType(serviceNowType: string): string {
    const mapping: Record<string, string> = {
      'Runs on::Runs': 'HOSTS',
      'Hosted on::Hosts': 'HOSTS',
      'Connected to::Connected by': 'CONNECTS_TO',
      'Uses::Used by': 'USES',
      'Depends on::Supports': 'DEPENDS_ON',
    };

    return mapping[serviceNowType] || 'RELATED_TO';
  }

  /**
   * Get fields to extract for a specific resource
   */
  private getFieldsForResource(resourceId: string): string {
    const commonFields = 'sys_id,name,serial_number,asset_tag,ip_address,mac_address,sys_class_name,operational_status,install_status,sys_created_on,sys_updated_on';

    const resourceSpecificFields: Record<string, string> = {
      servers: `${commonFields},os,os_version,cpu_count,ram,disk_space,manufacturer,model_id`,
      virtual_machines: `${commonFields},vcpus,memory,disk_space,host_name,vm_inst_id,guest_os`,
      databases: `${commonFields},db_version,db_type,instance_name,port,size_bytes`,
      applications: `${commonFields},version,vendor,support_group,business_criticality`,
      network_devices: `${commonFields},device_type,ports,firmware_version,location`,
      relationships: 'sys_id,parent,child,type',
    };

    return resourceSpecificFields[resourceId] || commonFields;
  }

  /**
   * Extract environment from ServiceNow record
   */
  private extractEnvironment(record: any): string {
    // Try to extract from common fields
    if (record.environment) {
      return record.environment.toLowerCase();
    }
    if (record.u_environment) {
      return record.u_environment.toLowerCase();
    }
    // Default to production
    return 'production';
  }

  /**
   * Transform server-specific attributes
   */
  private transformServer(record: any, baseCI: TransformedCI): TransformedCI {
    return {
      ...baseCI,
      attributes: {
        ...baseCI.attributes,
        os: record.os?.display_value,
        os_version: record.os_version,
        cpu_count: record.cpu_count,
        ram: record.ram,
        disk_space: record.disk_space,
        manufacturer: record.manufacturer?.display_value,
        model: record.model_id?.display_value,
      },
    };
  }

  /**
   * Transform virtual machine-specific attributes
   */
  private transformVirtualMachine(record: any, baseCI: TransformedCI): TransformedCI {
    return {
      ...baseCI,
      attributes: {
        ...baseCI.attributes,
        vcpus: record.vcpus,
        memory: record.memory,
        disk_space: record.disk_space,
        host_name: record.host_name?.display_value,
        vm_inst_id: record.vm_inst_id,
        guest_os: record.guest_os?.display_value,
      },
    };
  }

  /**
   * Transform database-specific attributes
   */
  private transformDatabase(record: any, baseCI: TransformedCI): TransformedCI {
    return {
      ...baseCI,
      attributes: {
        ...baseCI.attributes,
        db_version: record.db_version,
        db_type: record.db_type?.display_value,
        instance_name: record.instance_name,
        port: record.port,
        size_bytes: record.size_bytes,
      },
    };
  }

  /**
   * Transform application-specific attributes
   */
  private transformApplication(record: any, baseCI: TransformedCI): TransformedCI {
    return {
      ...baseCI,
      attributes: {
        ...baseCI.attributes,
        version: record.version,
        vendor: record.vendor?.display_value,
        support_group: record.support_group?.display_value,
        business_criticality: record.business_criticality?.display_value,
      },
    };
  }

  /**
   * Transform network device-specific attributes
   */
  private transformNetworkDevice(record: any, baseCI: TransformedCI): TransformedCI {
    return {
      ...baseCI,
      attributes: {
        ...baseCI.attributes,
        device_type: record.device_type?.display_value,
        ports: record.ports,
        firmware_version: record.firmware_version,
        location: record.location?.display_value,
      },
    };
  }
}
