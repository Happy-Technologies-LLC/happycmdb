# Quick Start Guide

Get HappyCMDB up and running in under 5 minutes using Docker Compose.

## Prerequisites

- Docker 20.10+ installed
- Docker Compose 2.0+ installed
- At least 4GB RAM available
- Required ports available:
  - 80 (Web UI)
  - 3000 (API Server)
  - 7474 (Neo4j Browser)
  - 7687 (Neo4j Bolt)
  - 5433 (PostgreSQL)
  - 6379 (Redis)

## Installation Steps

### 1. Clone the Repository

```bash
git clone https://github.com/happycmdb/happycmdb.git
cd happycmdb
```

### 2. Start All Services

```bash
docker-compose up -d
```

This will start:
- Neo4j (graph database)
- PostgreSQL with TimescaleDB (data mart)
- Redis (cache and queue)
- API Server
- Discovery Engine
- ETL Processor
- Web UI

### 3. Verify Services

Check that all services are running:

```bash
docker-compose ps
```

All services should show as "Up" or "healthy".

### 4. Access the UI

Open your browser and navigate to:

```
http://localhost:3000
```

Default credentials:
- Username: `admin`
- Password: `admin` (change immediately in production!)

### 5. Access Neo4j Browser (Optional)

For graph database exploration:

```
http://localhost:7474
```

Credentials:
- Username: `neo4j`
- Password: `password`

## Next Steps

### Configure Cloud Discovery

To start discovering your infrastructure:

1. Navigate to Settings > Integrations
2. Add your cloud provider credentials:
   - [AWS Setup](/integration/aws)
   - [Azure Setup](/integration/azure)
   - [GCP Setup](/integration/gcp)

### Run Your First Discovery Job

```bash
# Using the CLI
npx @cmdb/cli discovery run --provider aws --region us-east-1

# Or via API
curl -X POST http://localhost:3000/api/v1/discovery/jobs \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "aws", "region": "us-east-1"}'
```

### Explore the Graph

1. Go to the Graph View in the UI
2. Run a sample query to see discovered CIs
3. Explore relationships between infrastructure components

## Common Issues

### Port Already in Use

If you see port conflict errors:

```bash
# Stop other services using the required ports
# Or modify docker-compose.yml to use different ports
```

### Services Not Starting

Check logs for specific services:

```bash
docker-compose logs -f <service-name>
```

### Out of Memory

Increase Docker's memory limit to at least 4GB in Docker Desktop preferences.

## What's Next?

- [Understand Key Concepts](./key-concepts)
- [Configure Environment Variables](/configuration/environment-variables)
- [Set Up Monitoring](/monitoring/overview)
- [Explore the API](/api/overview)

## Getting Help

- [Troubleshooting Guide](/troubleshooting/overview)
- [GitHub Issues](https://github.com/happycmdb/happycmdb/issues)
- [Community Discussions](https://github.com/happycmdb/happycmdb/discussions)
