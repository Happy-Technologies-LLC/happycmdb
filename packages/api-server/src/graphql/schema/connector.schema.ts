// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/schema/connector.schema.ts

export const connectorTypeDefs = `
  """
  Connector registry entry (remote catalog)
  """
  type ConnectorRegistry {
    """Connector type identifier"""
    connectorType: String!
    """Category: discovery or connector"""
    category: ConnectorCategory!
    """Display name"""
    name: String!
    """Description"""
    description: String
    """Verified by HappyCMDB"""
    verified: Boolean!
    """Latest available version"""
    latestVersion: String!
    """All available versions"""
    versions: [ConnectorVersion!]!
    """Author name"""
    author: String
    """Homepage URL"""
    homepage: String
    """Repository URL"""
    repository: String
    """License type"""
    license: String
    """Download count"""
    downloads: Int!
    """Average rating"""
    rating: Float!
    """Search tags"""
    tags: [String!]!
    """Connector metadata"""
    metadata: JSON
  }

  """
  Connector version information
  """
  type ConnectorVersion {
    """Version string (e.g., 1.0.0)"""
    version: String!
    """Release date"""
    releasedAt: DateTime
    """Download URL"""
    downloadUrl: String
    """Checksum for verification"""
    checksum: String
    """Package size in bytes"""
    sizeBytes: Int
    """Has breaking changes"""
    breakingChanges: Boolean
    """Changelog text"""
    changelog: String
  }

  """
  Installed connector
  """
  type InstalledConnector {
    """Internal ID"""
    id: ID!
    """Connector type identifier"""
    connectorType: String!
    """Category"""
    category: ConnectorCategory!
    """Display name"""
    name: String!
    """Description"""
    description: String
    """Installed version"""
    installedVersion: String!
    """Latest available version"""
    latestAvailableVersion: String
    """Installation timestamp"""
    installedAt: DateTime!
    """Last update timestamp"""
    updatedAt: DateTime!
    """Is enabled"""
    enabled: Boolean!
    """Is verified"""
    verified: Boolean!
    """Installation path"""
    installPath: String!
    """Connector metadata"""
    metadata: JSON!
    """Capabilities"""
    capabilities: ConnectorCapabilities!
    """Available resources"""
    resources: [ConnectorResource!]!
    """Configuration schema"""
    configurationSchema: JSON!
    """Total run count"""
    totalRuns: Int!
    """Successful run count"""
    successfulRuns: Int!
    """Failed run count"""
    failedRuns: Int!
    """Last run timestamp"""
    lastRunAt: DateTime
    """Last run status"""
    lastRunStatus: String
    """Search tags"""
    tags: [String!]!
  }

  """
  Connector capabilities
  """
  type ConnectorCapabilities {
    """Supports data extraction"""
    extraction: Boolean
    """Supports relationship discovery"""
    relationships: Boolean
    """Supports incremental updates"""
    incremental: Boolean
    """Supports bidirectional sync"""
    bidirectional: Boolean
  }

  """
  Connector resource definition
  """
  type ConnectorResource {
    """Resource identifier"""
    id: String
    """Display name"""
    name: String
    """Description"""
    description: String
    """CI type this resource maps to"""
    ciType: String
    """Enabled by default"""
    enabledByDefault: Boolean
    """Supported operations"""
    operations: [String!]
    """Resource-specific configuration schema"""
    configurationSchema: JSON
    """Extraction settings"""
    extraction: ResourceExtraction
  }

  """
  Resource extraction configuration
  """
  type ResourceExtraction {
    """Supports incremental extraction"""
    incremental: Boolean!
    """Batch size for extraction"""
    batchSize: Int
    """Rate limit (requests per second)"""
    rateLimit: Int
    """Dependencies on other resources"""
    dependsOn: [String!]
  }

  """
  Connector configuration (user instance)
  """
  type ConnectorConfiguration {
    """Configuration ID"""
    id: ID!
    """Configuration name"""
    name: String!
    """Description"""
    description: String
    """Connector type"""
    connectorType: String!
    """Is enabled"""
    enabled: Boolean!
    """Cron schedule"""
    schedule: String
    """Schedule enabled"""
    scheduleEnabled: Boolean!
    """Connection credentials"""
    connection: JSON!
    """Global options"""
    options: JSON!
    """Enabled resources"""
    enabledResources: [String!]
    """Resource-specific configurations"""
    resourceConfigs: JSON!
    """Max retry attempts"""
    maxRetries: Int!
    """Retry delay in seconds"""
    retryDelaySeconds: Int!
    """Continue on error"""
    continueOnError: Boolean!
    """Notification channels"""
    notificationChannels: [String!]!
    """Notify on success"""
    notificationOnSuccess: Boolean!
    """Notify on failure"""
    notificationOnFailure: Boolean!
    """Created timestamp"""
    createdAt: DateTime!
    """Updated timestamp"""
    updatedAt: DateTime!
    """Created by user"""
    createdBy: String

    # Relationships
    """Associated connector"""
    connector: InstalledConnector!
    """Run history"""
    runs(first: Int, offset: Int): [ConnectorRun!]!
    """Performance metrics"""
    metrics: ConnectorMetrics
  }

  """
  Connector run history entry
  """
  type ConnectorRun {
    """Run ID"""
    id: ID!
    """Configuration ID"""
    configId: ID!
    """Connector type"""
    connectorType: String!
    """Configuration name"""
    configName: String!
    """Resource ID (if resource-level run)"""
    resourceId: String
    """Start timestamp"""
    startedAt: DateTime!
    """Completion timestamp"""
    completedAt: DateTime
    """Run status"""
    status: RunStatus!
    """Records extracted"""
    recordsExtracted: Int!
    """Records transformed"""
    recordsTransformed: Int!
    """Records loaded"""
    recordsLoaded: Int!
    """Records failed"""
    recordsFailed: Int!
    """Duration in milliseconds"""
    durationMs: Int
    """Error details"""
    errors: [JSON!]!
    """Error message"""
    errorMessage: String
    """Triggered by (manual/schedule/api/cli)"""
    triggeredBy: String!
    """User who triggered"""
    triggeredByUser: String
    """BullMQ job ID"""
    jobId: String
  }

  """
  Connector metrics
  """
  type ConnectorMetrics {
    """Total runs"""
    totalRuns: Int!
    """Successful runs"""
    successfulRuns: Int!
    """Failed runs"""
    failedRuns: Int!
    """Success rate percentage"""
    successRate: Float!
    """Average duration in ms"""
    avgDurationMs: Int!
    """Total records processed"""
    totalRecordsProcessed: Int!
    """Per-resource metrics"""
    resourceMetrics: [ResourceMetrics!]!
  }

  """
  Resource-level metrics
  """
  type ResourceMetrics {
    """Resource ID"""
    resourceId: String!
    """Total records extracted"""
    totalRecordsExtracted: Int!
    """Total records loaded"""
    totalRecordsLoaded: Int!
    """Success rate"""
    successRate: Float!
    """Average extraction time in ms"""
    avgExtractionTimeMs: Int!
    """Average transformation time in ms"""
    avgTransformationTimeMs: Int!
    """Average load time in ms"""
    avgLoadTimeMs: Int!
  }

  """
  Connector category enum
  """
  enum ConnectorCategory {
    DISCOVERY
    CONNECTOR
  }

  """
  Run status enum
  """
  enum RunStatus {
    QUEUED
    RUNNING
    COMPLETED
    FAILED
    CANCELLED
  }

  """
  Connector statistics
  """
  type ConnectorStats {
    """Total installed connectors"""
    totalInstalled: Int!
    """Total configurations"""
    totalConfigurations: Int!
    """Runs in last 24 hours"""
    totalRuns24h: Int!
    """Success rate in last 24 hours"""
    successRate24h: Float!
    """Top connectors by usage"""
    topConnectors: [ConnectorUsageStats!]!
  }

  """
  Connector usage statistics
  """
  type ConnectorUsageStats {
    """Connector type"""
    connectorType: String!
    """Connector name"""
    name: String!
    """Total configurations"""
    totalConfigurations: Int!
    """Total runs"""
    totalRuns: Int!
    """Success rate"""
    successRate: Float!
  }

  """
  Input for creating connector configuration
  """
  input CreateConnectorConfigInput {
    """Configuration name"""
    name: String!
    """Description"""
    description: String
    """Connector type"""
    connectorType: String!
    """Enable configuration"""
    enabled: Boolean
    """Cron schedule"""
    schedule: String
    """Enable schedule"""
    scheduleEnabled: Boolean
    """Connection credentials"""
    connection: JSON!
    """Global options"""
    options: JSON
    """Enabled resources"""
    enabledResources: [String!]
    """Resource configurations"""
    resourceConfigs: JSON
    """Max retry attempts"""
    maxRetries: Int
    """Retry delay in seconds"""
    retryDelaySeconds: Int
    """Continue on error"""
    continueOnError: Boolean
    """Notification channels"""
    notificationChannels: [String!]
    """Notify on success"""
    notificationOnSuccess: Boolean
    """Notify on failure"""
    notificationOnFailure: Boolean
  }

  """
  Input for updating connector configuration
  """
  input UpdateConnectorConfigInput {
    """Configuration name"""
    name: String
    """Description"""
    description: String
    """Enable configuration"""
    enabled: Boolean
    """Cron schedule"""
    schedule: String
    """Enable schedule"""
    scheduleEnabled: Boolean
    """Connection credentials"""
    connection: JSON
    """Global options"""
    options: JSON
    """Enabled resources"""
    enabledResources: [String!]
    """Resource configurations"""
    resourceConfigs: JSON
    """Max retry attempts"""
    maxRetries: Int
    """Retry delay in seconds"""
    retryDelaySeconds: Int
    """Continue on error"""
    continueOnError: Boolean
    """Notification channels"""
    notificationChannels: [String!]
    """Notify on success"""
    notificationOnSuccess: Boolean
    """Notify on failure"""
    notificationOnFailure: Boolean
  }

  """
  Install connector result
  """
  type InstallConnectorResult {
    """Success status"""
    success: Boolean!
    """Installed connector"""
    connector: InstalledConnector
    """Result message"""
    message: String
    """Error messages"""
    errors: [String!]
  }

  """
  Update connector result
  """
  type UpdateConnectorResult {
    """Success status"""
    success: Boolean!
    """Updated connector"""
    connector: InstalledConnector
    """Previous version"""
    previousVersion: String!
    """New version"""
    newVersion: String!
    """Result message"""
    message: String
    """Error messages"""
    errors: [String!]
  }

  """
  Uninstall connector result
  """
  type UninstallConnectorResult {
    """Success status"""
    success: Boolean!
    """Result message"""
    message: String
    """Error messages"""
    errors: [String!]
  }

  """
  Test connection result
  """
  type TestConnectionResult {
    """Success status"""
    success: Boolean!
    """Result message"""
    message: String
    """Additional details"""
    details: JSON
    """Error messages"""
    errors: [String!]
  }

  """
  Cancel run result
  """
  type CancelRunResult {
    """Success status"""
    success: Boolean!
    """Result message"""
    message: String
  }

  """
  Delete result
  """
  type DeleteResult {
    """Success status"""
    success: Boolean!
    """Result message"""
    message: String
  }

  # ============================================
  # QUERIES
  # ============================================

  extend type Query {
    """Get connector registry (remote catalog)"""
    connectorRegistry(
      category: ConnectorCategory
      search: String
      tags: [String!]
      verifiedOnly: Boolean
    ): [ConnectorRegistry!]!

    """Get connector details from registry"""
    connectorRegistryDetails(connectorType: String!): ConnectorRegistry

    """Get installed connectors"""
    installedConnectors(
      category: ConnectorCategory
      enabled: Boolean
    ): [InstalledConnector!]!

    """Get installed connector by type"""
    installedConnector(connectorType: String!): InstalledConnector

    """Get connector configurations"""
    connectorConfigurations(
      connectorType: String
      enabled: Boolean
    ): [ConnectorConfiguration!]!

    """Get connector configuration by ID"""
    connectorConfiguration(id: ID!): ConnectorConfiguration

    """Get connector runs"""
    connectorRuns(
      configId: ID
      connectorType: String
      status: RunStatus
      first: Int
      offset: Int
    ): [ConnectorRun!]!

    """Get connector run by ID"""
    connectorRun(id: ID!): ConnectorRun

    """Get connector statistics"""
    connectorStats: ConnectorStats!
  }

  # ============================================
  # MUTATIONS
  # ============================================

  extend type Mutation {
    """Install connector from registry"""
    installConnector(
      connectorType: String!
      version: String
    ): InstallConnectorResult!

    """Update connector to newer version"""
    updateConnector(
      connectorType: String!
      version: String
    ): UpdateConnectorResult!

    """Uninstall connector"""
    uninstallConnector(
      connectorType: String!
    ): UninstallConnectorResult!

    """Create connector configuration"""
    createConnectorConfiguration(
      input: CreateConnectorConfigInput!
    ): ConnectorConfiguration!

    """Update connector configuration"""
    updateConnectorConfiguration(
      id: ID!
      input: UpdateConnectorConfigInput!
    ): ConnectorConfiguration!

    """Delete connector configuration"""
    deleteConnectorConfiguration(id: ID!): DeleteResult!

    """Test connector connection"""
    testConnectorConnection(id: ID!): TestConnectionResult!

    """Run connector manually"""
    runConnector(id: ID!): ConnectorRun!

    """Cancel running connector job"""
    cancelConnectorRun(id: ID!): CancelRunResult!

    """Enable connector configuration"""
    enableConnectorConfiguration(id: ID!): ConnectorConfiguration!

    """Disable connector configuration"""
    disableConnectorConfiguration(id: ID!): ConnectorConfiguration!
  }
`;
