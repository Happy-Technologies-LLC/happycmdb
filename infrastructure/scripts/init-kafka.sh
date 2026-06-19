#!/bin/bash

#
# Kafka Topic Initialization Script
# Creates all required topics for HappyCMDB v3.0 event streaming
#
# Usage: ./init-kafka.sh [kafka-host:port]
#

set -e

KAFKA_HOST="${1:-localhost:9092}"
KAFKA_CONTAINER="${KAFKA_CONTAINER:-cmdb-kafka}"

echo "============================================"
echo "HappyCMDB v3.0 - Kafka Topic Initialization"
echo "============================================"
echo "Kafka Host: $KAFKA_HOST"
echo ""

# Wait for Kafka to be ready
echo "Waiting for Kafka to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if docker exec $KAFKA_CONTAINER kafka-broker-api-versions --bootstrap-server $KAFKA_HOST > /dev/null 2>&1; then
    echo "✓ Kafka is ready"
    break
  fi

  RETRY_COUNT=$((RETRY_COUNT + 1))
  echo "Waiting for Kafka... ($RETRY_COUNT/$MAX_RETRIES)"
  sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "✗ ERROR: Kafka failed to become ready after $MAX_RETRIES attempts"
  exit 1
fi

echo ""
echo "Creating Kafka topics..."
echo ""

# Function to create a topic
create_topic() {
  local TOPIC_NAME=$1
  local PARTITIONS=$2
  local REPLICATION_FACTOR=$3
  local RETENTION_MS=$4
  local DESCRIPTION=$5

  echo "Creating topic: $TOPIC_NAME"
  echo "  Partitions: $PARTITIONS"
  echo "  Replication Factor: $REPLICATION_FACTOR"
  echo "  Retention: $RETENTION_MS ms"
  echo "  Description: $DESCRIPTION"

  docker exec $KAFKA_CONTAINER kafka-topics \
    --create \
    --if-not-exists \
    --bootstrap-server $KAFKA_HOST \
    --topic $TOPIC_NAME \
    --partitions $PARTITIONS \
    --replication-factor $REPLICATION_FACTOR \
    --config retention.ms=$RETENTION_MS \
    --config compression.type=snappy

  if [ $? -eq 0 ]; then
    echo "  ✓ Topic created successfully"
  else
    echo "  ✗ Failed to create topic"
  fi
  echo ""
}

# Discovery Events
# Track CI discovery, updates, and changes from all discovery methods
create_topic \
  "discovery-events" \
  3 \
  1 \
  604800000 \
  "CI discovery and update events (7 day retention)"

# Enrichment Events
# Track ITIL, TBM, and BSM enrichment pipeline events
create_topic \
  "enrichment-events" \
  3 \
  1 \
  604800000 \
  "CI enrichment events for ITIL/TBM/BSM (7 day retention)"

# Change Events
# Track all CI changes and configuration drift
create_topic \
  "change-events" \
  3 \
  1 \
  2592000000 \
  "CI change tracking and drift detection (30 day retention)"

# ITIL Events
# Incidents, changes, and service management events
create_topic \
  "itil-events" \
  3 \
  1 \
  2592000000 \
  "ITIL incident and change management events (30 day retention)"

# Cost Events
# TBM cost updates and financial events
create_topic \
  "cost-events" \
  2 \
  1 \
  7776000000 \
  "TBM cost and financial events (90 day retention)"

# BSM Events
# Business service health and impact events
create_topic \
  "bsm-events" \
  3 \
  1 \
  2592000000 \
  "Business service mapping and health events (30 day retention)"

# Audit Events
# System audit trail for compliance and security
create_topic \
  "audit-events" \
  2 \
  1 \
  31536000000 \
  "Audit trail for compliance (365 day retention)"

# Alert Events
# Real-time alerts and notifications
create_topic \
  "alert-events" \
  4 \
  1 \
  604800000 \
  "Real-time alerts and notifications (7 day retention)"

# ETL Events
# ETL job status and data pipeline events
create_topic \
  "etl-events" \
  2 \
  1 \
  2592000000 \
  "ETL job execution and data pipeline events (30 day retention)"

# Integration Events
# External system integration events (API calls, webhooks)
create_topic \
  "integration-events" \
  2 \
  1 \
  604800000 \
  "External integration events (7 day retention)"

# Dead Letter Queue
# Failed events for retry and debugging
create_topic \
  "dlq-events" \
  1 \
  1 \
  7776000000 \
  "Dead letter queue for failed events (90 day retention)"

echo "============================================"
echo "Topic creation complete!"
echo "============================================"
echo ""

# List all topics
echo "Listing all topics:"
docker exec $KAFKA_CONTAINER kafka-topics \
  --list \
  --bootstrap-server $KAFKA_HOST

echo ""
echo "To view topic details, run:"
echo "  docker exec $KAFKA_CONTAINER kafka-topics --describe --bootstrap-server $KAFKA_HOST --topic <topic-name>"
echo ""
echo "Kafka UI available at: http://localhost:8090"
echo ""
