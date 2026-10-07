// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Infoblox IPAM/DNS Connector (v1.0)
 * Multi-resource integration with Infoblox for network discovery, DNS records, and DHCP management
 * Supports networks, hosts, DNS records (A/CNAME), and DHCP ranges
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
 * Infoblox WAPI Response Types
 */
interface InfobloxNetwork {
  _ref: string;
  network: string;
  network_view: string;
  comment?: string;
  extattrs?: Record<string, any>;
  utilization?: number;
}

interface InfobloxHostRecord {
  _ref: string;
  name: string;
  ipv4addrs?: Array<{ ipv4addr: string; host: string }>;
  view?: string;
  comment?: string;
  extattrs?: Record<string, any>;
  disable?: boolean;
}

interface InfobloxDNSRecord {
  _ref: string;
  name: string;
  ipv4addr?: string;   // For A records
  canonical?: string;  // For CNAME records
  view?: string;
  comment?: string;
  ttl?: number;
  zone?: string;
}

interface InfobloxDHCPRange {
  _ref: string;
  network: string;
  start_addr: string;
  end_addr: string;
  network_view: string;
  comment?: string;
  server_association_type?: string;
  extattrs?: Record<string, any>;
}

export default class InfobloxConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private gridMasterUrl: string;
  private wapiVersion: string;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.gridMasterUrl = config.connection['grid_master_url'];
    this.wapiVersion = config.connection['wapi_version'] || 'v2.12';

    // Create axios client with basic authentication
    this.client = axios.create({
      baseURL: `${this.gridMasterUrl}/wapi/${this.wapiVersion}`,
      auth: {
        username: config.connection['username'],
        password: config.connection['password'],
      },
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
      httpsAgent: config.connection['verify_ssl'] === false ?
        new (require('https').Agent)({ rejectUnauthorized: false }) :
        undefined,
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Infoblox connector');
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying grid members (always exists)
      const response = await this.client.get('/grid', {
        params: { _max_results: 1 },
      });

      return {
        success: true,
        message: 'Successfully connected to Infoblox Grid Master',
        details: {
          grid_master: this.gridMasterUrl,
          wapi_version: this.wapiVersion,
          available: response.data.length > 0,
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  /**
   * Extract data for a specific resource (networks, hosts, dns_records, dhcp_ranges)
   */
  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    const batchSize = resource.extraction?.batch_size || 1000;

    logger.info('Starting Infoblox resource extraction');

    try {
      switch (resourceId) {
        case 'networks':
          return await this.extractNetworks(resourceConfig, batchSize);
        case 'hosts':
          return await this.extractHosts(resourceConfig, batchSize);
        case 'dns_records':
          return await this.extractDNSRecords(resourceConfig, batchSize);
        case 'dhcp_ranges':
          return await this.extractDHCPRanges(resourceConfig, batchSize);
        default:
          throw new Error(`Unsupported resource: ${resourceId}`);
      }
    } catch (error) {
      logger.error('Infoblox resource extraction failed');
      throw new Error('Connector extraction failed');
    }
  }

  /**
   * Extract network objects from Infoblox
   */
  private async extractNetworks(
    config?: Record<string, any>,
    batchSize: number = 1000
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const networkView = config?.['network_view'] || 'default';

    // Query IPv4 networks
    const params: any = {
      _max_results: batchSize,
      _return_fields: 'network,network_view,comment,extattrs,utilization',
      network_view: networkView,
    };

    const response = await this.client.get('/network', { params });
    const networks: InfobloxNetwork[] = response.data;

    for (const network of networks) {
      extractedData.push({
        external_id: network._ref,
        data: network,
        source_type: 'infoblox',
        extracted_at: new Date(),
      });
    }

    logger.info('Extracted networks from Infoblox');

    return extractedData;
  }

  /**
   * Extract host records from Infoblox
   */
  private async extractHosts(
    config?: Record<string, any>,
    batchSize: number = 1000
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const zoneFilter = config?.['zone_filter'] || '';
    const includeDisabled = config?.['include_disabled'] || false;

    const params: any = {
      _max_results: batchSize,
      _return_fields: 'name,ipv4addrs,view,comment,extattrs,disable',
    };

    if (zoneFilter) {
      params.zone = zoneFilter;
    }

    const response = await this.client.get('/record:host', { params });
    const hosts: InfobloxHostRecord[] = response.data;

    for (const host of hosts) {
      // Skip disabled hosts if not configured to include them
      if (host.disable && !includeDisabled) {
        continue;
      }

      extractedData.push({
        external_id: host._ref,
        data: host,
        source_type: 'infoblox',
        extracted_at: new Date(),
      });
    }

    logger.info('Extracted host records from Infoblox');

    return extractedData;
  }

  /**
   * Extract DNS A and CNAME records from Infoblox
   */
  private async extractDNSRecords(
    config?: Record<string, any>,
    batchSize: number = 1000
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const zoneFilter = config?.['zone_filter'] || '';
    const recordTypes = config?.['record_types'] || ['A', 'CNAME'];

    // Extract A records
    if (recordTypes.includes('A')) {
      const paramsA: any = {
        _max_results: batchSize,
        _return_fields: 'name,ipv4addr,view,comment,ttl,zone',
      };

      if (zoneFilter) {
        paramsA.zone = zoneFilter;
      }

      const responseA = await this.client.get('/record:a', { params: paramsA });
      const aRecords: InfobloxDNSRecord[] = responseA.data;

      for (const record of aRecords) {
        extractedData.push({
          external_id: record._ref,
          data: { ...record, record_type: 'A' },
          source_type: 'infoblox',
          extracted_at: new Date(),
        });
      }
    }

    // Extract CNAME records
    if (recordTypes.includes('CNAME')) {
      const paramsCNAME: any = {
        _max_results: batchSize,
        _return_fields: 'name,canonical,view,comment,ttl,zone',
      };

      if (zoneFilter) {
        paramsCNAME.zone = zoneFilter;
      }

      const responseCNAME = await this.client.get('/record:cname', { params: paramsCNAME });
      const cnameRecords: InfobloxDNSRecord[] = responseCNAME.data;

      for (const record of cnameRecords) {
        extractedData.push({
          external_id: record._ref,
          data: { ...record, record_type: 'CNAME' },
          source_type: 'infoblox',
          extracted_at: new Date(),
        });
      }
    }

    logger.info('Extracted DNS records from Infoblox');

    return extractedData;
  }

  /**
   * Extract DHCP ranges from Infoblox
   */
  private async extractDHCPRanges(
    config?: Record<string, any>,
    batchSize: number = 500
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const networkView = config?.['network_view'] || 'default';

    const params: any = {
      _max_results: batchSize,
      _return_fields: 'network,start_addr,end_addr,network_view,comment,server_association_type,extattrs',
      network_view: networkView,
    };

    const response = await this.client.get('/range', { params });
    const ranges: InfobloxDHCPRange[] = response.data;

    for (const range of ranges) {
      extractedData.push({
        external_id: range._ref,
        data: range,
        source_type: 'infoblox',
        extracted_at: new Date(),
      });
    }

    logger.info('Extracted DHCP ranges from Infoblox');

    return extractedData;
  }

  /**
   * Extract relationships - hosts belong to networks
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Get all hosts with IP addresses
      const hostsResponse = await this.client.get('/record:host', {
        params: {
          _return_fields: 'name,ipv4addrs',
          _max_results: 10000,
        },
      });

      const hosts: InfobloxHostRecord[] = hostsResponse.data;

      // Get all networks
      const networksResponse = await this.client.get('/network', {
        params: {
          _return_fields: 'network',
          _max_results: 10000,
        },
      });

      const networks: InfobloxNetwork[] = networksResponse.data;

      // Match hosts to networks by IP address
      for (const host of hosts) {
        if (!host.ipv4addrs || host.ipv4addrs.length === 0) {
          continue;
        }

        const hostIp = host.ipv4addrs[0]!.ipv4addr;

        // Find which network this host belongs to
        for (const network of networks) {
          if (this.ipInNetwork(hostIp, network.network)) {
            relationships.push({
              source_external_id: host._ref,
              target_external_id: network._ref,
              relationship_type: 'BELONGS_TO',
              properties: {
                ip_address: hostIp,
                network_cidr: network.network,
              },
            });
            break; // Host can only belong to one network at this level
          }
        }
      }

      logger.info('Infoblox relationships inferred', {
        count: relationships.length,
      });

    } catch (error) {
      logger.error('Infoblox relationship extraction failed');
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
      case 'networks':
        return this.transformNetwork(sourceData);
      case 'hosts':
        return this.transformHost(sourceData);
      case 'dns_records':
        return this.transformDNSRecord(sourceData);
      case 'dhcp_ranges':
        return this.transformDHCPRange(sourceData);
      default:
        throw new Error(`Unsupported resource transformation: ${resourceId}`);
    }
  }

  /**
   * Transform network object to CMDB CI
   */
  private transformNetwork(data: InfobloxNetwork): TransformedCI {
    return {
      name: data.network,
      ci_type: 'network',
      environment: this.extractEnvironmentFromExtAttrs(data.extattrs),
      status: 'active',
      attributes: {
        network_cidr: data.network,
        network_view: data.network_view,
        comment: data.comment,
        utilization: data.utilization,
        ...this.extractCustomAttributes(data.extattrs),
      },
      identifiers: {
        external_id: data._ref,
        custom_identifiers: {
          network_cidr: data.network,
          network_view: data.network_view,
        },
      },
      source: 'infoblox',
      source_id: data._ref,
      confidence_score: 95, // Infoblox is highly authoritative for network data
    };
  }

  /**
   * Transform host record to CMDB CI
   */
  private transformHost(data: InfobloxHostRecord): TransformedCI {
    const ipAddresses = data.ipv4addrs?.map(addr => addr.ipv4addr) || [];

    return {
      name: data.name,
      ci_type: 'server',
      environment: this.extractEnvironmentFromExtAttrs(data.extattrs),
      status: data.disable ? 'inactive' : 'active',
      attributes: {
        dns_name: data.name,
        view: data.view,
        comment: data.comment,
        disabled: data.disable,
        ...this.extractCustomAttributes(data.extattrs),
      },
      identifiers: {
        external_id: data._ref,
        hostname: data.name,
        fqdn: data.name,
        ip_address: ipAddresses,
        custom_identifiers: {
          infoblox_ref: data._ref,
        },
      },
      source: 'infoblox',
      source_id: data._ref,
      confidence_score: 90, // High confidence for host records
    };
  }

  /**
   * Transform DNS record to attributes (not a full CI)
   */
  private transformDNSRecord(data: InfobloxDNSRecord & { record_type: string }): TransformedCI {
    const isARecord = data.record_type === 'A';

    return {
      name: data.name,
      ci_type: 'dns-record', // Custom CI type for DNS records
      environment: 'production',
      status: 'active',
      attributes: {
        record_type: data.record_type,
        name: data.name,
        ipv4addr: data.ipv4addr,
        canonical: data.canonical,
        view: data.view,
        comment: data.comment,
        ttl: data.ttl,
        zone: data.zone,
      },
      identifiers: {
        external_id: data._ref,
        hostname: isARecord ? data.name : undefined,
        fqdn: isARecord ? data.name : undefined,
        ip_address: data.ipv4addr ? [data.ipv4addr] : undefined,
        custom_identifiers: {
          infoblox_ref: data._ref,
          record_type: data.record_type,
        },
      },
      source: 'infoblox',
      source_id: data._ref,
      confidence_score: 85,
    };
  }

  /**
   * Transform DHCP range to attributes (not a full CI)
   */
  private transformDHCPRange(data: InfobloxDHCPRange): TransformedCI {
    return {
      name: `DHCP Range ${data.start_addr} - ${data.end_addr}`,
      ci_type: 'dhcp-range', // Custom CI type for DHCP ranges
      environment: this.extractEnvironmentFromExtAttrs(data.extattrs),
      status: 'active',
      attributes: {
        network: data.network,
        start_addr: data.start_addr,
        end_addr: data.end_addr,
        network_view: data.network_view,
        comment: data.comment,
        server_association_type: data.server_association_type,
        ...this.extractCustomAttributes(data.extattrs),
      },
      identifiers: {
        external_id: data._ref,
        custom_identifiers: {
          infoblox_ref: data._ref,
          network: data.network,
          start_addr: data.start_addr,
          end_addr: data.end_addr,
        },
      },
      source: 'infoblox',
      source_id: data._ref,
      confidence_score: 90,
    };
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    // For host records
    if (data.name && data.ipv4addrs) {
      const ipAddresses = data.ipv4addrs.map((addr: any) => addr.ipv4addr);
      return {
        external_id: data._ref,
        hostname: data.name,
        fqdn: data.name,
        ip_address: ipAddresses,
        custom_identifiers: {
          infoblox_ref: data._ref,
        },
      };
    }

    // For networks
    if (data.network) {
      return {
        external_id: data._ref,
        custom_identifiers: {
          infoblox_ref: data._ref,
          network_cidr: data.network,
        },
      };
    }

    // Default
    return {
      external_id: data._ref,
      custom_identifiers: {
        infoblox_ref: data._ref,
      },
    };
  }

  /**
   * Extract environment from Infoblox extensible attributes
   */
  private extractEnvironmentFromExtAttrs(extattrs?: Record<string, any>): string {
    if (!extattrs) return 'production';

    // Common attribute names for environment
    const envKeys = ['Environment', 'environment', 'Env', 'env'];
    for (const key of envKeys) {
      if (extattrs[key]?.value) {
        return extattrs[key].value.toLowerCase();
      }
    }

    return 'production';
  }

  /**
   * Extract custom attributes from Infoblox extensible attributes
   */
  private extractCustomAttributes(extattrs?: Record<string, any>): Record<string, any> {
    if (!extattrs) return {};

    const customAttrs: Record<string, any> = {};
    for (const [key, value] of Object.entries(extattrs)) {
      if (value && typeof value === 'object' && 'value' in value) {
        customAttrs[key] = value.value;
      }
    }

    return customAttrs;
  }

  /**
   * Check if an IP address is within a network CIDR
   */
  private ipInNetwork(ip: string, cidr: string): boolean {
    const parts = cidr.split('/');
    if (parts.length !== 2) {
      return false;
    }
    const [network, prefixLengthStr] = parts;
    const prefixLength = parseInt(prefixLengthStr!, 10);

    const ipToLong = (ipStr: string): number => {
      return ipStr.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    };

    const ipLong = ipToLong(ip);
    const networkLong = ipToLong(network!);
    const mask = ~((1 << (32 - prefixLength)) - 1);

    return (ipLong & mask) === (networkLong & mask);
  }
}
