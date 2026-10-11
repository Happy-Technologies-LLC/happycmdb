// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Microsoft Defender for Endpoint Connector (v1.0)
 * Multi-resource integration with Microsoft Defender for Endpoint
 * Supports machines, alerts, vulnerabilities, software, and relationships
 */

import axios, { AxiosInstance } from 'axios';
import { ClientSecretCredential } from '@azure/identity';
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

interface DefenderMachine {
  id: string;
  computerDnsName: string;
  osPlatform: string;
  osVersion: string;
  lastIpAddress: string;
  lastExternalIpAddress: string;
  healthStatus: string;
  riskScore: string;
  exposureLevel: string;
  onboardingStatus: string;
  agentVersion: string;
  firstSeen: string;
  lastSeen: string;
  machineTags?: string[];
}

interface DefenderAlert {
  id: string;
  title: string;
  severity: string;
  status: string;
  category: string;
  detectionSource: string;
  machineId: string;
  investigationState: string;
  createdTime: string;
  resolvedTime?: string;
  classification?: string;
  determination?: string;
  description?: string;
}

interface DefenderVulnerability {
  id: string;
  cveId: string;
  severity: string;
  cvssV3: number;
  exploitVerified: boolean;
  exposedMachines: number;
  publishedOn: string;
  updatedOn: string;
  description?: string;
  weaknesses?: number;
}

interface DefenderSoftware {
  id: string;
  name: string;
  vendor: string;
  version: string;
  installedMachines: number;
  weaknesses: number;
  activeAlerts: number;
  endOfSupportStatus: string;
  endOfSupportDate?: string;
}

export default class DefenderConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private credential: ClientSecretCredential;
  private accessToken?: string;
  private tokenExpiry?: Date;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    const tenantId = config.connection['tenant_id'];
    const clientId = config.connection['client_id'];
    const clientSecret = config.connection['client_secret'];

    // Initialize Azure AD credential
    this.credential = new ClientSecretCredential(
      tenantId,
      clientId,
      clientSecret
    );

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: 'https://api.securitycenter.microsoft.com',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });

    // Add request interceptor to inject access token
    this.client.interceptors.request.use(async (config) => {
      const token = await this.getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Microsoft Defender for Endpoint connector');

    // Test authentication by getting a token
    await this.getAccessToken();

    this.isInitialized = true;
  }

  /**
   * Get or refresh Azure AD access token
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const tokenResponse = await this.credential.getToken(
        'https://api.securitycenter.microsoft.com/.default'
      );

      this.accessToken = tokenResponse.token;
      this.tokenExpiry = tokenResponse.expiresOnTimestamp
        ? new Date(tokenResponse.expiresOnTimestamp)
        : new Date(Date.now() + 3600000); // Default 1 hour

      logger.debug('Azure AD access token obtained');

      return this.accessToken;
    } catch (error: any) {
      logger.error('Failed to obtain Azure AD access token');
      throw new Error('Azure AD authentication failed');
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying machines endpoint with limit 1
      const response = await this.client.get('/api/machines', {
        params: { $top: 1 },
      });

      return {
        success: true,
        message: 'Successfully connected to Microsoft Defender for Endpoint',
        details: {
          api_version: 'v1.0',
          machines_available: response.data.value?.length > 0,
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
    const resource = this.metadata.resources.find((r) => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    logger.info('Starting Defender resource extraction');

    switch (resourceId) {
      case 'machines':
        return this.extractMachines(resourceConfig);
      case 'alerts':
        return this.extractAlerts(resourceConfig);
      case 'vulnerabilities':
        return this.extractVulnerabilities(resourceConfig);
      case 'software':
        return this.extractSoftware(resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Extract machines (protected devices)
   */
  private async extractMachines(
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    let skipToken: string | undefined;

    // Build OData filter from configuration
    const filters: string[] = [];

    if (this.config.connection['machines']?.health_status) {
      const statuses = this.config.connection['machines'].health_status;
      if (statuses.length > 0) {
        const statusFilter = statuses.map((s: string) => `healthStatus eq '${s}'`).join(' or ');
        filters.push(`(${statusFilter})`);
      }
    }

    if (this.config.connection['machines']?.risk_score) {
      const scores = this.config.connection['machines'].risk_score;
      if (scores.length > 0) {
        const scoreFilter = scores.map((s: string) => `riskScore eq '${s}'`).join(' or ');
        filters.push(`(${scoreFilter})`);
      }
    }

    const filterString = filters.length > 0 ? filters.join(' and ') : undefined;

    do {
      try {
        const params: any = {
          $top: 100,
        };

        if (filterString) {
          params.$filter = filterString;
        }

        if (skipToken) {
          params.$skiptoken = skipToken;
        }

        const response = await this.client.get('/api/machines', { params });
        const machines = response.data.value as DefenderMachine[];

        for (const machine of machines) {
          extractedData.push({
            external_id: machine.id,
            data: machine,
            source_type: 'defender',
            extracted_at: new Date(),
          });
        }

        // Get next page token
        skipToken = response.data['@odata.nextLink']
          ? new URL(response.data['@odata.nextLink']).searchParams.get('$skiptoken') || undefined
          : undefined;

        logger.info('Extracted machines batch from Defender', {
          batch_size: machines.length,
          total_extracted: extractedData.length,
        });
      } catch (error) {
        logger.error('Defender machines extraction failed');
        throw new Error('Connector extraction failed');
      }
    } while (skipToken);

    logger.info('Defender machines extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract alerts
   */
  private async extractAlerts(
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    let skipToken: string | undefined;

    // Build OData filter
    const filters: string[] = [];

    // Time range filter (default 24 hours)
    const timeRangeHours = resourceConfig?.time_range_hours || 24;
    const timeAgo = new Date(Date.now() - timeRangeHours * 3600000).toISOString();
    filters.push(`alertCreationTime ge ${timeAgo}`);

    if (this.config.connection['alerts']?.severity) {
      const severities = this.config.connection['alerts'].severity;
      if (severities.length > 0) {
        const severityFilter = severities.map((s: string) => `severity eq '${s}'`).join(' or ');
        filters.push(`(${severityFilter})`);
      }
    }

    if (this.config.connection['alerts']?.status) {
      const statuses = this.config.connection['alerts'].status;
      if (statuses.length > 0) {
        const statusFilter = statuses.map((s: string) => `status eq '${s}'`).join(' or ');
        filters.push(`(${statusFilter})`);
      }
    }

    const filterString = filters.join(' and ');

    do {
      try {
        const params: any = {
          $top: 100,
          $filter: filterString,
        };

        if (skipToken) {
          params.$skiptoken = skipToken;
        }

        const response = await this.client.get('/api/alerts', { params });
        const alerts = response.data.value as DefenderAlert[];

        for (const alert of alerts) {
          extractedData.push({
            external_id: alert.id,
            data: alert,
            source_type: 'defender',
            extracted_at: new Date(),
          });
        }

        skipToken = response.data['@odata.nextLink']
          ? new URL(response.data['@odata.nextLink']).searchParams.get('$skiptoken') || undefined
          : undefined;

        logger.info('Extracted alerts batch from Defender', {
          batch_size: alerts.length,
          total_extracted: extractedData.length,
        });
      } catch (error) {
        logger.error('Defender alerts extraction failed');
        throw new Error('Connector extraction failed');
      }
    } while (skipToken);

    logger.info('Defender alerts extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract vulnerabilities
   */
  private async extractVulnerabilities(
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    let skipToken: string | undefined;

    // Build OData filter
    const filters: string[] = [];

    if (this.config.connection['vulnerabilities']?.severity) {
      const severities = this.config.connection['vulnerabilities'].severity;
      if (severities.length > 0) {
        const severityFilter = severities.map((s: string) => `severity eq '${s}'`).join(' or ');
        filters.push(`(${severityFilter})`);
      }
    }

    if (this.config.connection['vulnerabilities']?.exploit_verified) {
      filters.push('exploitVerified eq true');
    }

    const filterString = filters.length > 0 ? filters.join(' and ') : undefined;

    do {
      try {
        const params: any = {
          $top: 100,
        };

        if (filterString) {
          params.$filter = filterString;
        }

        if (skipToken) {
          params.$skiptoken = skipToken;
        }

        const response = await this.client.get('/api/vulnerabilities', { params });
        const vulnerabilities = response.data.value as DefenderVulnerability[];

        for (const vulnerability of vulnerabilities) {
          extractedData.push({
            external_id: vulnerability.id,
            data: vulnerability,
            source_type: 'defender',
            extracted_at: new Date(),
          });
        }

        skipToken = response.data['@odata.nextLink']
          ? new URL(response.data['@odata.nextLink']).searchParams.get('$skiptoken') || undefined
          : undefined;

        logger.info('Extracted vulnerabilities batch from Defender', {
          batch_size: vulnerabilities.length,
          total_extracted: extractedData.length,
        });
      } catch (error) {
        logger.error('Defender vulnerabilities extraction failed');
        throw new Error('Connector extraction failed');
      }
    } while (skipToken);

    logger.info('Defender vulnerabilities extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract software inventory
   */
  private async extractSoftware(
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    let skipToken: string | undefined;

    do {
      try {
        const params: any = {
          $top: 100,
        };

        if (skipToken) {
          params.$skiptoken = skipToken;
        }

        const response = await this.client.get('/api/Software', { params });
        const software = response.data.value as DefenderSoftware[];

        for (const sw of software) {
          extractedData.push({
            external_id: sw.id,
            data: sw,
            source_type: 'defender',
            extracted_at: new Date(),
          });
        }

        skipToken = response.data['@odata.nextLink']
          ? new URL(response.data['@odata.nextLink']).searchParams.get('$skiptoken') || undefined
          : undefined;

        logger.info('Extracted software batch from Defender', {
          batch_size: software.length,
          total_extracted: extractedData.length,
        });
      } catch (error) {
        logger.error('Defender software extraction failed');
        throw new Error('Connector extraction failed');
      }
    } while (skipToken);

    logger.info('Defender software extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract relationships between resources
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Extract Alert -> Machine relationships
      const alertsData = await this.extractAlerts();
      for (const alertData of alertsData) {
        const alert = alertData.data as DefenderAlert;
        if (alert.machineId) {
          relationships.push({
            source_external_id: alert.id,
            target_external_id: alert.machineId,
            relationship_type: 'DETECTED_ON',
            properties: {
              severity: alert.severity,
              status: alert.status,
            },
          });
        }
      }

      // Extract Vulnerability -> Machine relationships
      // This requires additional API calls to get machine-specific vulnerability data
      const vulnerabilitiesData = await this.extractVulnerabilities();
      for (const vulnData of vulnerabilitiesData) {
        const vuln = vulnData.data as DefenderVulnerability;

        // Get machines affected by this vulnerability
        try {
          const response = await this.client.get(`/api/vulnerabilities/${vuln.id}/machineReferences`);
          const affectedMachines = response.data.value || [];

          for (const machineRef of affectedMachines) {
            relationships.push({
              source_external_id: vuln.id,
              target_external_id: machineRef.id,
              relationship_type: 'AFFECTS',
              properties: {
                severity: vuln.severity,
                cvss_score: vuln.cvssV3,
                exploit_verified: vuln.exploitVerified,
              },
            });
          }
        } catch (error) {
          logger.warn('Failed to get machines for vulnerability');
        }
      }

      // Extract Software -> Machine relationships
      const softwareData = await this.extractSoftware();
      for (const swData of softwareData) {
        const sw = swData.data as DefenderSoftware;

        // Get machines with this software installed
        try {
          const response = await this.client.get(`/api/Software/${sw.id}/machineReferences`);
          const machineRefs = response.data.value || [];

          for (const machineRef of machineRefs) {
            relationships.push({
              source_external_id: sw.id,
              target_external_id: machineRef.id,
              relationship_type: 'INSTALLED_ON',
              properties: {
                version: sw.version,
                vendor: sw.vendor,
              },
            });
          }
        } catch (error) {
          logger.warn('Failed to get machines for software');
        }
      }

      logger.info('Defender relationships extracted', {
        count: relationships.length,
      });
    } catch (error) {
      logger.error('Defender relationship extraction failed');
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
    const resource = this.metadata.resources.find((r) => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    switch (resourceId) {
      case 'machines':
        return this.transformMachine(sourceData);
      case 'alerts':
        return this.transformAlert(sourceData);
      case 'vulnerabilities':
        return this.transformVulnerability(sourceData);
      case 'software':
        return this.transformSoftware(sourceData);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  extractIdentifiers(data: any, resourceId: string): IdentificationAttributes {
    if (resourceId === 'machines') {
      const machine = data as DefenderMachine;
      return {
        external_id: machine.id,
        hostname: machine.computerDnsName,
        ip_address: machine.lastIpAddress ? [machine.lastIpAddress] : undefined,
        custom_identifiers: {
          defender_machine_id: machine.id,
          last_external_ip: machine.lastExternalIpAddress,
        },
      };
    }

    // For non-machine resources, use basic identifiers
    return {
      external_id: data.id,
      custom_identifiers: {
        defender_id: data.id,
      },
    };
  }

  /**
   * Transform machine to CMDB format
   */
  private transformMachine(data: DefenderMachine): TransformedCI {
    // Determine CI type based on OS platform
    let ciType = 'server';
    if (data.osPlatform?.toLowerCase().includes('windows')) {
      ciType = 'server';
    } else if (data.osPlatform?.toLowerCase().includes('linux')) {
      ciType = 'server';
    } else if (data.osPlatform?.toLowerCase().includes('macos')) {
      ciType = 'server';
    }

    return {
      name: data.computerDnsName || data.id,
      ci_type: ciType,
      environment: 'production', // Default - would need additional logic to determine
      status: this.mapMachineStatus(data.healthStatus),
      attributes: {
        os_platform: data.osPlatform,
        os_version: data.osVersion,
        last_ip_address: data.lastIpAddress,
        last_external_ip_address: data.lastExternalIpAddress,
        health_status: data.healthStatus,
        risk_score: data.riskScore,
        exposure_level: data.exposureLevel,
        onboarding_status: data.onboardingStatus,
        agent_version: data.agentVersion,
        first_seen: data.firstSeen,
        last_seen: data.lastSeen,
        machine_tags: data.machineTags,
      },
      identifiers: this.extractIdentifiers(data, 'machines'),
      source: 'defender',
      source_id: data.id,
      confidence_score: 95, // High confidence from Defender
    };
  }

  /**
   * Transform alert to CMDB format
   */
  private transformAlert(data: DefenderAlert): TransformedCI {
    return {
      name: data.title,
      ci_type: 'alert',
      environment: 'production',
      status: this.mapAlertStatus(data.status),
      attributes: {
        severity: data.severity,
        category: data.category,
        detection_source: data.detectionSource,
        machine_id: data.machineId,
        investigation_state: data.investigationState,
        created_time: data.createdTime,
        resolved_time: data.resolvedTime,
        classification: data.classification,
        determination: data.determination,
        description: data.description,
      },
      identifiers: this.extractIdentifiers(data, 'alerts'),
      source: 'defender',
      source_id: data.id,
      confidence_score: 100, // Defender alerts are authoritative
    };
  }

  /**
   * Transform vulnerability to CMDB format
   */
  private transformVulnerability(data: DefenderVulnerability): TransformedCI {
    return {
      name: data.cveId || data.id,
      ci_type: 'vulnerability',
      environment: 'production',
      status: data.exploitVerified ? 'active' : 'inactive',
      attributes: {
        cve_id: data.cveId,
        severity: data.severity,
        cvss_v3: data.cvssV3,
        exploit_verified: data.exploitVerified,
        exposed_machines: data.exposedMachines,
        published_on: data.publishedOn,
        updated_on: data.updatedOn,
        description: data.description,
        weaknesses: data.weaknesses,
      },
      identifiers: this.extractIdentifiers(data, 'vulnerabilities'),
      source: 'defender',
      source_id: data.id,
      confidence_score: 100,
    };
  }

  /**
   * Transform software to CMDB format
   */
  private transformSoftware(data: DefenderSoftware): TransformedCI {
    return {
      name: `${data.vendor} ${data.name} ${data.version}`,
      ci_type: 'software',
      environment: 'production',
      status: data.endOfSupportStatus === 'Supported' ? 'active' : 'inactive',
      attributes: {
        vendor: data.vendor,
        software_name: data.name,
        version: data.version,
        installed_machines: data.installedMachines,
        weaknesses: data.weaknesses,
        active_alerts: data.activeAlerts,
        end_of_support_status: data.endOfSupportStatus,
        end_of_support_date: data.endOfSupportDate,
      },
      identifiers: this.extractIdentifiers(data, 'software'),
      source: 'defender',
      source_id: data.id,
      confidence_score: 100,
    };
  }

  /**
   * Map Defender machine health status to CMDB status
   */
  private mapMachineStatus(healthStatus: string): string {
    const mapping: Record<string, string> = {
      Active: 'active',
      Inactive: 'inactive',
      ImpairedCommunication: 'maintenance',
      NoSensorData: 'inactive',
      NoSensorDataImpairedCommunication: 'inactive',
    };

    return mapping[healthStatus] || 'active';
  }

  /**
   * Map Defender alert status to CMDB status
   */
  private mapAlertStatus(alertStatus: string): string {
    const mapping: Record<string, string> = {
      New: 'active',
      InProgress: 'active',
      Resolved: 'inactive',
    };

    return mapping[alertStatus] || 'active';
  }
}
