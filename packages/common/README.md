# @cmdb/common

Shared TypeScript types, utilities, and constants for the CMDB platform.

## Overview

This package provides common functionality used across all CMDB platform packages:

- **Type Definitions**: Comprehensive TypeScript types for CIs, relationships, and discovery
- **Logger Utilities**: Winston-based logging with structured output
- **Validation Utilities**: Joi-based validation schemas for data validation

## Installation

```bash
npm install @cmdb/common
```

## Usage

### Importing Types

```typescript
import { CI, CIInput, DiscoveryJob, RelationshipType } from '@cmdb/common';

const ci: CI = {
  id: 'server-001',
  name: 'Web Server',
  type: 'server',
  status: 'active',
  environment: 'production',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  discovered_at: new Date().toISOString(),
  metadata: {},
};
```

### Using the Logger

```typescript
import { logger, createChildLogger } from '@cmdb/common';

// Basic logging
logger.info('Server started');
logger.error('Failed to connect', { error: 'Connection timeout' });

// Create child logger with context
const serviceLogger = createChildLogger({ service: 'discovery' });
serviceLogger.info('Discovery started', { provider: 'aws' });
```

### Validating Data

```typescript
import { validators } from '@cmdb/common';

const result = validators.validateCIInput({
  id: 'server-001',
  name: 'Web Server',
  type: 'server',
});

if (result.valid) {
  console.log('Valid CI:', result.value);
} else {
  console.error('Validation error:', result.error);
}
```

### Coded BullMQ Workers

Workers using `codedProcessor` must register `scrubCompletedJobs(worker)` after
creating the worker. The processor validates a data-free result but retains job
input through BullMQ completion so a stalled job can retry with its original
payload. The completed callback scrubs retained job data only while Redis still
records the job as completed; a crash before the callback may leave completed
payloads retained until their configured removal policy expires.

## Type Definitions

### CI Types

- `CI` - Core configuration item interface
- `CIInput` - Input data for creating/updating CIs
- `CIType` - CI type enum
- `CIStatus` - CI status enum
- `Environment` - Environment enum
- `Relationship` - Relationship between CIs
- `RelationshipType` - Relationship type enum

### Discovery Types

- `DiscoveryJob` - Discovery job interface
- `DiscoveredCI` - Discovered CI with metadata
- `DiscoveryProvider` - Discovery provider enum
- `DiscoveryMethod` - Discovery method enum
- `JobStatus` - Job status enum
- `DiscoveryConfig` - Discovery configuration

### Relationship Types

- `RelationshipDetails` - Extended relationship information
- `RelationshipInput` - Input for creating relationships
- `RelationshipQuery` - Query parameters for relationships
- `DependencyPath` - Dependency chain between CIs
- `ImpactAnalysisResult` - Impact analysis results
- `ImpactedCI` - Impacted CI information

## Validation Schemas

Available validation schemas:

- `ciSchema` - Validate CI data
- `ciInputSchema` - Validate CI input
- `relationshipSchema` - Validate relationship data
- `discoveryJobSchema` - Validate discovery job
- `discoveredCISchema` - Validate discovered CI
- `paginationSchema` - Validate pagination parameters
- `queryFiltersSchema` - Validate query filters

## Logger Configuration

The logger can be configured via environment variables:

- `LOG_LEVEL` - Log level (default: 'info')
- `SERVICE_NAME` - Service name for log context (default: 'cmdb')
- `NODE_ENV` - Environment (affects log formatting)

## Building

```bash
npm run build
```

## Testing

```bash
npm test
```

## License

MIT
