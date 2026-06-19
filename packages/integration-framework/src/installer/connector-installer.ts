// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorInstaller (v3.0)
 * Manages connector package installation, updates, and removal
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { exec } from 'child_process';
import { logger } from '@cmdb/common';
import { getConnectorRegistry } from '../registry/connector-registry';
import { ConnectorMetadata, InstalledConnector } from '../types/connector.types';

const execAsync = promisify(exec);
const mkdir = promisify(fs.mkdir);
const rm = promisify(fs.rm);
const readFile = promisify(fs.readFile);
const access = promisify(fs.access);

export interface DownloadOptions {
  url?: string;
  localPath?: string;
  version?: string;
}

export class ConnectorInstaller {
  private static instance: ConnectorInstaller;
  private connectorsDir: string;
  private registry = getConnectorRegistry();

  private constructor(connectorsDir: string = '/opt/cmdb/connectors') {
    this.connectorsDir = connectorsDir;
  }

  /**
   * Get singleton instance
   */
  static getInstance(connectorsDir?: string): ConnectorInstaller {
    if (!ConnectorInstaller.instance) {
      ConnectorInstaller.instance = new ConnectorInstaller(connectorsDir);
    }
    return ConnectorInstaller.instance;
  }

  /**
   * Download connector package
   * @param type Connector type identifier
   * @param options Download options (url, local path, or version)
   * @returns Path to downloaded package
   */
  async downloadConnector(
    type: string,
    options?: DownloadOptions
  ): Promise<string> {
    logger.info('Downloading connector', { type, options });

    try {
      // If local path provided, just return it
      if (options?.localPath) {
        await access(options.localPath);
        logger.info('Using local connector package', { path: options.localPath });
        return options.localPath;
      }

      // Create temp directory for download
      const tempDir = path.join(this.connectorsDir, '.temp');
      await mkdir(tempDir, { recursive: true });

      const packagePath = path.join(tempDir, `${type}.tar.gz`);

      // Download from URL or registry
      if (options?.url) {
        // Use curl to download (cross-platform)
        await execAsync(`curl -L -o "${packagePath}" "${options.url}"`);
      } else {
        // Download from connector registry (implement based on your registry)
        const version = options?.version || 'latest';
        const registryUrl = process.env['CONNECTOR_REGISTRY_URL'] || 'https://registry.happycmdb.io';
        const downloadUrl = `${registryUrl}/connectors/${type}/${version}/package.tar.gz`;

        logger.info('Downloading from registry', { url: downloadUrl });
        await execAsync(`curl -L -o "${packagePath}" "${downloadUrl}"`);
      }

      logger.info('Connector package downloaded', { path: packagePath });
      return packagePath;

    } catch (error) {
      logger.error('Failed to download connector', { type, error });
      throw new Error(`Failed to download connector ${type}: ${(error as Error).message}`);
    }
  }

  /**
   * Verify package checksum
   * @param filePath Path to package file
   * @param expectedChecksum Expected SHA256 checksum
   * @returns True if checksum matches
   */
  async verifyChecksum(
    filePath: string,
    expectedChecksum: string
  ): Promise<boolean> {
    try {
      logger.info('Verifying package checksum', { file: filePath });

      const fileBuffer = await readFile(filePath);
      const hash = crypto.createHash('sha256');
      hash.update(fileBuffer);
      const actualChecksum = hash.digest('hex');

      const matches = actualChecksum === expectedChecksum;

      if (!matches) {
        logger.error('Checksum mismatch', {
          expected: expectedChecksum,
          actual: actualChecksum,
        });
      } else {
        logger.info('Checksum verified successfully');
      }

      return matches;

    } catch (error) {
      logger.error('Failed to verify checksum', { error });
      return false;
    }
  }

  /**
   * Extract connector package
   * @param packagePath Path to package file (.tar.gz)
   * @param targetDir Target directory for extraction
   */
  async extractPackage(
    packagePath: string,
    targetDir: string
  ): Promise<void> {
    try {
      logger.info('Extracting package', { package: packagePath, target: targetDir });

      // Create target directory
      await mkdir(targetDir, { recursive: true });

      // Extract tar.gz archive
      await execAsync(`tar -xzf "${packagePath}" -C "${targetDir}"`);

      logger.info('Package extracted successfully', { target: targetDir });

    } catch (error) {
      logger.error('Failed to extract package', { error });
      throw new Error(`Failed to extract package: ${(error as Error).message}`);
    }
  }

  /**
   * Install connector dependencies (npm install)
   * @param connectorDir Connector directory
   */
  async installDependencies(connectorDir: string): Promise<void> {
    try {
      logger.info('Installing connector dependencies', { dir: connectorDir });

      const packageJsonPath = path.join(connectorDir, 'package.json');

      // Check if package.json exists
      try {
        await access(packageJsonPath);
      } catch {
        logger.info('No package.json found, skipping dependency installation');
        return;
      }

      // Run npm install
      await execAsync('npm install --production', { cwd: connectorDir });

      logger.info('Dependencies installed successfully');

    } catch (error) {
      logger.error('Failed to install dependencies', { error });
      throw new Error(`Failed to install dependencies: ${(error as Error).message}`);
    }
  }

  /**
   * Build connector (npm run build)
   * @param connectorDir Connector directory
   */
  async buildConnector(connectorDir: string): Promise<void> {
    try {
      logger.info('Building connector', { dir: connectorDir });

      // Check if build script exists in package.json
      const packageJsonPath = path.join(connectorDir, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));

      if (!packageJson.scripts?.build) {
        logger.info('No build script found, skipping build');
        return;
      }

      // Run build script
      await execAsync('npm run build', { cwd: connectorDir });

      logger.info('Connector built successfully');

    } catch (error) {
      logger.error('Failed to build connector', { error });
      throw new Error(`Failed to build connector: ${(error as Error).message}`);
    }
  }

  /**
   * Register connector in database and registry
   * @param type Connector type
   * @param version Connector version
   * @param installPath Installation path
   * @param checksum Package checksum (optional)
   */
  async registerConnector(
    type: string,
    version: string,
    installPath: string,
    checksum?: string
  ): Promise<void> {
    try {
      logger.info('Registering connector', { type, version, installPath });

      // Load connector metadata
      const metadataPath = path.join(installPath, 'connector.json');
      const metadataContent = await readFile(metadataPath, 'utf-8');
      const metadata: ConnectorMetadata = JSON.parse(metadataContent);

      // Validate metadata
      if (metadata.type !== type) {
        throw new Error(
          `Metadata type mismatch: expected ${type}, got ${metadata.type}`
        );
      }

      if (metadata.version !== version) {
        logger.warn('Metadata version differs from requested version', {
          requested: version,
          actual: metadata.version,
        });
      }

      // Save to database
      const connector: InstalledConnector = {
        connector_type: type,
        version: metadata.version,
        installed_at: new Date(),
        metadata,
        install_path: installPath,
        checksum,
      };

      await this.registry.saveInstalledConnector(connector);

      // Load connector class into registry
      const indexPath = path.join(installPath, 'dist', 'index.js');
      if (fs.existsSync(indexPath)) {
        const connectorModule = await import(indexPath);
        const ConnectorClass = connectorModule.default || connectorModule[type];

        if (ConnectorClass) {
          this.registry.registerConnector(metadata, ConnectorClass);
          logger.info('Connector registered successfully', { type, version });
        } else {
          throw new Error('Connector class not found in package');
        }
      } else {
        throw new Error('Connector implementation not found (missing dist/index.js)');
      }

    } catch (error) {
      logger.error('Failed to register connector', { type, error });
      throw error;
    }
  }

  /**
   * Install connector from package
   * @param type Connector type
   * @param options Download options
   */
  async installConnector(
    type: string,
    options?: DownloadOptions
  ): Promise<void> {
    const startTime = Date.now();

    try {
      logger.info('Installing connector', { type, options });

      // Check if already installed
      const existing = await this.registry.getInstalledConnector(type);
      if (existing) {
        throw new Error(
          `Connector ${type} is already installed (version ${existing.version}). Use updateConnector() to update.`
        );
      }

      // Download package
      const packagePath = await this.downloadConnector(type, options);

      // Verify checksum if provided
      if (options?.localPath && process.env['CONNECTOR_VERIFY_CHECKSUM']) {
        const checksumPath = `${packagePath}.sha256`;
        if (fs.existsSync(checksumPath)) {
          const expectedChecksum = (await readFile(checksumPath, 'utf-8')).trim();
          const valid = await this.verifyChecksum(packagePath, expectedChecksum);
          if (!valid) {
            throw new Error('Checksum verification failed');
          }
        }
      }

      // Extract package
      const installPath = path.join(this.connectorsDir, type);
      await this.extractPackage(packagePath, installPath);

      // Install dependencies
      await this.installDependencies(installPath);

      // Build connector
      await this.buildConnector(installPath);

      // Load metadata to get version
      const metadataPath = path.join(installPath, 'connector.json');
      const metadata: ConnectorMetadata = JSON.parse(
        await readFile(metadataPath, 'utf-8')
      );

      // Register connector
      await this.registerConnector(type, metadata.version, installPath);

      // Cleanup temp files
      if (packagePath.includes('.temp')) {
        await rm(packagePath, { force: true });
      }

      const duration = Date.now() - startTime;
      logger.info('Connector installed successfully', {
        type,
        version: metadata.version,
        duration_ms: duration,
      });

    } catch (error) {
      logger.error('Connector installation failed', { type, error });
      throw error;
    }
  }

  /**
   * Uninstall connector
   * @param type Connector type
   */
  async uninstallConnector(type: string): Promise<void> {
    try {
      logger.info('Uninstalling connector', { type });

      // Check if installed
      const existing = await this.registry.getInstalledConnector(type);
      if (!existing) {
        throw new Error(`Connector ${type} is not installed`);
      }

      // Remove from registry
      await this.registry.removeInstalledConnector(type);

      // Remove installation directory
      const installPath = existing.install_path;
      if (fs.existsSync(installPath)) {
        await rm(installPath, { recursive: true, force: true });
        logger.info('Connector files removed', { path: installPath });
      }

      logger.info('Connector uninstalled successfully', { type });

    } catch (error) {
      logger.error('Failed to uninstall connector', { type, error });
      throw error;
    }
  }

  /**
   * Update connector to new version
   * @param type Connector type
   * @param options Download options (version, url, or local path)
   */
  async updateConnector(
    type: string,
    options?: DownloadOptions
  ): Promise<void> {
    try {
      logger.info('Updating connector', { type, options });

      // Check if installed
      const existing = await this.registry.getInstalledConnector(type);
      if (!existing) {
        throw new Error(
          `Connector ${type} is not installed. Use installConnector() to install.`
        );
      }

      logger.info('Current version', {
        type,
        version: existing.version,
      });

      // Backup existing installation
      const backupPath = `${existing.install_path}.backup`;
      if (fs.existsSync(existing.install_path)) {
        await execAsync(`cp -r "${existing.install_path}" "${backupPath}"`);
        logger.info('Created backup', { path: backupPath });
      }

      try {
        // Remove existing installation
        await rm(existing.install_path, { recursive: true, force: true });

        // Download new version
        const packagePath = await this.downloadConnector(type, options);

        // Extract package
        await this.extractPackage(packagePath, existing.install_path);

        // Install dependencies
        await this.installDependencies(existing.install_path);

        // Build connector
        await this.buildConnector(existing.install_path);

        // Load new metadata
        const metadataPath = path.join(existing.install_path, 'connector.json');
        const metadata: ConnectorMetadata = JSON.parse(
          await readFile(metadataPath, 'utf-8')
        );

        // Register updated connector
        await this.registerConnector(
          type,
          metadata.version,
          existing.install_path
        );

        // Remove backup on success
        await rm(backupPath, { recursive: true, force: true });

        logger.info('Connector updated successfully', {
          type,
          from_version: existing.version,
          to_version: metadata.version,
        });

      } catch (error) {
        // Restore from backup on failure
        logger.error('Update failed, restoring from backup', { error });

        if (fs.existsSync(backupPath)) {
          await rm(existing.install_path, { recursive: true, force: true });
          await execAsync(`mv "${backupPath}" "${existing.install_path}"`);
          logger.info('Restored from backup');
        }

        throw error;
      }

    } catch (error) {
      logger.error('Failed to update connector', { type, error });
      throw error;
    }
  }

  /**
   * List all installed connectors
   */
  async listInstalledConnectors(): Promise<InstalledConnector[]> {
    try {
      const connectorTypes = this.registry.getAllConnectorTypes();
      const installedConnectors: InstalledConnector[] = [];

      for (const metadata of connectorTypes) {
        const connector = await this.registry.getInstalledConnector(metadata.type);
        if (connector) {
          installedConnectors.push(connector);
        }
      }

      return installedConnectors;

    } catch (error) {
      logger.error('Failed to list installed connectors', { error });
      return [];
    }
  }

  /**
   * Get connector installation status
   */
  async getConnectorStatus(type: string): Promise<{
    installed: boolean;
    version?: string;
    install_path?: string;
    installed_at?: Date;
  }> {
    const connector = await this.registry.getInstalledConnector(type);

    if (!connector) {
      return { installed: false };
    }

    return {
      installed: true,
      version: connector.version,
      install_path: connector.install_path,
      installed_at: connector.installed_at,
    };
  }
}

/**
 * Get singleton instance
 */
export function getConnectorInstaller(connectorsDir?: string): ConnectorInstaller {
  return ConnectorInstaller.getInstance(connectorsDir);
}
