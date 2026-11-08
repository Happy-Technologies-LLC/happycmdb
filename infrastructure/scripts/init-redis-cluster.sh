#!/bin/bash
# Redis Cluster Initialization Script
# This script creates a Redis cluster from individual Redis instances

set -e

# HAP-1666: the password comes from the caller's environment and reaches redis-cli via
# REDISCLI_AUTH, never argv (ps, /proc/<pid>/cmdline). No literal default.
: "${REDIS_PASSWORD:?REDIS_PASSWORD must be set}"
export REDISCLI_AUTH="$REDIS_PASSWORD"
REDIS_NODES="${REDIS_NODES:-redis-1:6379 redis-2:6379 redis-3:6379 redis-4:6379 redis-5:6379 redis-6:6379}"

echo "Waiting for Redis instances to be ready..."
sleep 30

# Convert space-separated list to comma-separated for redis-cli
NODES_COMMA=$(echo $REDIS_NODES | tr ' ' ',')

echo "Creating Redis cluster with nodes: $NODES_COMMA"

redis-cli --cluster create $REDIS_NODES \
  --cluster-replicas 1 \
  --cluster-yes

echo "Redis cluster created successfully!"

# Verify cluster status
echo "Checking cluster status..."
redis-cli -h redis-1 -p 6379 cluster info

echo "Cluster nodes:"
redis-cli -h redis-1 -p 6379 cluster nodes

echo "Redis cluster initialization complete!"
