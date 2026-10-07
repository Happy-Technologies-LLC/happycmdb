// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Microsoft SCCM (Configuration Manager) Connector (v1.0)
 * Multi-resource integration with Microsoft System Center Configuration Manager
 * Supports devices, software inventory, collections, and software updates
 */

import sql from 'mssql';
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

export default class SCCMConnector extends BaseIntegrationConnector {
  private connectionConfig: sql.config;
  private connectionPool: sql.ConnectionPool | null = null;
  private siteCode: string;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.siteCode = config.connection['site_code'];

    // Build SQL Server connection configuration
    this.connectionConfig = {
      server: config.connection['server'],
      database: config.connection['database'],
      options: {
        encrypt: true,
        trustServerCertificate: true,
        enableArithAbort: true,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
      requestTimeout: 60000,
    };

    // Configure authentication
    if (config.connection['use_windows_auth']) {
      this.connectionConfig.authentication = {
        type: 'ntlm',
        options: {
          domain: '',
          userName: config.connection['username'] || '',
          password: config.connection['password'] || '',
        },
      };
    } else {
      this.connectionConfig.user = config.connection['username'];
      this.connectionConfig.password = config.connection['password'];
    }
  }

  async initialize(): Promise<void> {
    logger.info('Initializing SCCM connector');

    // Create connection pool
    this.connectionPool = new sql.ConnectionPool(this.connectionConfig);
    await this.connectionPool.connect();

    this.isInitialized = true;
    logger.info('SCCM connector initialized successfully');
  }

  async cleanup(): Promise<void> {
    if (this.connectionPool) {
      await this.connectionPool.close();
      this.connectionPool = null;
      logger.info('SCCM connection pool closed');
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      const pool = await this.getConnectionPool();
      const result = await pool.request().query('SELECT @@VERSION AS Version');

      return {
        success: true,
        message: 'Successfully connected to SCCM SQL Server',
        details: {
          server: this.connectionConfig.server,
          database: this.connectionConfig.database,
          site_code: this.siteCode,
          sql_version: result.recordset[0].Version,
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  /**
   * Extract data for a specific resource (devices, software_inventory, collections, updates)
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
    const extractedData: ExtractedData[] = [];

    logger.info('Starting SCCM resource extraction');

    try {
      const pool = await this.getConnectionPool();

      // Route to appropriate extraction method
      switch (resourceId) {
        case 'devices':
          return await this.extractDevices(pool, resourceConfig, batchSize);
        case 'software_inventory':
          return await this.extractSoftwareInventory(pool, resourceConfig, batchSize);
        case 'collections':
          return await this.extractCollections(pool, resourceConfig, batchSize);
        case 'updates':
          return await this.extractUpdates(pool, resourceConfig, batchSize);
        default:
          throw new Error(`Unsupported resource: ${resourceId}`);
      }
    } catch (error) {
      logger.error('SCCM resource extraction failed');
      throw new Error('Connector extraction failed');
    }
  }

  /**
   * Extract managed devices from SCCM
   */
  private async extractDevices(
    pool: sql.ConnectionPool,
    resourceConfig: Record<string, any> = {},
    batchSize: number
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    // Get configuration
    const activeOnly = resourceConfig.active_only ?? this.config.connection.devices?.active_only ?? true;
    const lastScanDays = resourceConfig.last_scan_days ?? this.config.connection.devices?.last_scan_days ?? 30;

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const query = `
        SELECT TOP ${batchSize}
          sys.ResourceID,
          sys.Name0 AS Name,
          sys.Distinguished_Name0 AS DistinguishedName,
          sys.Client_Version0 AS ClientVersion,
          sys.Operating_System_Name_and0 AS OperatingSystem,
          sys.Resource_Domain_OR_Workgr0 AS Domain,
          sys.AD_Site_Name0 AS ADSite,
          sys.Client0 AS IsClient,
          sys.Active0 AS IsActive,
          sys.Obsolete0 AS IsObsolete,
          sys.Creation_Date0 AS CreatedDate,
          sys.Last_Logon_Timestamp0 AS LastLogon,
          comp.Manufacturer0 AS Manufacturer,
          comp.Model0 AS Model,
          comp.SystemType0 AS SystemType,
          comp.TotalPhysicalMemory0 AS TotalMemoryKB,
          proc.Name0 AS ProcessorName,
          proc.NumberOfCores0 AS CPUCores,
          proc.NumberOfLogicalProcessors0 AS CPULogicalProcessors,
          net.IPAddress0 AS IPAddress,
          net.MACAddress0 AS MACAddress,
          hw.SerialNumber0 AS SerialNumber,
          os.InstallDate0 AS OSInstallDate,
          os.LastBootUpTime0 AS LastBootTime,
          disk.Size0 AS DiskSizeGB,
          scan.LastScanDate AS LastHardwareScan
        FROM v_R_System sys
        LEFT JOIN v_GS_COMPUTER_SYSTEM comp ON sys.ResourceID = comp.ResourceID
        LEFT JOIN v_GS_PROCESSOR proc ON sys.ResourceID = proc.ResourceID AND proc.DeviceID0 = 'CPU0'
        LEFT JOIN v_RA_System_IPAddresses net ON sys.ResourceID = net.ResourceID
        LEFT JOIN v_GS_PC_BIOS hw ON sys.ResourceID = hw.ResourceID
        LEFT JOIN v_GS_OPERATING_SYSTEM os ON sys.ResourceID = os.ResourceID
        LEFT JOIN (
          SELECT ResourceID, SUM(Size0) / 1024 AS Size0
          FROM v_GS_DISK
          GROUP BY ResourceID
        ) disk ON sys.ResourceID = disk.ResourceID
        LEFT JOIN (
          SELECT ResourceID, MAX(LastUpdateDate) AS LastScanDate
          FROM v_GS_WORKSTATION_STATUS
          GROUP BY ResourceID
        ) scan ON sys.ResourceID = scan.ResourceID
        WHERE 1=1
          ${activeOnly ? "AND sys.Active0 = 1 AND sys.Obsolete0 = 0" : ""}
          ${lastScanDays > 0 ? `AND scan.LastScanDate >= DATEADD(day, -${lastScanDays}, GETDATE())` : ""}
          AND sys.ResourceID > ${offset}
        ORDER BY sys.ResourceID
      `;

      const result = await pool.request().query(query);
      const records = result.recordset;

      for (const record of records) {
        extractedData.push({
          external_id: `SCCM-${record.ResourceID}`,
          data: {
            resource_id: record.ResourceID,
            name: record.Name,
            distinguished_name: record.DistinguishedName,
            client_version: record.ClientVersion,
            operating_system: record.OperatingSystem,
            domain: record.Domain,
            ad_site: record.ADSite,
            is_client: record.IsClient,
            is_active: record.IsActive,
            is_obsolete: record.IsObsolete,
            created_date: record.CreatedDate,
            last_logon: record.LastLogon,
            manufacturer: record.Manufacturer,
            model: record.Model,
            system_type: record.SystemType,
            total_memory_kb: record.TotalMemoryKB,
            total_memory_gb: record.TotalMemoryKB ? Math.round(record.TotalMemoryKB / 1024 / 1024) : null,
            processor_name: record.ProcessorName,
            cpu_cores: record.CPUCores,
            cpu_logical_processors: record.CPULogicalProcessors,
            ip_address: record.IPAddress,
            mac_address: record.MACAddress,
            serial_number: record.SerialNumber,
            os_install_date: record.OSInstallDate,
            last_boot_time: record.LastBootTime,
            disk_size_gb: record.DiskSizeGB,
            last_hardware_scan: record.LastHardwareScan,
          },
          source_type: 'sccm',
          extracted_at: new Date(),
        });

        offset = record.ResourceID;
      }

      logger.info('Extracted device batch from SCCM', {
        batch_size: records.length,
        total_extracted: extractedData.length,
      });

      hasMore = records.length === batchSize;
    }

    logger.info('SCCM device extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract software inventory from SCCM
   */
  private async extractSoftwareInventory(
    pool: sql.ConnectionPool,
    resourceConfig: Record<string, any> = {},
    batchSize: number
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const includeSystemSoftware = resourceConfig.include_system_software ?? false;
    const minInstallCount = resourceConfig.min_install_count ?? 1;

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const query = `
        SELECT TOP ${batchSize}
          arp.DisplayName0 AS ProductName,
          arp.Version0 AS ProductVersion,
          arp.Publisher0 AS Publisher,
          arp.InstallDate0 AS InstallDate,
          sys.ResourceID,
          sys.Name0 AS DeviceName,
          arp.ProdID0 AS ProductID,
          COUNT(*) OVER (PARTITION BY arp.DisplayName0, arp.Version0) AS InstallCount
        FROM v_GS_ADD_REMOVE_PROGRAMS arp
        INNER JOIN v_R_System sys ON arp.ResourceID = sys.ResourceID
        WHERE arp.DisplayName0 IS NOT NULL
          AND arp.DisplayName0 != ''
          ${!includeSystemSoftware ? "AND arp.Publisher0 NOT LIKE 'Microsoft%'" : ""}
          AND arp.ResourceID > ${offset}
        ORDER BY arp.ResourceID, arp.DisplayName0
      `;

      const result = await pool.request().query(query);
      const records = result.recordset;

      for (const record of records) {
        // Filter by minimum install count
        if (record.InstallCount < minInstallCount) {
          continue;
        }

        extractedData.push({
          external_id: `SCCM-SW-${record.ResourceID}-${record.ProductName}-${record.ProductVersion}`,
          data: {
            product_name: record.ProductName,
            product_version: record.ProductVersion,
            publisher: record.Publisher,
            install_date: record.InstallDate,
            device_resource_id: record.ResourceID,
            device_name: record.DeviceName,
            product_id: record.ProductID,
            install_count: record.InstallCount,
          },
          source_type: 'sccm',
          extracted_at: new Date(),
        });

        offset = record.ResourceID;
      }

      logger.info('Extracted software inventory batch from SCCM', {
        batch_size: records.length,
        total_extracted: extractedData.length,
      });

      hasMore = records.length === batchSize;
    }

    logger.info('SCCM software inventory extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract device collections from SCCM
   */
  private async extractCollections(
    pool: sql.ConnectionPool,
    resourceConfig: Record<string, any> = {},
    batchSize: number
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const excludeSystemCollections = resourceConfig.exclude_system_collections ?? true;
    const minMemberCount = resourceConfig.min_member_count ?? 0;

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const query = `
        SELECT TOP ${batchSize}
          coll.CollectionID,
          coll.Name,
          coll.Comment,
          coll.MemberCount,
          coll.CollectionType,
          coll.LastMemberChangeTime,
          coll.LastRefreshTime,
          coll.LimitToCollectionID,
          coll.LimitToCollectionName,
          coll.IsBuiltIn,
          coll.IsReferenceCollection,
          COUNT(rules.CollectionID) AS RuleCount
        FROM v_Collection coll
        LEFT JOIN v_CollectionRuleDirect rules ON coll.CollectionID = rules.CollectionID
        WHERE coll.CollectionType = 2  -- Device collections only (not user collections)
          ${excludeSystemCollections ? "AND coll.IsBuiltIn = 0" : ""}
          AND coll.MemberCount >= ${minMemberCount}
          AND CAST(coll.CollectionID AS INT) > ${offset}
        GROUP BY
          coll.CollectionID, coll.Name, coll.Comment, coll.MemberCount,
          coll.CollectionType, coll.LastMemberChangeTime, coll.LastRefreshTime,
          coll.LimitToCollectionID, coll.LimitToCollectionName,
          coll.IsBuiltIn, coll.IsReferenceCollection
        ORDER BY CAST(coll.CollectionID AS INT)
      `;

      const result = await pool.request().query(query);
      const records = result.recordset;

      for (const record of records) {
        extractedData.push({
          external_id: `SCCM-COLL-${record.CollectionID}`,
          data: {
            collection_id: record.CollectionID,
            name: record.Name,
            comment: record.Comment,
            member_count: record.MemberCount,
            collection_type: record.CollectionType,
            last_member_change: record.LastMemberChangeTime,
            last_refresh: record.LastRefreshTime,
            limiting_collection_id: record.LimitToCollectionID,
            limiting_collection_name: record.LimitToCollectionName,
            is_built_in: record.IsBuiltIn,
            is_reference: record.IsReferenceCollection,
            rule_count: record.RuleCount,
          },
          source_type: 'sccm',
          extracted_at: new Date(),
        });

        offset = parseInt(record.CollectionID, 10);
      }

      logger.info('Extracted collection batch from SCCM', {
        batch_size: records.length,
        total_extracted: extractedData.length,
      });

      hasMore = records.length === batchSize;
    }

    logger.info('SCCM collection extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract software updates from SCCM
   */
  private async extractUpdates(
    pool: sql.ConnectionPool,
    resourceConfig: Record<string, any> = {},
    batchSize: number
  ): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    const deployedOnly = resourceConfig.deployed_only ?? false;
    const requiredOnly = resourceConfig.required_only ?? true;
    const severityLevels = resourceConfig.severity_levels ?? ['Critical', 'Important'];

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const severityFilter = severityLevels.length > 0
        ? `AND upd.SeverityName IN (${severityLevels.map(s => `'${s}'`).join(',')})`
        : '';

      const query = `
        SELECT TOP ${batchSize}
          upd.CI_ID,
          upd.ArticleID,
          upd.BulletinID,
          upd.Title,
          upd.Description,
          upd.SeverityName AS Severity,
          upd.IsDeployed,
          upd.IsSuperseded,
          upd.IsExpired,
          upd.DatePosted,
          upd.DateRevised,
          comp.NumPresent AS InstalledCount,
          comp.NumMissing AS RequiredCount,
          comp.NumNotApplicable AS NotApplicableCount,
          comp.NumTotal AS TotalDevices
        FROM v_UpdateInfo upd
        LEFT JOIN v_Update_ComplianceSummary comp ON upd.CI_ID = comp.CI_ID
        WHERE 1=1
          ${deployedOnly ? "AND upd.IsDeployed = 1" : ""}
          ${requiredOnly ? "AND comp.NumMissing > 0" : ""}
          ${severityFilter}
          AND upd.IsExpired = 0
          AND upd.CI_ID > ${offset}
        ORDER BY upd.CI_ID
      `;

      const result = await pool.request().query(query);
      const records = result.recordset;

      for (const record of records) {
        extractedData.push({
          external_id: `SCCM-UPD-${record.CI_ID}`,
          data: {
            ci_id: record.CI_ID,
            article_id: record.ArticleID,
            bulletin_id: record.BulletinID,
            title: record.Title,
            description: record.Description,
            severity: record.Severity,
            is_deployed: record.IsDeployed,
            is_superseded: record.IsSuperseded,
            is_expired: record.IsExpired,
            date_posted: record.DatePosted,
            date_revised: record.DateRevised,
            installed_count: record.InstalledCount || 0,
            required_count: record.RequiredCount || 0,
            not_applicable_count: record.NotApplicableCount || 0,
            total_devices: record.TotalDevices || 0,
          },
          source_type: 'sccm',
          extracted_at: new Date(),
        });

        offset = record.CI_ID;
      }

      logger.info('Extracted update batch from SCCM', {
        batch_size: records.length,
        total_extracted: extractedData.length,
      });

      hasMore = records.length === batchSize;
    }

    logger.info('SCCM update extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  /**
   * Extract relationships between SCCM resources
   */
  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      const pool = await this.getConnectionPool();

      // Extract Software -> Device relationships (INSTALLED_ON)
      if (this.isResourceEnabled('software_inventory') && this.isResourceEnabled('devices')) {
        const softwareRelQuery = `
          SELECT
            arp.DisplayName0 AS ProductName,
            arp.Version0 AS ProductVersion,
            sys.ResourceID
          FROM v_GS_ADD_REMOVE_PROGRAMS arp
          INNER JOIN v_R_System sys ON arp.ResourceID = sys.ResourceID
          WHERE arp.DisplayName0 IS NOT NULL
        `;

        const result = await pool.request().query(softwareRelQuery);

        for (const record of result.recordset) {
          relationships.push({
            source_external_id: `SCCM-SW-${record.ResourceID}-${record.ProductName}-${record.ProductVersion}`,
            target_external_id: `SCCM-${record.ResourceID}`,
            relationship_type: 'INSTALLED_ON',
            properties: {
              source: 'sccm',
              type: 'software_installation',
            },
          });
        }

        logger.info('Extracted software-device relationships', {
          count: result.recordset.length,
        });
      }

      // Extract Collection -> Device relationships (MEMBER_OF)
      if (this.isResourceEnabled('collections') && this.isResourceEnabled('devices')) {
        const collectionRelQuery = `
          SELECT
            mem.CollectionID,
            mem.ResourceID
          FROM v_FullCollectionMembership mem
          INNER JOIN v_Collection coll ON mem.CollectionID = coll.CollectionID
          WHERE coll.CollectionType = 2  -- Device collections
        `;

        const result = await pool.request().query(collectionRelQuery);

        for (const record of result.recordset) {
          relationships.push({
            source_external_id: `SCCM-${record.ResourceID}`,
            target_external_id: `SCCM-COLL-${record.CollectionID}`,
            relationship_type: 'MEMBER_OF',
            properties: {
              source: 'sccm',
              type: 'collection_membership',
            },
          });
        }

        logger.info('Extracted collection-device relationships', {
          count: result.recordset.length,
        });
      }

      // Extract Update -> Device relationships (REQUIRED_BY)
      if (this.isResourceEnabled('updates') && this.isResourceEnabled('devices')) {
        const updateRelQuery = `
          SELECT
            status.CI_ID,
            status.ResourceID,
            status.Status  -- 0 = Unknown, 1 = NotApplicable, 2 = Missing, 3 = Present
          FROM v_Update_ComplianceStatus status
          WHERE status.Status IN (2, 3)  -- Missing or Installed
        `;

        const result = await pool.request().query(updateRelQuery);

        for (const record of result.recordset) {
          const relType = record.Status === 2 ? 'REQUIRED_BY' : 'INSTALLED_ON';

          relationships.push({
            source_external_id: `SCCM-UPD-${record.CI_ID}`,
            target_external_id: `SCCM-${record.ResourceID}`,
            relationship_type: relType,
            properties: {
              source: 'sccm',
              type: 'update_compliance',
              status: record.Status === 2 ? 'required' : 'installed',
            },
          });
        }

        logger.info('Extracted update-device relationships', {
          count: result.recordset.length,
        });
      }

    } catch (error) {
      logger.error('SCCM relationship extraction failed');
      // Don't throw - relationships are optional
    }

    logger.info('SCCM relationship extraction completed', {
      total_relationships: relationships.length,
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

    // Route to appropriate transformation method
    switch (resourceId) {
      case 'devices':
        return this.transformDevice(sourceData);
      case 'software_inventory':
        return this.transformSoftware(sourceData);
      case 'collections':
        return this.transformCollection(sourceData);
      case 'updates':
        return this.transformUpdate(sourceData);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  /**
   * Transform SCCM device to CMDB CI
   */
  private transformDevice(data: any): TransformedCI {
    // Determine CI type based on system type
    let ciType = 'server';
    if (data.system_type?.toLowerCase().includes('virtual')) {
      ciType = 'virtual-machine';
    }

    return {
      name: data.name || `Device-${data.resource_id}`,
      ci_type: ciType,
      environment: this.extractEnvironment(data),
      status: this.mapDeviceStatus(data),
      attributes: {
        resource_id: data.resource_id,
        distinguished_name: data.distinguished_name,
        client_version: data.client_version,
        operating_system: data.operating_system,
        domain: data.domain,
        ad_site: data.ad_site,
        manufacturer: data.manufacturer,
        model: data.model,
        system_type: data.system_type,
        total_memory_gb: data.total_memory_gb,
        processor_name: data.processor_name,
        cpu_cores: data.cpu_cores,
        cpu_logical_processors: data.cpu_logical_processors,
        disk_size_gb: data.disk_size_gb,
        os_install_date: data.os_install_date,
        last_boot_time: data.last_boot_time,
        last_hardware_scan: data.last_hardware_scan,
        last_logon: data.last_logon,
        created_date: data.created_date,
        is_client: data.is_client,
        is_active: data.is_active,
        is_obsolete: data.is_obsolete,
      },
      identifiers: {
        external_id: `SCCM-${data.resource_id}`,
        serial_number: data.serial_number,
        mac_address: data.mac_address ? [data.mac_address] : undefined,
        ip_address: data.ip_address ? [data.ip_address] : undefined,
        hostname: data.name,
        fqdn: data.distinguished_name,
        custom_identifiers: {
          sccm_resource_id: data.resource_id.toString(),
          domain: data.domain,
        },
      },
      source: 'sccm',
      source_id: `SCCM-${data.resource_id}`,
      confidence_score: 95, // SCCM is highly authoritative for Windows devices
    };
  }

  /**
   * Transform SCCM software to CMDB CI
   */
  private transformSoftware(data: any): TransformedCI {
    return {
      name: `${data.product_name} ${data.product_version}`,
      ci_type: 'software',
      environment: 'production',
      status: 'active',
      attributes: {
        product_name: data.product_name,
        product_version: data.product_version,
        publisher: data.publisher,
        install_date: data.install_date,
        product_id: data.product_id,
        install_count: data.install_count,
        device_resource_id: data.device_resource_id,
        device_name: data.device_name,
      },
      identifiers: {
        external_id: `SCCM-SW-${data.device_resource_id}-${data.product_name}-${data.product_version}`,
        custom_identifiers: {
          product_name: data.product_name,
          product_version: data.product_version,
          publisher: data.publisher,
        },
      },
      source: 'sccm',
      source_id: `SCCM-SW-${data.device_resource_id}-${data.product_name}-${data.product_version}`,
      confidence_score: 90,
    };
  }

  /**
   * Transform SCCM collection to CMDB CI
   */
  private transformCollection(data: any): TransformedCI {
    return {
      name: data.name,
      ci_type: 'collection',
      environment: 'production',
      status: 'active',
      attributes: {
        collection_id: data.collection_id,
        comment: data.comment,
        member_count: data.member_count,
        collection_type: data.collection_type,
        last_member_change: data.last_member_change,
        last_refresh: data.last_refresh,
        limiting_collection_id: data.limiting_collection_id,
        limiting_collection_name: data.limiting_collection_name,
        is_built_in: data.is_built_in,
        is_reference: data.is_reference,
        rule_count: data.rule_count,
      },
      identifiers: {
        external_id: `SCCM-COLL-${data.collection_id}`,
        custom_identifiers: {
          collection_id: data.collection_id,
        },
      },
      source: 'sccm',
      source_id: `SCCM-COLL-${data.collection_id}`,
      confidence_score: 100,
    };
  }

  /**
   * Transform SCCM update to CMDB CI
   */
  private transformUpdate(data: any): TransformedCI {
    return {
      name: data.title,
      ci_type: 'update',
      environment: 'production',
      status: this.mapUpdateStatus(data),
      attributes: {
        ci_id: data.ci_id,
        article_id: data.article_id,
        bulletin_id: data.bulletin_id,
        description: data.description,
        severity: data.severity,
        is_deployed: data.is_deployed,
        is_superseded: data.is_superseded,
        is_expired: data.is_expired,
        date_posted: data.date_posted,
        date_revised: data.date_revised,
        installed_count: data.installed_count,
        required_count: data.required_count,
        not_applicable_count: data.not_applicable_count,
        total_devices: data.total_devices,
        compliance_percentage: data.total_devices > 0
          ? Math.round((data.installed_count / data.total_devices) * 100)
          : 0,
      },
      identifiers: {
        external_id: `SCCM-UPD-${data.ci_id}`,
        custom_identifiers: {
          ci_id: data.ci_id.toString(),
          article_id: data.article_id,
          bulletin_id: data.bulletin_id,
        },
      },
      source: 'sccm',
      source_id: `SCCM-UPD-${data.ci_id}`,
      confidence_score: 100,
    };
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: `SCCM-${data.resource_id}`,
      serial_number: data.serial_number,
      mac_address: data.mac_address ? [data.mac_address] : undefined,
      ip_address: data.ip_address ? [data.ip_address] : undefined,
      hostname: data.name,
      fqdn: data.distinguished_name,
      custom_identifiers: {
        sccm_resource_id: data.resource_id?.toString(),
      },
    };
  }

  /**
   * Map SCCM device status to CMDB status
   */
  private mapDeviceStatus(data: any): string {
    if (data.is_obsolete) {
      return 'decommissioned';
    }
    if (!data.is_active) {
      return 'inactive';
    }
    return 'active';
  }

  /**
   * Map SCCM update status to CMDB status
   */
  private mapUpdateStatus(data: any): string {
    if (data.is_expired) {
      return 'decommissioned';
    }
    if (data.is_superseded) {
      return 'inactive';
    }
    if (data.is_deployed) {
      return 'active';
    }
    return 'inactive';
  }

  /**
   * Extract environment from SCCM device data
   */
  private extractEnvironment(data: any): string {
    // Try to infer from AD site or domain
    const adSite = data.ad_site?.toLowerCase() || '';
    const domain = data.domain?.toLowerCase() || '';
    const name = data.name?.toLowerCase() || '';

    if (adSite.includes('prod') || domain.includes('prod') || name.includes('prod')) {
      return 'production';
    }
    if (adSite.includes('dev') || domain.includes('dev') || name.includes('dev')) {
      return 'development';
    }
    if (adSite.includes('test') || domain.includes('test') || name.includes('test')) {
      return 'test';
    }
    if (adSite.includes('staging') || domain.includes('staging') || name.includes('staging')) {
      return 'staging';
    }

    // Default to production for managed devices
    return 'production';
  }

  /**
   * Get connection pool (lazy initialization)
   */
  private async getConnectionPool(): Promise<sql.ConnectionPool> {
    if (!this.connectionPool) {
      await this.initialize();
    }
    if (!this.connectionPool) {
      throw new Error('SCCM connection pool not initialized');
    }
    return this.connectionPool;
  }

  /**
   * Check if a resource is enabled
   */
  private isResourceEnabled(resourceId: string): boolean {
    const enabledResources = this.getEnabledResources();
    return enabledResources.includes(resourceId);
  }
}
