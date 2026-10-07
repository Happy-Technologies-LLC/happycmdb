// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * BaseIntegrationConnector (v3.0)
 * Abstract base class for all integration connectors
 * Now supports multi-resource connectors with N8N-style resource management
 */

import { EventEmitter } from 'events';
import { logger } from '@cmdb/common';
import {
  ConnectorConfiguration,
  ConnectorMetadata,
  ConnectorResource,
  TestResult,
  ExtractedData,
  ExtractedRelationship,
  TransformedCI,
  IdentificationAttributes,
  ConnectorEvent,
} from '../types/connector.types';

export abstract class BaseIntegrationConnector extends EventEmitter {
  protected config: ConnectorConfiguration;
  protected metadata: ConnectorMetadata;
  protected isInitialized: boolean = false;

  constructor(config: ConnectorConfiguration, metadata: ConnectorMetadata) {
    super();
    this.config = config;
    this.metadata = metadata;
  }

  /**
   * Initialize the connector (establish connection, validate config, etc.)
   */
  abstract initialize(): Promise<void>;

  /**
   * Test connection to external system
   */
  abstract testConnection(): Promise<TestResult>;

  /**
   * Extract data for a specific resource
   * @param resourceId Resource identifier (e.g., 'servers', 'virtual_machines')
   * @param resourceConfig Resource-specific configuration overrides
   * @returns Array of extracted data records
   */
  abstract extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]>;

  /**
   * Extract relationships from external system (optional)
   * @returns Array of extracted relationships
   */
  abstract extractRelationships(): Promise<ExtractedRelationship[]>;

  /**
   * Transform source data to CMDB format for a specific resource
   * @param resourceId Resource identifier being transformed
   * @param sourceData Raw data from external system
   * @returns Transformed CI
   */
  abstract transformResource(
    resourceId: string,
    sourceData: any
  ): Promise<TransformedCI>;

  /**
   * Extract identification attributes for reconciliation
   * @param data Source data
   * @returns Identification attributes
   */
  abstract extractIdentifiers(data: any): IdentificationAttributes;

  /**
   * Standard CI fields that should NOT go into metadata
   */
  protected readonly STANDARD_CI_FIELDS = new Set([
    'name',
    'type',
    'status',
    'environment',
    'description',
    'external_id',
    'discovered_at',
    'discovered_by',
    'confidence_score',
    'tags',
    'ip_address',
    'hostname',
    'serial_number',
    'manufacturer',
    'model',
    'location',
    'owner',
    'cost_center',
  ]);

  /**
   * Apply field mappings from resource definition to source data
   * Maps fields to either standard CI fields or dynamic metadata
   * @param resourceId Resource identifier
   * @param sourceData Raw data from external system
   * @returns Mapped data with standard fields and metadata
   */
  protected applyFieldMappings(
    resourceId: string,
    sourceData: any
  ): { standardFields: Record<string, any>; metadata: Record<string, any> } {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    const standardFields: Record<string, any> = {};
    const metadata: Record<string, any> = {};

    if (!resource?.field_mappings) {
      return { standardFields, metadata };
    }

    // Apply field mappings from resource definition
    for (const [targetField, sourcePath] of Object.entries(resource.field_mappings)) {
      const value = this.getNestedValue(sourceData, sourcePath as string);

      if (value !== undefined && value !== null) {
        // Check if this is a standard CI field
        if (this.STANDARD_CI_FIELDS.has(targetField)) {
          standardFields[targetField] = value;
        } else {
          // Non-standard field goes to metadata
          metadata[targetField] = value;
        }
      }
    }

    return { standardFields, metadata };
  }

  /**
   * Get nested value from object using dot notation path
   * @param obj Source object
   * @param path Dot-notation path (e.g., 'AssetBasicInfo.AssetName')
   * @returns Value at path or undefined
   */
  protected getNestedValue(obj: any, path: string): any {
    if (!obj || !path) return undefined;

    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current == null) return undefined;
      current = current[part];
    }

    return current;
  }

  // DEPRECATED: Backward compatibility methods (will be removed in v4.0)
  /**
   * @deprecated Use extractResource() instead
   */
  async extract(): Promise<ExtractedData[]> {
    logger.warn('extract() is deprecated, use extractResource() instead');
    // Default implementation: extract from first enabled resource
    const enabledResources = this.getEnabledResources();
    if (enabledResources.length === 0) {
      return [];
    }
    const resourceId = enabledResources[0]!;
    const resourceConfig = this.config.resource_configs?.[resourceId];
    return this.extractResource(resourceId, resourceConfig);
  }

  /**
   * @deprecated Use transformResource() instead
   */
  async transform(sourceData: any): Promise<TransformedCI> {
    logger.warn('transform() is deprecated, use transformResource() instead');
    // Default implementation: transform using first enabled resource
    const enabledResources = this.getEnabledResources();
    if (enabledResources.length === 0) {
      throw new Error('No enabled resources found');
    }
    const resourceId = enabledResources[0]!;
    return this.transformResource(resourceId, sourceData);
  }

  /**
   * Get list of available resources for this connector
   */
  getAvailableResources(): ConnectorResource[] {
    return this.metadata.resources;
  }

  /**
   * Get enabled resources from configuration
   * If enabled_resources is not set, returns resources with enabled_by_default=true
   */
  getEnabledResources(): string[] {
    if (this.config.enabled_resources && this.config.enabled_resources.length > 0) {
      return this.config.enabled_resources;
    }
    return this.getDefaultEnabledResources();
  }

  /**
   * Get default enabled resources (enabled_by_default=true)
   */
  private getDefaultEnabledResources(): string[] {
    return this.metadata.resources
      .filter(r => r.enabled_by_default)
      .map(r => r.id);
  }

  /**
   * Resolve resource dependencies and return resources in execution order
   */
  private resolveResourceDependencies(resourceIds: string[]): string[] {
    const resourceMap = new Map(
      this.metadata.resources.map(r => [r.id, r])
    );

    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (resourceId: string) => {
      if (visited.has(resourceId)) {
        return;
      }

      const resource = resourceMap.get(resourceId);
      if (!resource) {
        logger.warn('Resource not found in metadata', { resourceId });
        return;
      }

      // Visit dependencies first
      const dependencies = resource.extraction?.depends_on || [];
      for (const depId of dependencies) {
        if (resourceIds.includes(depId)) {
          visit(depId);
        }
      }

      visited.add(resourceId);
      result.push(resourceId);
    };

    for (const resourceId of resourceIds) {
      visit(resourceId);
    }

    return result;
  }

  /**
   * Run full ETL pipeline for all enabled resources
   */
  async run(): Promise<void> {
    const startTime = Date.now();

    try {
      logger.info('Starting connector run', { connector: this.config.name });

      // Ensure initialized
      if (!this.isInitialized) {
        await this.initialize();
        this.isInitialized = true;
        this.emitEvent('initialized', { connector: this.config.name });
      }

      const enabledResources = this.getEnabledResources();
      logger.info('Processing resources', {
        connector: this.config.name,
        resources: enabledResources
      });

      // Resolve dependencies and get execution order
      const orderedResources = this.resolveResourceDependencies(enabledResources);

      // Process each resource
      let totalRecordsExtracted = 0;
      let totalRecordsTransformed = 0;

      for (const resourceId of orderedResources) {
        const resource = this.metadata.resources.find(r => r.id === resourceId);
        if (!resource) {
          logger.warn('Resource not found', { resourceId });
          continue;
        }

        try {
          logger.info('Extracting resource', {
            connector: this.config.name,
            resource: resourceId,
            ci_type: resource.ci_type
          });

          this.emitEvent('extraction_started', {
            connector: this.config.name,
            resource: resourceId
          });

          // Get resource-specific configuration
          const resourceConfig = this.config.resource_configs?.[resourceId];
          const extractedData = await this.extractResource(resourceId, resourceConfig);

          totalRecordsExtracted += extractedData.length;

          logger.info('Resource extracted', {
            connector: this.config.name,
            resource: resourceId,
            records: extractedData.length
          });

          this.emitEvent('extraction_completed', {
            connector: this.config.name,
            resource: resourceId,
            records: extractedData.length
          });

          // Transform each extracted record
          for (const data of extractedData) {
            try {
              const transformedCI = await this.transformResource(resourceId, data.data);
              totalRecordsTransformed++;

              this.emitEvent('ci_discovered', {
                connector: this.config.name,
                resource: resourceId,
                ci: transformedCI,
              });

            } catch {
              logger.error('Transformation failed', {
                connector: this.config.name,
                resource: resourceId,
              });
            }
          }

        } catch {
          logger.error('Resource extraction failed', {
            connector: this.config.name,
            resource: resourceId,
          });
          this.emitEvent('extraction_failed', {
            connector: this.config.name,
            resource: resourceId,
            error: 'CONNECTOR_EXTRACTION_FAILED',
          });
        }
      }

      // Extract relationships if supported
      if (this.metadata.capabilities.relationships) {
        try {
          logger.info('Extracting relationships', { connector: this.config.name });
          const relationships = await this.extractRelationships();
          if (relationships.length > 0) {
            logger.info('Relationships extracted', {
              connector: this.config.name,
              count: relationships.length
            });
            this.emitEvent('relationships_extracted', {
              connector: this.config.name,
              relationships,
            });
          }
        } catch {
          logger.warn('Relationship extraction failed', { connector: this.config.name });
        }
      }

      const duration = Date.now() - startTime;
      logger.info('Connector run completed', {
        connector: this.config.name,
        duration_ms: duration,
        resources_processed: orderedResources.length,
        records_extracted: totalRecordsExtracted,
        records_transformed: totalRecordsTransformed
      });

    } catch {
      logger.error('Connector run failed', { connector: this.config.name });
      throw new Error('CONNECTOR_RUN_FAILED');
    }
  }

  /**
   * Emit typed event
   */
  protected emitEvent(event: ConnectorEvent, data: any): void {
    this.emit(event, data);
  }

  /**
   * Get connector configuration
   */
  getConfig(): ConnectorConfiguration {
    return this.config;
  }

  /**
   * Update connector configuration
   */
  updateConfig(updates: Partial<ConnectorConfiguration>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Override in subclasses if needed
  }
}
