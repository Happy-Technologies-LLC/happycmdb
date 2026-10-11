// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenable.io Vulnerability Management Connector (v1.0)
 * Comprehensive integration with Tenable.io for vulnerability management
 * Supports devices, vulnerabilities, assets, and plugins
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

interface TenableDevice {
  id: string;
  uuid: string;
  hostname?: string;
  fqdn?: string;
  ipv4?: string[];
  ipv6?: string[];
  mac_address?: string[];
  netbios_name?: string;
  operating_system?: string[];
  system_type?: string[];
  has_agent?: boolean;
  first_seen?: string;
  last_seen?: string;
  last_authenticated_scan?: string;
  sources?: Array<{
    name: string;
    first_seen: string;
    last_seen: string;
  }>;
  tags?: Array<{
    key: string;
    value: string;
    uuid: string;
  }>;
}

interface TenableVulnerability {
  plugin_id: number;
  plugin_name: string;
  plugin_family: string;
  severity: number;
  severity_name: string;
  count: number;
  vpr_score?: number;
  cvss_base_score?: number;
  cvss_temporal_score?: number;
  cvss_vector?: string;
  cvss3_base_score?: number;
  cvss3_temporal_score?: number;
  cvss3_vector?: string;
  cve?: string[];
  description?: string;
  solution?: string;
  synopsis?: string;
  first_found?: string;
  last_found?: string;
  state?: string;
  accepted_count?: number;
  recasted_count?: number;
  asset_uuids?: string[];
}

interface TenableAsset {
  id: string;
  uuid: string;
  has_agent?: boolean;
  created_at?: string;
  updated_at?: string;
  first_seen?: string;
  last_seen?: string;
  first_scan_time?: string;
  last_scan_time?: string;
  last_authenticated_scan_date?: string;
  ipv4?: string[];
  ipv6?: string[];
  fqdn?: string[];
  netbios_name?: string[];
  hostname?: string[];
  mac_address?: string[];
  operating_system?: string[];
  system_type?: string[];
  agent_name?: string[];
  bios_uuid?: string[];
  aws_ec2_instance_id?: string[];
  aws_ec2_name?: string[];
  aws_region?: string[];
  azure_vm_id?: string[];
  azure_resource_id?: string[];
  gcp_instance_id?: string[];
  exposure_score?: number;
  tags?: Array<{
    key: string;
    value: string;
    uuid: string;
  }>;
}

interface TenablePlugin {
  id: number;
  name: string;
  family_name: string;
  description: string;
  synopsis?: string;
  solution?: string;
  risk_factor?: string;
  cvss_base_score?: number;
  cvss_temporal_score?: number;
  cvss_vector?: string;
  cvss3_base_score?: number;
  cvss3_temporal_score?: number;
  cvss3_vector?: string;
  cve?: string[];
  bid?: number[];
  xref?: string[];
  see_also?: string[];
  plugin_publication_date?: string;
  plugin_modification_date?: string;
  vuln_publication_date?: string;
  patch_publication_date?: string;
  exploitability_ease?: string;
  exploit_available?: boolean;
  exploit_framework_canvas?: boolean;
  exploit_framework_metasploit?: boolean;
  exploit_framework_core?: boolean;
  metasploit_name?: string;
  canvas_package?: string;
  vpr_score?: number;
}

export default class TenableConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private apiUrl: string;
  private accessKey: string;
  private secretKey: string;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.apiUrl = config.connection['api_url'] || 'https://cloud.tenable.com';
    this.accessKey = config.connection['access_key'];
    this.secretKey = config.connection['secret_key'];

    const verifySSL = config.connection['verify_ssl'] !== false;

    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-ApiKeys': `accessKey=${this.accessKey}; secretKey=${this.secretKey}`,
      },
      timeout: 60000,
      httpsAgent: verifySSL ? undefined : new (require('https').Agent)({
        rejectUnauthorized: false,
      }),
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Tenable.io connector');
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying server info endpoint
      const response = await this.client.get('/server/properties');

      return {
        success: true,
        message: 'Successfully connected to Tenable.io',
        details: {
          api_url: this.apiUrl,
          server_version: response.data?.server_version,
          nessus_ui_version: response.data?.nessus_ui_version,
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

    logger.info('Starting Tenable resource extraction');

    switch (resourceId) {
      case 'devices':
        return this.extractDevices(resourceConfig);
      case 'vulnerabilities':
        return this.extractVulnerabilities(resourceConfig);
      case 'assets':
        return this.extractAssets(resourceConfig);
      case 'plugins':
        return this.extractPlugins(resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Extract devices from Tenable.io
   */
  private async extractDevices(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 1000;
    let offset = 0;
    let hasMore = true;

    // Build filter
    const filters: any = {};

    const sourceFilter = resourceConfig?.['source_filter'];
    if (sourceFilter && sourceFilter.length > 0) {
      filters['sources.name'] = sourceFilter;
    }

    const hasAgentFilter = resourceConfig?.['has_agent_filter'];
    if (typeof hasAgentFilter === 'boolean') {
      filters['has_agent'] = hasAgentFilter;
    }

    const osFilter = resourceConfig?.['operating_systems'];
    if (osFilter && osFilter.length > 0) {
      filters['operating_system'] = osFilter;
    }

    logger.info('Extracting Tenable devices');

    while (hasMore) {
      try {
        const response = await this.client.get('/devices/v2', {
          params: {
            size: batchSize,
            offset,
            ...(Object.keys(filters).length > 0 && { filter: JSON.stringify(filters) }),
          },
        });

        const devices: TenableDevice[] = response.data?.devices || [];

        for (const device of devices) {
          extractedData.push({
            external_id: device.uuid || device.id,
            data: device,
            source_type: 'tenable',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of Tenable devices', {
          batch_size: devices.length,
          total_extracted: extractedData.length,
        });

        hasMore = devices.length === batchSize;
        offset += batchSize;

      } catch (error) {
        logger.error('Tenable device extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('Tenable device extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract vulnerabilities from Tenable.io
   */
  private async extractVulnerabilities(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 5000;
    let offset = 0;
    let hasMore = true;

    // Build filter
    const severityFilter = resourceConfig?.['severity_filter'] || ['critical', 'high', 'medium'];
    const stateFilter = resourceConfig?.['state_filter'] || ['open', 'reopened'];
    const daysBack = resourceConfig?.['days_back'] || 90;
    const includeAcceptedRisk = resourceConfig?.['include_accepted_risk'] || false;

    const severityMap: Record<string, number> = {
      'critical': 4,
      'high': 3,
      'medium': 2,
      'low': 1,
      'info': 0,
    };

    const severityValues = severityFilter.map((s: string) => severityMap[s]);

    logger.info('Extracting Tenable vulnerabilities');

    while (hasMore) {
      try {
        const response = await this.client.get('/workbenches/vulnerabilities', {
          params: {
            size: batchSize,
            offset,
            filter_search_type: 'and',
            'filter.0.filter': 'severity',
            'filter.0.quality': 'eq',
            'filter.0.value': severityValues.join(','),
            'filter.1.filter': 'state',
            'filter.1.quality': 'eq',
            'filter.1.value': stateFilter.join(','),
            ...(daysBack && {
              'filter.2.filter': 'last_found',
              'filter.2.quality': 'gt',
              'filter.2.value': daysBack,
            }),
          },
        });

        const vulnerabilities: TenableVulnerability[] = response.data?.vulnerabilities || [];

        for (const vuln of vulnerabilities) {
          // Skip accepted risk if configured
          if (!includeAcceptedRisk && vuln.accepted_count && vuln.accepted_count > 0) {
            continue;
          }

          extractedData.push({
            external_id: `${vuln.plugin_id}`,
            data: vuln,
            source_type: 'tenable',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of Tenable vulnerabilities', {
          batch_size: vulnerabilities.length,
          total_extracted: extractedData.length,
        });

        hasMore = vulnerabilities.length === batchSize;
        offset += batchSize;

      } catch (error) {
        logger.error('Tenable vulnerability extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('Tenable vulnerability extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract assets from Tenable.io
   */
  private async extractAssets(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 500;
    let offset = 0;
    let hasMore = true;

    const tagFilter = resourceConfig?.['tag_filter'] || [];
    const exposureScoreMin = resourceConfig?.['exposure_score_min'] || 0;

    logger.info('Extracting Tenable assets');

    while (hasMore) {
      try {
        const params: any = {
          size: batchSize,
          offset,
        };

        // Add tag filter if specified
        if (tagFilter.length > 0) {
          params['filter.0.filter'] = 'tag';
          params['filter.0.quality'] = 'contains';
          params['filter.0.value'] = tagFilter.join(',');
        }

        const response = await this.client.get('/assets', { params });
        const assets: TenableAsset[] = response.data?.assets || [];

        for (const asset of assets) {
          // Filter by exposure score
          if (exposureScoreMin > 0 && (!asset.exposure_score || asset.exposure_score < exposureScoreMin)) {
            continue;
          }

          extractedData.push({
            external_id: asset.uuid || asset.id,
            data: asset,
            source_type: 'tenable',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of Tenable assets', {
          batch_size: assets.length,
          total_extracted: extractedData.length,
        });

        hasMore = assets.length === batchSize;
        offset += batchSize;

      } catch (error) {
        logger.error('Tenable asset extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('Tenable asset extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract plugins from Tenable.io
   */
  private async extractPlugins(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    const pluginFamilies = resourceConfig?.['plugin_families'] || [];
    const severityFilter = resourceConfig?.['severity_filter'] || ['critical', 'high', 'medium'];

    logger.info('Extracting Tenable plugins');

    try {
      // First, get list of plugin families if not specified
      const familiesToQuery = pluginFamilies.length > 0
        ? pluginFamilies
        : await this.getPluginFamilies();

      for (const family of familiesToQuery) {
        try {
          const response = await this.client.get(`/plugins/families/${encodeURIComponent(family)}`);
          const plugins: TenablePlugin[] = response.data?.plugins || [];

          for (const plugin of plugins) {
            // Filter by severity
            const riskFactor = plugin.risk_factor?.toLowerCase();
            if (riskFactor && !severityFilter.includes(riskFactor)) {
              continue;
            }

            extractedData.push({
              external_id: `${plugin.id}`,
              data: plugin,
              source_type: 'tenable',
              extracted_at: new Date(),
            });
          }

          logger.info('Extracted plugins from family');

        } catch (error) {
          logger.warn('Failed to extract plugins from family');
        }
      }

    } catch (error) {
      logger.error('Tenable plugin extraction failed');
      throw new Error('Connector extraction failed');
    }

    logger.info('Tenable plugin extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Get list of available plugin families
   */
  private async getPluginFamilies(): Promise<string[]> {
    try {
      const response = await this.client.get('/plugins/families');
      const families = response.data?.families || [];
      return families.map((f: any) => f.name);
    } catch (error) {
      logger.error('Failed to get plugin families');
      return [];
    }
  }

  /**
   * Extract relationships between vulnerabilities and devices
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Note: Relationships are primarily inferred during transformation
      // Vulnerabilities contain asset_uuids that link to devices
      logger.info('Tenable relationships will be inferred during transformation');

    } catch (error) {
      logger.error('Tenable relationship extraction failed');
    }

    return relationships;
  }

  /**
   * Infer relationships from vulnerability data
   */
  inferRelationships(vulnerabilities: ExtractedData[]): ExtractedRelationship[] {
    const relationships: ExtractedRelationship[] = [];

    for (const vulnData of vulnerabilities) {
      const vuln = vulnData.data as TenableVulnerability;

      if (vuln.asset_uuids && vuln.asset_uuids.length > 0) {
        for (const assetUuid of vuln.asset_uuids) {
          relationships.push({
            source_external_id: `${vuln.plugin_id}`,
            target_external_id: assetUuid,
            relationship_type: 'AFFECTS',
            properties: {
              severity: vuln.severity_name,
              cvss_score: vuln.cvss3_base_score || vuln.cvss_base_score,
              first_found: vuln.first_found,
              last_found: vuln.last_found,
              state: vuln.state,
            },
          });
        }
      }
    }

    logger.info('Inferred vulnerability relationships', {
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
      case 'devices':
        return this.transformDevice(sourceData);
      case 'vulnerabilities':
        return this.transformVulnerability(sourceData);
      case 'assets':
        return this.transformAsset(sourceData);
      case 'plugins':
        return this.transformPlugin(sourceData);
      default:
        throw new Error(`Unsupported resource transformation: ${resourceId}`);
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    const hostname = Array.isArray(data.hostname) ? data.hostname[0] : data.hostname;
    const fqdn = Array.isArray(data.fqdn) ? data.fqdn[0] : data.fqdn;
    const netbiosName = Array.isArray(data.netbios_name) ? data.netbios_name[0] : data.netbios_name;

    return {
      external_id: data.uuid || data.id,
      uuid: data.uuid,
      serial_number: data.bios_uuid?.[0],
      mac_address: data.mac_address,
      ip_address: [...(data.ipv4 || []), ...(data.ipv6 || [])],
      hostname,
      fqdn,
      custom_identifiers: {
        tenable_device_id: data.id,
        tenable_uuid: data.uuid,
        netbios_name: netbiosName,
        aws_instance_id: data.aws_ec2_instance_id?.[0],
        azure_vm_id: data.azure_vm_id?.[0],
        gcp_instance_id: data.gcp_instance_id?.[0],
      },
    };
  }

  /**
   * Transform Tenable device to CMDB CI
   */
  private transformDevice(device: TenableDevice): TransformedCI {
    // Determine CI type from system type
    let ciType = 'server';
    if (device.system_type && device.system_type.length > 0) {
      const sysType = device.system_type[0].toLowerCase();
      if (sysType.includes('vm') || sysType.includes('virtual')) {
        ciType = 'virtual-machine';
      } else if (sysType.includes('router') || sysType.includes('switch') || sysType.includes('firewall')) {
        ciType = 'network-device';
      }
    }

    const deviceName = device.hostname || device.fqdn || device.netbios_name || device.ipv4?.[0] || device.uuid || 'unknown';

    return {
      name: deviceName,
      ci_type: ciType,
      environment: 'production', // Tenable doesn't provide environment info
      status: this.mapDeviceStatus(device),
      attributes: {
        hostname: device.hostname,
        fqdn: device.fqdn,
        ipv4: device.ipv4,
        ipv6: device.ipv6,
        mac_address: device.mac_address,
        netbios_name: device.netbios_name,
        operating_system: device.operating_system,
        system_type: device.system_type,
        has_agent: device.has_agent,
        first_seen: device.first_seen,
        last_seen: device.last_seen,
        last_authenticated_scan: device.last_authenticated_scan,
        sources: device.sources,
        tags: device.tags,
      },
      identifiers: this.extractIdentifiers(device),
      source: 'tenable',
      source_id: device.uuid || device.id,
      confidence_score: device.has_agent ? 95 : 85, // Higher confidence with agent
    };
  }

  /**
   * Transform Tenable vulnerability to CMDB CI
   */
  private transformVulnerability(vuln: TenableVulnerability): TransformedCI {
    return {
      name: vuln.plugin_name,
      ci_type: 'vulnerability',
      environment: 'production',
      status: this.mapVulnerabilityStatus(vuln.state || 'open'),
      attributes: {
        plugin_id: vuln.plugin_id,
        plugin_family: vuln.plugin_family,
        severity: vuln.severity_name,
        severity_score: vuln.severity,
        vpr_score: vuln.vpr_score,
        cvss_base_score: vuln.cvss_base_score,
        cvss_temporal_score: vuln.cvss_temporal_score,
        cvss_vector: vuln.cvss_vector,
        cvss3_base_score: vuln.cvss3_base_score,
        cvss3_temporal_score: vuln.cvss3_temporal_score,
        cvss3_vector: vuln.cvss3_vector,
        cve: vuln.cve,
        description: vuln.description,
        solution: vuln.solution,
        synopsis: vuln.synopsis,
        count: vuln.count,
        first_found: vuln.first_found,
        last_found: vuln.last_found,
        state: vuln.state,
        accepted_count: vuln.accepted_count,
        recasted_count: vuln.recasted_count,
        affected_assets: vuln.asset_uuids?.length || 0,
      },
      identifiers: {
        external_id: `${vuln.plugin_id}`,
        custom_identifiers: {
          tenable_plugin_id: `${vuln.plugin_id}`,
          cve: vuln.cve?.join(','),
        },
      },
      source: 'tenable',
      source_id: `${vuln.plugin_id}`,
      confidence_score: 90, // High confidence from vulnerability scanner
    };
  }

  /**
   * Transform Tenable asset to CMDB CI
   */
  private transformAsset(asset: TenableAsset): TransformedCI {
    // Determine CI type from system type or cloud metadata
    let ciType = 'server';
    if (asset.system_type && asset.system_type.length > 0) {
      const sysType = asset.system_type[0].toLowerCase();
      if (sysType.includes('vm') || sysType.includes('virtual')) {
        ciType = 'virtual-machine';
      }
    } else if (asset.aws_ec2_instance_id || asset.azure_vm_id || asset.gcp_instance_id) {
      ciType = 'virtual-machine';
    }

    // Determine environment from tags
    let environment = 'production';
    if (asset.tags) {
      const envTag = asset.tags.find(t =>
        t.key.toLowerCase().includes('env') ||
        t.key.toLowerCase().includes('environment')
      );
      if (envTag) {
        environment = envTag.value.toLowerCase();
      }
    }

    const assetName = asset.hostname?.[0] || asset.fqdn?.[0] || asset.netbios_name?.[0] || asset.ipv4?.[0] || asset.uuid || 'unknown';

    return {
      name: assetName,
      ci_type: ciType,
      environment,
      status: 'active',
      attributes: {
        has_agent: asset.has_agent,
        created_at: asset.created_at,
        updated_at: asset.updated_at,
        first_seen: asset.first_seen,
        last_seen: asset.last_seen,
        first_scan_time: asset.first_scan_time,
        last_scan_time: asset.last_scan_time,
        last_authenticated_scan_date: asset.last_authenticated_scan_date,
        ipv4: asset.ipv4,
        ipv6: asset.ipv6,
        fqdn: asset.fqdn,
        netbios_name: asset.netbios_name,
        hostname: asset.hostname,
        mac_address: asset.mac_address,
        operating_system: asset.operating_system,
        system_type: asset.system_type,
        agent_name: asset.agent_name,
        bios_uuid: asset.bios_uuid,
        aws_ec2_instance_id: asset.aws_ec2_instance_id,
        aws_ec2_name: asset.aws_ec2_name,
        aws_region: asset.aws_region,
        azure_vm_id: asset.azure_vm_id,
        azure_resource_id: asset.azure_resource_id,
        gcp_instance_id: asset.gcp_instance_id,
        exposure_score: asset.exposure_score,
        tags: asset.tags,
      },
      identifiers: this.extractIdentifiers(asset),
      source: 'tenable',
      source_id: asset.uuid || asset.id,
      confidence_score: asset.has_agent ? 95 : 85,
    };
  }

  /**
   * Transform Tenable plugin to CMDB CI
   */
  private transformPlugin(plugin: TenablePlugin): TransformedCI {
    return {
      name: plugin.name,
      ci_type: 'plugin',
      environment: 'production',
      status: 'active',
      attributes: {
        plugin_id: plugin.id,
        family_name: plugin.family_name,
        description: plugin.description,
        synopsis: plugin.synopsis,
        solution: plugin.solution,
        risk_factor: plugin.risk_factor,
        cvss_base_score: plugin.cvss_base_score,
        cvss_temporal_score: plugin.cvss_temporal_score,
        cvss_vector: plugin.cvss_vector,
        cvss3_base_score: plugin.cvss3_base_score,
        cvss3_temporal_score: plugin.cvss3_temporal_score,
        cvss3_vector: plugin.cvss3_vector,
        cve: plugin.cve,
        bid: plugin.bid,
        xref: plugin.xref,
        see_also: plugin.see_also,
        plugin_publication_date: plugin.plugin_publication_date,
        plugin_modification_date: plugin.plugin_modification_date,
        vuln_publication_date: plugin.vuln_publication_date,
        patch_publication_date: plugin.patch_publication_date,
        exploitability_ease: plugin.exploitability_ease,
        exploit_available: plugin.exploit_available,
        exploit_framework_canvas: plugin.exploit_framework_canvas,
        exploit_framework_metasploit: plugin.exploit_framework_metasploit,
        exploit_framework_core: plugin.exploit_framework_core,
        metasploit_name: plugin.metasploit_name,
        canvas_package: plugin.canvas_package,
        vpr_score: plugin.vpr_score,
      },
      identifiers: {
        external_id: `${plugin.id}`,
        custom_identifiers: {
          tenable_plugin_id: `${plugin.id}`,
          cve: plugin.cve?.join(','),
        },
      },
      source: 'tenable',
      source_id: `${plugin.id}`,
      confidence_score: 100, // Plugin definitions are authoritative
    };
  }

  /**
   * Map Tenable device status to CMDB status
   */
  private mapDeviceStatus(device: TenableDevice): string {
    // Consider device active if seen recently (within last 30 days)
    if (device.last_seen) {
      const lastSeenDate = new Date(device.last_seen);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      if (lastSeenDate > thirtyDaysAgo) {
        return 'active';
      } else {
        return 'inactive';
      }
    }

    return 'active'; // Default to active
  }

  /**
   * Map Tenable vulnerability state to CMDB status
   */
  private mapVulnerabilityStatus(state: string): string {
    const mapping: Record<string, string> = {
      'open': 'active',
      'reopened': 'active',
      'fixed': 'inactive',
    };
    return mapping[state.toLowerCase()] || 'active';
  }
}
