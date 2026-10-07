// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jira Connector (v2.0)
 * Integration with Jira for asset management and project tracking
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '@cmdb/common';
import {
  BaseIntegrationConnector,
  ConnectorConfiguration,
  TestResult,
  ExtractedData,
  ExtractedRelationship,
  TransformedCI,
  IdentificationAttributes,
} from '@cmdb/integration-framework';

export default class JiraConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private instanceUrl: string;
  private jqlFilter: string;

  constructor(config: ConnectorConfiguration) {
    super(config);

    this.instanceUrl = config.connection['instance_url'];
    this.jqlFilter = config.connection['jql_filter'] || 'project = IT AND type = Asset';

    const auth = Buffer.from(
      `${config.connection['email']}:${config.connection['api_token']}`
    ).toString('base64');

    this.client = axios.create({
      baseURL: `${this.instanceUrl}/rest/api/3`,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Jira connector');
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Test connection by getting current user
      const response = await this.client.get('/myself');

      return {
        success: true,
        message: 'Successfully connected to Jira',
        details: {
          instance: this.instanceUrl,
          user: response.data.emailAddress,
          display_name: response.data.displayName,
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  async extract(): Promise<ExtractedData[]> {
    const extractedData: ExtractedData[] = [];
    let startAt = 0;
    const maxResults = 100;
    let hasMore = true;

    logger.info('Starting Jira asset extraction', { jql: this.jqlFilter });

    while (hasMore) {
      try {
        const response = await this.client.get('/search', {
          params: {
            jql: this.jqlFilter,
            startAt,
            maxResults,
            fields: 'summary,description,status,created,updated,customfield_*',
          },
        });

        const issues = response.data.issues;

        for (const issue of issues) {
          extractedData.push({
            external_id: issue.key,
            data: issue,
            source_type: 'jira',
            extracted_at: new Date(),
          });
        }

        logger.info('Extracted batch from Jira', {
          batch_size: issues.length,
          total_extracted: extractedData.length,
        });

        hasMore = response.data.total > startAt + maxResults;
        startAt += maxResults;

      } catch (error) {
        logger.error('Jira extraction failed');
        throw new Error('Connector extraction failed');
      }
    }

    logger.info('Jira extraction completed', {
      total_records: extractedData.length,
    });

    return extractedData;
  }

  async extractRelationships(): Promise<ExtractedRelationship[]> {
    // Jira relationships are typically issue links
    // For now, return empty - can be extended to extract issue links
    return [];
  }

  async transform(sourceData: any): Promise<TransformedCI> {
    const issue = sourceData;
    const fields = issue.fields;

    return {
      name: fields.summary,
      ci_type: this.determineCIType(issue),
      environment: this.determineEnvironment(fields),
      status: this.mapStatus(fields.status?.name),
      attributes: {
        issue_key: issue.key,
        issue_type: issue.fields.issuetype?.name,
        project: fields.project?.key,
        description: fields.description,
        created: fields.created,
        updated: fields.updated,
        assignee: fields.assignee?.displayName,
        reporter: fields.reporter?.displayName,
        // Include custom fields
        ...this.extractCustomFields(fields),
      },
      identifiers: this.extractIdentifiers(issue),
      source: 'jira',
      source_id: issue.key,
      confidence_score: 70, // Jira is less authoritative than CMDB systems
    };
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    const fields = data.fields;

    return {
      external_id: data.key,
      hostname: this.extractHostname(fields),
      custom_identifiers: {
        issue_key: data.key,
        project: fields.project?.key,
        asset_tag: fields.customfield_asset_tag,
        serial_number: fields.customfield_serial_number,
      },
    };
  }

  /**
   * Determine CI type from Jira issue
   */
  private determineCIType(issue: any): string {
    const issueType = issue.fields.issuetype?.name?.toLowerCase() || '';
    const summary = issue.fields.summary?.toLowerCase() || '';

    if (issueType.includes('server') || summary.includes('server')) {
      return 'server';
    }
    if (issueType.includes('application') || summary.includes('app')) {
      return 'application';
    }
    if (issueType.includes('database') || summary.includes('database')) {
      return 'database';
    }
    if (issueType.includes('network') || summary.includes('network')) {
      return 'network-device';
    }

    return 'service'; // Default for Jira assets
  }

  /**
   * Determine environment from Jira fields
   */
  private determineEnvironment(fields: any): string {
    const summary = fields.summary?.toLowerCase() || '';
    const description = fields.description?.toLowerCase() || '';

    if (summary.includes('prod') || description.includes('production')) {
      return 'production';
    }
    if (summary.includes('staging') || summary.includes('stg')) {
      return 'staging';
    }
    if (summary.includes('dev') || description.includes('development')) {
      return 'development';
    }

    return 'production'; // Default assumption
  }

  /**
   * Map Jira status to CMDB status
   */
  private mapStatus(jiraStatus?: string): string {
    if (!jiraStatus) return 'active';

    const status = jiraStatus.toLowerCase();

    if (status.includes('done') || status.includes('closed')) {
      return 'inactive';
    }
    if (status.includes('progress') || status.includes('active')) {
      return 'active';
    }
    if (status.includes('blocked') || status.includes('hold')) {
      return 'maintenance';
    }

    return 'active';
  }

  /**
   * Extract hostname from custom fields or summary
   */
  private extractHostname(fields: any): string | undefined {
    // Try common custom field names for hostname
    const hostnameFields = [
      fields.customfield_hostname,
      fields.customfield_server_name,
      fields.customfield_fqdn,
    ];

    for (const field of hostnameFields) {
      if (field && typeof field === 'string') {
        return field;
      }
    }

    // Try to extract from summary (e.g., "Server: web-server-01")
    const summary = fields.summary || '';
    const hostnameMatch = summary.match(/(?:server|host|node):\s*([a-zA-Z0-9\-\.]+)/i);
    if (hostnameMatch) {
      return hostnameMatch[1];
    }

    return undefined;
  }

  /**
   * Extract custom fields for attributes
   */
  private extractCustomFields(fields: any): Record<string, any> {
    const customFields: Record<string, any> = {};

    for (const [key, value] of Object.entries(fields)) {
      if (key.startsWith('customfield_') && value != null) {
        // Clean up the field name
        const fieldName = key.replace('customfield_', '');
        customFields[fieldName] = value;
      }
    }

    return customFields;
  }
}
