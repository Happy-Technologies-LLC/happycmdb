// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Microsoft Intune Connector (v1.0)
 * Multi-resource integration with Microsoft Intune for MDM
 * Supports devices, applications, compliance policies, configuration profiles, and users
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
 * Microsoft Graph API OAuth token response
 */
interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Microsoft Graph API paginated response
 */
interface GraphResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

export default class IntuneConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private graphClient: AxiosInstance;
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken?: string;
  private tokenExpiry?: Date;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.tenantId = config.connection['tenant_id'];
    this.clientId = config.connection['client_id'];
    this.clientSecret = config.connection['client_secret'];

    // OAuth client for getting tokens
    this.client = axios.create({
      baseURL: `https://login.microsoftonline.com/${this.tenantId}`,
      timeout: 30000,
    });

    // Microsoft Graph API client
    this.graphClient = axios.create({
      baseURL: 'https://graph.microsoft.com/v1.0',
      timeout: 30000,
    });

    // Add request interceptor to inject access token
    this.graphClient.interceptors.request.use(async (config) => {
      const token = await this.getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Intune connector');

    // Get initial access token
    await this.getAccessToken();

    this.isInitialized = true;
  }

  /**
   * Get OAuth 2.0 access token using client credentials flow
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return this.accessToken;
    }

    try {
      const response = await this.client.post<TokenResponse>(
        '/oauth2/v2.0/token',
        new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = response.data.access_token;
      // Set expiry to 5 minutes before actual expiry
      this.tokenExpiry = new Date(Date.now() + (response.data.expires_in - 300) * 1000);

      logger.info('Intune access token obtained');

      return this.accessToken;
    } catch (error: any) {
      logger.error('Failed to obtain Intune access token');
      throw new Error('OAuth authentication failed');
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test by querying organization details
      const response = await this.graphClient.get('/organization');

      return {
        success: true,
        message: 'Successfully connected to Microsoft Intune',
        details: {
          tenant_id: this.tenantId,
          organization: response.data.value[0]?.displayName,
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

    logger.info('Starting Intune resource extraction');

    switch (resourceId) {
      case 'devices':
        return this.extractDevices(resourceConfig);
      case 'applications':
        return this.extractApplications(resourceConfig);
      case 'compliance_policies':
        return this.extractCompliancePolicies(resourceConfig);
      case 'configuration_profiles':
        return this.extractConfigurationProfiles(resourceConfig);
      case 'users':
        return this.extractUsers(resourceConfig);
      default:
        throw new Error(`Extraction not implemented for resource: ${resourceId}`);
    }
  }

  /**
   * Extract managed devices from Intune
   */
  private async extractDevices(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    // Build OData filter based on config
    const filters: string[] = [];

    if (config?.last_sync_days) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - config.last_sync_days);
      filters.push(`lastSyncDateTime ge ${cutoffDate.toISOString()}`);
    }

    let url = '/deviceManagement/managedDevices';
    if (filters.length > 0) {
      url += `?$filter=${filters.join(' and ')}`;
    }

    await this.paginateAndExtract(url, extractedData, 'intune_device');

    // Filter by compliance state and ownership if specified
    if (config?.compliance_state || config?.ownership) {
      return extractedData.filter(item => {
        const complianceMatch = !config.compliance_state ||
          config.compliance_state.includes(item.data.complianceState);
        const ownershipMatch = !config.ownership ||
          config.ownership.includes(item.data.managedDeviceOwnerType);
        return complianceMatch && ownershipMatch;
      });
    }

    logger.info('Intune devices extraction completed', {
      total_devices: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract managed applications from Intune
   */
  private async extractApplications(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    const url = '/deviceAppManagement/mobileApps';
    await this.paginateAndExtract(url, extractedData, 'intune_app');

    // Filter by platform if specified
    if (config?.platform) {
      const platformSet = new Set(config.platform.map((p: string) => p.toLowerCase()));
      return extractedData.filter(item => {
        const odataType = item.data['@odata.type'];
        if (odataType?.includes('iosStoreApp') || odataType?.includes('iosVppApp')) {
          return platformSet.has('ios');
        }
        if (odataType?.includes('androidStoreApp') || odataType?.includes('androidManagedStoreApp')) {
          return platformSet.has('android');
        }
        if (odataType?.includes('windowsMobileMSI') || odataType?.includes('win32LobApp')) {
          return platformSet.has('windows');
        }
        if (odataType?.includes('macOSOfficeSuiteApp') || odataType?.includes('macOSLobApp')) {
          return platformSet.has('macos');
        }
        return true;
      });
    }

    logger.info('Intune applications extraction completed', {
      total_apps: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract compliance policies from Intune
   */
  private async extractCompliancePolicies(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    const url = '/deviceManagement/deviceCompliancePolicies';
    await this.paginateAndExtract(url, extractedData, 'intune_compliance_policy');

    logger.info('Intune compliance policies extraction completed', {
      total_policies: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract configuration profiles from Intune
   */
  private async extractConfigurationProfiles(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    const url = '/deviceManagement/deviceConfigurations';
    await this.paginateAndExtract(url, extractedData, 'intune_config_profile');

    logger.info('Intune configuration profiles extraction completed', {
      total_profiles: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract users from Intune
   */
  private async extractUsers(config?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    let url = '/users';

    // Optionally filter to users with devices
    if (config?.has_devices) {
      url += '?$expand=registeredDevices';
    }

    await this.paginateAndExtract(url, extractedData, 'intune_user');

    // Filter to only users with devices if requested
    if (config?.has_devices) {
      const filtered = extractedData.filter(item =>
        item.data.registeredDevices && item.data.registeredDevices.length > 0
      );

      logger.info('Intune users extraction completed (filtered to users with devices)', {
        total_users: filtered.length,
        total_all_users: extractedData.length,
      });

      return filtered;
    }

    logger.info('Intune users extraction completed', {
      total_users: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Helper method to paginate through Graph API results
   */
  private async paginateAndExtract(
    initialUrl: string,
    extractedData: ExtractedData[],
    sourceType: string
  ): Promise<void> {
    let url: string | undefined = initialUrl;

    while (url) {
      try {
        const response = await this.graphClient.get<GraphResponse<any>>(url);
        const records = response.data.value;

        for (const record of records) {
          extractedData.push({
            external_id: record.id,
            data: record,
            source_type: sourceType,
            extracted_at: new Date(),
          });
        }

        // Get next page URL from @odata.nextLink
        url = response.data['@odata.nextLink'];

        // If using nextLink, extract just the path (remove base URL)
        if (url && url.startsWith('https://graph.microsoft.com/v1.0')) {
          url = url.substring('https://graph.microsoft.com/v1.0'.length);
        }

        logger.debug('Extracted batch from Intune');

      } catch (error: any) {
        logger.error('Intune resource extraction failed');
        throw new Error('Connector extraction failed');
      }
    }
  }

  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Extract device-to-user relationships
      const devices = await this.graphClient.get<GraphResponse<any>>(
        '/deviceManagement/managedDevices?$select=id,userId,userPrincipalName'
      );

      for (const device of devices.data.value) {
        if (device.userId) {
          relationships.push({
            source_external_id: device.id,
            target_external_id: device.userId,
            relationship_type: 'ASSIGNED_TO',
            properties: {
              user_principal_name: device.userPrincipalName,
            },
          });
        }
      }

      // Extract app-to-device relationships (installed apps)
      // Note: This requires additional API calls per device, so we'll sample or limit
      const deviceLimit = 100; // Limit to first 100 devices for performance
      const limitedDevices = devices.data.value.slice(0, deviceLimit);

      for (const device of limitedDevices) {
        try {
          const detectedApps = await this.graphClient.get<GraphResponse<any>>(
            `/deviceManagement/managedDevices/${device.id}/detectedApps`
          );

          for (const app of detectedApps.data.value) {
            relationships.push({
              source_external_id: app.id,
              target_external_id: device.id,
              relationship_type: 'INSTALLED_ON',
              properties: {
                app_name: app.displayName,
                version: app.version,
              },
            });
          }
        } catch (error: any) {
          logger.warn('Failed to get detected apps for device');
        }
      }

      // Extract compliance policy assignments
      const policies = await this.graphClient.get<GraphResponse<any>>(
        '/deviceManagement/deviceCompliancePolicies?$expand=assignments'
      );

      for (const policy of policies.data.value) {
        if (policy.assignments) {
          for (const assignment of policy.assignments) {
            // Assignments are typically to groups, but we track the policy-level relationship
            relationships.push({
              source_external_id: policy.id,
              target_external_id: assignment.target?.groupId || 'all-devices',
              relationship_type: 'APPLIES_TO',
              properties: {
                assignment_type: assignment.target?.['@odata.type'],
                policy_name: policy.displayName,
              },
            });
          }
        }
      }

      // Extract configuration profile assignments
      const configs = await this.graphClient.get<GraphResponse<any>>(
        '/deviceManagement/deviceConfigurations?$expand=assignments'
      );

      for (const config of configs.data.value) {
        if (config.assignments) {
          for (const assignment of config.assignments) {
            relationships.push({
              source_external_id: config.id,
              target_external_id: assignment.target?.groupId || 'all-devices',
              relationship_type: 'APPLIES_TO',
              properties: {
                assignment_type: assignment.target?.['@odata.type'],
                config_name: config.displayName,
              },
            });
          }
        }
      }

      logger.info('Intune relationships extracted', {
        total_relationships: relationships.length,
      });

    } catch (error: any) {
      logger.error('Intune relationship extraction failed');
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
      case 'devices':
        return this.transformDevice(sourceData);
      case 'applications':
        return this.transformApplication(sourceData);
      case 'compliance_policies':
        return this.transformCompliancePolicy(sourceData);
      case 'configuration_profiles':
        return this.transformConfigurationProfile(sourceData);
      case 'users':
        return this.transformUser(sourceData);
      default:
        throw new Error(`Transformation not implemented for resource: ${resourceId}`);
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.id,
      serial_number: data.serialNumber,
      mac_address: data.wiFiMacAddress ? [data.wiFiMacAddress] : undefined,
      hostname: data.deviceName,
      custom_identifiers: {
        imei: data.imei,
        meid: data.meid,
        azure_ad_device_id: data.azureADDeviceId,
      },
    };
  }

  /**
   * Transform Intune device to CMDB CI
   */
  private transformDevice(device: any): TransformedCI {
    // Determine CI type based on device category
    let ciType = 'mobile-device';
    const os = device.operatingSystem?.toLowerCase() || '';

    if (os.includes('windows') || os.includes('macos')) {
      ciType = 'virtual-machine'; // Treat computers as virtual machines
    }

    return {
      name: device.deviceName || device.id,
      ci_type: ciType,
      environment: 'production',
      status: this.mapDeviceStatus(device.complianceState),
      attributes: {
        operating_system: device.operatingSystem,
        os_version: device.osVersion,
        manufacturer: device.manufacturer,
        model: device.model,
        serial_number: device.serialNumber,
        imei: device.imei,
        meid: device.meid,
        phone_number: device.phoneNumber,
        azure_ad_device_id: device.azureADDeviceId,
        enrolled_date: device.enrolledDateTime,
        last_sync_date: device.lastSyncDateTime,
        compliance_state: device.complianceState,
        compliance_grace_period_expiration: device.complianceGracePeriodExpirationDateTime,
        management_state: device.managementState,
        ownership_type: device.managedDeviceOwnerType,
        device_category: device.deviceCategoryDisplayName,
        exchange_access_state: device.exchangeAccessState,
        user_principal_name: device.userPrincipalName,
        user_display_name: device.userDisplayName,
        is_encrypted: device.isEncrypted,
        is_supervised: device.isSupervised,
        jail_broken: device.jailBroken,
        total_storage_space_bytes: device.totalStorageSpaceInBytes,
        free_storage_space_bytes: device.freeStorageSpaceInBytes,
      },
      identifiers: this.extractIdentifiers(device),
      source: 'intune',
      source_id: device.id,
      confidence_score: 95, // Intune is authoritative for managed devices
    };
  }

  /**
   * Transform Intune application to CMDB CI
   */
  private transformApplication(app: any): TransformedCI {
    const platform = this.extractPlatformFromODataType(app['@odata.type']);

    return {
      name: app.displayName || app.id,
      ci_type: 'application',
      environment: 'production',
      status: 'active',
      attributes: {
        description: app.description,
        publisher: app.publisher,
        platform,
        odata_type: app['@odata.type'],
        created_date: app.createdDateTime,
        last_modified_date: app.lastModifiedDateTime,
        is_featured: app.isFeatured,
        is_assigned: app.isAssigned,
        large_icon: app.largeIcon,
        privacy_information_url: app.privacyInformationUrl,
        information_url: app.informationUrl,
        owner: app.owner,
        developer: app.developer,
        notes: app.notes,
      },
      identifiers: {
        external_id: app.id,
        custom_identifiers: {
          bundle_id: app.bundleId,
          package_id: app.packageIdentifier,
        },
      },
      source: 'intune',
      source_id: app.id,
      confidence_score: 90,
    };
  }

  /**
   * Transform Intune compliance policy to CMDB CI
   */
  private transformCompliancePolicy(policy: any): TransformedCI {
    const platform = this.extractPlatformFromODataType(policy['@odata.type']);

    return {
      name: policy.displayName || policy.id,
      ci_type: 'policy',
      environment: 'production',
      status: 'active',
      attributes: {
        description: policy.description,
        platform,
        odata_type: policy['@odata.type'],
        created_date: policy.createdDateTime,
        last_modified_date: policy.lastModifiedDateTime,
        version: policy.version,
        scheduled_actions_count: policy.scheduledActionsForRule?.length || 0,
      },
      identifiers: {
        external_id: policy.id,
      },
      source: 'intune',
      source_id: policy.id,
      confidence_score: 100,
    };
  }

  /**
   * Transform Intune configuration profile to CMDB CI
   */
  private transformConfigurationProfile(config: any): TransformedCI {
    const platform = this.extractPlatformFromODataType(config['@odata.type']);

    return {
      name: config.displayName || config.id,
      ci_type: 'configuration',
      environment: 'production',
      status: 'active',
      attributes: {
        description: config.description,
        platform,
        odata_type: config['@odata.type'],
        created_date: config.createdDateTime,
        last_modified_date: config.lastModifiedDateTime,
        version: config.version,
      },
      identifiers: {
        external_id: config.id,
      },
      source: 'intune',
      source_id: config.id,
      confidence_score: 100,
    };
  }

  /**
   * Transform Intune user to CMDB CI
   */
  private transformUser(user: any): TransformedCI {
    return {
      name: user.displayName || user.userPrincipalName,
      ci_type: 'user',
      environment: 'production',
      status: user.accountEnabled ? 'active' : 'inactive',
      attributes: {
        user_principal_name: user.userPrincipalName,
        mail: user.mail,
        job_title: user.jobTitle,
        department: user.department,
        office_location: user.officeLocation,
        mobile_phone: user.mobilePhone,
        business_phones: user.businessPhones,
        registered_devices_count: user.registeredDevices?.length || 0,
      },
      identifiers: {
        external_id: user.id,
        custom_identifiers: {
          user_principal_name: user.userPrincipalName,
          mail: user.mail,
        },
      },
      source: 'intune',
      source_id: user.id,
      confidence_score: 100,
    };
  }

  /**
   * Map Intune device compliance state to CMDB status
   */
  private mapDeviceStatus(complianceState: string): string {
    const mapping: Record<string, string> = {
      'compliant': 'active',
      'noncompliant': 'inactive',
      'conflict': 'maintenance',
      'error': 'inactive',
      'inGracePeriod': 'active',
      'configManager': 'active',
      'unknown': 'active',
    };

    return mapping[complianceState] || 'active';
  }

  /**
   * Extract platform from OData type
   */
  private extractPlatformFromODataType(odataType: string): string {
    if (!odataType) return 'Unknown';

    const type = odataType.toLowerCase();
    if (type.includes('ios')) return 'iOS';
    if (type.includes('android')) return 'Android';
    if (type.includes('windows')) return 'Windows';
    if (type.includes('macos')) return 'macOS';

    return 'Unknown';
  }
}
