// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AppDynamics APM Connector (v1.0)
 * Multi-resource integration with AppDynamics Application Performance Monitoring
 * Supports applications, tiers, nodes, and backends with relationship inference
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
 * AppDynamics API Response Types
 */
interface AppDynamicsApplication {
  id: number;
  name: string;
  description?: string;
  active?: boolean;
}

interface AppDynamicsTier {
  id: number;
  name: string;
  description?: string;
  type?: string;
  agentType?: string;
  numberOfNodes?: number;
}

interface AppDynamicsNode {
  id: number;
  name: string;
  type?: string;
  tierName?: string;
  tierId?: number;
  machineId?: number;
  machineName?: string;
  machineOSType?: string;
  machineAgentVersion?: string;
  appAgentVersion?: string;
  ipAddresses?: Record<string, string>;
}

interface AppDynamicsBackend {
  id: number;
  name: string;
  exitPointType?: string;
  tierId?: number;
  properties?: Array<{
    name: string;
    value: string;
  }>;
}

export default class AppDynamicsConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private controllerUrl: string;
  private accountName: string;
  private username: string;

  // Cache for extracted data to support relationship inference
  private applicationsCache: Map<number, AppDynamicsApplication> = new Map();
  private tiersCache: Map<string, AppDynamicsTier> = new Map(); // key: "appId:tierId"
  private nodesCache: Map<string, AppDynamicsNode> = new Map(); // key: "appId:nodeId"

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.controllerUrl = config.connection['controller_url'].replace(/\/$/, '');
    this.accountName = config.connection['account_name'];
    this.username = config.connection['username'];
    const password = config.connection['password'];

    // AppDynamics uses username@accountName format for authentication
    const authUsername = `${this.username}@${this.accountName}`;

    this.client = axios.create({
      baseURL: this.controllerUrl,
      auth: {
        username: authUsername,
        password: password,
      },
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing AppDynamics connector');
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by listing applications
      const response = await this.client.get('/controller/rest/applications', {
        params: { output: 'json' },
      });

      const applications = response.data;
      const applicationCount = Array.isArray(applications) ? applications.length : 0;

      return {
        success: true,
        message: 'Successfully connected to AppDynamics Controller',
        details: {
          controller: this.controllerUrl,
          account: this.accountName,
          applications_found: applicationCount,
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  /**
   * Extract data for a specific resource (applications, tiers, nodes, backends)
   */
  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    logger.info('Starting AppDynamics resource extraction');

    switch (resourceId) {
      case 'applications':
        return this.extractApplications(resourceConfig);
      case 'tiers':
        return this.extractTiers(resourceConfig);
      case 'nodes':
        return this.extractNodes(resourceConfig);
      case 'backends':
        return this.extractBackends(resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Extract applications from AppDynamics
   */
  private async extractApplications(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const includeInactive = config?.['include_inactive'] ?? false;

    try {
      const response = await this.client.get('/controller/rest/applications', {
        params: { output: 'json' },
      });

      const applications: AppDynamicsApplication[] = response.data || [];

      for (const app of applications) {
        // Filter inactive applications if requested
        if (!includeInactive && app.active === false) {
          continue;
        }

        // Cache application for relationship inference
        this.applicationsCache.set(app.id, app);

        extractedData.push({
          external_id: `app-${app.id}`,
          data: app,
          source_type: 'appdynamics',
          extracted_at: new Date(),
        });
      }

      logger.info('AppDynamics applications extracted', {
        total: extractedData.length,
      });

    } catch (error) {
      logger.error('Failed to extract AppDynamics applications');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract tiers from all applications
   */
  private async extractTiers(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const tierTypes = config?.['tier_types'] || [];

    try {
      // Get all applications first
      const applications = Array.from(this.applicationsCache.values());
      if (applications.length === 0) {
        logger.warn('No applications in cache, extracting applications first');
        await this.extractApplications();
      }

      // Extract tiers for each application
      for (const app of Array.from(this.applicationsCache.values())) {
        try {
          const response = await this.client.get(
            `/controller/rest/applications/${app.id}/tiers`,
            { params: { output: 'json' } }
          );

          const tiers: AppDynamicsTier[] = response.data || [];

          for (const tier of tiers) {
            // Filter by tier type if specified
            if (tierTypes.length > 0 && tier.type && !tierTypes.includes(tier.type)) {
              continue;
            }

            // Cache tier for relationship inference
            const cacheKey = `${app.id}:${tier.id}`;
            this.tiersCache.set(cacheKey, { ...tier, /* store appId in extended object */ });

            extractedData.push({
              external_id: `tier-${app.id}-${tier.id}`,
              data: {
                ...tier,
                applicationId: app.id,
                applicationName: app.name,
              },
              source_type: 'appdynamics',
              extracted_at: new Date(),
            });
          }

        } catch (error) {
          logger.error('Failed to extract tiers for application');
        }
      }

      logger.info('AppDynamics tiers extracted', {
        total: extractedData.length,
      });

    } catch (error) {
      logger.error('Failed to extract AppDynamics tiers');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract nodes from all applications
   */
  private async extractNodes(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const includeHistorical = config?.['include_historical'] ?? false;

    try {
      // Get all applications first
      const applications = Array.from(this.applicationsCache.values());
      if (applications.length === 0) {
        logger.warn('No applications in cache, extracting applications first');
        await this.extractApplications();
      }

      // Extract nodes for each application
      for (const app of Array.from(this.applicationsCache.values())) {
        try {
          const response = await this.client.get(
            `/controller/rest/applications/${app.id}/nodes`,
            { params: { output: 'json' } }
          );

          const nodes: AppDynamicsNode[] = response.data || [];

          for (const node of nodes) {
            // Filter historical nodes if not requested
            // (AppDynamics doesn't have a clear "historical" flag, but we can check for missing properties)
            if (!includeHistorical && !node.tierName && !node.machineId) {
              continue;
            }

            // Cache node for relationship inference
            const cacheKey = `${app.id}:${node.id}`;
            this.nodesCache.set(cacheKey, node);

            extractedData.push({
              external_id: `node-${app.id}-${node.id}`,
              data: {
                ...node,
                applicationId: app.id,
                applicationName: app.name,
              },
              source_type: 'appdynamics',
              extracted_at: new Date(),
            });
          }

        } catch (error) {
          logger.error('Failed to extract nodes for application');
        }
      }

      logger.info('AppDynamics nodes extracted', {
        total: extractedData.length,
      });

    } catch (error) {
      logger.error('Failed to extract AppDynamics nodes');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract backends from all applications
   */
  private async extractBackends(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const backendTypes = config?.['backend_types'] || [];

    try {
      // Get all applications first
      const applications = Array.from(this.applicationsCache.values());
      if (applications.length === 0) {
        logger.warn('No applications in cache, extracting applications first');
        await this.extractApplications();
      }

      // Extract backends for each application
      for (const app of Array.from(this.applicationsCache.values())) {
        try {
          const response = await this.client.get(
            `/controller/rest/applications/${app.id}/backends`,
            { params: { output: 'json' } }
          );

          const backends: AppDynamicsBackend[] = response.data || [];

          for (const backend of backends) {
            // Filter by backend type if specified
            if (backendTypes.length > 0 && backend.exitPointType &&
                !backendTypes.includes(backend.exitPointType)) {
              continue;
            }

            extractedData.push({
              external_id: `backend-${app.id}-${backend.id}`,
              data: {
                ...backend,
                applicationId: app.id,
                applicationName: app.name,
              },
              source_type: 'appdynamics',
              extracted_at: new Date(),
            });
          }

        } catch (error) {
          logger.error('Failed to extract backends for application');
        }
      }

      logger.info('AppDynamics backends extracted', {
        total: extractedData.length,
      });

    } catch (error) {
      logger.error('Failed to extract AppDynamics backends');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract relationships between AppDynamics entities
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Relationship 1: Nodes -> Tiers (BELONGS_TO)
      for (const [nodeKey, node] of this.nodesCache.entries()) {
        const [appId, nodeId] = nodeKey.split(':');

        if (node.tierId) {
          const tierKey = `${appId}:${node.tierId}`;
          if (this.tiersCache.has(tierKey)) {
            relationships.push({
              source_external_id: `node-${appId}-${nodeId}`,
              target_external_id: `tier-${appId}-${node.tierId}`,
              relationship_type: 'BELONGS_TO',
              properties: {
                tier_name: node.tierName,
              },
            });
          }
        }
      }

      // Relationship 2: Tiers -> Applications (BELONGS_TO)
      for (const [tierKey, tier] of this.tiersCache.entries()) {
        const [appId, tierId] = tierKey.split(':');

        if (appId && this.applicationsCache.has(parseInt(appId))) {
          relationships.push({
            source_external_id: `tier-${appId}-${tierId}`,
            target_external_id: `app-${appId}`,
            relationship_type: 'BELONGS_TO',
            properties: {
              tier_type: tier.type,
            },
          });
        }
      }

      logger.info('AppDynamics relationships extracted', {
        count: relationships.length,
      });

    } catch (error) {
      logger.error('AppDynamics relationship extraction failed');
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

    switch (resourceId) {
      case 'applications':
        return this.transformApplication(sourceData);
      case 'tiers':
        return this.transformTier(sourceData);
      case 'nodes':
        return this.transformNode(sourceData);
      case 'backends':
        return this.transformBackend(sourceData);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Transform application to CMDB format
   */
  private transformApplication(data: any): TransformedCI {
    const app = data as AppDynamicsApplication;

    return {
      name: app.name,
      ci_type: 'application',
      environment: 'production', // AppDynamics doesn't provide environment info
      status: app.active === false ? 'inactive' : 'active',
      attributes: {
        description: app.description,
        appdynamics_id: app.id,
        source: 'appdynamics',
      },
      identifiers: this.extractIdentifiers(data),
      source: 'appdynamics',
      source_id: `app-${app.id}`,
      confidence_score: 95, // High confidence from APM tool
    };
  }

  /**
   * Transform tier to CMDB format
   */
  private transformTier(data: any): TransformedCI {
    const tier = data as AppDynamicsTier & { applicationId: number; applicationName: string };

    return {
      name: `${tier.applicationName} - ${tier.name}`,
      ci_type: 'service',
      environment: 'production',
      status: 'active',
      attributes: {
        description: tier.description,
        tier_type: tier.type,
        agent_type: tier.agentType,
        number_of_nodes: tier.numberOfNodes,
        appdynamics_tier_id: tier.id,
        appdynamics_app_id: tier.applicationId,
        application_name: tier.applicationName,
        source: 'appdynamics',
      },
      identifiers: this.extractIdentifiers(data),
      source: 'appdynamics',
      source_id: `tier-${tier.applicationId}-${tier.id}`,
      confidence_score: 95,
    };
  }

  /**
   * Transform node to CMDB format
   */
  private transformNode(data: any): TransformedCI {
    const node = data as AppDynamicsNode & { applicationId: number; applicationName: string };

    // Extract IP addresses from ipAddresses object
    const ipAddresses: string[] = [];
    if (node.ipAddresses) {
      for (const value of Object.values(node.ipAddresses)) {
        if (value && typeof value === 'string') {
          ipAddresses.push(value);
        }
      }
    }

    return {
      name: node.name,
      ci_type: 'server',
      environment: 'production',
      status: 'active',
      attributes: {
        node_type: node.type,
        tier_name: node.tierName,
        machine_name: node.machineName,
        machine_os_type: node.machineOSType,
        machine_agent_version: node.machineAgentVersion,
        app_agent_version: node.appAgentVersion,
        appdynamics_node_id: node.id,
        appdynamics_tier_id: node.tierId,
        appdynamics_machine_id: node.machineId,
        appdynamics_app_id: node.applicationId,
        application_name: node.applicationName,
        source: 'appdynamics',
      },
      identifiers: {
        ...this.extractIdentifiers(data),
        hostname: node.name,
        ip_address: ipAddresses.length > 0 ? ipAddresses : undefined,
      },
      source: 'appdynamics',
      source_id: `node-${node.applicationId}-${node.id}`,
      confidence_score: 90,
    };
  }

  /**
   * Transform backend to CMDB format
   */
  private transformBackend(data: any): TransformedCI {
    const backend = data as AppDynamicsBackend & { applicationId: number; applicationName: string };

    // Extract properties from backend
    const backendProperties: Record<string, string> = {};
    if (backend.properties) {
      for (const prop of backend.properties) {
        backendProperties[prop.name] = prop.value;
      }
    }

    // Determine service type based on exitPointType
    const serviceType = this.mapBackendTypeToServiceType(backend.exitPointType);

    return {
      name: backend.name,
      ci_type: 'service',
      environment: 'production',
      status: 'active',
      attributes: {
        service_type: serviceType,
        backend_type: backend.exitPointType,
        appdynamics_backend_id: backend.id,
        appdynamics_tier_id: backend.tierId,
        appdynamics_app_id: backend.applicationId,
        application_name: backend.applicationName,
        properties: backendProperties,
        source: 'appdynamics',
      },
      identifiers: this.extractIdentifiers(data),
      source: 'appdynamics',
      source_id: `backend-${backend.applicationId}-${backend.id}`,
      confidence_score: 85,
    };
  }

  /**
   * Map AppDynamics backend type to service type
   */
  private mapBackendTypeToServiceType(exitPointType?: string): string {
    if (!exitPointType) {
      return 'external';
    }

    const mapping: Record<string, string> = {
      'DB': 'database',
      'HTTP': 'web_service',
      'WEB_SERVICE': 'web_service',
      'CACHE': 'cache',
      'MESSAGING': 'message_queue',
      'JMS': 'message_queue',
      'CASSANDRA': 'database',
      'MONGODB': 'database',
      'RABBITMQ': 'message_queue',
      'KAFKA': 'message_queue',
    };

    return mapping[exitPointType.toUpperCase()] || 'external';
  }

  /**
   * Extract identification attributes for reconciliation
   */
  extractIdentifiers(data: any): IdentificationAttributes {
    // For applications
    if (data.id && !data.applicationId) {
      return {
        external_id: `app-${data.id}`,
        custom_identifiers: {
          appdynamics_app_id: String(data.id),
          appdynamics_app_name: data.name,
        },
      };
    }

    // For tiers
    if (data.id && data.applicationId && data.tierName !== undefined) {
      return {
        external_id: `tier-${data.applicationId}-${data.id}`,
        custom_identifiers: {
          appdynamics_tier_id: String(data.id),
          appdynamics_app_id: String(data.applicationId),
          tier_name: data.name,
        },
      };
    }

    // For nodes
    if (data.id && data.applicationId && data.machineId !== undefined) {
      const ipAddresses: string[] = [];
      if (data.ipAddresses) {
        for (const value of Object.values(data.ipAddresses)) {
          if (value && typeof value === 'string') {
            ipAddresses.push(value);
          }
        }
      }

      return {
        external_id: `node-${data.applicationId}-${data.id}`,
        hostname: data.name,
        ip_address: ipAddresses.length > 0 ? ipAddresses : undefined,
        custom_identifiers: {
          appdynamics_node_id: String(data.id),
          appdynamics_machine_id: String(data.machineId),
          appdynamics_app_id: String(data.applicationId),
          machine_name: data.machineName,
        },
      };
    }

    // For backends
    if (data.id && data.applicationId && data.exitPointType !== undefined) {
      return {
        external_id: `backend-${data.applicationId}-${data.id}`,
        custom_identifiers: {
          appdynamics_backend_id: String(data.id),
          appdynamics_app_id: String(data.applicationId),
          backend_type: data.exitPointType,
        },
      };
    }

    // Fallback
    return {
      external_id: data.id ? String(data.id) : '',
      custom_identifiers: {
        appdynamics_id: data.id ? String(data.id) : '',
      },
    };
  }
}
