// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Datadog Monitoring Connector (v1.0)
 * Multi-resource integration with Datadog monitoring platform
 * Supports hosts, containers, services, and monitors
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

export default class DatadogConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private site: string;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.site = config.connection['site'] || 'datadoghq.com';

    this.client = axios.create({
      baseURL: `https://api.${this.site}/api`,
      headers: {
        'DD-API-KEY': config.connection['api_key'],
        'DD-APPLICATION-KEY': config.connection['app_key'],
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Datadog connector');
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by validating API keys
      const response = await this.client.get('/v1/validate');

      return {
        success: response.data.valid === true,
        message: response.data.valid
          ? 'Successfully connected to Datadog'
          : 'Invalid API or Application key',
        details: {
          site: this.site,
          valid: response.data.valid,
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  /**
   * Extract data for a specific resource (hosts, containers, services, monitors)
   */
  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    logger.info('Starting Datadog resource extraction');

    switch (resourceId) {
      case 'hosts':
        return this.extractHosts(resourceConfig);
      case 'containers':
        return this.extractContainers(resourceConfig);
      case 'services':
        return this.extractServices(resourceConfig);
      case 'monitors':
        return this.extractMonitors(resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Extract infrastructure hosts
   */
  private async extractHosts(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const params: any = {
        count: resourceConfig?.['batch_size'] || 1000,
      };

      if (resourceConfig?.['filter']) {
        params.filter = resourceConfig['filter'];
      }

      if (resourceConfig?.['include_muted'] !== undefined) {
        params.include_muted_hosts_data = resourceConfig['include_muted'];
      }

      const response = await this.client.get('/v1/hosts', { params });
      const hosts = response.data.host_list || [];

      for (const host of hosts) {
        extractedData.push({
          external_id: host.id?.toString() || host.name,
          data: host,
          source_type: 'datadog',
          extracted_at: new Date(),
        });
      }

      logger.info('Datadog hosts extracted');

    } catch (error) {
      logger.error('Datadog host extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract containers
   */
  private async extractContainers(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const params: any = {
        page_size: resourceConfig?.['batch_size'] || 1000,
      };

      if (resourceConfig?.['filter']) {
        params.filter = resourceConfig['filter'];
      }

      const response = await this.client.get('/v2/containers', { params });
      const containers = response.data.data || [];

      for (const container of containers) {
        extractedData.push({
          external_id: container.id || container.attributes?.container_id,
          data: container,
          source_type: 'datadog',
          extracted_at: new Date(),
        });
      }

      logger.info('Datadog containers extracted', {
        count: extractedData.length,
      });

    } catch (error) {
      logger.error('Datadog container extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract APM services
   */
  private async extractServices(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const params: any = {
        page_size: resourceConfig?.['batch_size'] || 500,
      };

      if (resourceConfig?.['env']) {
        params.env = resourceConfig['env'];
      }

      const response = await this.client.get('/v2/services/definitions', { params });
      const services = response.data.data || [];

      for (const service of services) {
        extractedData.push({
          external_id: service.id || service.attributes?.name,
          data: service,
          source_type: 'datadog',
          extracted_at: new Date(),
        });
      }

      logger.info('Datadog services extracted', {
        count: extractedData.length,
      });

    } catch (error) {
      logger.error('Datadog service extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract monitors
   */
  private async extractMonitors(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const params: any = {
        page_size: resourceConfig?.['batch_size'] || 1000,
      };

      if (resourceConfig?.['group_states']) {
        params.group_states = resourceConfig['group_states'];
      }

      if (resourceConfig?.['tags']) {
        params.tags = resourceConfig['tags'];
      }

      const response = await this.client.get('/v1/monitor', { params });
      const monitors = Array.isArray(response.data) ? response.data : [];

      for (const monitor of monitors) {
        extractedData.push({
          external_id: monitor.id?.toString(),
          data: monitor,
          source_type: 'datadog',
          extracted_at: new Date(),
        });
      }

      logger.info('Datadog monitors extracted', {
        count: extractedData.length,
      });

    } catch (error) {
      logger.error('Datadog monitor extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract relationships between resources
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    // Infer relationships will be called after extraction
    // We'll implement relationship inference based on extracted data
    logger.info('Datadog relationship extraction - using inferred relationships');

    return relationships;
  }

  /**
   * Infer relationships from extracted data
   * Containers link to hosts, monitors link to services
   */
  inferRelationships(
    extractedData: Map<string, ExtractedData[]>
  ): ExtractedRelationship[] {
    const relationships: ExtractedRelationship[] = [];

    // Container -> Host relationships
    const containers = extractedData.get('containers') || [];
    for (const container of containers) {
      const attributes = container.data['attributes'] || {};
      const hostName = attributes['host'] || container.data['host'];
      if (hostName) {
        relationships.push({
          source_external_id: container.external_id,
          target_external_id: hostName,
          relationship_type: 'HOSTED_ON',
          properties: {
            source_type: 'datadog',
            inferred: true,
          },
        });
      }
    }

    // Monitor -> Service relationships
    const monitors = extractedData.get('monitors') || [];
    const services = extractedData.get('services') || [];
    const serviceNames = new Set(
      services.map(s => {
        const attrs = s.data['attributes'] || {};
        return attrs['name'] || s.data['name'] || '';
      })
    );

    for (const monitor of monitors) {
      const query = monitor.data['query'] || '';
      const monitorTags = monitor.data['tags'] || [];

      // Extract service names from monitor query and tags
      for (const serviceName of serviceNames) {
        if (query.includes(serviceName) || monitorTags.some((tag: string) => tag.includes(serviceName))) {
          // Find the service external_id
          const service = services.find(s => {
            const attrs = s.data['attributes'] || {};
            const name = attrs['name'] || s.data['name'];
            return name === serviceName;
          });
          if (service) {
            relationships.push({
              source_external_id: monitor.external_id,
              target_external_id: service.external_id,
              relationship_type: 'MONITORS',
              properties: {
                source_type: 'datadog',
                inferred: true,
                monitor_type: monitor.data['type'],
              },
            });
          }
        }
      }
    }

    logger.info('Datadog relationships inferred', {
      count: relationships.length,
    });

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
      case 'hosts':
        return this.transformHost(sourceData);
      case 'containers':
        return this.transformContainer(sourceData);
      case 'services':
        return this.transformService(sourceData);
      case 'monitors':
        return this.transformMonitor(sourceData);
      default:
        throw new Error(`Unsupported resource transformation: ${resourceId}`);
    }
  }

  /**
   * Transform Datadog host to CMDB server CI
   */
  private transformHost(host: any): TransformedCI {
    const meta = host.meta || {};
    const metrics = host.metrics || {};

    return {
      name: host.name || host.host_name || 'unknown-host',
      ci_type: 'server',
      environment: this.extractEnvironment(host.tags_by_source || host.tags),
      status: this.mapHostStatus(host.is_muted, host.up),
      attributes: {
        host_id: host.id,
        aliases: host.aliases || [],
        apps: host.apps || [],
        aws_name: host.aws_name,
        is_muted: host.is_muted,
        up: host.up,
        last_reported_time: host.last_reported_time,
        sources: host.sources || [],
        tags_by_source: host.tags_by_source,
        agent_version: meta.agent_version,
        platform: meta.platform,
        processor: meta.processor,
        cpu_cores: meta.cpuCores,
        os: meta.os,
        python_version: meta.pythonV,
        socket_fqdn: meta.socketFqdn,
        socket_hostname: meta.socketHostname,
        cpu_usage: metrics.cpu,
        iowait: metrics.iowait,
        load: metrics.load,
      },
      identifiers: this.extractIdentifiers(host),
      source: 'datadog',
      source_id: host.id?.toString() || host.name,
      confidence_score: 95, // High confidence from monitoring platform
    };
  }

  /**
   * Transform Datadog container to CMDB container CI
   */
  private transformContainer(container: any): TransformedCI {
    const attributes = container.attributes || {};
    const tags = attributes.tags || [];

    return {
      name: attributes.name || attributes.container_name || container.id || 'unknown-container',
      ci_type: 'container',
      environment: this.extractEnvironment(tags),
      status: this.mapContainerStatus(attributes.state),
      attributes: {
        container_id: container.id,
        image_name: attributes.image_name,
        image_tag: attributes.image_tag,
        image_digest: attributes.image_digest,
        state: attributes.state,
        started_at: attributes.started_at,
        host: attributes.host,
        created_at: attributes.created_at,
        runtime: attributes.runtime,
        tags: tags,
      },
      identifiers: {
        external_id: container.id,
        hostname: attributes.name || attributes.container_name,
        custom_identifiers: {
          container_id: container.id,
          image_name: attributes.image_name,
        },
      },
      source: 'datadog',
      source_id: container.id,
      confidence_score: 95,
    };
  }

  /**
   * Transform Datadog APM service to CMDB service CI
   */
  private transformService(service: any): TransformedCI {
    const attributes = service.attributes || {};
    const schema = attributes.schema || {};

    return {
      name: attributes.name || service.id || 'unknown-service',
      ci_type: 'service',
      environment: attributes.env || 'production',
      status: 'active',
      attributes: {
        service_id: service.id,
        env: attributes.env,
        last_seen: attributes.last_seen,
        languages: schema.languages || [],
        type: schema.type,
        dd_service: schema.dd_service,
        schema_version: schema.schema_version,
      },
      identifiers: {
        external_id: service.id,
        hostname: attributes.name,
        custom_identifiers: {
          service_name: attributes.name,
          env: attributes.env,
        },
      },
      source: 'datadog',
      source_id: service.id,
      confidence_score: 90,
    };
  }

  /**
   * Transform Datadog monitor (metadata only, not a CI)
   */
  private transformMonitor(monitor: any): TransformedCI {
    return {
      name: monitor.name || monitor.id?.toString() || 'unknown-monitor',
      ci_type: 'service', // Monitors are metadata, not CIs - we map to service for now
      environment: this.extractEnvironment(monitor.tags),
      status: this.mapMonitorStatus(monitor.overall_state),
      attributes: {
        monitor_id: monitor.id,
        type: monitor.type,
        query: monitor.query,
        message: monitor.message,
        tags: monitor.tags || [],
        options: monitor.options,
        overall_state: monitor.overall_state,
        created: monitor.created,
        modified: monitor.modified,
        creator: monitor.creator,
      },
      identifiers: {
        external_id: monitor.id?.toString(),
        custom_identifiers: {
          monitor_id: monitor.id?.toString(),
          monitor_name: monitor.name,
        },
      },
      source: 'datadog',
      source_id: monitor.id?.toString(),
      confidence_score: 100,
    };
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    const meta = data['meta'] || {};
    const dataId = data['id'];
    const dataName = data['name'];
    const hostName = data['host_name'];
    const awsName = data['aws_name'];

    return {
      external_id: dataId?.toString() || dataName || 'unknown',
      hostname: dataName || hostName || meta['socketHostname'],
      fqdn: meta['socketFqdn'],
      custom_identifiers: {
        datadog_id: dataId?.toString() || '',
        aws_name: awsName || '',
      },
    };
  }

  /**
   * Extract environment from Datadog tags
   */
  private extractEnvironment(tags: any): string {
    let tagArray: string[] = [];

    if (Array.isArray(tags)) {
      tagArray = tags;
    } else if (typeof tags === 'object') {
      // tags_by_source format
      tagArray = Object.values(tags).flat() as string[];
    }

    // Look for env: tags
    const envTag = tagArray.find((tag: string) =>
      tag.startsWith('env:') || tag.startsWith('environment:')
    );

    if (envTag) {
      const env = envTag.split(':')[1]?.toLowerCase();
      if (['production', 'staging', 'development', 'test'].includes(env)) {
        return env;
      }
    }

    return 'production'; // Default
  }

  /**
   * Map Datadog host status to CMDB status
   */
  private mapHostStatus(isMuted: boolean, isUp: boolean): string {
    if (isMuted) {
      return 'maintenance';
    }
    if (isUp === false) {
      return 'inactive';
    }
    return 'active';
  }

  /**
   * Map Datadog container status to CMDB status
   */
  private mapContainerStatus(state: string): string {
    const stateMap: Record<string, string> = {
      'running': 'active',
      'paused': 'maintenance',
      'stopped': 'inactive',
      'exited': 'inactive',
      'dead': 'decommissioned',
    };

    return stateMap[state?.toLowerCase()] || 'active';
  }

  /**
   * Map Datadog monitor overall state to CMDB status
   */
  private mapMonitorStatus(overallState: string): string {
    const stateMap: Record<string, string> = {
      'OK': 'active',
      'Alert': 'active', // Monitor is active, just alerting
      'Warn': 'active',
      'No Data': 'maintenance',
      'Ignored': 'maintenance',
    };

    return stateMap[overallState] || 'active';
  }
}
