// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { gql } from '@apollo/client';
import { apolloClient } from './graphql';

// ============================================================================
// TypeScript Types
// ============================================================================

export interface ConnectorRegistry {
  connectorType: string;
  category: 'DISCOVERY' | 'CONNECTOR';
  name: string;
  description: string;
  verified: boolean;
  latestVersion: string;
  versions: ConnectorVersion[];
  author: string;
  homepage: string;
  repository: string;
  license: string;
  downloads: number;
  rating: number;
  tags: string[];
  metadata?: any;
}

export interface ConnectorVersion {
  version: string;
  releasedAt: string;
  downloadUrl: string;
  checksum: string;
  sizeBytes: number;
  breakingChanges: boolean;
  changelog: string;
}

export interface InstalledConnector {
  id: string;
  connectorType: string;
  category: 'DISCOVERY' | 'CONNECTOR';
  name: string;
  description: string;
  installedVersion: string;
  latestAvailableVersion: string;
  installedAt: string;
  updatedAt: string;
  enabled: boolean;
  verified: boolean;
  installPath: string;
  metadata: any;
  capabilities: ConnectorCapabilities;
  resources: ConnectorResource[];
  configurationSchema: any;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt?: string;
  lastRunStatus?: string;
  tags: string[];
}

export interface ConnectorCapabilities {
  extraction: boolean;
  relationships: boolean;
  incremental: boolean;
  bidirectional: boolean;
}

export interface ConnectorResource {
  id: string;
  name: string;
  description?: string;
  ciType?: string;
  enabledByDefault: boolean;
  operations: string[];
  configurationSchema?: any;
  extraction?: ResourceExtraction;
}

export interface ResourceExtraction {
  incremental: boolean;
  batchSize?: number;
  rateLimit?: number;
  dependsOn?: string[];
}

export interface ConnectorConfiguration {
  id: string;
  name: string;
  description?: string;
  connectorType: string;
  enabled: boolean;
  schedule?: string;
  scheduleEnabled: boolean;
  connection: any;
  options: any;
  enabledResources?: string[];
  resourceConfigs: any;
  maxRetries: number;
  retryDelaySeconds: number;
  continueOnError: boolean;
  notificationChannels: string[];
  notificationOnSuccess: boolean;
  notificationOnFailure: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  connector: InstalledConnector;
  runs: ConnectorRun[];
  metrics?: ConnectorMetrics;
}

export interface ConnectorRun {
  id: string;
  configId: string;
  connectorType: string;
  configName: string;
  resourceId?: string;
  startedAt: string;
  completedAt?: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  recordsExtracted: number;
  recordsTransformed: number;
  recordsLoaded: number;
  recordsFailed: number;
  durationMs?: number;
  errors: any[];
  errorMessage?: string;
  triggeredBy: string;
  triggeredByUser?: string;
  jobId?: string;
}

export interface ConnectorMetrics {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  successRate: number;
  avgDurationMs: number;
  totalRecordsProcessed: number;
  resourceMetrics: ResourceMetrics[];
}

export interface ResourceMetrics {
  resourceId: string;
  totalRecordsExtracted: number;
  totalRecordsLoaded: number;
  successRate: number;
  avgExtractionTimeMs: number;
  avgTransformationTimeMs: number;
  avgLoadTimeMs: number;
}

export interface ConnectorStats {
  totalInstalled: number;
  totalConfigurations: number;
  totalRuns24h: number;
  successRate24h: number;
  topConnectors: ConnectorUsageStats[];
}

export interface ConnectorUsageStats {
  connectorType: string;
  name: string;
  totalConfigurations: number;
  totalRuns: number;
  successRate: number;
}

// ============================================================================
// GraphQL Queries
// ============================================================================

export const CONNECTOR_REGISTRY_QUERY = gql`
  query ConnectorRegistry(
    $category: ConnectorCategory
    $search: String
    $tags: [String!]
    $verifiedOnly: Boolean
  ) {
    connectorRegistry(
      category: $category
      search: $search
      tags: $tags
      verifiedOnly: $verifiedOnly
    ) {
      connectorType
      category
      name
      description
      verified
      latestVersion
      versions {
        version
        releasedAt
        downloadUrl
        checksum
        sizeBytes
        breakingChanges
        changelog
      }
      author
      homepage
      repository
      license
      downloads
      rating
      tags
      metadata
    }
  }
`;

export const CONNECTOR_REGISTRY_DETAILS_QUERY = gql`
  query ConnectorRegistryDetails($connectorType: String!) {
    connectorRegistryDetails(connectorType: $connectorType) {
      connectorType
      category
      name
      description
      verified
      latestVersion
      versions {
        version
        releasedAt
        downloadUrl
        checksum
        sizeBytes
        breakingChanges
        changelog
      }
      author
      homepage
      repository
      license
      downloads
      rating
      tags
      metadata
    }
  }
`;

export const INSTALLED_CONNECTORS_QUERY = gql`
  query InstalledConnectors($category: ConnectorCategory, $enabled: Boolean) {
    installedConnectors(category: $category, enabled: $enabled) {
      id
      connectorType
      category
      name
      description
      installedVersion
      latestAvailableVersion
      installedAt
      updatedAt
      enabled
      verified
      installPath
      metadata
      capabilities {
        extraction
        relationships
        incremental
        bidirectional
      }
      resources {
        id
        name
        description
        ciType
        enabledByDefault
        operations
        configurationSchema
        extraction {
          incremental
          batchSize
          rateLimit
          dependsOn
        }
      }
      configurationSchema
      totalRuns
      successfulRuns
      failedRuns
      lastRunAt
      lastRunStatus
      tags
    }
  }
`;

export const INSTALLED_CONNECTOR_QUERY = gql`
  query InstalledConnector($connectorType: String!) {
    installedConnector(connectorType: $connectorType) {
      id
      connectorType
      category
      name
      description
      installedVersion
      latestAvailableVersion
      installedAt
      updatedAt
      enabled
      verified
      installPath
      metadata
      capabilities {
        extraction
        relationships
        incremental
        bidirectional
      }
      resources {
        id
        name
        description
        ciType
        enabledByDefault
        operations
        configurationSchema
        extraction {
          incremental
          batchSize
          rateLimit
          dependsOn
        }
      }
      configurationSchema
      totalRuns
      successfulRuns
      failedRuns
      lastRunAt
      lastRunStatus
      tags
    }
  }
`;

export const CONNECTOR_CONFIGURATIONS_QUERY = gql`
  query ConnectorConfigurations($connectorType: String, $enabled: Boolean) {
    connectorConfigurations(connectorType: $connectorType, enabled: $enabled) {
      id
      name
      description
      connectorType
      enabled
      schedule
      scheduleEnabled
      connection
      options
      enabledResources
      resourceConfigs
      maxRetries
      retryDelaySeconds
      continueOnError
      notificationChannels
      notificationOnSuccess
      notificationOnFailure
      createdAt
      updatedAt
      createdBy
    }
  }
`;

export const CONNECTOR_CONFIGURATION_QUERY = gql`
  query ConnectorConfiguration($id: ID!) {
    connectorConfiguration(id: $id) {
      id
      name
      description
      connectorType
      enabled
      schedule
      scheduleEnabled
      connection
      options
      enabledResources
      resourceConfigs
      maxRetries
      retryDelaySeconds
      continueOnError
      notificationChannels
      notificationOnSuccess
      notificationOnFailure
      createdAt
      updatedAt
      createdBy
      connector {
        id
        connectorType
        name
        description
        resources {
          id
          name
          description
          ciType
          enabledByDefault
          operations
          configurationSchema
          extraction {
            incremental
            batchSize
            rateLimit
            dependsOn
          }
        }
      }
      runs(first: 10) {
        id
        configId
        connectorType
        configName
        resourceId
        startedAt
        completedAt
        status
        recordsExtracted
        recordsTransformed
        recordsLoaded
        recordsFailed
        durationMs
        errors
        errorMessage
        triggeredBy
        triggeredByUser
        jobId
      }
      metrics {
        totalRuns
        successfulRuns
        failedRuns
        successRate
        avgDurationMs
        totalRecordsProcessed
        resourceMetrics {
          resourceId
          totalRecordsExtracted
          totalRecordsLoaded
          successRate
          avgExtractionTimeMs
          avgTransformationTimeMs
          avgLoadTimeMs
        }
      }
    }
  }
`;

export const CONNECTOR_RUNS_QUERY = gql`
  query ConnectorRuns(
    $configId: ID
    $connectorType: String
    $status: RunStatus
    $first: Int
    $offset: Int
  ) {
    connectorRuns(
      configId: $configId
      connectorType: $connectorType
      status: $status
      first: $first
      offset: $offset
    ) {
      id
      configId
      connectorType
      configName
      resourceId
      startedAt
      completedAt
      status
      recordsExtracted
      recordsTransformed
      recordsLoaded
      recordsFailed
      durationMs
      errors
      errorMessage
      triggeredBy
      triggeredByUser
      jobId
    }
  }
`;

export const CONNECTOR_STATS_QUERY = gql`
  query ConnectorStats {
    connectorStats {
      totalInstalled
      totalConfigurations
      totalRuns24h
      successRate24h
      topConnectors {
        connectorType
        name
        totalConfigurations
        totalRuns
        successRate
      }
    }
  }
`;

// ============================================================================
// GraphQL Mutations
// ============================================================================

export const INSTALL_CONNECTOR_MUTATION = gql`
  mutation InstallConnector($connectorType: String!, $version: String) {
    installConnector(connectorType: $connectorType, version: $version) {
      success
      connector {
        id
        connectorType
        name
        installedVersion
      }
      message
      errors
    }
  }
`;

export const UPDATE_CONNECTOR_MUTATION = gql`
  mutation UpdateConnector($connectorType: String!, $version: String) {
    updateConnector(connectorType: $connectorType, version: $version) {
      success
      connector {
        id
        connectorType
        name
        installedVersion
      }
      previousVersion
      newVersion
      message
      errors
    }
  }
`;

export const UNINSTALL_CONNECTOR_MUTATION = gql`
  mutation UninstallConnector($connectorType: String!) {
    uninstallConnector(connectorType: $connectorType) {
      success
      message
      errors
    }
  }
`;

export const CREATE_CONNECTOR_CONFIG_MUTATION = gql`
  mutation CreateConnectorConfiguration($input: CreateConnectorConfigInput!) {
    createConnectorConfiguration(input: $input) {
      id
      name
      description
      connectorType
      enabled
      schedule
      scheduleEnabled
      connection
      options
      enabledResources
      resourceConfigs
      createdAt
      updatedAt
    }
  }
`;

export const UPDATE_CONNECTOR_CONFIG_MUTATION = gql`
  mutation UpdateConnectorConfiguration(
    $id: ID!
    $input: UpdateConnectorConfigInput!
  ) {
    updateConnectorConfiguration(id: $id, input: $input) {
      id
      name
      description
      connectorType
      enabled
      schedule
      scheduleEnabled
      connection
      options
      enabledResources
      resourceConfigs
      updatedAt
    }
  }
`;

export const DELETE_CONNECTOR_CONFIG_MUTATION = gql`
  mutation DeleteConnectorConfiguration($id: ID!) {
    deleteConnectorConfiguration(id: $id) {
      success
      message
    }
  }
`;

export const RUN_CONNECTOR_MUTATION = gql`
  mutation RunConnector($id: ID!) {
    runConnector(id: $id) {
      id
      configId
      connectorType
      configName
      startedAt
      status
      triggeredBy
    }
  }
`;

export const ENABLE_CONNECTOR_CONFIG_MUTATION = gql`
  mutation EnableConnectorConfiguration($id: ID!) {
    enableConnectorConfiguration(id: $id) {
      id
      enabled
      updatedAt
    }
  }
`;

export const DISABLE_CONNECTOR_CONFIG_MUTATION = gql`
  mutation DisableConnectorConfiguration($id: ID!) {
    disableConnectorConfiguration(id: $id) {
      id
      enabled
      updatedAt
    }
  }
`;

// ============================================================================
// Service Class
// ============================================================================

class ConnectorService {
  async getConnectorRegistry(params?: {
    category?: 'DISCOVERY' | 'CONNECTOR';
    search?: string;
    tags?: string[];
    verifiedOnly?: boolean;
  }): Promise<ConnectorRegistry[]> {
    const { data } = await apolloClient.query({
      query: CONNECTOR_REGISTRY_QUERY,
      variables: params,
    });
    return data.connectorRegistry;
  }

  async getConnectorRegistryDetails(
    connectorType: string
  ): Promise<ConnectorRegistry | null> {
    const { data } = await apolloClient.query({
      query: CONNECTOR_REGISTRY_DETAILS_QUERY,
      variables: { connectorType },
    });
    return data.connectorRegistryDetails;
  }

  async getInstalledConnectors(params?: {
    category?: 'DISCOVERY' | 'CONNECTOR';
    enabled?: boolean;
  }): Promise<InstalledConnector[]> {
    const { data } = await apolloClient.query({
      query: INSTALLED_CONNECTORS_QUERY,
      variables: params,
    });
    return data.installedConnectors;
  }

  async getInstalledConnector(
    connectorType: string
  ): Promise<InstalledConnector | null> {
    const { data } = await apolloClient.query({
      query: INSTALLED_CONNECTOR_QUERY,
      variables: { connectorType },
    });
    return data.installedConnector;
  }

  async getConnectorConfigurations(params?: {
    connectorType?: string;
    enabled?: boolean;
  }): Promise<ConnectorConfiguration[]> {
    const { data } = await apolloClient.query({
      query: CONNECTOR_CONFIGURATIONS_QUERY,
      variables: params,
    });
    return data.connectorConfigurations;
  }

  async getConnectorConfiguration(
    id: string
  ): Promise<ConnectorConfiguration | null> {
    const { data } = await apolloClient.query({
      query: CONNECTOR_CONFIGURATION_QUERY,
      variables: { id },
    });
    return data.connectorConfiguration;
  }

  async getConnectorRuns(params?: {
    configId?: string;
    connectorType?: string;
    status?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    first?: number;
    offset?: number;
  }): Promise<ConnectorRun[]> {
    const { data } = await apolloClient.query({
      query: CONNECTOR_RUNS_QUERY,
      variables: params,
    });
    return data.connectorRuns;
  }

  async getConnectorStats(): Promise<ConnectorStats> {
    const { data } = await apolloClient.query({
      query: CONNECTOR_STATS_QUERY,
    });
    return data.connectorStats;
  }

  async installConnector(
    connectorType: string,
    version?: string
  ): Promise<{ success: boolean; connector?: InstalledConnector; message?: string; errors?: string[] }> {
    const { data } = await apolloClient.mutate({
      mutation: INSTALL_CONNECTOR_MUTATION,
      variables: { connectorType, version },
    });
    return data.installConnector;
  }

  async updateConnector(
    connectorType: string,
    version?: string
  ): Promise<{ success: boolean; connector?: InstalledConnector; previousVersion: string; newVersion: string; message?: string; errors?: string[] }> {
    const { data } = await apolloClient.mutate({
      mutation: UPDATE_CONNECTOR_MUTATION,
      variables: { connectorType, version },
    });
    return data.updateConnector;
  }

  async uninstallConnector(
    connectorType: string
  ): Promise<{ success: boolean; message?: string; errors?: string[] }> {
    const { data } = await apolloClient.mutate({
      mutation: UNINSTALL_CONNECTOR_MUTATION,
      variables: { connectorType },
    });
    return data.uninstallConnector;
  }

  async createConnectorConfiguration(
    input: any
  ): Promise<ConnectorConfiguration> {
    const { data } = await apolloClient.mutate({
      mutation: CREATE_CONNECTOR_CONFIG_MUTATION,
      variables: { input },
    });
    return data.createConnectorConfiguration;
  }

  async updateConnectorConfiguration(
    id: string,
    input: any
  ): Promise<ConnectorConfiguration> {
    const { data } = await apolloClient.mutate({
      mutation: UPDATE_CONNECTOR_CONFIG_MUTATION,
      variables: { id, input },
    });
    return data.updateConnectorConfiguration;
  }

  async deleteConnectorConfiguration(
    id: string
  ): Promise<{ success: boolean; message?: string }> {
    const { data } = await apolloClient.mutate({
      mutation: DELETE_CONNECTOR_CONFIG_MUTATION,
      variables: { id },
    });
    return data.deleteConnectorConfiguration;
  }

  async runConnector(id: string): Promise<ConnectorRun> {
    const { data } = await apolloClient.mutate({
      mutation: RUN_CONNECTOR_MUTATION,
      variables: { id },
    });
    return data.runConnector;
  }

  async enableConnectorConfiguration(
    id: string
  ): Promise<ConnectorConfiguration> {
    const { data } = await apolloClient.mutate({
      mutation: ENABLE_CONNECTOR_CONFIG_MUTATION,
      variables: { id },
    });
    return data.enableConnectorConfiguration;
  }

  async disableConnectorConfiguration(
    id: string
  ): Promise<ConnectorConfiguration> {
    const { data } = await apolloClient.mutate({
      mutation: DISABLE_CONNECTOR_CONFIG_MUTATION,
      variables: { id },
    });
    return data.disableConnectorConfiguration;
  }
}

export const connectorService = new ConnectorService();
export default connectorService;
