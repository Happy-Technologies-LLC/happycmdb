# Event Streaming (Kafka)

Event streaming infrastructure powering HappyCMDB's real-time, event-driven architecture using Apache Kafka. This component enables asynchronous processing, decoupled microservices, and scalable data pipelines across discovery, cost management, and impact analysis workflows.

## Overview

HappyCMDB v3.0 uses **Apache Kafka** as its event streaming backbone to enable:

- **Real-time event processing** - Process CI changes, cost allocations, and impact scores as they happen
- **Decoupled microservices** - Services communicate via events without tight coupling
- **Reliable delivery** - Guaranteed message delivery with exactly-once semantics
- **Scalable pipelines** - Horizontal scaling through partitioned topics
- **Audit trail** - Complete event history for compliance and debugging
- **Analytics integration** - Stream events to data marts and BI platforms

### Key Features

- ✅ **24 Event Topics** organized by domain (discovery, cost, impact, analytics)
- ✅ **Strongly-typed event schemas** with TypeScript interfaces
- ✅ **Producer/Consumer patterns** with automatic retry and error handling
- ✅ **Dead Letter Queue** for failed message processing
- ✅ **Exactly-once semantics** with idempotent producers
- ✅ **Consumer groups** for parallel processing and load balancing
- ✅ **Monitoring integration** with Kafka UI and Prometheus metrics

## Architecture

### Event-Driven Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         HappyCMDB Event Bus                            │
│                         (Apache Kafka Cluster)                           │
└──────────────────────────────────────────────────────────────────────────┘
         ▲                        ▲                        ▲
         │                        │                        │
    Producers                 Producers               Producers
         │                        │                        │
┌────────┴─────────┐    ┌────────┴─────────┐    ┌────────┴─────────┐
│  Discovery       │    │  TBM Cost        │    │  BSM Impact      │
│  Engine          │    │  Engine          │    │  Engine          │
│                  │    │                  │    │                  │
│  - CI.discovered │    │  - Cost.allocated│    │  - Impact.calc   │
│  - CI.updated    │    │  - Cost.anomaly  │    │  - Impact.analysis│
│  - CI.deleted    │    │  - Cost.budget   │    │  - Business-svc  │
│  - Relationship  │    │                  │    │  - App-svc       │
└──────────────────┘    └──────────────────┘    └──────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         Kafka Topics (24 topics)                         │
│                                                                           │
│  cmdb.ci.discovered              cmdb.cost.allocated                     │
│  cmdb.ci.updated                 cmdb.cost.updated                       │
│  cmdb.ci.deleted                 cmdb.cost.anomaly.detected              │
│  cmdb.relationship.created       cmdb.cost.budget.exceeded               │
│  cmdb.relationship.deleted                                               │
│                                  cmdb.impact.calculated                  │
│  cmdb.analytics.raw              cmdb.business-service.updated           │
│  cmdb.analytics.aggregated       cmdb.application-service.updated        │
│                                  cmdb.impact.analysis.triggered          │
│  cmdb.dlq (Dead Letter Queue)    cmdb.impact.analysis.completed          │
└──────────────────────────────────────────────────────────────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
    Consumers                Consumers               Consumers
         │                        │                        │
┌────────┴─────────┐    ┌────────┴─────────┐    ┌────────┴─────────┐
│  Data Mart       │    │  Notification    │    │  Analytics       │
│  Sync            │    │  Service         │    │  Pipeline        │
│                  │    │                  │    │                  │
│  - PostgreSQL    │    │  - Email alerts  │    │  - Metabase      │
│  - TimescaleDB   │    │  - Slack alerts  │    │  - Data warehouse│
│  - Indexes       │    │  - Webhooks      │    │  - ML training   │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      @cmdb/event-streaming                          │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │  Producers   │  │  Consumers   │  │  Event Types │            │
│  ├──────────────┤  ├──────────────┤  ├──────────────┤            │
│  │ Discovery    │  │ Discovery    │  │ Discovery    │            │
│  │ Cost         │  │ Cost         │  │ Cost         │            │
│  │ Impact       │  │ Impact       │  │ Impact       │            │
│  │              │  │ Analytics    │  │              │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐         │
│  │  Kafka Client (Singleton)                            │         │
│  │  - Connection pooling                                │         │
│  │  - Admin operations                                  │         │
│  │  - Health checks                                     │         │
│  └──────────────────────────────────────────────────────┘         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐         │
│  │  Utilities                                           │         │
│  │  - Serialization/Deserialization                     │         │
│  │  - Logging                                           │         │
│  │  - Error handling                                    │         │
│  └──────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
```

## Event Topics

HappyCMDB uses **24 Kafka topics** organized by domain, each with specific configurations for retention, partitioning, and compression.

### Topic Naming Convention

All topics follow the pattern: `cmdb.{domain}.{action}`

- **Domain**: `ci`, `cost`, `impact`, `relationship`, `analytics`
- **Action**: `discovered`, `updated`, `deleted`, `allocated`, `calculated`, etc.

### Discovery Topics (5 topics)

High-throughput topics for CI discovery and relationship management.

| Topic Name | Partitions | Retention | Description |
|------------|------------|-----------|-------------|
| `cmdb.ci.discovered` | 6 | 7 days | New CI discovered by connector or agent |
| `cmdb.ci.updated` | 6 | 7 days | CI attributes or metadata updated |
| `cmdb.ci.deleted` | 3 | 30 days | CI removed from CMDB |
| `cmdb.relationship.created` | 3 | 7 days | Relationship created between CIs |
| `cmdb.relationship.deleted` | 3 | 30 days | Relationship removed |

**Compression**: Snappy
**Replication Factor**: 1 (increase to 3 for production)

### Cost Topics (4 topics)

Medium-throughput topics for TBM cost allocation and financial analytics.

| Topic Name | Partitions | Retention | Description |
|------------|------------|-----------|-------------|
| `cmdb.cost.allocated` | 3 | 30 days | Cost allocated to CI via TBM engine |
| `cmdb.cost.updated` | 3 | 30 days | Cost allocation revised |
| `cmdb.cost.anomaly.detected` | 2 | 30 days | Cost anomaly detected by AI/ML engine |
| `cmdb.cost.budget.exceeded` | 2 | 30 days | Cost budget threshold exceeded |

**Compression**: Snappy
**Replication Factor**: 1 (increase to 3 for production)

### Impact Topics (5 topics)

Lower-throughput topics for business impact scoring and analysis.

| Topic Name | Partitions | Retention | Description |
|------------|------------|-----------|-------------|
| `cmdb.impact.calculated` | 3 | 14 days | Impact score calculated for entity |
| `cmdb.business-service.updated` | 2 | 30 days | Business service created or updated |
| `cmdb.application-service.updated` | 2 | 30 days | Application service created or updated |
| `cmdb.impact.analysis.triggered` | 2 | 7 days | Impact analysis job started |
| `cmdb.impact.analysis.completed` | 2 | 7 days | Impact analysis results available |

**Compression**: Snappy
**Replication Factor**: 1 (increase to 3 for production)

### Analytics Topics (2 topics)

High-volume topics for streaming analytics and aggregation.

| Topic Name | Partitions | Retention | Description |
|------------|------------|-----------|-------------|
| `cmdb.analytics.raw` | 12 | 24 hours | Raw event stream for real-time analytics |
| `cmdb.analytics.aggregated` | 6 | 7 days | Aggregated metrics and KPIs |

**Compression**: Snappy
**Replication Factor**: 1 (increase to 3 for production)
**Note**: High partition count for parallel processing

### Dead Letter Queue (1 topic)

Long-retention topic for failed message handling.

| Topic Name | Partitions | Retention | Description |
|------------|------------|-----------|-------------|
| `cmdb.dlq` | 1 | 90 days | Failed messages for manual inspection |

**Compression**: Snappy
**Replication Factor**: 1 (increase to 3 for production)

## Event Schemas

All events share a common base schema with domain-specific payloads.

### Base Event Structure

```typescript
interface BaseEvent {
  eventId: string;           // Unique event identifier (UUID)
  timestamp: Date;           // Event creation timestamp
  version: string;           // Event schema version (e.g., "3.0.0")
}
```

### Discovery Events

#### CI Discovered Event

Emitted when a new Configuration Item is discovered by a connector or agent.

```typescript
interface CIDiscoveredEvent extends BaseEvent {
  eventType: 'ci.discovered';
  payload: {
    ciId: string;              // CI unique identifier
    ciType: string;            // server, application, database, etc.
    name: string;              // CI display name
    discoveredBy: string;      // Connector or agent name
    connectorId?: string;      // Connector ID (if applicable)
    agentId?: string;          // Agent ID (if applicable)
    confidence: number;        // Discovery confidence score (0-1)
    environment?: string;      // production, staging, development
    location?: string;         // AWS region, datacenter, etc.
    metadata: Record<string, any>; // Custom attributes
  };
}
```

**Example**:
```json
{
  "eventId": "evt-123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2025-11-06T10:30:00Z",
  "version": "3.0.0",
  "eventType": "ci.discovered",
  "payload": {
    "ciId": "ci-aws-i-0abcd1234efgh5678",
    "ciType": "server",
    "name": "web-server-prod-01",
    "discoveredBy": "aws-ec2-connector",
    "connectorId": "aws-ec2",
    "confidence": 0.95,
    "environment": "production",
    "location": "us-east-1a",
    "metadata": {
      "instanceType": "t3.medium",
      "platform": "Linux/UNIX",
      "ipAddress": "10.0.1.42",
      "tags": {
        "Owner": "Engineering",
        "CostCenter": "CC-1234"
      }
    }
  }
}
```

#### CI Updated Event

Emitted when a CI's attributes or metadata change.

```typescript
interface CIUpdatedEvent extends BaseEvent {
  eventType: 'ci.updated';
  payload: {
    ciId: string;
    ciType: string;
    name: string;
    updatedBy: string;
    changes: {
      field: string;
      oldValue: any;
      newValue: any;
    }[];
    metadata?: Record<string, any>;
  };
}
```

#### CI Deleted Event

Emitted when a CI is removed from the CMDB.

```typescript
interface CIDeletedEvent extends BaseEvent {
  eventType: 'ci.deleted';
  payload: {
    ciId: string;
    ciType: string;
    name: string;
    deletedBy: string;
    reason?: string;
    metadata?: Record<string, any>;
  };
}
```

#### Relationship Created Event

Emitted when a relationship is created between two CIs.

```typescript
interface RelationshipCreatedEvent extends BaseEvent {
  eventType: 'relationship.created';
  payload: {
    relationshipId: string;
    relationshipType: string;  // DEPENDS_ON, HOSTS, CONNECTS_TO, etc.
    sourceCiId: string;
    targetCiId: string;
    createdBy: string;
    properties?: Record<string, any>;
  };
}
```

#### Relationship Deleted Event

Emitted when a relationship is removed.

```typescript
interface RelationshipDeletedEvent extends BaseEvent {
  eventType: 'relationship.deleted';
  payload: {
    relationshipId: string;
    relationshipType: string;
    sourceCiId: string;
    targetCiId: string;
    deletedBy: string;
    reason?: string;
  };
}
```

### Cost Events

#### Cost Allocation Event

Emitted when cost is allocated to a CI by the TBM engine.

```typescript
interface CostAllocationEvent extends BaseEvent {
  eventType: 'cost.allocated';
  payload: {
    ciId: string;
    ciType: string;
    ciName: string;
    monthlyCost: number;
    currency: string;               // USD, EUR, GBP
    tower: string;                  // Infrastructure, Application, Data, Security
    allocationMethod: string;       // direct, proportional, tag-based, rule-based
    allocationDetails?: {
      sourceService?: string;
      tagKey?: string;
      tagValue?: string;
      allocationRule?: string;
    };
    effectiveDate: Date;
    metadata?: Record<string, any>;
  };
}
```

**Example**:
```json
{
  "eventId": "evt-789a0123-e45f-67g8-h901-234567890abc",
  "timestamp": "2025-11-06T10:35:00Z",
  "version": "3.0.0",
  "eventType": "cost.allocated",
  "payload": {
    "ciId": "ci-aws-i-0abcd1234efgh5678",
    "ciType": "server",
    "ciName": "web-server-prod-01",
    "monthlyCost": 125.50,
    "currency": "USD",
    "tower": "Infrastructure",
    "allocationMethod": "tag-based",
    "allocationDetails": {
      "tagKey": "CostCenter",
      "tagValue": "CC-1234"
    },
    "effectiveDate": "2025-11-01T00:00:00Z"
  }
}
```

#### Cost Anomaly Detected Event

Emitted when the AI/ML engine detects unusual cost patterns.

```typescript
interface CostAnomalyDetectedEvent extends BaseEvent {
  eventType: 'cost.anomaly.detected';
  payload: {
    ciId: string;
    ciType: string;
    ciName: string;
    expectedCost: number;
    actualCost: number;
    deviationPercent: number;
    currency: string;
    anomalyType: 'spike' | 'drop' | 'trend';
    severity: 'low' | 'medium' | 'high' | 'critical';
    detectedAt: Date;
    metadata?: Record<string, any>;
  };
}
```

#### Cost Budget Exceeded Event

Emitted when a cost pool exceeds its budget threshold.

```typescript
interface CostBudgetExceededEvent extends BaseEvent {
  eventType: 'cost.budget.exceeded';
  payload: {
    budgetId: string;
    budgetName: string;
    tower: string;
    budgetAmount: number;
    currentSpend: number;
    currency: string;
    exceedancePercent: number;
    period: string;              // monthly, quarterly, yearly
    affectedCIs: string[];
    metadata?: Record<string, any>;
  };
}
```

### Impact Events

#### Impact Score Calculated Event

Emitted when the BSM engine calculates impact score for an entity.

```typescript
interface ImpactScoreCalculatedEvent extends BaseEvent {
  eventType: 'impact.calculated';
  payload: {
    entityId: string;
    entityType: 'ci' | 'application-service' | 'business-service';
    entityName: string;
    impactScore: number;         // 0-100 scale
    criticality: 'low' | 'medium' | 'high' | 'critical';
    factors: {
      dependencyCount: number;
      upstreamDependencies: number;
      downstreamDependencies: number;
      userCount?: number;
      revenue?: number;
      regulatoryCompliance?: boolean;
    };
    calculatedBy: string;
    calculatedAt: Date;
    metadata?: Record<string, any>;
  };
}
```

**Example**:
```json
{
  "eventId": "evt-def01234-5678-90ab-cdef-0123456789ab",
  "timestamp": "2025-11-06T10:40:00Z",
  "version": "3.0.0",
  "eventType": "impact.calculated",
  "payload": {
    "entityId": "ci-aws-i-0abcd1234efgh5678",
    "entityType": "ci",
    "entityName": "web-server-prod-01",
    "impactScore": 85,
    "criticality": "high",
    "factors": {
      "dependencyCount": 15,
      "upstreamDependencies": 3,
      "downstreamDependencies": 12,
      "userCount": 5000
    },
    "calculatedBy": "bsm-impact-engine",
    "calculatedAt": "2025-11-06T10:40:00Z"
  }
}
```

#### Business Service Updated Event

Emitted when a business service is created or modified.

```typescript
interface BusinessServiceUpdatedEvent extends BaseEvent {
  eventType: 'business-service.updated';
  payload: {
    businessServiceId: string;
    businessServiceName: string;
    owner: string;
    department: string;
    criticality: 'low' | 'medium' | 'high' | 'critical';
    associatedCIs: string[];
    associatedApplications: string[];
    impactScore: number;
    updatedBy: string;
    metadata?: Record<string, any>;
  };
}
```

#### Impact Analysis Completed Event

Emitted when a blast radius or impact analysis job completes.

```typescript
interface ImpactAnalysisCompletedEvent extends BaseEvent {
  eventType: 'impact.analysis.completed';
  payload: {
    analysisId: string;
    results: {
      entitiesAnalyzed: number;
      highImpactEntities: string[];
      criticalDependencies: string[];
      riskScore: number;
      recommendations: string[];
    };
    duration: number;            // milliseconds
    completedAt: Date;
    metadata?: Record<string, any>;
  };
}
```

## Producer Patterns

Producers publish events to Kafka topics. HappyCMDB provides three producer implementations.

### Discovery Producer

Used by discovery connectors and agents to publish CI and relationship events.

```typescript
import { DiscoveryProducer, CIDiscoveredEvent } from '@cmdb/event-streaming';
import { v4 as uuidv4 } from 'uuid';

// Initialize producer
const producer = new DiscoveryProducer();
await producer.connect();

// Create event
const event: CIDiscoveredEvent = {
  eventId: uuidv4(),
  timestamp: new Date(),
  version: '3.0.0',
  eventType: 'ci.discovered',
  payload: {
    ciId: 'ci-12345',
    ciType: 'server',
    name: 'web-server-01',
    discoveredBy: 'aws-ec2-connector',
    connectorId: 'aws-ec2',
    confidence: 0.95,
    environment: 'production',
    location: 'us-east-1',
    metadata: {
      instanceType: 't3.medium',
      tags: { Owner: 'Engineering' }
    }
  }
};

// Publish event
await producer.publishCIDiscovered(event);

// Graceful shutdown
await producer.disconnect();
```

### Cost Producer

Used by the TBM cost engine to publish cost allocation and anomaly events.

```typescript
import { CostProducer, CostAllocationEvent } from '@cmdb/event-streaming';
import { v4 as uuidv4 } from 'uuid';

const producer = new CostProducer();
await producer.connect();

const event: CostAllocationEvent = {
  eventId: uuidv4(),
  timestamp: new Date(),
  version: '3.0.0',
  eventType: 'cost.allocated',
  payload: {
    ciId: 'ci-12345',
    ciType: 'server',
    ciName: 'web-server-01',
    monthlyCost: 125.50,
    currency: 'USD',
    tower: 'Infrastructure',
    allocationMethod: 'tag-based',
    allocationDetails: {
      tagKey: 'CostCenter',
      tagValue: 'CC-1234'
    },
    effectiveDate: new Date()
  }
};

await producer.publishCostAllocation(event);
await producer.disconnect();
```

### Impact Producer

Used by the BSM impact engine to publish impact scoring events.

```typescript
import { ImpactProducer, ImpactScoreCalculatedEvent } from '@cmdb/event-streaming';
import { v4 as uuidv4 } from 'uuid';

const producer = new ImpactProducer();
await producer.connect();

const event: ImpactScoreCalculatedEvent = {
  eventId: uuidv4(),
  timestamp: new Date(),
  version: '3.0.0',
  eventType: 'impact.calculated',
  payload: {
    entityId: 'ci-12345',
    entityType: 'ci',
    entityName: 'web-server-01',
    impactScore: 85,
    criticality: 'high',
    factors: {
      dependencyCount: 15,
      upstreamDependencies: 3,
      downstreamDependencies: 12,
      userCount: 5000
    },
    calculatedBy: 'bsm-impact-engine',
    calculatedAt: new Date()
  }
};

await producer.publishImpactScore(event);
await producer.disconnect();
```

### Batch Publishing

For high-throughput scenarios, use batch publishing to improve performance.

```typescript
import { DiscoveryProducer } from '@cmdb/event-streaming';

const producer = new DiscoveryProducer();
await producer.connect();

// Create array of events
const events: CIDiscoveredEvent[] = [
  // ... 100+ events
];

// Publish all events in a single batch
await producer.publishBatch(events);

await producer.disconnect();
```

**Performance**: Batch publishing is 5-10x faster than individual publishes for bulk operations.

## Consumer Patterns

Consumers subscribe to topics and process events. HappyCMDB uses **consumer groups** for parallel processing.

### Discovery Consumer

Subscribe to all discovery events (CI and relationship changes).

```typescript
import { DiscoveryConsumer, DiscoveryEvent } from '@cmdb/event-streaming';

// Create consumer with group ID
const consumer = new DiscoveryConsumer('data-mart-sync-group');
await consumer.connect();

// Define event handler
const handler = async (event: DiscoveryEvent) => {
  console.log(`Received ${event.eventType}:`, event);

  switch (event.eventType) {
    case 'ci.discovered':
      // Sync new CI to PostgreSQL data mart
      await syncCIToDataMart(event.payload);
      break;

    case 'ci.updated':
      // Update existing CI in data mart
      await updateCIInDataMart(event.payload);
      break;

    case 'ci.deleted':
      // Soft-delete CI in data mart
      await deleteCIFromDataMart(event.payload);
      break;

    case 'relationship.created':
      // Sync relationship to data mart
      await syncRelationshipToDataMart(event.payload);
      break;

    case 'relationship.deleted':
      // Remove relationship from data mart
      await deleteRelationshipFromDataMart(event.payload);
      break;
  }
};

// Start consuming
await consumer.startConsuming(handler);

// Graceful shutdown
process.on('SIGTERM', async () => {
  await consumer.disconnect();
});
```

### Cost Consumer

Subscribe to cost allocation and anomaly events.

```typescript
import { CostConsumer, CostEvent } from '@cmdb/event-streaming';

const consumer = new CostConsumer('notification-service-group');
await consumer.connect();

const handler = async (event: CostEvent) => {
  switch (event.eventType) {
    case 'cost.allocated':
      // Log cost allocation
      logger.info('Cost allocated', event.payload);
      break;

    case 'cost.anomaly.detected':
      // Send alert to finance team
      await sendSlackAlert({
        channel: '#finance-alerts',
        severity: event.payload.severity,
        message: `Cost anomaly detected: ${event.payload.ciName} - Expected: $${event.payload.expectedCost}, Actual: $${event.payload.actualCost}`
      });
      break;

    case 'cost.budget.exceeded':
      // Send critical alert
      await sendEmailAlert({
        to: 'finops-team@example.com',
        subject: `Budget Exceeded: ${event.payload.budgetName}`,
        body: `Current spend: $${event.payload.currentSpend} exceeds budget: $${event.payload.budgetAmount}`
      });
      break;
  }
};

await consumer.startConsuming(handler);
```

### Analytics Consumer

Subscribe to ALL topics for analytics and reporting.

```typescript
import { AnalyticsConsumer } from '@cmdb/event-streaming';

const consumer = new AnalyticsConsumer('analytics-pipeline-group');
await consumer.connect();

const handler = async (event: any) => {
  // Stream all events to data warehouse
  await streamToWarehouse(event);

  // Update real-time dashboards
  await updateDashboardMetrics(event);

  // Feed ML training pipeline
  if (shouldTrainModel(event)) {
    await queueForMLTraining(event);
  }
};

await consumer.startConsuming(handler);
```

### Consumer Controls

Consumers support pause/resume for backpressure handling.

```typescript
import { DiscoveryConsumer } from '@cmdb/event-streaming';

const consumer = new DiscoveryConsumer();
await consumer.connect();

// Start consuming
await consumer.startConsuming(handler);

// Pause when downstream systems are overloaded
await consumer.pause();
console.log('Consumer paused');

// Resume when systems recover
await consumer.resume();
console.log('Consumer resumed');

// Disconnect
await consumer.disconnect();
```

## Dead Letter Queue Handling

Failed events are automatically sent to the Dead Letter Queue (DLQ) for manual inspection and retry.

### DLQ Message Structure

```typescript
{
  "originalMessage": {
    "key": "ci-12345",
    "value": "{\"eventId\":\"...\", ...}",
    "headers": {},
    "timestamp": "1699267200000",
    "offset": "12345"
  },
  "error": {
    "message": "Database connection timeout",
    "stack": "Error: Database connection timeout\n    at ..."
  },
  "metadata": {
    "topic": "cmdb.ci.discovered",
    "partition": 2,
    "failedAt": "2025-11-06T10:45:00Z"
  }
}
```

### Processing DLQ Messages

Monitor and process failed messages using a dedicated DLQ consumer.

```typescript
import { Consumer } from 'kafkajs';
import { createConsumer } from '@cmdb/event-streaming';

const dlqConsumer = createConsumer('dlq-processor-group');
await dlqConsumer.connect();

await dlqConsumer.subscribe({
  topics: ['cmdb.dlq'],
  fromBeginning: false
});

await dlqConsumer.run({
  eachMessage: async ({ message }) => {
    const dlqMessage = JSON.parse(message.value.toString());

    // Log failed message
    logger.error('Processing DLQ message', {
      originalTopic: dlqMessage.metadata.topic,
      error: dlqMessage.error.message,
      failedAt: dlqMessage.metadata.failedAt
    });

    // Attempt to reprocess
    try {
      const originalEvent = JSON.parse(dlqMessage.originalMessage.value);
      await retryEventProcessing(originalEvent);
      logger.info('Successfully reprocessed DLQ message');
    } catch (error) {
      logger.error('Failed to reprocess DLQ message', { error });
      // Send alert for manual intervention
      await sendOpsAlert('DLQ message processing failed', dlqMessage);
    }
  }
});
```

### DLQ Monitoring

Set up alerts for DLQ message accumulation:

```typescript
import { getTopicMetadata } from '@cmdb/event-streaming';

// Check DLQ message count
const metadata = await getTopicMetadata(['cmdb.dlq']);
const messageCount = metadata.topics[0].partitions.reduce(
  (sum, partition) => sum + partition.offsetLag,
  0
);

if (messageCount > 100) {
  await sendOpsAlert('DLQ accumulation detected', { messageCount });
}
```

## Kafka Cluster Setup

### Local Development (Docker Compose)

Start Kafka cluster for development:

```bash
# Start Kafka with Zookeeper and UI
docker-compose -f infrastructure/docker/docker-compose.yml up -d zookeeper kafka kafka-ui
```

Access Kafka UI at http://localhost:8090

### Environment Variables

```bash
# Kafka brokers (comma-separated)
KAFKA_BROKERS=kafka:29092,localhost:9092

# Client identification
KAFKA_CLIENT_ID=cmdb-event-streaming

# Connection timeouts
KAFKA_CONNECTION_TIMEOUT=30000
KAFKA_REQUEST_TIMEOUT=30000

# SSL/TLS (optional for production)
KAFKA_SSL_ENABLED=false

# SASL Authentication (optional for production)
KAFKA_SASL_ENABLED=false
KAFKA_SASL_MECHANISM=plain
KAFKA_SASL_USERNAME=
KAFKA_SASL_PASSWORD=
```

### Initialize Topics

Create all 24 topics with proper configuration:

```typescript
import { initializeTopics } from '@cmdb/event-streaming';

// Creates topics if they don't exist
await initializeTopics();
```

### Production Configuration

For production deployments, adjust topic configurations:

```typescript
// Update topic configurations in src/config/topics.ts
export const TOPIC_CONFIGS: TopicConfig[] = [
  {
    topic: 'cmdb.ci.discovered',
    numPartitions: 12,              // Increased for higher throughput
    replicationFactor: 3,           // Data durability
    configEntries: [
      { name: 'retention.ms', value: '604800000' },  // 7 days
      { name: 'compression.type', value: 'snappy' },
      { name: 'min.insync.replicas', value: '2' }    // Durability
    ]
  },
  // ... other topics
];
```

## Monitoring & Operations

### Kafka UI Dashboard

Access Kafka UI at http://localhost:8090 for visual monitoring:

- **Brokers**: Cluster health, disk usage, network throughput
- **Topics**: Message rates, partition distribution, retention
- **Consumer Groups**: Lag, offset commits, member assignments
- **Messages**: Browse messages, search, inspect payloads

### Health Checks

Verify Kafka connectivity programmatically:

```typescript
import { checkKafkaHealth } from '@cmdb/event-streaming';

const isHealthy = await checkKafkaHealth();
if (!isHealthy) {
  logger.error('Kafka health check failed');
  // Alert operations team
}
```

### Topic Metrics

Get topic metadata and partition information:

```typescript
import { getTopicMetadata } from '@cmdb/event-streaming';

const metadata = await getTopicMetadata([
  'cmdb.ci.discovered',
  'cmdb.cost.allocated'
]);

for (const topic of metadata.topics) {
  console.log(`Topic: ${topic.name}`);
  console.log(`Partitions: ${topic.partitions.length}`);
  console.log(`Replicas: ${topic.partitions[0].replicas.length}`);
}
```

### Consumer Lag Monitoring

Monitor consumer group lag to detect processing bottlenecks:

```bash
# List consumer groups
kafka-consumer-groups --bootstrap-server localhost:9092 --list

# Describe group (shows lag per partition)
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --describe --group cmdb-discovery-group
```

**Expected output**:
```
GROUP              TOPIC            PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
cmdb-discovery-group  cmdb.ci.discovered  0        1250            1250            0
cmdb-discovery-group  cmdb.ci.discovered  1        1180            1180            0
cmdb-discovery-group  cmdb.ci.discovered  2        1220            1225            5
```

**Alert if lag > 1000 messages** for more than 5 minutes.

### Partition Management

Increase partitions for higher throughput:

```bash
# Increase partitions for high-traffic topic
kafka-topics --bootstrap-server localhost:9092 \
  --alter --topic cmdb.ci.discovered \
  --partitions 12
```

::: warning
Cannot decrease partition count. Plan capacity carefully.
:::

### Prometheus Metrics

Kafka exposes JMX metrics for Prometheus scraping:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'kafka'
    static_configs:
      - targets: ['kafka:9999']
    metrics_path: /metrics
```

**Key metrics to monitor**:
- `kafka_server_brokertopicmetrics_messagesin_total` - Messages published
- `kafka_server_brokertopicmetrics_bytesin_total` - Bytes written
- `kafka_consumergroup_lag` - Consumer lag per partition
- `kafka_server_replicamanager_underreplicatedpartitions` - Replication health

## Best Practices

### 1. Always Connect Before Publishing

```typescript
const producer = new DiscoveryProducer();
await producer.connect();

try {
  await producer.publishCIDiscovered(event);
} finally {
  await producer.disconnect();
}
```

### 2. Use Meaningful Consumer Group IDs

Group IDs enable parallel processing. Use descriptive names:

```typescript
// Good
const consumer = new DiscoveryConsumer('data-mart-sync-group');

// Bad
const consumer = new DiscoveryConsumer('consumer1');
```

### 3. Handle Errors Gracefully

```typescript
try {
  await producer.publishCIDiscovered(event);
} catch (error) {
  logger.error('Failed to publish event', { error, event });
  // Send to DLQ or retry with exponential backoff
  await publishToDLQ(event, error);
}
```

### 4. Use Batch Operations for Bulk Data

```typescript
// Efficient: Single network call
await producer.publishBatch(events);

// Inefficient: 1000 network calls
for (const event of events) {
  await producer.publishCIDiscovered(event);
}
```

**Performance**: Batch operations are 5-10x faster for bulk data.

### 5. Close Connections on Shutdown

```typescript
process.on('SIGTERM', async () => {
  await producer.disconnect();
  await consumer.disconnect();
  process.exit(0);
});
```

### 6. Set Appropriate Retention Policies

- **Short-lived events** (analytics): 24 hours
- **Operational events** (discovery, cost): 7-30 days
- **Audit trail** (DLQ): 90 days

### 7. Monitor Consumer Lag

Consumer lag indicates processing bottlenecks. Set alerts:

- **Warning**: Lag > 1000 messages for > 5 minutes
- **Critical**: Lag > 10,000 messages for > 15 minutes

### 8. Use Idempotent Producers

Idempotent producers prevent duplicate messages:

```typescript
// Already enabled by default in HappyCMDB producers
const DEFAULT_PRODUCER_CONFIG: ProducerConfig = {
  idempotent: true,
  maxInFlightRequests: 5
};
```

### 9. Implement Circuit Breakers

Protect downstream systems from cascading failures:

```typescript
import CircuitBreaker from 'opossum';

const breaker = new CircuitBreaker(async (event) => {
  await processEvent(event);
}, {
  timeout: 30000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000
});

await consumer.startConsuming(async (event) => {
  await breaker.fire(event);
});
```

### 10. Version Your Event Schemas

Include schema version in every event:

```typescript
{
  "eventId": "...",
  "timestamp": "...",
  "version": "3.0.0",  // Schema version
  "eventType": "ci.discovered",
  "payload": { ... }
}
```

## Troubleshooting

### Connection Issues

**Problem**: Cannot connect to Kafka brokers

**Solution**:
```bash
# Check Kafka is running
docker ps | grep kafka

# Check Kafka logs
docker logs cmdb-kafka

# Test connection
docker exec -it cmdb-kafka kafka-broker-api-versions \
  --bootstrap-server localhost:9092
```

### High Consumer Lag

**Problem**: Consumer lag increasing continuously

**Solution**:
1. Add more consumers in the same group (parallel processing)
2. Increase partition count for higher throughput
3. Optimize event handler (reduce processing time)
4. Scale up consumer instances

```typescript
// Scale horizontally: Run multiple instances with same group ID
const consumer1 = new DiscoveryConsumer('data-mart-sync-group');
const consumer2 = new DiscoveryConsumer('data-mart-sync-group'); // Same group
```

### Message Processing Failures

**Problem**: Events failing to process

**Solution**:
1. Check DLQ for failed messages
2. Review error logs
3. Fix underlying issue (database, network, etc.)
4. Reprocess messages from DLQ

```bash
# Check DLQ message count
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --describe --group dlq-processor-group
```

### Disk Space Issues

**Problem**: Kafka broker disk full

**Solution**:
1. Reduce retention periods
2. Increase disk capacity
3. Enable log compaction
4. Purge old messages

```bash
# Reduce retention for a topic
kafka-configs --bootstrap-server localhost:9092 \
  --entity-type topics \
  --entity-name cmdb.analytics.raw \
  --alter --add-config retention.ms=43200000  # 12 hours
```

## Related Resources

- [AI Discovery](/components/ai-discovery) - Event-driven AI discovery workflows
- [TBM Cost Engine](/components/tbm-cost-engine) - Cost event publishing
- [BSM Impact Engine](/components/bsm-impact-engine) - Impact event publishing
- [Monitoring Setup](/operations/MONITORING_SETUP_SUMMARY) - Prometheus and Grafana setup
- [Apache Kafka Documentation](https://kafka.apache.org/documentation/)

## API Reference

### Producer APIs

- `DiscoveryProducer.publishCIDiscovered(event)` - Publish CI discovered event
- `DiscoveryProducer.publishCIUpdated(event)` - Publish CI updated event
- `DiscoveryProducer.publishCIDeleted(event)` - Publish CI deleted event
- `DiscoveryProducer.publishRelationshipCreated(event)` - Publish relationship event
- `DiscoveryProducer.publishBatch(events)` - Batch publish events

### Consumer APIs

- `DiscoveryConsumer.connect()` - Connect to Kafka
- `DiscoveryConsumer.startConsuming(handler)` - Start processing events
- `DiscoveryConsumer.pause()` - Pause consumption
- `DiscoveryConsumer.resume()` - Resume consumption
- `DiscoveryConsumer.disconnect()` - Disconnect from Kafka

### Admin APIs

- `initializeTopics()` - Create all topics
- `checkKafkaHealth()` - Health check
- `getTopicMetadata(topics)` - Get topic info
- `listConsumerGroups()` - List all groups
- `deleteTopic(topic)` - Delete topic (testing only)

---

**Last Updated**: 2025-11-06
**Maintainer**: HappyCMDB Team
**Package**: `@cmdb/event-streaming` v3.0.0
