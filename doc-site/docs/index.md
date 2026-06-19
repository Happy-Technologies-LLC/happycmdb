---
layout: home

hero:
  name: HappyCMDB
  text: Open-Source Enterprise CMDB
  tagline: Graph-powered Configuration Management Database for multi-cloud infrastructure discovery and dependency mapping
  image:
    src: /logos/happycmdb-logo.svg
    alt: HappyCMDB
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/quick-start
    - theme: alt
      text: View on GitHub
      link: https://github.com/happycmdb/happycmdb
    - theme: alt
      text: Architecture Guide
      link: /architecture/system-overview

features:
  - icon: 🔍
    title: Multi-Cloud Discovery
    details: Agentless discovery across AWS, Azure, and GCP. Automatically map your entire infrastructure with support for EC2, RDS, VMs, containers, and more.
    link: /getting-started/discovery-guide
    linkText: Discovery Guide

  - icon: 🕸️
    title: Graph Database Power
    details: Neo4j-powered relationship mapping provides deep visibility into dependencies, impact analysis, and configuration drift detection.
    link: /architecture/database-design
    linkText: Database Architecture

  - icon: 📊
    title: Advanced Analytics
    details: PostgreSQL data mart with TimescaleDB for time-series metrics, custom reporting, and trend analysis of your infrastructure.
    link: /components/data-mart
    linkText: Data Mart Guide

  - icon: ⚡
    title: Real-Time Processing
    details: BullMQ-powered job orchestration with Redis backend for high-performance discovery, ETL, and data synchronization workflows.
    link: /components/bullmq
    linkText: Job Scheduling

  - icon: 🎯
    title: REST & GraphQL APIs
    details: Modern APIs with comprehensive endpoints for querying CIs, relationships, and triggering discovery jobs programmatically.
    link: /api/overview
    linkText: API Documentation

  - icon: 🔒
    title: Enterprise Security
    details: Built-in authentication, role-based access control, audit logging, and secrets management for enterprise-grade deployments.
    link: /components/authentication
    linkText: Security Guide

  - icon: 🐳
    title: Container-Ready
    details: Docker and Kubernetes deployment options with Helm charts, monitoring dashboards, and auto-scaling configurations.
    link: /deployment/kubernetes
    linkText: Deployment Options

  - icon: 🔌
    title: Connector Framework
    details: Extensible connector architecture with 43 connectors for cloud providers, monitoring tools, and enterprise systems.
    link: /architecture/connector-framework
    linkText: Connector Architecture

  - icon: 🛠️
    title: Unified Credentials
    details: Protocol-based credential system with affinity matching, credential sets, and intelligent credential selection for automated discovery.
    link: /components/credentials
    linkText: Credential Management
---

## Why HappyCMDB?

HappyCMDB is a modern, open-source Configuration Management Database designed for cloud-native infrastructure. Unlike traditional CMDBs, HappyCMDB leverages graph database technology to provide intuitive relationship mapping and dependency tracking across your entire technology stack.

### Built for Modern Infrastructure

- **Multi-Cloud Native**: First-class support for AWS, Azure, and GCP with agentless discovery
- **Graph-First Design**: Neo4j Community Edition for powerful relationship queries
- **Microservices Architecture**: Scalable, maintainable, and cloud-ready from day one
- **100% Open Source**: MIT licensed with transparent development and community-driven roadmap

### Key Use Cases

- **Infrastructure Discovery**: Automatically discover and catalog all configuration items across cloud providers
- **Dependency Mapping**: Visualize application dependencies and infrastructure relationships
- **Impact Analysis**: Understand the blast radius of changes before making them
- **Compliance Reporting**: Track configuration changes and maintain audit trails
- **Cost Optimization**: Identify unused resources and optimize cloud spend
- **Disaster Recovery**: Document dependencies for faster recovery planning

## Technology Stack

HappyCMDB is built with modern, proven technologies:

- **Backend**: Node.js 20 LTS + TypeScript 5.x
- **Graph Database**: Neo4j Community Edition (v5.x)
- **Data Warehouse**: PostgreSQL 15+ with TimescaleDB
- **Cache & Queue**: Redis 7.x with BullMQ
- **API**: Express (REST) + Apollo GraphQL
- **Frontend**: React 18+ with TypeScript
- **Deployment**: Docker, Kubernetes, Helm

## Quick Start

Get HappyCMDB running in minutes with Docker Compose:

```bash
# Clone the repository
git clone https://github.com/happycmdb/happycmdb.git
cd happycmdb

# Start all services
docker-compose up -d

# Access the UI
open http://localhost:3000
```

For detailed installation instructions, see the [Quick Start Guide](/getting-started/quick-start).

## Documentation Structure

- **[Getting Started](/getting-started/overview)**: Installation, configuration, and basic concepts
- **[Architecture](/architecture/system-overview)**: Deep dive into system design and components
- **[Components](/components/bullmq)**: Core components, credentials, discovery agents, connectors
- **[Deployment](/deployment/kubernetes)**: Docker, Kubernetes, and cloud deployment guides
- **[Operations](/operations/daily-operations)**: Day-to-day operations, backup, scaling, and maintenance
- **[Configuration](/configuration/environment-variables)**: Environment variables and service configuration
- **[API Reference](/api/overview)**: Complete REST and GraphQL API documentation
- **[Quick Reference](/quick-reference/cli-commands)**: CLI commands, queries, and troubleshooting

## Target Audiences

This documentation is designed for:

- **Developers**: Build integrations, extend discovery capabilities, contribute to the project
- **DevOps Engineers**: Deploy, configure, and operate HappyCMDB in production
- **Security Teams**: Understand security architecture and compliance features
- **Data Analysts**: Leverage the data mart for reporting and analytics
- **Project Managers**: Understand capabilities and integration options

## Community & Support

- **GitHub**: [Report issues and contribute](https://github.com/happycmdb/happycmdb)
- **Discussions**: [Community forum](https://github.com/happycmdb/happycmdb/discussions)
- **Documentation**: You're here!

## License

HappyCMDB is released under the [MIT License](https://github.com/happycmdb/happycmdb/blob/main/LICENSE). All components are 100% open source.

---

<div style="text-align: center; margin-top: 3rem; color: #666;">
  <p>Built with ❤️ by the HappyCMDB community</p>
</div>
