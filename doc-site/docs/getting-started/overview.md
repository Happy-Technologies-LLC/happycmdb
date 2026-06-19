# Getting Started Overview

Welcome to HappyCMDB! This guide will help you get started with installation, configuration, and understanding the core concepts.

## What is HappyCMDB?

HappyCMDB is an open-source enterprise Configuration Management Database (CMDB) built for modern cloud infrastructure. It provides:

- Automated multi-cloud discovery (AWS, Azure, GCP)
- Graph-based relationship mapping using Neo4j
- Advanced analytics with PostgreSQL data mart
- REST and GraphQL APIs
- Real-time job processing with BullMQ

## Prerequisites

Before installing HappyCMDB, ensure you have:

- **Node.js**: 20.x LTS or higher
- **Docker**: 20.10+ and Docker Compose 2.0+ (for quickstart)
- **Operating System**: Linux, macOS, or Windows with WSL2

For production deployments, you'll also need:

- **Kubernetes**: 1.25+ (optional, for K8s deployment)
- **Cloud Provider Access**: AWS, Azure, or GCP credentials for discovery

## Quick Navigation

- **[Quick Start](./quick-start)** - Get HappyCMDB running in 5 minutes
- **[Installation](./installation)** - Detailed installation instructions
- **[Project Structure](./project-structure)** - Understanding the codebase
- **[Key Concepts](./key-concepts)** - Core CMDB terminology and concepts

## Learning Path

1. Start with the [Quick Start](./quick-start) to get a working instance
2. Review [Key Concepts](./key-concepts) to understand CMDB fundamentals
3. Explore the [Architecture](/architecture/system-overview) for deeper understanding
4. Configure [Cloud Integrations](/integration/cloud-providers) for discovery
5. Set up [Monitoring](/monitoring/overview) for production use

## Need Help?

- Check the [Troubleshooting Guide](/troubleshooting/overview)
- Visit our [GitHub Discussions](https://github.com/happycmdb/happycmdb/discussions)
- Review [Common Issues](/troubleshooting/common-issues)
