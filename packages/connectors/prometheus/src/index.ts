// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Prometheus Connector (v1.0)
 * Multi-resource integration with Prometheus for monitoring targets, services, alerts, and metrics
 * Supports targets, services, alerts, and metrics extraction via Prometheus HTTP API
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
 * Prometheus API Response Types
 */
interface PrometheusTarget {
  discoveredLabels: Record<string, string>;
  labels: Record<string, string>;
  scrapePool: string;
  scrapeUrl: string;
  globalUrl: string;
  lastError: string;
  lastScrape: string;
  lastScrapeDuration: number;
  health: 'up' | 'down' | 'unknown';
}

interface PrometheusMetadata {
  target: Record<string, string>;
  metric: string;
  type: string;
  help: string;
  unit: string;
}

interface PrometheusAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: 'inactive' | 'pending' | 'firing';
  activeAt: string;
  value: string;
}

export default class PrometheusConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private prometheusUrl: string;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    this.prometheusUrl = config.connection['prometheus_url'];

    const axiosConfig: any = {
      baseURL: this.prometheusUrl,
      timeout: config.connection['timeout_ms'] || 30000,
      headers: {
        'Accept': 'application/json',
      },
    };

    // Add basic authentication if provided
    if (config.connection['basic_auth_username'] && config.connection['basic_auth_password']) {
      axiosConfig.auth = {
        username: config.connection['basic_auth_username'],
        password: config.connection['basic_auth_password'],
      };
    }

    this.client = axios.create(axiosConfig);
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Prometheus connector');

    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by querying Prometheus build info
      const response = await this.client.get('/api/v1/status/buildinfo');

      if (response.data.status === 'success') {
        return {
          success: true,
          message: 'Successfully connected to Prometheus',
          details: {
            prometheus_url: this.prometheusUrl,
            version: response.data.data.version,
            enabled_resources: this.getEnabledResources(),
          },
        };
      }

      return { success: false, message: 'Prometheus API returned non-success status' };
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

    logger.info('Starting Prometheus resource extraction', {
      resource: resourceId,
    });

    switch (resourceId) {
      case 'targets':
        return await this.extractTargets(resourceConfig);
      case 'services':
        return await this.extractServices(resourceConfig);
      case 'alerts':
        return await this.extractAlerts(resourceConfig);
      case 'metrics':
        return await this.extractMetrics(resourceConfig);
      default:
        throw new Error(`Extraction not implemented for resource: ${resourceId}`);
    }
  }

  /**
   * Extract monitored targets
   */
  private async extractTargets(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.client.get('/api/v1/targets');

      if (response.data.status !== 'success') {
        throw new Error('Failed to fetch targets from Prometheus');
      }

      const activeTargets: PrometheusTarget[] = response.data.data.activeTargets || [];
      const droppedTargets: PrometheusTarget[] = response.data.data.droppedTargets || [];

      logger.info('Retrieved targets from Prometheus', {
        active: activeTargets.length,
        dropped: droppedTargets.length,
      });

      // Process active targets
      for (const target of activeTargets) {
        if (this.shouldIncludeTarget(target, resourceConfig, true)) {
          const targetId = this.generateTargetId(target);
          extractedData.push({
            external_id: targetId,
            data: { ...target, status: 'active' },
            source_type: 'prometheus',
            extracted_at: new Date(),
          });
        }
      }

      // Process dropped targets if not filtering by active only
      if (resourceConfig?.['active_only'] !== true) {
        for (const target of droppedTargets) {
          if (this.shouldIncludeTarget(target, resourceConfig, false)) {
            const targetId = this.generateTargetId(target);
            extractedData.push({
              external_id: targetId,
              data: { ...target, status: 'dropped' },
              source_type: 'prometheus',
              extracted_at: new Date(),
            });
          }
        }
      }

      logger.info('Prometheus targets extraction completed', {
        total_extracted: extractedData.length,
      });

    } catch (error) {
      logger.error('Prometheus targets extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract service discovery data
   */
  private async extractServices(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.client.get('/api/v1/targets/metadata');

      if (response.data.status !== 'success') {
        throw new Error('Failed to fetch service metadata from Prometheus');
      }

      const metadataList: PrometheusMetadata[] = response.data.data || [];

      logger.info('Retrieved service metadata from Prometheus', {
        count: metadataList.length,
      });

      // Group by target (service)
      const serviceMap = new Map<string, any>();

      for (const metadata of metadataList) {
        const targetLabels = metadata.target;
        const serviceKey = this.generateServiceKey(targetLabels);

        if (!serviceMap.has(serviceKey)) {
          serviceMap.set(serviceKey, {
            labels: targetLabels,
            metrics: [],
          });
        }

        if (resourceConfig?.['include_metadata'] !== false) {
          serviceMap.get(serviceKey)!.metrics.push({
            metric: metadata.metric,
            type: metadata.type,
            help: metadata.help,
            unit: metadata.unit,
          });
        }
      }

      // Convert map to extracted data
      for (const [serviceKey, serviceData] of serviceMap.entries()) {
        extractedData.push({
          external_id: serviceKey,
          data: serviceData,
          source_type: 'prometheus',
          extracted_at: new Date(),
        });
      }

      logger.info('Prometheus services extraction completed', {
        total_services: extractedData.length,
      });

    } catch (error) {
      logger.error('Prometheus services extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract active alerts
   */
  private async extractAlerts(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.client.get('/api/v1/alerts');

      if (response.data.status !== 'success') {
        throw new Error('Failed to fetch alerts from Prometheus');
      }

      const alerts: PrometheusAlert[] = response.data.data.alerts || [];

      logger.info('Retrieved alerts from Prometheus', {
        count: alerts.length,
      });

      for (const alert of alerts) {
        if (this.shouldIncludeAlert(alert, resourceConfig)) {
          const alertId = this.generateAlertId(alert);
          extractedData.push({
            external_id: alertId,
            data: alert,
            source_type: 'prometheus',
            extracted_at: new Date(),
          });
        }
      }

      logger.info('Prometheus alerts extraction completed', {
        total_extracted: extractedData.length,
      });

    } catch (error) {
      logger.error('Prometheus alerts extraction failed');
      throw new Error('Connector extraction failed');
    }

    return extractedData;
  }

  /**
   * Extract available metrics
   */
  private async extractMetrics(resourceConfig?: Record<string, any>): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];

    try {
      const response = await this.client.get('/api/v1/label/__name__/values');

      if (response.data.status !== 'success') {
        throw new Error('Failed to fetch metric names from Prometheus');
      }

      const metricNames: string[] = response.data.data || [];

      logger.info('Retrieved metric names from Prometheus', {
        count: metricNames.length,
      });

      // Apply filters
      const pattern = resourceConfig?.['metric_name_pattern']
        ? new RegExp(resourceConfig['metric_name_pattern'])
        : null;
      const limit = resourceConfig?.['limit'] || 1000;

      let processedCount = 0;

      for (const metricName of metricNames) {
        if (pattern && !pattern.test(metricName)) {
          continue;
        }

        if (processedCount >= limit) {
          logger.info('Reached metric extraction limit');
          break;
        }

        extractedData.push({
          external_id: metricName,
          data: { name: metricName },
          source_type: 'prometheus',
          extracted_at: new Date(),
        });

        processedCount++;
      }

      logger.info('Prometheus metrics extraction completed', {
        total_extracted: extractedData.length,
      });

    } catch (error) {
      logger.error('Prometheus metrics extraction failed');
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
      // Extract alert -> target relationships
      const alerts = await this.extractAlerts();
      const targets = await this.extractTargets();

      for (const alert of alerts) {
        const alertLabels = alert.data['labels'] || {};
        const instance = alertLabels['instance'];
        const job = alertLabels['job'];

        if (instance || job) {
          // Find matching target
          for (const target of targets) {
            const targetLabels = target.data['labels'] || {};

            if (
              (instance && targetLabels['instance'] === instance) ||
              (job && targetLabels['job'] === job)
            ) {
              relationships.push({
                source_external_id: alert.external_id,
                target_external_id: target.external_id,
                relationship_type: 'ALERTS_ON',
                properties: {
                  severity: alertLabels['severity'],
                  alertname: alertLabels['alertname'],
                },
              });
              break; // Only link to first matching target
            }
          }
        }
      }

      logger.info('Prometheus relationships extracted', {
        count: relationships.length,
      });

    } catch (error) {
      logger.error('Prometheus relationship extraction failed');
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
      case 'targets':
        return this.transformTarget(sourceData);
      case 'services':
        return this.transformService(sourceData);
      case 'alerts':
        return this.transformAlert(sourceData);
      case 'metrics':
        return this.transformMetric(sourceData);
      default:
        throw new Error(`Transformation not implemented for resource: ${resourceId}`);
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    // For targets
    if (data.labels) {
      const labels = data.labels;
      return {
        external_id: this.generateTargetId(data),
        hostname: labels['instance']?.split(':')[0],
        ip_address: this.extractIpFromInstance(labels['instance']),
        custom_identifiers: {
          prometheus_job: labels['job'],
          prometheus_instance: labels['instance'],
        },
      };
    }

    // For services
    if (data.target) {
      return {
        external_id: this.generateServiceKey(data.target),
        custom_identifiers: {
          prometheus_service: data.target['job'] || 'unknown',
        },
      };
    }

    // Default
    return {
      external_id: data.external_id || 'unknown',
      custom_identifiers: {},
    };
  }

  /**
   * Transform target to CMDB CI
   */
  private transformTarget(sourceData: any): TransformedCI {
    const labels = sourceData.labels || {};
    const discoveredLabels = sourceData.discoveredLabels || {};

    // Determine CI type based on labels
    const ciType = this.inferCITypeFromLabels(labels);

    // Extract environment from labels
    const environment = labels['env'] || labels['environment'] || 'production';

    // Map health to status
    const status = this.mapHealthToStatus(sourceData.health);

    return {
      name: labels['instance'] || sourceData.scrapeUrl || 'Unknown Target',
      ci_type: ciType,
      environment,
      status,
      attributes: {
        job: labels['job'],
        instance: labels['instance'],
        scrape_pool: sourceData.scrapePool,
        scrape_url: sourceData.scrapeUrl,
        global_url: sourceData.globalUrl,
        health: sourceData.health,
        last_scrape: sourceData.lastScrape,
        last_scrape_duration_ms: sourceData.lastScrapeDuration * 1000,
        last_error: sourceData.lastError || null,
        labels: labels,
        discovered_labels: discoveredLabels,
        prometheus_status: sourceData.status,
      },
      identifiers: this.extractIdentifiers(sourceData),
      source: 'prometheus',
      source_id: this.generateTargetId(sourceData),
      confidence_score: sourceData.health === 'up' ? 90 : 70,
    };
  }

  /**
   * Transform service to CMDB CI
   */
  private transformService(sourceData: any): TransformedCI {
    const labels = sourceData.labels || {};

    return {
      name: labels['job'] || labels['service'] || 'Unknown Service',
      ci_type: 'service',
      environment: labels['env'] || labels['environment'] || 'production',
      status: 'active',
      attributes: {
        job: labels['job'],
        namespace: labels['namespace'],
        labels: labels,
        metric_count: sourceData.metrics?.length || 0,
        metrics: sourceData.metrics || [],
      },
      identifiers: this.extractIdentifiers(sourceData),
      source: 'prometheus',
      source_id: this.generateServiceKey(labels),
      confidence_score: 85,
    };
  }

  /**
   * Transform alert to CMDB CI
   */
  private transformAlert(sourceData: any): TransformedCI {
    const labels = sourceData.labels || {};
    const annotations = sourceData.annotations || {};

    return {
      name: labels['alertname'] || 'Unknown Alert',
      ci_type: 'alert',
      environment: labels['env'] || labels['environment'] || 'production',
      status: sourceData.state === 'firing' ? 'active' : 'inactive',
      attributes: {
        alertname: labels['alertname'],
        severity: labels['severity'],
        state: sourceData.state,
        active_at: sourceData.activeAt,
        value: sourceData.value,
        instance: labels['instance'],
        job: labels['job'],
        summary: annotations['summary'],
        description: annotations['description'],
        labels: labels,
        annotations: annotations,
      },
      identifiers: {
        external_id: this.generateAlertId(sourceData),
        custom_identifiers: {
          prometheus_alertname: labels['alertname'],
          prometheus_fingerprint: this.generateAlertId(sourceData),
        },
      },
      source: 'prometheus',
      source_id: this.generateAlertId(sourceData),
      confidence_score: 100,
    };
  }

  /**
   * Transform metric to CMDB CI
   */
  private transformMetric(sourceData: any): TransformedCI {
    const metricName = sourceData.name || 'Unknown Metric';

    return {
      name: metricName,
      ci_type: 'metric',
      environment: 'production',
      status: 'active',
      attributes: {
        metric_name: metricName,
      },
      identifiers: {
        external_id: metricName,
        custom_identifiers: {
          prometheus_metric: metricName,
        },
      },
      source: 'prometheus',
      source_id: metricName,
      confidence_score: 100,
    };
  }

  /**
   * Helper: Generate target ID
   */
  private generateTargetId(target: any): string {
    const labels = target.labels || {};
    return `${labels['job'] || 'unknown'}-${labels['instance'] || 'unknown'}`;
  }

  /**
   * Helper: Generate service key
   */
  private generateServiceKey(labels: Record<string, string>): string {
    return `service-${labels['job'] || 'unknown'}-${labels['namespace'] || 'default'}`;
  }

  /**
   * Helper: Generate alert ID
   */
  private generateAlertId(alert: any): string {
    const labels = alert.labels || {};
    // Create a fingerprint based on alertname, instance, and job
    return `alert-${labels['alertname'] || 'unknown'}-${labels['instance'] || 'unknown'}`;
  }

  /**
   * Helper: Extract IP from instance label
   */
  private extractIpFromInstance(instance?: string): string[] | undefined {
    if (!instance) return undefined;

    // Check if instance contains IP address (IPv4)
    const ipMatch = instance.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (ipMatch && ipMatch[1]) {
      return [ipMatch[1]];
    }

    return undefined;
  }

  /**
   * Helper: Infer CI type from labels
   */
  private inferCITypeFromLabels(labels: Record<string, string>): string {
    const job = labels['job']?.toLowerCase() || '';

    if (job.includes('node') || job.includes('server')) {
      return 'server';
    } else if (job.includes('kubernetes') || job.includes('k8s')) {
      return 'container';
    } else if (job.includes('database') || job.includes('postgres') || job.includes('mysql')) {
      return 'database';
    } else if (job.includes('application') || job.includes('app')) {
      return 'application';
    }

    return 'server'; // Default to server
  }

  /**
   * Helper: Map Prometheus health to CMDB status
   */
  private mapHealthToStatus(health: string): string {
    switch (health) {
      case 'up':
        return 'active';
      case 'down':
        return 'inactive';
      default:
        return 'unknown';
    }
  }

  /**
   * Filter: Should include target?
   */
  private shouldIncludeTarget(
    target: PrometheusTarget,
    resourceConfig?: Record<string, any>,
    isActive: boolean = true
  ): boolean {
    // Filter by active status
    if (resourceConfig?.['active_only'] === true && !isActive) {
      return false;
    }

    // Filter by excluded jobs
    const excludeJobs = resourceConfig?.['exclude_jobs'] || [];
    if (excludeJobs.length > 0) {
      const job = target.labels?.['job'];
      if (job && excludeJobs.includes(job)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Filter: Should include alert?
   */
  private shouldIncludeAlert(
    alert: PrometheusAlert,
    resourceConfig?: Record<string, any>
  ): boolean {
    // Filter by severity
    const severityFilter = resourceConfig?.['severity_filter'] || [];
    if (severityFilter.length > 0) {
      const severity = alert.labels?.['severity'];
      if (!severity || !severityFilter.includes(severity)) {
        return false;
      }
    }

    return true;
  }
}
