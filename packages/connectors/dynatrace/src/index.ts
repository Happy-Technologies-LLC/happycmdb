// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dynatrace APM Connector (v1.0)
 * Multi-resource integration with Dynatrace for hosts, processes, services, and applications
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

interface DynatraceEntity {
  entityId: string;
  displayName: string;
  firstSeenTms?: number;
  lastSeenTms?: number;
  properties?: Record<string, any>;
  tags?: Array<{ key: string; value?: string }>;
  toRelationships?: Record<string, string[]>;
  fromRelationships?: Record<string, string[]>;
}

interface DynatraceEntitiesResponse {
  entities: DynatraceEntity[];
  nextPageKey?: string;
  totalCount: number;
}

export default class DynatraceConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private environmentUrl: string;
  private apiToken: string;

  // Store entities for relationship inference
  private entityCache: Map<string, DynatraceEntity> = new Map();

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.environmentUrl = config.connection['environment_url'];
    this.apiToken = config.connection['api_token'];

    this.client = axios.create({
      baseURL: `${this.environmentUrl}/api/v2`,
      headers: {
        'Authorization': `Api-Token ${this.apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Dynatrace connector');
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying a lightweight endpoint
      const response = await this.client.get('/entities/types');

      return {
        success: true,
        message: 'Successfully connected to Dynatrace',
        details: {
          environment: this.environmentUrl,
          entity_types: response.data.types?.length || 0,
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  /**
   * Extract data for a specific resource (hosts, processes, services, applications)
   */
  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    // Map resource ID to Dynatrace entity type
    const entityTypeSelector = this.getEntityTypeSelector(resourceId);
    if (!entityTypeSelector) {
      throw new Error(`No entity type mapping for resource: ${resourceId}`);
    }

    // Get configuration parameters
    const pageSize = resourceConfig?.['pageSize'] ||
                    resource.configuration_schema?.['properties']?.['pageSize']?.['default'] ||
                    500;
    const fields = resourceConfig?.['fields'] ||
                  resource.configuration_schema?.['properties']?.['fields']?.['default'] ||
                  '+properties,+tags,+toRelationships';

    const extractedData: ExtractedData[] = [];
    let nextPageKey: string | undefined = undefined;

    logger.info('Starting Dynatrace resource extraction');

    do {
      try {
        const params: any = {
          pageSize,
          entitySelector: entityTypeSelector,
          fields,
        };

        if (nextPageKey) {
          params.nextPageKey = nextPageKey;
        }

        const response = await this.client.get<DynatraceEntitiesResponse>(
          '/entities',
          { params }
        );

        const entities = response.data.entities || [];

        for (const entity of entities) {
          // Cache entity for relationship inference
          this.entityCache.set(entity.entityId, entity);

          extractedData.push({
            external_id: entity.entityId,
            data: entity,
            source_type: 'dynatrace',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch from Dynatrace', {
          resource: resourceId,
          batch_size: entities.length,
          total_extracted: extractedData.length,
          total_count: response.data.totalCount,
        });

        nextPageKey = response.data.nextPageKey;

      } catch (error) {
        logger.error('Dynatrace resource extraction failed');
        throw new Error('Connector extraction failed');
      }
    } while (nextPageKey);

    logger.info('Dynatrace resource extraction completed', {
      resource: resourceId,
      entity_type: entityTypeSelector,
      total_records: extractedData.length,
    });

    return extractedData;
  }

  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      logger.info('Inferring relationships from Dynatrace entities', {
        cached_entities: this.entityCache.size,
      });

      // Process toRelationships from cached entities
      for (const [entityId, entity] of this.entityCache) {
        if (!entity.toRelationships) {
          continue;
        }

        // Process each relationship type
        for (const [relType, targetIds] of Object.entries(entity.toRelationships)) {
          for (const targetId of targetIds) {
            const mappedRelType = this.mapRelationType(relType);

            relationships.push({
              source_external_id: entityId,
              target_external_id: targetId,
              relationship_type: mappedRelType,
              properties: {
                dynatrace_type: relType,
                inferred_from: 'toRelationships',
              },
            });
          }
        }
      }

      logger.info('Dynatrace relationships inferred', {
        count: relationships.length,
      });

    } catch (error) {
      logger.error('Dynatrace relationship extraction failed');
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

    const entity: DynatraceEntity = sourceData;

    // Base transformation common to all resources
    const transformedCI: TransformedCI = {
      name: entity.displayName || entity.entityId,
      ci_type: resource.ci_type || 'server',
      environment: this.extractEnvironment(entity),
      status: this.determineStatus(entity),
      attributes: {
        dynatrace_id: entity.entityId,
        first_seen: entity.firstSeenTms
          ? new Date(entity.firstSeenTms).toISOString()
          : undefined,
        last_seen: entity.lastSeenTms
          ? new Date(entity.lastSeenTms).toISOString()
          : undefined,
        tags: this.extractTags(entity),
        properties: entity.properties || {},
      },
      identifiers: this.extractIdentifiers(entity),
      source: 'dynatrace',
      source_id: entity.entityId,
      confidence_score: 95, // High confidence from APM monitoring
    };

    // Resource-specific transformations
    switch (resourceId) {
      case 'hosts':
        return this.transformHost(entity, transformedCI);
      case 'processes':
        return this.transformProcess(entity, transformedCI);
      case 'services':
        return this.transformService(entity, transformedCI);
      case 'applications':
        return this.transformApplication(entity, transformedCI);
      default:
        return transformedCI;
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    const entity: DynatraceEntity = data;
    const props = entity.properties || {};

    return {
      external_id: entity.entityId,
      hostname: props['hostname'] || props['hostName'] || entity.displayName,
      ip_address: props['ipAddress'] ? [props['ipAddress']] :
                  props['ipAddresses'] ? props['ipAddresses'] : undefined,
      fqdn: props['fqdn'],
      custom_identifiers: {
        dynatrace_id: entity.entityId,
        entity_name: entity.displayName,
      },
    };
  }

  /**
   * Map resource ID to Dynatrace entity type selector
   */
  private getEntityTypeSelector(resourceId: string): string | null {
    const mapping: Record<string, string> = {
      'hosts': 'type("HOST")',
      'processes': 'type("PROCESS_GROUP_INSTANCE")',
      'services': 'type("SERVICE")',
      'applications': 'type("APPLICATION")',
    };

    return mapping[resourceId] || null;
  }

  /**
   * Map Dynatrace relationship type to CMDB relationship type
   */
  private mapRelationType(dynatraceType: string): string {
    const mapping: Record<string, string> = {
      'runsOn': 'RUNS_ON',
      'isProcessOf': 'RUNS_ON',
      'isSiteOf': 'BELONGS_TO',
      'isInstanceOf': 'INSTANCE_OF',
      'calls': 'CONNECTS_TO',
      'runsOnHost': 'RUNS_ON',
      'runs': 'HOSTS',
    };

    return mapping[dynatraceType] || 'RELATED_TO';
  }

  /**
   * Extract environment from Dynatrace entity
   */
  private extractEnvironment(entity: DynatraceEntity): string {
    // Check tags for environment indicators
    const tags = entity.tags || [];
    for (const tag of tags) {
      const key = tag.key.toLowerCase();
      if (key.includes('environment') || key === 'env') {
        const value = tag.value?.toLowerCase() || '';
        if (['production', 'prod'].includes(value)) return 'production';
        if (['staging', 'stage'].includes(value)) return 'staging';
        if (['development', 'dev'].includes(value)) return 'development';
        if (['test', 'testing'].includes(value)) return 'test';
      }
    }

    // Check properties
    const props = entity.properties || {};
    if (props['environment']) {
      const env = props['environment'].toLowerCase();
      if (['production', 'prod'].includes(env)) return 'production';
      if (['staging', 'stage'].includes(env)) return 'staging';
      if (['development', 'dev'].includes(env)) return 'development';
      if (['test', 'testing'].includes(env)) return 'test';
    }

    // Default to production
    return 'production';
  }

  /**
   * Determine status based on lastSeenTms
   */
  private determineStatus(entity: DynatraceEntity): string {
    if (!entity.lastSeenTms) {
      return 'active'; // No last seen time, assume active
    }

    const lastSeen = new Date(entity.lastSeenTms);
    const now = new Date();
    const hoursSinceLastSeen = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60);

    // If not seen in last 24 hours, mark as inactive
    return hoursSinceLastSeen > 24 ? 'inactive' : 'active';
  }

  /**
   * Extract tags as array of key:value strings
   */
  private extractTags(entity: DynatraceEntity): string[] {
    if (!entity.tags) {
      return [];
    }

    return entity.tags.map(tag =>
      tag.value ? `${tag.key}:${tag.value}` : tag.key
    );
  }

  /**
   * Transform host-specific attributes
   */
  private transformHost(entity: DynatraceEntity, baseCI: TransformedCI): TransformedCI {
    const props = entity.properties || {};

    return {
      ...baseCI,
      attributes: {
        ...baseCI.attributes,
        os_type: props['osType'],
        os_version: props['osVersion'],
        cpu_cores: props['cpuCores'],
        physical_memory: props['physicalMemory'],
        hypervisor_type: props['hypervisorType'],
        cloud_type: props['cloudType'],
        bosh_availability_zone: props['boshAvailabilityZone'],
        paas_agent_version: props['paasAgentVersion'],
        monitoring_mode: props['monitoringMode'],
      },
    };
  }

  /**
   * Transform process-specific attributes
   */
  private transformProcess(entity: DynatraceEntity, baseCI: TransformedCI): TransformedCI {
    const props = entity.properties || {};

    return {
      ...baseCI,
      ci_type: 'process',
      attributes: {
        ...baseCI.attributes,
        process_type: props['softwareTechnologies']?.[0] || 'unknown',
        software_technologies: props['softwareTechnologies'],
        listening_ports: props['listeningPorts'],
        metadata: props['metadata'],
      },
    };
  }

  /**
   * Transform service-specific attributes
   */
  private transformService(entity: DynatraceEntity, baseCI: TransformedCI): TransformedCI {
    const props = entity.properties || {};

    return {
      ...baseCI,
      ci_type: 'service',
      attributes: {
        ...baseCI.attributes,
        service_type: props['serviceType'],
        service_technology_types: props['serviceTechnologyTypes'],
        web_service_namespace: props['webServiceNamespace'],
        web_service_name: props['webServiceName'],
        database_vendor: props['databaseVendor'],
        database_name: props['databaseName'],
      },
    };
  }

  /**
   * Transform application-specific attributes
   */
  private transformApplication(entity: DynatraceEntity, baseCI: TransformedCI): TransformedCI {
    const props = entity.properties || {};

    return {
      ...baseCI,
      ci_type: 'application',
      attributes: {
        ...baseCI.attributes,
        application_type: props['applicationType'],
        application_name: props['applicationName'] || entity.displayName,
        public_domain_names: props['publicDomainNames'],
        real_user_monitoring_enabled: props['realUserMonitoringEnabled'],
        cost_control_user_session_percentage: props['costControlUserSessionPercentage'],
      },
    };
  }
}
