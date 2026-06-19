#!/bin/bash
# Kafka Topics Initialization Script
# Creates topics required by HappyCMDB

set -e

KAFKA_BROKERS="${KAFKA_BROKERS:-kafka-1:29092,kafka-2:29092,kafka-3:29092}"
REPLICATION_FACTOR="${REPLICATION_FACTOR:-3}"
PARTITIONS="${PARTITIONS:-6}"

echo "Waiting for Kafka brokers to be ready..."
sleep 60

# Function to create topic if it doesn't exist
create_topic() {
  local topic_name=$1
  local partitions=${2:-$PARTITIONS}
  local replication=${3:-$REPLICATION_FACTOR}

  echo "Creating topic: $topic_name (partitions: $partitions, replication: $replication)"

  kafka-topics --bootstrap-server "$KAFKA_BROKERS" \
    --create \
    --topic "$topic_name" \
    --partitions "$partitions" \
    --replication-factor "$replication" \
    --if-not-exists \
    --config retention.ms=604800000 \
    --config segment.ms=86400000 \
    --config compression.type=lz4
}

# Discovery topics
create_topic "discovery.aws.ec2" 6 3
create_topic "discovery.aws.rds" 6 3
create_topic "discovery.aws.s3" 6 3
create_topic "discovery.azure.vms" 6 3
create_topic "discovery.gcp.compute" 6 3
create_topic "discovery.ssh.servers" 6 3

# ETL topics
create_topic "etl.ci.created" 6 3
create_topic "etl.ci.updated" 6 3
create_topic "etl.ci.deleted" 6 3
create_topic "etl.relationship.created" 6 3
create_topic "etl.datamart.sync" 6 3

# Analytics topics
create_topic "analytics.events" 12 3
create_topic "analytics.metrics" 12 3

# Dead letter queues
create_topic "dlq.discovery" 3 3
create_topic "dlq.etl" 3 3

echo "Listing all topics:"
kafka-topics --bootstrap-server "$KAFKA_BROKERS" --list

echo "Kafka topics initialization complete!"
