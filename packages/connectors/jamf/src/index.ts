// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JAMF Pro Connector (v1.0)
 * Multi-resource integration with JAMF Pro for macOS/iOS device management
 * Supports computers, mobile devices, applications, and policies
 */

import axios, { AxiosInstance } from 'axios';
import { parseStringPromise } from 'xml2js';
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

export default class JAMFConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private jamfUrl: string;
  private useClassicAPI: boolean;
  private bearerToken: string | null = null;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.jamfUrl = config.connection['jamf_url'];
    this.useClassicAPI = config.connection['use_classic_api'] !== false; // Default to true

    this.client = axios.create({
      baseURL: this.jamfUrl,
      auth: {
        username: config.connection['username'],
        password: config.connection['password'],
      },
      headers: {
        'Accept': this.useClassicAPI ? 'application/xml' : 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing JAMF connector');

    // If using new API, get bearer token
    if (!this.useClassicAPI) {
      await this.getBearerToken();
    }

    this.isInitialized = true;
  }

  /**
   * Get bearer token for new JAMF Pro API
   */
  private async getBearerToken(): Promise<void> {
    try {
      const response = await this.client.post('/api/v1/auth/token');
      this.bearerToken = response.data.token;

      // Update client headers with bearer token
      this.client.defaults.headers.common['Authorization'] = `Bearer ${this.bearerToken}`;

      logger.info('JAMF bearer token obtained successfully');
    } catch (error: any) {
      logger.error('Failed to obtain JAMF bearer token');
      throw new Error('Bearer token authentication failed');
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying activationcode endpoint (lightweight)
      const endpoint = this.useClassicAPI
        ? '/JSSResource/activationcode'
        : '/api/v1/jamf-pro-version';

      await this.client.get(endpoint);

      return {
        success: true,
        message: 'Successfully connected to JAMF Pro',
        details: {
          jamf_url: this.jamfUrl,
          api_mode: this.useClassicAPI ? 'Classic API (XML)' : 'New API (JSON)',
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

    logger.info('Starting JAMF resource extraction');

    switch (resourceId) {
      case 'computers':
        return await this.extractComputers(resourceConfig);
      case 'mobile_devices':
        return await this.extractMobileDevices(resourceConfig);
      case 'applications':
        return await this.extractApplications(resourceConfig);
      case 'policies':
        return await this.extractPolicies(resourceConfig);
      default:
        throw new Error(`Extraction not implemented for resource: ${resourceId}`);
    }
  }

  /**
   * Extract computers (macOS devices)
   */
  private async extractComputers(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      // Get list of all computers
      const listEndpoint = this.useClassicAPI
        ? '/JSSResource/computers'
        : '/api/v1/computers-inventory';

      const listResponse = await this.client.get(listEndpoint);
      const computerList = this.useClassicAPI
        ? await this.parseXML(listResponse.data)
        : listResponse.data;

      const computers = this.useClassicAPI
        ? computerList.computers?.computer || []
        : computerList.results || [];

      logger.info('Retrieved computer list from JAMF', { count: computers.length });

      // Get detailed info for each computer
      for (const computer of computers) {
        try {
          const computerId = this.useClassicAPI ? computer.id[0] : computer.id;
          const detailEndpoint = this.useClassicAPI
            ? `/JSSResource/computers/id/${computerId}`
            : `/api/v1/computers-inventory/detail/${computerId}`;

          const detailResponse = await this.client.get(detailEndpoint);
          const computerDetail = this.useClassicAPI
            ? await this.parseXML(detailResponse.data)
            : detailResponse.data;

          const computerData = this.useClassicAPI
            ? computerDetail.computer
            : computerDetail;

          // Apply filters
          if (this.shouldIncludeComputer(computerData, resourceConfig)) {
            extractedData.push({
              external_id: String(computerId),
              data: computerData,
              source_type: 'jamf',
              extracted_at: new Date(),
            });
          }

        } catch (error) {
          logger.error('Failed to extract computer detail');
          // Continue with next computer
        }
      }

      logger.info('JAMF computers extraction completed', {
        total_found: computers.length,
        total_extracted: extractedData.length,
      });

    } catch (error) {
      logger.error('JAMF computers extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract mobile devices (iOS/iPadOS)
   */
  private async extractMobileDevices(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      // Get list of all mobile devices
      const listEndpoint = '/JSSResource/mobiledevices';
      const listResponse = await this.client.get(listEndpoint);
      const deviceList = await this.parseXML(listResponse.data);

      const devices = deviceList.mobile_devices?.mobile_device || [];

      logger.info('Retrieved mobile device list from JAMF', { count: devices.length });

      // Get detailed info for each device
      for (const device of devices) {
        try {
          const deviceId = device.id[0];
          const detailEndpoint = `/JSSResource/mobiledevices/id/${deviceId}`;
          const detailResponse = await this.client.get(detailEndpoint);
          const deviceDetail = await this.parseXML(detailResponse.data);

          const deviceData = deviceDetail.mobile_device;

          // Apply filters
          if (this.shouldIncludeMobileDevice(deviceData, resourceConfig)) {
            extractedData.push({
              external_id: String(deviceId),
              data: deviceData,
              source_type: 'jamf',
              extracted_at: new Date(),
            });
          }

        } catch (error) {
          logger.error('Failed to extract mobile device detail');
          // Continue with next device
        }
      }

      logger.info('JAMF mobile devices extraction completed', {
        total_found: devices.length,
        total_extracted: extractedData.length,
      });

    } catch (error) {
      logger.error('JAMF mobile devices extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract applications from computers and mobile devices
   */
  private async extractApplications(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const applicationMap = new Map<string, any>(); // Deduplicate by bundle_id or name

    try {
      // Extract applications from computers
      const computers = await this.extractComputers();

      for (const computer of computers) {
        const apps = this.useClassicAPI
          ? computer.data['software']?.[0]?.['applications']?.[0]?.application || []
          : computer.data['software']?.applications || [];

        for (const app of apps) {
          const appData = this.useClassicAPI ? {
            name: app.name?.[0] || 'Unknown',
            version: app.version?.[0] || '',
            bundle_id: app.bundle_id?.[0] || '',
            path: app.path?.[0] || '',
            size_mb: app.size?.[0] || '',
          } : app;

          const key = appData.bundle_id || appData.name;

          if (!applicationMap.has(key)) {
            applicationMap.set(key, {
              ...appData,
              installed_on: [],
            });
          }

          // Track which devices have this app
          applicationMap.get(key).installed_on.push({
            device_type: 'computer',
            device_id: computer.external_id,
          });
        }
      }

      // Extract applications from mobile devices if enabled
      if (resourceConfig?.['include_mobile_apps'] !== false) {
        const mobileDevices = await this.extractMobileDevices();

        for (const device of mobileDevices) {
          const apps = device.data['applications']?.[0]?.application || [];

          for (const app of apps) {
            const appData = {
              name: app.application_name?.[0] || 'Unknown',
              version: app.application_version?.[0] || '',
              bundle_id: app.identifier?.[0] || '',
              size_mb: app.application_size?.[0] || '',
            };

            const key = appData.bundle_id || appData.name;

            if (!applicationMap.has(key)) {
              applicationMap.set(key, {
                ...appData,
                installed_on: [],
              });
            }

            applicationMap.get(key).installed_on.push({
              device_type: 'mobile_device',
              device_id: device.external_id,
            });
          }
        }
      }

      // Convert map to extracted data
      let appIndex = 0;
      for (const [_key, appData] of applicationMap.entries()) {
        extractedData.push({
          external_id: `app-${appIndex++}`,
          data: appData,
          source_type: 'jamf',
          extracted_at: new Date(),
        });
      }

      logger.info('JAMF applications extraction completed', {
        total_applications: extractedData.length,
      });

    } catch (error) {
      logger.error('JAMF applications extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract policies
   */
  private async extractPolicies(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      // Get list of all policies
      const listEndpoint = '/JSSResource/policies';
      const listResponse = await this.client.get(listEndpoint);
      const policyList = await this.parseXML(listResponse.data);

      const policies = policyList.policies?.policy || [];

      logger.info('Retrieved policy list from JAMF', { count: policies.length });

      // Get detailed info for each policy
      for (const policy of policies) {
        try {
          const policyId = policy.id[0];
          const detailEndpoint = `/JSSResource/policies/id/${policyId}`;
          const detailResponse = await this.client.get(detailEndpoint);
          const policyDetail = await this.parseXML(detailResponse.data);

          const policyData = policyDetail.policy;

          // Apply filters
          if (this.shouldIncludePolicy(policyData, resourceConfig)) {
            extractedData.push({
              external_id: String(policyId),
              data: policyData,
              source_type: 'jamf',
              extracted_at: new Date(),
            });
          }

        } catch (error) {
          logger.error('Failed to extract policy detail');
          // Continue with next policy
        }
      }

      logger.info('JAMF policies extraction completed', {
        total_found: policies.length,
        total_extracted: extractedData.length,
      });

    } catch (error) {
      logger.error('JAMF policies extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract relationships between resources
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      // Extract application -> device relationships
      const applications = await this.extractApplications();

      for (const app of applications) {
        const installedOn = app.data['installed_on'] || [];

        for (const installation of installedOn) {
          relationships.push({
            source_external_id: app.external_id,
            target_external_id: installation.device_id,
            relationship_type: 'INSTALLED_ON',
            properties: {
              device_type: installation.device_type,
            },
          });
        }
      }

      // Extract policy -> computer relationships
      const policies = await this.extractPolicies();

      for (const policy of policies) {
        const scope = policy.data['scope']?.[0] || {};
        const computers = scope.computers?.[0]?.computer || [];

        for (const computer of computers) {
          const computerId = computer.id?.[0];
          if (computerId) {
            relationships.push({
              source_external_id: policy.external_id,
              target_external_id: String(computerId),
              relationship_type: 'APPLIES_TO',
              properties: {
                policy_name: policy.data['general']?.[0]?.name?.[0],
              },
            });
          }
        }
      }

      logger.info('JAMF relationships extracted', {
        count: relationships.length,
      });

    } catch (error) {
      logger.error('JAMF relationship extraction failed');
      // Don't throw - relationships are optional
    }

    return relationships;
  }

  /**
   * Transform source data to CMDB format
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
      case 'computers':
        return this.transformComputer(sourceData);
      case 'mobile_devices':
        return this.transformMobileDevice(sourceData);
      case 'applications':
        return this.transformApplication(sourceData);
      case 'policies':
        return this.transformPolicy(sourceData);
      default:
        throw new Error(`Transformation not implemented for resource: ${resourceId}`);
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.general?.[0]?.id?.[0] || data.id,
      serial_number: data.general?.[0]?.serial_number?.[0],
      uuid: data.general?.[0]?.udid?.[0],
      mac_address: data.general?.[0]?.mac_address?.[0]
        ? [data.general[0].mac_address[0]]
        : undefined,
      hostname: data.general?.[0]?.name?.[0],
      ip_address: data.general?.[0]?.ip_address?.[0]
        ? [data.general[0].ip_address[0]]
        : undefined,
      custom_identifiers: {
        jamf_id: data.general?.[0]?.id?.[0] || data.id,
      },
    };
  }

  /**
   * Transform computer to CMDB CI
   */
  private transformComputer(sourceData: any): TransformedCI {
    const general = sourceData.general?.[0] || {};
    const hardware = sourceData.hardware?.[0] || {};
    const operatingSystem = hardware.os_name?.[0] || hardware.operating_system?.[0] || '';

    return {
      name: general.name?.[0] || 'Unknown Computer',
      ci_type: 'server',
      environment: this.extractEnvironment(sourceData),
      status: this.mapComputerStatus(general.remote_management?.[0]?.managed?.[0]),
      attributes: {
        serial_number: general.serial_number?.[0],
        mac_address: general.mac_address?.[0],
        udid: general.udid?.[0],
        model: hardware.model?.[0],
        model_identifier: hardware.model_identifier?.[0],
        os: operatingSystem,
        os_version: hardware.os_version?.[0],
        os_build: hardware.os_build?.[0],
        processor_type: hardware.processor_type?.[0],
        processor_speed_mhz: hardware.processor_speed_mhz?.[0],
        number_processors: hardware.number_processors?.[0],
        number_cores: hardware.number_cores?.[0],
        total_ram_mb: hardware.total_ram?.[0],
        storage_capacity_mb: hardware.storage?.[0]?.drive?.[0]?.size?.[0],
        battery_capacity: hardware.battery_capacity?.[0],
        last_contact_time: general.last_contact_time?.[0],
        last_contact_time_utc: general.last_contact_time_utc?.[0],
        ip_address: general.ip_address?.[0],
        managed: general.remote_management?.[0]?.managed?.[0] === 'true',
        mdm_capable: general.mdm_capable?.[0] === 'true',
        jamf_version: general.jamf_version?.[0],
        platform: general.platform?.[0],
        barcode_1: general.barcode_1?.[0],
        barcode_2: general.barcode_2?.[0],
        asset_tag: general.asset_tag?.[0],
      },
      identifiers: this.extractIdentifiers(sourceData),
      source: 'jamf',
      source_id: general.id?.[0] || 'unknown',
      confidence_score: 95, // JAMF is highly authoritative for Apple devices
    };
  }

  /**
   * Transform mobile device to CMDB CI
   */
  private transformMobileDevice(sourceData: any): TransformedCI {
    const general = sourceData.general?.[0] || {};
    const mobileDeviceInfo = sourceData.mobile_device_information?.[0] || {};

    return {
      name: general.name?.[0] || general.device_name?.[0] || 'Unknown Device',
      ci_type: 'mobile-device',
      environment: this.extractEnvironment(sourceData),
      status: this.mapDeviceStatus(general.managed?.[0]),
      attributes: {
        serial_number: general.serial_number?.[0],
        udid: general.udid?.[0],
        wifi_mac_address: general.wifi_mac_address?.[0],
        bluetooth_mac_address: general.bluetooth_mac_address?.[0],
        model: general.model?.[0],
        model_identifier: general.model_identifier?.[0],
        model_display: general.model_display?.[0],
        device_name: general.device_name?.[0],
        os_type: general.os_type?.[0],
        os_version: general.os_version?.[0],
        os_build: general.os_build?.[0],
        capacity_mb: mobileDeviceInfo.capacity_mb?.[0],
        available_mb: mobileDeviceInfo.available_mb?.[0],
        percentage_used: mobileDeviceInfo.percentage_used?.[0],
        battery_level: mobileDeviceInfo.battery_level?.[0],
        last_backup_time: mobileDeviceInfo.last_backup_time?.[0],
        ip_address: general.ip_address?.[0],
        managed: general.managed?.[0] === 'true',
        supervised: general.supervised?.[0] === 'true',
        phone_number: general.phone_number?.[0],
        carrier: mobileDeviceInfo.carrier?.[0],
        iccid: mobileDeviceInfo.iccid?.[0],
        imei: mobileDeviceInfo.imei?.[0],
        last_inventory_update: general.last_inventory_update?.[0],
        last_inventory_update_utc: general.last_inventory_update_utc?.[0],
      },
      identifiers: {
        external_id: general.id?.[0],
        serial_number: general.serial_number?.[0],
        uuid: general.udid?.[0],
        mac_address: general.wifi_mac_address?.[0]
          ? [general.wifi_mac_address[0]]
          : undefined,
        hostname: general.name?.[0] || general.device_name?.[0],
        ip_address: general.ip_address?.[0]
          ? [general.ip_address[0]]
          : undefined,
        custom_identifiers: {
          jamf_id: general.id?.[0],
          imei: mobileDeviceInfo.imei?.[0],
        },
      },
      source: 'jamf',
      source_id: general.id?.[0] || 'unknown',
      confidence_score: 95,
    };
  }

  /**
   * Transform application to CMDB CI
   */
  private transformApplication(sourceData: any): TransformedCI {
    return {
      name: sourceData.name || 'Unknown Application',
      ci_type: 'application',
      environment: 'production',
      status: 'active',
      attributes: {
        version: sourceData.version,
        bundle_id: sourceData.bundle_id,
        path: sourceData.path,
        size_mb: sourceData.size_mb,
        install_count: sourceData['installed_on']?.length || 0,
        device_types: [...new Set(sourceData['installed_on']?.map((i: any) => i.device_type) || [])],
      },
      identifiers: {
        external_id: sourceData.bundle_id || sourceData.name,
        custom_identifiers: {
          bundle_id: sourceData.bundle_id,
        },
      },
      source: 'jamf',
      source_id: sourceData.bundle_id || sourceData.name,
      confidence_score: 85,
    };
  }

  /**
   * Transform policy to CMDB CI
   */
  private transformPolicy(sourceData: any): TransformedCI {
    const general = sourceData.general?.[0] || {};
    const scope = sourceData.scope?.[0] || {};
    const selfService = sourceData.self_service?.[0] || {};

    return {
      name: general.name?.[0] || 'Unknown Policy',
      ci_type: 'policy',
      environment: 'production',
      status: general.enabled?.[0] === 'true' ? 'active' : 'inactive',
      attributes: {
        enabled: general.enabled?.[0] === 'true',
        frequency: general.frequency?.[0],
        category: general.category?.[0]?.name?.[0],
        trigger: general.trigger?.[0],
        trigger_checkin: general.trigger_checkin?.[0] === 'true',
        trigger_enrollment_complete: general.trigger_enrollment_complete?.[0] === 'true',
        trigger_login: general.trigger_login?.[0] === 'true',
        trigger_logout: general.trigger_logout?.[0] === 'true',
        trigger_startup: general.trigger_startup?.[0] === 'true',
        execution_frequency: general.execution_frequency?.[0],
        target_drive: general.target_drive?.[0],
        offline: general.offline?.[0] === 'true',
        network_limitations: general.network_limitations?.[0],
        self_service_enabled: selfService.use_for_self_service?.[0] === 'true',
        self_service_display_name: selfService.self_service_display_name?.[0],
        self_service_description: selfService.self_service_description?.[0],
        scope_all_computers: scope.all_computers?.[0] === 'true',
        scope_computer_count: scope.computers?.[0]?.computer?.length || 0,
      },
      identifiers: {
        external_id: general.id?.[0],
        custom_identifiers: {
          jamf_policy_id: general.id?.[0],
        },
      },
      source: 'jamf',
      source_id: general.id?.[0] || 'unknown',
      confidence_score: 100,
    };
  }

  /**
   * Parse XML response to JSON
   */
  private async parseXML(xmlData: string): Promise<any> {
    try {
      return await parseStringPromise(xmlData, {
        explicitArray: true,
        mergeAttrs: true,
      });
    } catch (error) {
      logger.error('Failed to parse XML response');
      throw new Error('XML parsing failed');
    }
  }

  /**
   * Filter: Should include computer?
   */
  private shouldIncludeComputer(computerData: any, resourceConfig?: Record<string, any>): boolean {
    const general = computerData.general?.[0] || {};
    const globalConfig = this.config.connection['computers'] || {};
    const config = { ...globalConfig, ...resourceConfig };

    // Filter by managed status
    if (config.managed_only !== false) {
      const managed = general.remote_management?.[0]?.managed?.[0] === 'true';
      if (!managed) return false;
    }

    // Filter by last check-in time
    if (config.last_checkin_days) {
      const lastContactTime = general.last_contact_time_utc?.[0];
      if (lastContactTime) {
        const lastContact = new Date(lastContactTime);
        const daysAgo = (Date.now() - lastContact.getTime()) / (1000 * 60 * 60 * 24);
        if (daysAgo > config.last_checkin_days) return false;
      }
    }

    return true;
  }

  /**
   * Filter: Should include mobile device?
   */
  private shouldIncludeMobileDevice(deviceData: any, resourceConfig?: Record<string, any>): boolean {
    const general = deviceData.general?.[0] || {};
    const globalConfig = this.config.connection['mobile_devices'] || {};
    const config = { ...globalConfig, ...resourceConfig };

    // Filter by managed status
    if (config.managed_only !== false) {
      const managed = general.managed?.[0] === 'true';
      if (!managed) return false;
    }

    // Filter by supervised status
    if (config.supervised_only === true) {
      const supervised = general.supervised?.[0] === 'true';
      if (!supervised) return false;
    }

    return true;
  }

  /**
   * Filter: Should include policy?
   */
  private shouldIncludePolicy(policyData: any, resourceConfig?: Record<string, any>): boolean {
    const general = policyData.general?.[0] || {};
    const config = resourceConfig || {};

    // Filter by enabled status
    if (config['enabled_only'] !== false) {
      const enabled = general.enabled?.[0] === 'true';
      if (!enabled) return false;
    }

    return true;
  }

  /**
   * Extract environment from source data
   */
  private extractEnvironment(_sourceData: any): string {
    // JAMF doesn't have built-in environment concept
    // Could be derived from computer groups, site, or custom fields
    // Default to production
    return 'production';
  }

  /**
   * Map computer managed status to CMDB status
   */
  private mapComputerStatus(managed?: string): string {
    return managed === 'true' ? 'active' : 'inactive';
  }

  /**
   * Map mobile device managed status to CMDB status
   */
  private mapDeviceStatus(managed?: string): string {
    return managed === 'true' ? 'active' : 'inactive';
  }
}
