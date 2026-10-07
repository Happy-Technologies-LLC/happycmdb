// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CrowdStrike Falcon Connector (v1.0)
 * Real-time threat intelligence and endpoint protection integration
 * Supports devices, detections, vulnerabilities, and incidents
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

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CrowdStrikeDevice {
  device_id: string;
  hostname: string;
  platform_name: string;
  os_version: string;
  mac_address?: string;
  local_ip?: string;
  external_ip?: string;
  agent_version: string;
  last_seen: string;
  first_seen: string;
  status: string;
  product_type_desc?: string;
  service_provider?: string;
  service_provider_account_id?: string;
  system_manufacturer?: string;
  system_product_name?: string;
  serial_number?: string;
  tags?: string[];
}

interface CrowdStrikeDetection {
  detection_id: string;
  severity: number;
  max_severity: number;
  max_confidence: number;
  status: string;
  tactic: string;
  technique: string;
  device: {
    device_id: string;
    hostname: string;
  };
  created_timestamp: string;
  last_behavior?: string;
  behaviors?: any[];
}

interface CrowdStrikeVulnerability {
  id: string;
  cve: {
    id: string;
    description: string;
    base_score: number;
    severity: string;
    exploit_status?: number;
    exprt_rating?: string;
  };
  aid: string; // Device ID
  apps: {
    product_name_version: string;
    vendor: string;
  }[];
  created_timestamp: string;
  updated_timestamp: string;
  status: string;
}

interface CrowdStrikeIncident {
  incident_id: string;
  name: string;
  description: string;
  status: string;
  assigned_to: string;
  assigned_to_name: string;
  severity: number;
  tactics: string[];
  techniques: string[];
  hosts: Array<{ device_id: string; hostname: string }>;
  created: string;
  modified_timestamp: string;
  start: string;
  end?: string;
}

export default class CrowdStrikeConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken?: string;
  private tokenExpiry?: number;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.baseUrl = config.connection['base_url'] || 'https://api.crowdstrike.com';
    this.clientId = config.connection['client_id'];
    this.clientSecret = config.connection['client_secret'];

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 60000,
    });

    // Add request interceptor to inject access token
    this.client.interceptors.request.use(async (config) => {
      await this.ensureValidToken();
      if (this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`;
      }
      return config;
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing CrowdStrike Falcon connector');

    // Authenticate on initialization
    await this.authenticate();
    this.isInitialized = true;
  }

  /**
   * OAuth 2.0 authentication using client credentials flow
   */
  private async authenticate(): Promise<void> {
    try {
      logger.info('Authenticating with CrowdStrike Falcon API');

      const response = await axios.post<OAuthTokenResponse>(
        `${this.baseUrl}/oauth2/token`,
        new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);

      logger.info('CrowdStrike authentication successful');
    } catch (error: any) {
      logger.error('CrowdStrike authentication failed');
      throw new Error('CrowdStrike authentication failed');
    }
  }

  /**
   * Ensure we have a valid access token (refresh if expired)
   */
  private async ensureValidToken(): Promise<void> {
    const now = Date.now();
    const buffer = 60000; // 60 seconds buffer before expiry

    if (!this.accessToken || !this.tokenExpiry || (this.tokenExpiry - buffer) < now) {
      await this.authenticate();
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying devices (limit 1)
      const response = await this.client.get('/devices/queries/devices/v1', {
        params: { limit: 1 },
      });

      return {
        success: true,
        message: 'Successfully connected to CrowdStrike Falcon',
        details: {
          base_url: this.baseUrl,
          available: response.data.resources?.length >= 0,
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

    logger.info('Starting CrowdStrike resource extraction');

    switch (resourceId) {
      case 'devices':
        return this.extractDevices(resourceConfig);
      case 'detections':
        return this.extractDetections(resourceConfig);
      case 'vulnerabilities':
        return this.extractVulnerabilities(resourceConfig);
      case 'incidents':
        return this.extractIncidents(resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Extract devices (protected endpoints)
   */
  private async extractDevices(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 500;
    let offset = 0;
    let hasMore = true;

    // Build filter query
    const statusFilter = resourceConfig?.status_filter ||
                        this.config.connection['devices']?.status ||
                        ['normal', 'containment_pending', 'contained'];

    const platformFilter = resourceConfig?.platform_filter ||
                          this.config.connection['devices']?.platform ||
                          ['Windows', 'Mac', 'Linux'];

    const filterParts: string[] = [];
    if (statusFilter.length > 0) {
      filterParts.push(`status:${statusFilter.map((s: string) => `'${s}'`).join(',')}`);
    }
    if (platformFilter.length > 0) {
      filterParts.push(`platform_name:${platformFilter.map((p: string) => `'${p}'`).join(',')}`);
    }

    const filter = filterParts.join('+');

    logger.info('Extracting CrowdStrike devices');

    while (hasMore) {
      try {
        // Step 1: Get device IDs
        const idsResponse = await this.client.get('/devices/queries/devices/v1', {
          params: {
            limit: batchSize,
            offset,
            filter: filter || undefined,
          },
        });

        const deviceIds: string[] = idsResponse.data.resources || [];
        if (deviceIds.length === 0) {
          break;
        }

        // Step 2: Get device details
        const detailsResponse = await this.client.post('/devices/entities/devices/v2', {
          ids: deviceIds,
        });

        const devices: CrowdStrikeDevice[] = detailsResponse.data.resources || [];

        for (const device of devices) {
          extractedData.push({
            external_id: device.device_id,
            data: device,
            source_type: 'crowdstrike',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of CrowdStrike devices', {
          batch_size: devices.length,
          total_extracted: extractedData.length,
        });

        hasMore = deviceIds.length === batchSize;
        offset += batchSize;

      } catch (error) {
        logger.error('CrowdStrike device extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('CrowdStrike device extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract detections (threat alerts)
   */
  private async extractDetections(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 1000;
    let offset = 0;
    let hasMore = true;

    // Build filter query
    const severityFilter = resourceConfig?.severity_filter ||
                          this.config.connection['detections']?.severity ||
                          ['critical', 'high', 'medium', 'low'];

    const statusFilter = resourceConfig?.status_filter ||
                        this.config.connection['detections']?.status ||
                        ['new', 'in_progress', 'reopened'];

    const daysBack = resourceConfig?.days_back || 7;
    const timestamp = new Date();
    timestamp.setDate(timestamp.getDate() - daysBack);

    const filterParts: string[] = [];
    filterParts.push(`created_timestamp:>'${timestamp.toISOString()}'`);

    if (severityFilter.length > 0) {
      filterParts.push(`max_severity_displayname:${severityFilter.map((s: string) => `'${s}'`).join(',')}`);
    }
    if (statusFilter.length > 0) {
      filterParts.push(`status:${statusFilter.map((s: string) => `'${s}'`).join(',')}`);
    }

    const filter = filterParts.join('+');

    logger.info('Extracting CrowdStrike detections');

    while (hasMore) {
      try {
        // Step 1: Get detection IDs
        const idsResponse = await this.client.get('/detects/queries/detects/v1', {
          params: {
            limit: batchSize,
            offset,
            filter: filter || undefined,
          },
        });

        const detectionIds: string[] = idsResponse.data.resources || [];
        if (detectionIds.length === 0) {
          break;
        }

        // Step 2: Get detection details
        const detailsResponse = await this.client.post('/detects/entities/summaries/GET/v1', {
          ids: detectionIds,
        });

        const detections: CrowdStrikeDetection[] = detailsResponse.data.resources || [];

        for (const detection of detections) {
          extractedData.push({
            external_id: detection.detection_id,
            data: detection,
            source_type: 'crowdstrike',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of CrowdStrike detections', {
          batch_size: detections.length,
          total_extracted: extractedData.length,
        });

        hasMore = detectionIds.length === batchSize;
        offset += batchSize;

      } catch (error) {
        logger.error('CrowdStrike detection extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('CrowdStrike detection extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract vulnerabilities (CVEs from Spotlight)
   */
  private async extractVulnerabilities(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 500;
    let offset = 0;
    let hasMore = true;

    // Build filter query
    const severityFilter = resourceConfig?.severity_filter || ['critical', 'high', 'medium'];
    const exploitStatusFilter = resourceConfig?.exploit_status_filter ||
                               ['EXPLOITED_IN_THE_WILD', 'WEAPONIZED', 'PUBLIC_POC'];

    const filterParts: string[] = [];
    if (severityFilter.length > 0) {
      filterParts.push(`cve.severity:${severityFilter.map((s: string) => `'${s}'`).join(',')}`);
    }

    const filter = filterParts.join('+');

    logger.info('Extracting CrowdStrike vulnerabilities');

    while (hasMore) {
      try {
        const response = await this.client.get('/spotlight/combined/vulnerabilities/v1', {
          params: {
            limit: batchSize,
            offset,
            filter: filter || undefined,
          },
        });

        const vulnerabilities: CrowdStrikeVulnerability[] = response.data.resources || [];
        if (vulnerabilities.length === 0) {
          break;
        }

        for (const vuln of vulnerabilities) {
          extractedData.push({
            external_id: `${vuln.aid}-${vuln.cve.id}`,
            data: vuln,
            source_type: 'crowdstrike',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of CrowdStrike vulnerabilities', {
          batch_size: vulnerabilities.length,
          total_extracted: extractedData.length,
        });

        hasMore = vulnerabilities.length === batchSize;
        offset += batchSize;

      } catch (error) {
        logger.error('CrowdStrike vulnerability extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('CrowdStrike vulnerability extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract incidents (security incidents)
   */
  private async extractIncidents(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const batchSize = 100;
    let offset = 0;
    let hasMore = true;

    // Build filter query
    const statusFilter = resourceConfig?.status_filter || ['new', 'in_progress', 'reopened'];
    const severityFilter = resourceConfig?.severity_filter || ['critical', 'high', 'medium'];
    const daysBack = resourceConfig?.days_back || 30;

    const timestamp = new Date();
    timestamp.setDate(timestamp.getDate() - daysBack);

    const filterParts: string[] = [];
    filterParts.push(`created:>'${timestamp.toISOString()}'`);

    if (statusFilter.length > 0) {
      filterParts.push(`status:${statusFilter.map((s: string) => `'${s}'`).join(',')}`);
    }
    if (severityFilter.length > 0) {
      filterParts.push(`severity:${severityFilter.map((s: string) => `'${s}'`).join(',')}`);
    }

    const filter = filterParts.join('+');

    logger.info('Extracting CrowdStrike incidents');

    while (hasMore) {
      try {
        // Step 1: Get incident IDs
        const idsResponse = await this.client.get('/incidents/queries/incidents/v1', {
          params: {
            limit: batchSize,
            offset,
            filter: filter || undefined,
          },
        });

        const incidentIds: string[] = idsResponse.data.resources || [];
        if (incidentIds.length === 0) {
          break;
        }

        // Step 2: Get incident details
        const detailsResponse = await this.client.post('/incidents/entities/incidents/GET/v1', {
          ids: incidentIds,
        });

        const incidents: CrowdStrikeIncident[] = detailsResponse.data.resources || [];

        for (const incident of incidents) {
          extractedData.push({
            external_id: incident.incident_id,
            data: incident,
            source_type: 'crowdstrike',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch of CrowdStrike incidents', {
          batch_size: incidents.length,
          total_extracted: extractedData.length,
        });

        hasMore = incidentIds.length === batchSize;
        offset += batchSize;

      } catch (error) {
        logger.error('CrowdStrike incident extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('CrowdStrike incident extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract relationships between security resources
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Note: Relationships are inferred during transformation based on device_id references
      // This method would be called if we need to extract explicit relationship data

      logger.info('CrowdStrike relationships will be inferred during transformation');

    } catch (error) {
      logger.error('CrowdStrike relationship extraction failed');
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
      case 'devices':
        return this.transformDevice(sourceData);
      case 'detections':
        return this.transformDetection(sourceData);
      case 'vulnerabilities':
        return this.transformVulnerability(sourceData);
      case 'incidents':
        return this.transformIncident(sourceData);
      default:
        throw new Error(`Unsupported resource transformation: ${resourceId}`);
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.device_id || data.detection_id || data.incident_id || data.id,
      serial_number: data.serial_number,
      mac_address: data.mac_address ? [data.mac_address] : undefined,
      ip_address: data.local_ip ? [data.local_ip] : undefined,
      hostname: data.hostname,
      custom_identifiers: {
        crowdstrike_device_id: data.device_id,
        agent_version: data.agent_version,
      },
    };
  }

  /**
   * Transform CrowdStrike device to CMDB CI
   */
  private transformDevice(device: CrowdStrikeDevice): TransformedCI {
    // Determine CI type based on platform
    let ciType = 'server';
    if (device.platform_name === 'Windows' || device.platform_name === 'Mac' || device.platform_name === 'Linux') {
      ciType = device.product_type_desc?.toLowerCase().includes('virtual') ? 'virtual-machine' : 'server';
    }

    return {
      name: device.hostname,
      ci_type: ciType,
      environment: 'production', // CrowdStrike doesn't provide environment info
      status: this.mapDeviceStatus(device.status),
      attributes: {
        platform: device.platform_name,
        os_version: device.os_version,
        mac_address: device.mac_address,
        local_ip: device.local_ip,
        external_ip: device.external_ip,
        agent_version: device.agent_version,
        last_seen: device.last_seen,
        first_seen: device.first_seen,
        product_type: device.product_type_desc,
        service_provider: device.service_provider,
        service_provider_account_id: device.service_provider_account_id,
        manufacturer: device.system_manufacturer,
        model: device.system_product_name,
        serial_number: device.serial_number,
        tags: device.tags,
      },
      identifiers: this.extractIdentifiers(device),
      source: 'crowdstrike',
      source_id: device.device_id,
      confidence_score: 95, // High confidence from endpoint agent
    };
  }

  /**
   * Transform CrowdStrike detection to CMDB CI
   */
  private transformDetection(detection: CrowdStrikeDetection): TransformedCI {
    return {
      name: `Detection ${detection.detection_id}`,
      ci_type: 'detection',
      environment: 'production',
      status: this.mapDetectionStatus(detection.status),
      attributes: {
        severity: this.mapSeverityNumber(detection.max_severity),
        severity_score: detection.max_severity,
        confidence: detection.max_confidence,
        tactic: detection.tactic,
        technique: detection.technique,
        device_id: detection.device.device_id,
        hostname: detection.device.hostname,
        created_timestamp: detection.created_timestamp,
        last_behavior: detection.last_behavior,
        behaviors_count: detection.behaviors?.length || 0,
      },
      identifiers: {
        external_id: detection.detection_id,
        custom_identifiers: {
          crowdstrike_detection_id: detection.detection_id,
          device_id: detection.device.device_id,
        },
      },
      source: 'crowdstrike',
      source_id: detection.detection_id,
      confidence_score: detection.max_confidence,
    };
  }

  /**
   * Transform CrowdStrike vulnerability to CMDB CI
   */
  private transformVulnerability(vuln: CrowdStrikeVulnerability): TransformedCI {
    return {
      name: vuln.cve.id,
      ci_type: 'vulnerability',
      environment: 'production',
      status: this.mapVulnerabilityStatus(vuln.status),
      attributes: {
        cve_id: vuln.cve.id,
        description: vuln.cve.description,
        severity: vuln.cve.severity,
        base_score: vuln.cve.base_score,
        exploit_status: vuln.cve.exploit_status,
        exploit_rating: vuln.cve.exprt_rating,
        device_id: vuln.aid,
        affected_software: vuln.apps.map(app => ({
          product: app.product_name_version,
          vendor: app.vendor,
        })),
        created_timestamp: vuln.created_timestamp,
        updated_timestamp: vuln.updated_timestamp,
      },
      identifiers: {
        external_id: `${vuln.aid}-${vuln.cve.id}`,
        custom_identifiers: {
          cve_id: vuln.cve.id,
          device_id: vuln.aid,
        },
      },
      source: 'crowdstrike',
      source_id: `${vuln.aid}-${vuln.cve.id}`,
      confidence_score: 90, // CVE data is highly reliable
    };
  }

  /**
   * Transform CrowdStrike incident to CMDB CI
   */
  private transformIncident(incident: CrowdStrikeIncident): TransformedCI {
    return {
      name: incident.name,
      ci_type: 'incident',
      environment: 'production',
      status: this.mapIncidentStatus(incident.status),
      attributes: {
        description: incident.description,
        assigned_to: incident.assigned_to,
        assigned_to_name: incident.assigned_to_name,
        severity: this.mapSeverityNumber(incident.severity),
        severity_score: incident.severity,
        tactics: incident.tactics,
        techniques: incident.techniques,
        hosts: incident.hosts,
        created: incident.created,
        modified: incident.modified_timestamp,
        start: incident.start,
        end: incident.end,
      },
      identifiers: {
        external_id: incident.incident_id,
        custom_identifiers: {
          crowdstrike_incident_id: incident.incident_id,
        },
      },
      source: 'crowdstrike',
      source_id: incident.incident_id,
      confidence_score: 85, // Incidents are analyst-curated
    };
  }

  /**
   * Map CrowdStrike device status to CMDB status
   */
  private mapDeviceStatus(status: string): string {
    const mapping: Record<string, string> = {
      'normal': 'active',
      'containment_pending': 'maintenance',
      'contained': 'inactive',
      'lift_containment_pending': 'maintenance',
    };
    return mapping[status] || 'active';
  }

  /**
   * Map CrowdStrike detection status to CMDB status
   */
  private mapDetectionStatus(status: string): string {
    const mapping: Record<string, string> = {
      'new': 'active',
      'in_progress': 'active',
      'true_positive': 'inactive',
      'false_positive': 'inactive',
      'ignored': 'inactive',
      'closed': 'inactive',
      'reopened': 'active',
    };
    return mapping[status] || 'active';
  }

  /**
   * Map CrowdStrike vulnerability status to CMDB status
   */
  private mapVulnerabilityStatus(status: string): string {
    const mapping: Record<string, string> = {
      'open': 'active',
      'closed': 'inactive',
      'remediated': 'inactive',
    };
    return mapping[status] || 'active';
  }

  /**
   * Map CrowdStrike incident status to CMDB status
   */
  private mapIncidentStatus(status: string): string {
    const mapping: Record<string, string> = {
      'new': 'active',
      'in_progress': 'active',
      'reopened': 'active',
      'closed': 'inactive',
    };
    return mapping[status] || 'active';
  }

  /**
   * Map numeric severity to string
   */
  private mapSeverityNumber(severity: number): string {
    if (severity >= 70) return 'critical';
    if (severity >= 50) return 'high';
    if (severity >= 30) return 'medium';
    if (severity >= 10) return 'low';
    return 'informational';
  }
}
