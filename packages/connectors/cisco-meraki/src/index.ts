// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cisco Meraki Dashboard Connector (v1.0)
 * Multi-resource integration with Cisco Meraki Dashboard API
 * Supports organizations, networks, devices, and clients discovery
 * Implements rate limiting (5 requests/second) and relationship inference
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
 * Rate limiter for Meraki API (5 requests per second)
 */
class RateLimiter {
  private queue: Array<() => void> = [];
  private processing = false;
  private readonly intervalMs: number;

  constructor(requestsPerSecond: number = 5) {
    this.intervalMs = 1000 / requestsPerSecond;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const fn = this.queue.shift();
      if (fn) {
        await fn();
        await this.delay(this.intervalMs);
      }
    }

    this.processing = false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

interface MerakiOrganization {
  id: string;
  name: string;
  url?: string;
  api?: {
    enabled: boolean;
  };
  licensing?: {
    model: string;
  };
  cloud?: {
    region: {
      name: string;
    };
  };
}

interface MerakiNetwork {
  id: string;
  organizationId: string;
  name: string;
  productTypes: string[];
  timeZone: string;
  tags?: string[];
  enrollmentString?: string;
  url?: string;
  notes?: string;
  isBoundToConfigTemplate?: boolean;
}

interface MerakiDevice {
  serial: string;
  mac: string;
  name?: string;
  model: string;
  productType?: string;
  networkId: string;
  address?: string;
  lat?: number;
  lng?: number;
  notes?: string;
  tags?: string[];
  lanIp?: string;
  firmware?: string;
  floorPlanId?: string;
}

interface MerakiClient {
  id: string;
  mac: string;
  description?: string;
  ip?: string;
  ip6?: string;
  user?: string;
  vlan?: number;
  switchport?: string;
  adaptivePolicyGroup?: string;
  deviceTypePrediction?: string;
  recentDeviceSerial?: string;
  recentDeviceName?: string;
  recentDeviceMac?: string;
  os?: string;
  manufacturer?: string;
  status?: string;
  notes?: string;
  smInstalled?: boolean;
  namedVlan?: string;
}

export default class CiscoMerakiConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private rateLimiter: RateLimiter;
  private baseUrl: string;
  private organizationIds: string[];

  // Cache for relationships
  private organizationCache: Map<string, MerakiOrganization> = new Map();
  private networkCache: Map<string, MerakiNetwork> = new Map();
  private deviceCache: Map<string, MerakiDevice> = new Map();

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.baseUrl = config.connection['base_url'] || 'https://api.meraki.com/api/v1';
    this.organizationIds = config.connection['organization_ids'] || [];

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'X-Cisco-Meraki-API-Key': config.connection['api_key'],
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });

    // Initialize rate limiter (5 requests/second)
    const rateLimit = 5;
    this.rateLimiter = new RateLimiter(rateLimit);

    logger.info('Cisco Meraki connector initialized');
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Cisco Meraki connector');
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying organizations endpoint
      const response = await this.rateLimiter.execute(() =>
        this.client.get<MerakiOrganization[]>('/organizations')
      );

      const organizations = response.data;

      return {
        success: true,
        message: 'Successfully connected to Cisco Meraki Dashboard API',
        details: {
          base_url: this.baseUrl,
          organizations_found: organizations.length,
          organization_names: organizations.map(org => org.name),
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  /**
   * Extract data for a specific resource (organizations, networks, devices, clients)
   */
  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    logger.info('Starting Meraki resource extraction');

    switch (resourceId) {
      case 'organizations':
        return this.extractOrganizations(resourceConfig);
      case 'networks':
        return this.extractNetworks(resourceConfig);
      case 'devices':
        return this.extractDevices(resourceConfig);
      case 'clients':
        return this.extractClients(resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Extract organizations
   */
  private async extractOrganizations(_config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.rateLimiter.execute(() =>
        this.client.get<MerakiOrganization[]>('/organizations')
      );

      let organizations = response.data;

      // Filter by specific organization IDs if configured
      if (this.organizationIds.length > 0) {
        organizations = organizations.filter(org => this.organizationIds.includes(org.id));
      }

      for (const org of organizations) {
        // Cache for relationship inference
        this.organizationCache.set(org.id, org);

        extractedData.push({
          external_id: org.id,
          data: org,
          source_type: 'cisco_meraki',
          extracted_at: new Date(),
        });
      }

      logger.info('Organizations extracted', {
        count: extractedData.length,
      });

    } catch (error) {
      logger.error('Organization extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract networks for all organizations
   */
  private async extractNetworks(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const includeConfigTemplates = config?.['include_config_templates'] ?? true;

    try {
      // Get list of organizations to query
      let organizations: string[];

      if (this.organizationCache.size > 0) {
        // Use cached organizations from previous extraction
        organizations = Array.from(this.organizationCache.keys());
      } else if (this.organizationIds.length > 0) {
        // Use configured organization IDs
        organizations = this.organizationIds;
      } else {
        // Query all organizations
        const response = await this.rateLimiter.execute(() =>
          this.client.get<MerakiOrganization[]>('/organizations')
        );
        organizations = response.data.map(org => org.id);
      }

      logger.info('Extracting networks for organizations', {
        organization_count: organizations.length,
      });

      // Extract networks for each organization
      for (const orgId of organizations) {
        try {
          const response = await this.rateLimiter.execute(() =>
            this.client.get<MerakiNetwork[]>(`/organizations/${orgId}/networks`)
          );

          let networks = response.data;

          // Filter out config templates if needed
          if (!includeConfigTemplates) {
            networks = networks.filter(net => !net.isBoundToConfigTemplate);
          }

          for (const network of networks) {
            // Cache for relationship inference
            this.networkCache.set(network.id, network);

            extractedData.push({
              external_id: network.id,
              data: network,
              source_type: 'cisco_meraki',
              extracted_at: new Date(),
            });
          }

          logger.info('Networks extracted for organization');

        } catch (error: any) {
          logger.error('Network extraction failed for organization');
          // Continue with next organization
        }
      }

      logger.info('Networks extraction completed', {
        total_networks: extractedData.length,
      });

    } catch (error) {
      logger.error('Network extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract devices for all networks
   */
  private async extractDevices(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const deviceTypes = config?.['device_types'] || [];

    try {
      // Get list of networks to query
      let networkIds: string[];

      if (this.networkCache.size > 0) {
        // Use cached networks from previous extraction
        networkIds = Array.from(this.networkCache.keys());
      } else {
        logger.warn('No networks cached, extracting networks first');
        // Extract networks first
        const networksData = await this.extractNetworks();
        networkIds = networksData.map(data => data.external_id);
      }

      logger.info('Extracting devices for networks', {
        network_count: networkIds.length,
      });

      // Extract devices for each network
      for (const networkId of networkIds) {
        try {
          const response = await this.rateLimiter.execute(() =>
            this.client.get<MerakiDevice[]>(`/networks/${networkId}/devices`)
          );

          let devices = response.data;

          // Filter by device types if specified
          if (deviceTypes.length > 0) {
            devices = devices.filter(device =>
              device.productType && deviceTypes.includes(device.productType)
            );
          }

          for (const device of devices) {
            // Cache for relationship inference
            this.deviceCache.set(device.serial, device);

            extractedData.push({
              external_id: device.serial,
              data: device,
              source_type: 'cisco_meraki',
              extracted_at: new Date(),
            });
          }

          logger.info('Devices extracted for network');

        } catch (error: any) {
          // 404 errors are normal for networks without devices
          if (error.response?.status !== 404) {
            logger.error('Device extraction failed for network');
          }
          // Continue with next network
        }
      }

      logger.info('Devices extraction completed', {
        total_devices: extractedData.length,
      });

    } catch (error) {
      logger.error('Device extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract clients for all networks
   */
  private async extractClients(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const timespan = config?.['timespan'] || 86400; // Default: last 24 hours
    const perPage = config?.['per_page'] || 1000;

    try {
      // Get list of networks to query
      let networkIds: string[];

      if (this.networkCache.size > 0) {
        // Use cached networks from previous extraction
        networkIds = Array.from(this.networkCache.keys());
      } else {
        logger.warn('No networks cached, extracting networks first');
        // Extract networks first
        const networksData = await this.extractNetworks();
        networkIds = networksData.map(data => data.external_id);
      }

      logger.info('Extracting clients for networks');

      // Extract clients for each network
      for (const networkId of networkIds) {
        try {
          const response = await this.rateLimiter.execute(() =>
            this.client.get<MerakiClient[]>(`/networks/${networkId}/clients`, {
              params: {
                timespan,
                perPage,
              },
            })
          );

          const clients = response.data;

          for (const client of clients) {
            extractedData.push({
              external_id: client.id,
              data: client,
              source_type: 'cisco_meraki',
              extracted_at: new Date(),
            });
          }

          logger.info('Clients extracted for network');

        } catch (error: any) {
          // 404 errors are normal for networks without clients
          if (error.response?.status !== 404) {
            logger.error('Client extraction failed for network');
          }
          // Continue with next network
        }
      }

      logger.info('Clients extraction completed', {
        total_clients: extractedData.length,
      });

    } catch (error) {
      logger.error('Client extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract and infer relationships between resources
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Infer network → organization relationships
      for (const [networkId, network] of this.networkCache.entries()) {
        relationships.push({
          source_external_id: network.organizationId,
          target_external_id: networkId,
          relationship_type: 'CONTAINS',
          properties: {
            description: 'Organization contains network',
          },
        });
      }

      // Infer device → network relationships
      for (const [serial, device] of this.deviceCache.entries()) {
        relationships.push({
          source_external_id: device.networkId,
          target_external_id: serial,
          relationship_type: 'CONTAINS',
          properties: {
            description: 'Network contains device',
            device_model: device.model,
            device_type: device.productType,
          },
        });
      }

      logger.info('Meraki relationships inferred', {
        count: relationships.length,
      });

    } catch (error) {
      logger.error('Meraki relationship extraction failed');
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
      case 'organizations':
        return this.transformOrganization(sourceData);
      case 'networks':
        return this.transformNetwork(sourceData);
      case 'devices':
        return this.transformDevice(sourceData);
      case 'clients':
        return this.transformClient(sourceData);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Transform organization to CMDB format
   */
  private transformOrganization(org: MerakiOrganization): TransformedCI {
    return {
      name: org.name,
      ci_type: 'organization',
      environment: 'production',
      status: 'active',
      attributes: {
        url: org.url,
        api_enabled: org.api?.enabled,
        licensing_model: org.licensing?.model,
        cloud_region: org.cloud?.region?.name,
      },
      identifiers: this.extractIdentifiers({
        external_id: org.id,
        type: 'organization',
      }),
      source: 'cisco_meraki',
      source_id: org.id,
      confidence_score: 100,
    };
  }

  /**
   * Transform network to CMDB format
   */
  private transformNetwork(network: MerakiNetwork): TransformedCI {
    return {
      name: network.name,
      ci_type: 'network',
      environment: 'production',
      status: 'active',
      attributes: {
        organization_id: network.organizationId,
        product_types: network.productTypes,
        time_zone: network.timeZone,
        tags: network.tags,
        url: network.url,
        notes: network.notes,
        is_config_template: network.isBoundToConfigTemplate,
        enrollment_string: network.enrollmentString,
      },
      identifiers: this.extractIdentifiers({
        external_id: network.id,
        type: 'network',
        hostname: network.name,
      }),
      source: 'cisco_meraki',
      source_id: network.id,
      confidence_score: 100,
    };
  }

  /**
   * Transform device to CMDB format
   */
  private transformDevice(device: MerakiDevice): TransformedCI {
    const ipAddresses = [];
    if (device.lanIp) {
      ipAddresses.push(device.lanIp);
    }

    return {
      name: device.name || device.serial,
      ci_type: 'network-device',
      environment: 'production',
      status: 'active',
      attributes: {
        network_id: device.networkId,
        model: device.model,
        product_type: device.productType,
        firmware: device.firmware,
        address: device.address,
        latitude: device.lat,
        longitude: device.lng,
        notes: device.notes,
        tags: device.tags,
        floor_plan_id: device.floorPlanId,
      },
      identifiers: this.extractIdentifiers({
        external_id: device.serial,
        serial_number: device.serial,
        mac_address: [device.mac],
        ip_address: ipAddresses,
        hostname: device.name,
        type: 'device',
      }),
      source: 'cisco_meraki',
      source_id: device.serial,
      confidence_score: 100,
    };
  }

  /**
   * Transform client to CMDB format
   */
  private transformClient(client: MerakiClient): TransformedCI {
    const ipAddresses = [];
    if (client.ip) {
      ipAddresses.push(client.ip);
    }
    if (client.ip6) {
      ipAddresses.push(client.ip6);
    }

    return {
      name: client.description || client.mac,
      ci_type: 'endpoint',
      environment: 'production',
      status: client.status === 'Online' ? 'active' : 'inactive',
      attributes: {
        user: client.user,
        vlan: client.vlan,
        named_vlan: client.namedVlan,
        switchport: client.switchport,
        device_type_prediction: client.deviceTypePrediction,
        recent_device_serial: client.recentDeviceSerial,
        recent_device_name: client.recentDeviceName,
        recent_device_mac: client.recentDeviceMac,
        os: client.os,
        manufacturer: client.manufacturer,
        notes: client.notes,
        sm_installed: client.smInstalled,
        adaptive_policy_group: client.adaptivePolicyGroup,
      },
      identifiers: this.extractIdentifiers({
        external_id: client.id,
        mac_address: [client.mac],
        ip_address: ipAddresses,
        type: 'client',
      }),
      source: 'cisco_meraki',
      source_id: client.id,
      confidence_score: 95,
    };
  }

  /**
   * Extract identification attributes for reconciliation
   */
  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.external_id,
      serial_number: data.serial_number,
      mac_address: data.mac_address,
      ip_address: data.ip_address,
      hostname: data.hostname,
      custom_identifiers: {
        meraki_type: data.type,
      },
    };
  }

  /**
   * Cleanup resources
   */
  override async cleanup(): Promise<void> {
    this.organizationCache.clear();
    this.networkCache.clear();
    this.deviceCache.clear();
    logger.info('Cisco Meraki connector cleanup completed');
  }
}
