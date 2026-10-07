// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiz Cloud Security Connector (v1.0)
 * Cloud security posture management integration with multi-resource support
 * Supports cloud resources, vulnerabilities, security issues, and identities
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
import { WizAuthManager } from './auth';
import { GraphQLResponse } from './types';
import { extractCloudResources } from './extractors/cloud-resources.extractor';
import { extractVulnerabilities } from './extractors/vulnerabilities.extractor';
import { extractIssues } from './extractors/issues.extractor';
import { extractIdentities } from './extractors/identities.extractor';
import {
  transformCloudResource,
  transformVulnerability,
  transformIssue,
  transformIdentity,
} from './transformers';

export default class WizConnector extends BaseIntegrationConnector {
  private client: AxiosInstance;
  private authManager: WizAuthManager;
  private apiUrl: string;

  constructor(config: ConnectorConfiguration) {
    super(config, connectorMetadata as ConnectorMetadata);

    const authUrl = config.connection['auth_url'] || 'https://auth.app.wiz.io/oauth/token';
    this.apiUrl = config.connection['api_url'] || 'https://api.us1.app.wiz.io/graphql';
    const clientId = config.connection['client_id'];
    const clientSecret = config.connection['client_secret'];

    this.authManager = new WizAuthManager(authUrl, clientId, clientSecret);

    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 60000,
    });

    // Add request interceptor to inject access token
    this.client.interceptors.request.use(async (config) => {
      await this.authManager.ensureValidToken();
      const token = this.authManager.getAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Wiz Cloud Security connector');

    await this.authManager.authenticate();
    this.isInitialized = true;
  }

  async testConnection(): Promise<TestResult> {
    try {
      const query = `
        query TestConnection {
          graphSearch(query: {type: [CLOUD_RESOURCE]}, first: 1) {
            totalCount
          }
        }
      `;

      const response = await this.client.post<GraphQLResponse<any>>('', {
        query,
      });

      if (response.data.errors) {
        return { success: false, message: 'Connection test failed' };
      }

      return {
        success: true,
        message: 'Successfully connected to Wiz API',
        details: {
          api_url: this.apiUrl,
          total_resources: response.data.data?.graphSearch?.totalCount || 0,
          enabled_resources: this.getEnabledResources(),
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Connection failed' };
    }
  }

  async extractResource(
    resourceId: string,
    resourceConfig?: Record<string, any>
  ): Promise<ExtractedData[]> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    logger.info('Starting Wiz resource extraction');

    switch (resourceId) {
      case 'cloud_resources':
        return extractCloudResources(this.client, this.config, resourceConfig);
      case 'vulnerabilities':
        return extractVulnerabilities(this.client, this.config, resourceConfig);
      case 'issues':
        return extractIssues(this.client, this.config, resourceConfig);
      case 'identities':
        return extractIdentities(this.client, this.config, resourceConfig);
      default:
        throw new Error(`Unsupported resource: ${resourceId}`);
    }
  }

  async extractRelationships(): Promise<ExtractedRelationship[]> {
    const relationships: ExtractedRelationship[] = [];

    try {
      logger.info('Wiz relationships will be inferred during transformation');
    } catch (error) {
      logger.error('Wiz relationship extraction failed');
    }

    return relationships;
  }

  async transformResource(
    resourceId: string,
    sourceData: any
  ): Promise<TransformedCI> {
    const resource = this.metadata.resources.find(r => r.id === resourceId);
    if (!resource) {
      throw new Error(`Unknown resource: ${resourceId}`);
    }

    switch (resourceId) {
      case 'cloud_resources':
        return transformCloudResource(sourceData);
      case 'vulnerabilities':
        return transformVulnerability(sourceData);
      case 'issues':
        return transformIssue(sourceData);
      case 'identities':
        return transformIdentity(sourceData);
      default:
        throw new Error(`Unsupported resource transformation: ${resourceId}`);
    }
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    return {
      external_id: data.id,
      hostname: data.name,
      custom_identifiers: {
        wiz_id: data.id,
        wiz_type: data.type,
        cloud_platform: data.cloudPlatform,
        provider_unique_id: data.providerUniqueId,
      },
    };
  }
}
