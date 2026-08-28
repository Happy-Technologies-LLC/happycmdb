// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorLifecycleService
 *
 * Single source of truth for connector install/update/uninstall. Both the
 * REST controller (ConnectorController) and the GraphQL resolvers
 * (connector.resolvers.ts) call this service so their lifecycle behavior
 * cannot diverge: both drive the real ConnectorInstaller (download, extract,
 * build, register) and layer the same catalog-derived presentation fields
 * onto the resulting `installed_connectors` row.
 */

import { getPostgresClient, PostgresClient } from '@cmdb/database';
import { getConnectorInstaller, ConnectorInstaller } from '@cmdb/integration-framework';
import { logger } from '@cmdb/common';

/** Normalizes a caught value (typed `unknown` at every catch site) into a display message. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface InstalledConnectorRow {
  id: string;
  connector_type: string;
  category: string;
  name: string;
  description: string | null;
  installed_version: string;
  latest_available_version: string | null;
  installed_at: Date;
  updated_at: Date;
  enabled: boolean;
  verified: boolean;
  install_path: string;
  metadata: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  resources: unknown[];
  configuration_schema: Record<string, unknown>;
  total_runs: number;
  successful_runs: number;
  failed_runs: number;
  last_run_at: Date | null;
  last_run_status: string | null;
  tags: string[];
}

export type LifecycleFailureCode =
  | 'NOT_FOUND_IN_REGISTRY'
  | 'ALREADY_INSTALLED'
  | 'NOT_INSTALLED'
  | 'HAS_DEPENDENT_CONFIGURATIONS'
  | 'NO_VERSION_AVAILABLE'
  | 'INSTALL_FAILED'
  | 'UPDATE_FAILED'
  | 'UNINSTALL_FAILED';

export interface InstallOutcome {
  success: boolean;
  code?: LifecycleFailureCode;
  connector: InstalledConnectorRow | null;
  message: string;
  errors?: string[];
}

export interface UpdateOutcome extends InstallOutcome {
  previousVersion: string;
  newVersion: string;
}

export interface UninstallOutcome {
  success: boolean;
  code?: LifecycleFailureCode;
  message: string;
  errors?: string[];
}

interface CatalogVersionEntry {
  version: string;
  downloadUrl?: string;
  download_url?: string;
  checksum?: string;
}

interface CatalogEntry {
  connector_type: string;
  category: string;
  name: string;
  description: string | null;
  verified: boolean;
  latest_version: string;
  versions: CatalogVersionEntry[];
  tags: string[];
}

export class ConnectorLifecycleService {
  constructor(
    private readonly pgClient: PostgresClient = getPostgresClient(),
    private readonly installer: ConnectorInstaller = getConnectorInstaller()
  ) {}

  /**
   * Install a connector from the registry cache. Fails without creating (or
   * leaving behind) an `installed_connectors` row when the catalog entry is
   * missing, the connector is already installed (unless `force`), or the
   * real installer fails for any reason.
   */
  async installConnector(
    connectorType: string,
    version?: string,
    force = false
  ): Promise<InstallOutcome> {
    const catalogEntry = await this.getCatalogEntry(connectorType);
    if (!catalogEntry) {
      return {
        success: false,
        code: 'NOT_FOUND_IN_REGISTRY',
        connector: null,
        message: `Connector '${connectorType}' not found in registry`,
      };
    }

    const existing = await this.getInstalledRow(connectorType);
    if (existing && !force) {
      return {
        success: false,
        code: 'ALREADY_INSTALLED',
        connector: existing,
        message: `Connector '${connectorType}' is already installed. Use force to reinstall.`,
      };
    }

    const targetVersion = version || catalogEntry.latest_version;
    if (!targetVersion) {
      return {
        success: false,
        code: 'NO_VERSION_AVAILABLE',
        connector: null,
        message: `No version specified and no latest version found for '${connectorType}'`,
      };
    }

    const versionEntry = this.findVersionEntry(catalogEntry.versions, targetVersion);

    try {
      if (existing && force) {
        // Reinstalling: clear the stale record first so the installer's own
        // "already installed" guard doesn't reject the forced reinstall.
        await this.installer.uninstallConnector(connectorType);
      }

      await this.installer.installConnector(connectorType, {
        url: versionEntry?.downloadUrl || versionEntry?.download_url,
        version: targetVersion,
      });
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      logger.error('Connector installation failed', { connectorType, error: message });
      return {
        success: false,
        code: 'INSTALL_FAILED',
        connector: null,
        message: `Failed to install connector '${connectorType}': ${message}`,
        errors: [message],
      };
    }

    await this.enrichInstalledRow(connectorType, catalogEntry);
    const installed = await this.getInstalledRow(connectorType);

    logger.info(`Connector '${connectorType}' installed successfully`, { version: targetVersion });

    return {
      success: true,
      connector: installed,
      message: `Connector '${connectorType}' version ${targetVersion} installed successfully`,
    };
  }

  /**
   * Update an installed connector to a newer (or explicitly requested)
   * version via the real installer, which backs up and restores the prior
   * installation on failure.
   */
  async updateConnector(
    connectorType: string,
    version?: string,
    force = false
  ): Promise<UpdateOutcome> {
    const existing = await this.getInstalledRow(connectorType);
    if (!existing) {
      return {
        success: false,
        code: 'NOT_INSTALLED',
        connector: null,
        message: `Connector '${connectorType}' is not installed`,
        previousVersion: '',
        newVersion: '',
      };
    }

    const previousVersion = existing.installed_version;
    const catalogEntry = await this.getCatalogEntry(connectorType);
    const targetVersion = version || catalogEntry?.latest_version;

    if (!targetVersion) {
      return {
        success: false,
        code: 'NO_VERSION_AVAILABLE',
        connector: existing,
        message: 'No version specified and latest version not found in registry',
        previousVersion,
        newVersion: previousVersion,
      };
    }

    if (previousVersion === targetVersion && !force) {
      return {
        success: true,
        connector: existing,
        message: `Connector '${connectorType}' is already at version ${targetVersion}`,
        previousVersion,
        newVersion: targetVersion,
      };
    }

    const versionEntry = catalogEntry
      ? this.findVersionEntry(catalogEntry.versions, targetVersion)
      : undefined;

    try {
      await this.installer.updateConnector(connectorType, {
        url: versionEntry?.downloadUrl || versionEntry?.download_url,
        version: targetVersion,
      });
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      logger.error('Connector update failed', { connectorType, error: message });
      return {
        success: false,
        code: 'UPDATE_FAILED',
        connector: existing,
        message: `Failed to update connector '${connectorType}': ${message}`,
        errors: [message],
        previousVersion,
        newVersion: previousVersion,
      };
    }

    if (catalogEntry) {
      await this.enrichInstalledRow(connectorType, catalogEntry);
    }
    const updated = await this.getInstalledRow(connectorType);

    logger.info(`Connector '${connectorType}' updated successfully`, {
      from: previousVersion,
      to: targetVersion,
    });

    return {
      success: true,
      connector: updated,
      message: `Connector '${connectorType}' updated from ${previousVersion} to ${targetVersion}`,
      previousVersion,
      newVersion: targetVersion,
    };
  }

  /**
   * Uninstall a connector via the real installer. Refuses when configurations
   * still reference the connector type, matching the pre-existing REST
   * contract.
   */
  async uninstallConnector(connectorType: string): Promise<UninstallOutcome> {
    const existing = await this.getInstalledRow(connectorType);
    if (!existing) {
      return {
        success: false,
        code: 'NOT_INSTALLED',
        message: `Connector '${connectorType}' is not installed`,
      };
    }

    const configCountResult = await this.pgClient.query(
      'SELECT COUNT(*) FROM connector_configurations WHERE connector_type = $1',
      [connectorType]
    );
    const configCount = parseInt(configCountResult.rows[0].count, 10);
    if (configCount > 0) {
      return {
        success: false,
        code: 'HAS_DEPENDENT_CONFIGURATIONS',
        message: `Cannot uninstall connector '${connectorType}': ${configCount} configuration(s) exist. Delete configurations first.`,
      };
    }

    try {
      await this.installer.uninstallConnector(connectorType);
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      logger.error('Connector uninstall failed', { connectorType, error: message });
      return {
        success: false,
        code: 'UNINSTALL_FAILED',
        message: `Failed to uninstall connector '${connectorType}': ${message}`,
        errors: [message],
      };
    }

    logger.info(`Connector '${connectorType}' uninstalled successfully`);

    return {
      success: true,
      message: `Connector '${connectorType}' uninstalled successfully`,
    };
  }

  private async getCatalogEntry(connectorType: string): Promise<CatalogEntry | null> {
    const result = await this.pgClient.query(
      'SELECT * FROM connector_registry_cache WHERE connector_type = $1',
      [connectorType]
    );
    return result.rows[0] || null;
  }

  private async getInstalledRow(connectorType: string): Promise<InstalledConnectorRow | null> {
    const result = await this.pgClient.query(
      'SELECT * FROM installed_connectors WHERE connector_type = $1',
      [connectorType]
    );
    return result.rows[0] || null;
  }

  private findVersionEntry(
    versions: CatalogVersionEntry[] | null | undefined,
    version: string
  ): CatalogVersionEntry | undefined {
    return (versions || []).find((v) => v.version === version);
  }

  /**
   * Layer the catalog's presentation fields (description, latest available
   * version, verified flag, tags) onto the row the installer wrote. The
   * installer only persists the narrow install-time fields (type, category,
   * name, version, metadata, install path); this keeps the browsable
   * `installed_connectors` listing consistent with the catalog it was
   * installed from.
   */
  private async enrichInstalledRow(connectorType: string, catalogEntry: CatalogEntry): Promise<void> {
    await this.pgClient.query(
      `UPDATE installed_connectors SET
        description = $2,
        latest_available_version = $3,
        verified = $4,
        tags = $5,
        updated_at = NOW()
      WHERE connector_type = $1`,
      [
        connectorType,
        catalogEntry.description ?? null,
        catalogEntry.latest_version ?? null,
        catalogEntry.verified ?? false,
        catalogEntry.tags || [],
      ]
    );
  }
}

export function getConnectorLifecycleService(): ConnectorLifecycleService {
  return new ConnectorLifecycleService();
}
