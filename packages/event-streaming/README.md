# @cmdb/event-streaming

Event streaming infrastructure for HappyCMDB v3.0 using Apache Kafka.

## Overview

This package provides a comprehensive event streaming solution for HappyCMDB, enabling real-time event processing across:

- **Discovery Events**: CI discovery, updates, and relationship changes
- **Cost Events**: Cost allocation, updates, anomaly detection, and budget alerts
- **Impact Events**: Impact scoring, business service mapping, and analysis
- **Analytics Events**: Aggregated data for reporting and insights

## Installation

This package is part of the HappyCMDB monorepo and is not published separately.

```bash
# Install dependencies
npm install

# Build the package
npm run build
```

## Architecture

### Event Flow

```
Producer → Kafka Topics → Consumer → Event Handler
```

### Components

- **Producers**: Publish events to Kafka topics
- **Consumers**: Subscribe to topics and process events
- **Event Types**: Strongly-typed event schemas
- **Topics**: Organized by domain (discovery, cost, impact)

## Usage

### Prerequisites

Ensure Kafka is running:

```bash
# Start Kafka via Docker Compose
docker-compose -f infrastructure/docker/docker-compose.yml up -d zookeeper kafka kafka-ui
```

Access Kafka UI at http://localhost:8090

### Initialize Topics

```typescript
import { initializeTopics } from '@cmdb/event-streaming';

// Create all topics with proper configuration
await initializeTopics();
```

### Publishing Events

#### Discovery Events

```typescript
import { DiscoveryProducer, createBaseEvent } from '@cmdb/event-streaming';

const producer = new DiscoveryProducer();
await producer.connect();

// Publish CI discovered event
await producer.publishCIDiscovered({
  ...createBaseEvent('ci.discovered'),
  eventType: 'ci.discovered',
  payload: {
    ciId: 'ci-12345',
    ciType: 'server',
    name: 'web-server-01',
    discoveredBy: 'aws-connector',
    connectorId: 'aws-ec2',
    confidence: 0.95,
    environment: 'production',
    location: 'us-east-1',
    metadata: {
      instanceType: 't3.medium',
      tags: { Owner: 'Engineering' },
    },
  },
});

await producer.disconnect();
```

#### Cost Events

```typescript
import { CostProducer, createBaseEvent } from '@cmdb/event-streaming';

const producer = new CostProducer();
await producer.connect();

// Publish cost allocation event
await producer.publishCostAllocation({
  ...createBaseEvent('cost.allocated'),
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
      tagValue: 'Engineering',
    },
    effectiveDate: new Date(),
  },
});

await producer.disconnect();
```

#### Impact Events

```typescript
import { ImpactProducer, createBaseEvent } from '@cmdb/event-streaming';

const producer = new ImpactProducer();
await producer.connect();

// Publish impact score calculated event
await producer.publishImpactScore({
  ...createBaseEvent('impact.calculated'),
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
      userCount: 5000,
    },
    calculatedBy: 'impact-analyzer',
    calculatedAt: new Date(),
  },
});

await producer.disconnect();
```

#### Batch Publishing

```typescript
import { DiscoveryProducer } from '@cmdb/event-streaming';

const producer = new DiscoveryProducer();
await producer.connect();

const events = [
  // ... array of events
];

// Publish multiple events in a batch
await producer.publishBatch(events);

await producer.disconnect();
```

### Consuming Events

#### Discovery Consumer

```typescript
import { DiscoveryConsumer } from '@cmdb/event-streaming';

const consumer = new DiscoveryConsumer('my-consumer-group');
await consumer.connect();

// Start consuming with event handler
await consumer.startConsuming(async (event) => {
  console.log(`Received ${event.eventType}:`, event);

  // Process event based on type
  switch (event.eventType) {
    case 'ci.discovered':
      // Handle CI discovered
      break;
    case 'ci.updated':
      // Handle CI updated
      break;
    case 'ci.deleted':
      // Handle CI deleted
      break;
    case 'relationship.created':
      // Handle relationship created
      break;
    case 'relationship.deleted':
      // Handle relationship deleted
      break;
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await consumer.disconnect();
});
```

#### Cost Consumer

```typescript
import { CostConsumer } from '@cmdb/event-streaming';

const consumer = new CostConsumer('cost-processor-group');
await consumer.connect();

await consumer.startConsuming(async (event) => {
  switch (event.eventType) {
    case 'cost.allocated':
      // Process cost allocation
      break;
    case 'cost.updated':
      // Process cost update
      break;
    case 'cost.anomaly.detected':
      // Alert on cost anomaly
      break;
    case 'cost.budget.exceeded':
      // Alert on budget exceeded
      break;
  }
});
```

#### Analytics Consumer

```typescript
import { AnalyticsConsumer } from '@cmdb/event-streaming';

// Subscribe to ALL topics for analytics
const consumer = new AnalyticsConsumer('analytics-pipeline-group');
await consumer.connect();

await consumer.startConsuming(async (event) => {
  // Process all events for analytics
  await saveToDataWarehouse(event);
  await updateDashboards(event);
  await generateMetrics(event);
});
```

#### Consumer Controls

```typescript
import { DiscoveryConsumer } from '@cmdb/event-streaming';

const consumer = new DiscoveryConsumer();
await consumer.connect();

// Pause consumption
await consumer.pause();

// Resume consumption
await consumer.resume();

// Disconnect
await consumer.disconnect();
```

## Configuration

### Environment Variables

```bash
# Kafka brokers (comma-separated)
KAFKA_BROKERS=kafka:29092,localhost:9092

# Client identification
KAFKA_CLIENT_ID=cmdb-event-streaming

# Connection timeouts
KAFKA_CONNECTION_TIMEOUT=30000
KAFKA_REQUEST_TIMEOUT=30000

# SSL/TLS (optional)
KAFKA_SSL_ENABLED=false

# SASL Authentication (optional)
KAFKA_SASL_ENABLED=false
KAFKA_SASL_MECHANISM=plain
KAFKA_SASL_USERNAME=
KAFKA_SASL_PASSWORD=

# Logging
LOG_LEVEL=info
```

### Topic Configuration

All topics are automatically created with appropriate configurations:

- **Retention**: 7-90 days depending on topic type
- **Compression**: Snappy compression for all topics
- **Partitions**: 1-12 partitions based on expected throughput
- **Replication**: Factor of 1 (adjust for production)

See `src/config/topics.ts` for complete topic definitions.

## Event Types

### Discovery Events

- `ci.discovered` - New CI discovered
- `ci.updated` - CI updated
- `ci.deleted` - CI deleted
- `relationship.created` - Relationship created
- `relationship.deleted` - Relationship deleted

### Cost Events

- `cost.allocated` - Cost allocated to CI
- `cost.updated` - Cost allocation updated
- `cost.anomaly.detected` - Cost anomaly detected
- `cost.budget.exceeded` - Budget threshold exceeded

### Impact Events

- `impact.calculated` - Impact score calculated
- `business-service.updated` - Business service updated
- `application-service.updated` - Application service updated
- `impact.analysis.triggered` - Impact analysis triggered
- `impact.analysis.completed` - Impact analysis completed

## Utilities

### Health Check

```typescript
import { checkKafkaHealth } from '@cmdb/event-streaming';

const isHealthy = await checkKafkaHealth();
console.log('Kafka health:', isHealthy);
```

### Admin Operations

```typescript
import {
  getTopicMetadata,
  listConsumerGroups,
  deleteTopic
} from '@cmdb/event-streaming';

// Get topic metadata
const metadata = await getTopicMetadata(['cmdb.ci.discovered']);

// List consumer groups
const groups = await listConsumerGroups();

// Delete topic (testing only!)
await deleteTopic('test-topic');
```

## Error Handling

All producers and consumers include comprehensive error handling:

- **Automatic retries**: Exponential backoff for transient failures
- **Dead letter queue**: Failed messages sent to DLQ topic
- **Logging**: Structured logs for all operations
- **Idempotency**: Producers use idempotent writes

## Testing

```bash
# Run unit tests
npm test

# Run integration tests (requires Kafka)
npm run test:integration
```

## Performance

### Producer Performance

- **Batching**: Use `publishBatch()` for bulk operations
- **Compression**: Snappy compression reduces network overhead
- **Idempotency**: Ensures exactly-once semantics
- **Async**: All operations are non-blocking

### Consumer Performance

- **Parallel processing**: Multiple consumers in same group
- **Partitioning**: Topics partitioned for parallelism
- **Consumer groups**: Separate groups for different use cases
- **Backpressure handling**: Pause/resume controls

## Monitoring

Use Kafka UI at http://localhost:8090 to monitor:

- Topic throughput
- Consumer lag
- Message rates
- Partition distribution

## Best Practices

1. **Always connect before producing/consuming**:
   ```typescript
   await producer.connect();
   await producer.publishCIDiscovered(event);
   await producer.disconnect();
   ```

2. **Use meaningful consumer group IDs**:
   ```typescript
   const consumer = new DiscoveryConsumer('my-app-discovery-processor');
   ```

3. **Handle errors gracefully**:
   ```typescript
   try {
     await producer.publishCIDiscovered(event);
   } catch (error) {
     logger.error('Failed to publish event', { error });
     // Send to DLQ or retry
   }
   ```

4. **Close connections on shutdown**:
   ```typescript
   process.on('SIGTERM', async () => {
     await producer.disconnect();
     await consumer.disconnect();
   });
   ```

5. **Use batch operations for bulk data**:
   ```typescript
   await producer.publishBatch(events); // More efficient
   ```

## Troubleshooting

### Connection Issues

```bash
# Check Kafka is running
docker ps | grep kafka

# Check Kafka logs
docker logs cmdb-kafka

# Test connection
docker exec -it cmdb-kafka kafka-broker-api-versions --bootstrap-server localhost:9092
```

### Consumer Lag

```bash
# Check consumer groups
kafka-consumer-groups --bootstrap-server localhost:9092 --list

# Describe group
kafka-consumer-groups --bootstrap-server localhost:9092 --describe --group my-group
```

### Topic Issues

```bash
# List topics
kafka-topics --bootstrap-server localhost:9092 --list

# Describe topic
kafka-topics --bootstrap-server localhost:9092 --describe --topic cmdb.ci.discovered
```

## License

MIT

## Support

For issues and questions, see the main HappyCMDB documentation at http://localhost:8080
