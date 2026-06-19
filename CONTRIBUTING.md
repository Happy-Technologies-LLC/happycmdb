# Contributing to HappyCMDB

Thank you for your interest in contributing to HappyCMDB. This guide covers
the development setup, coding standards, and pull request process.

## Contributor License Agreement (CLA)

All contributors must sign the HappyCMDB CLA before their first pull request
can be merged. The CLA bot will automatically comment on your PR with instructions.
See [CLA.md](CLA.md) for the full agreement text.

## Prerequisites

- **Node.js** >= 20.0.0
- **npm** >= 9.0.0
- **Docker** >= 20.10 and **Docker Compose** >= 2.0
- **Git**

## Development Setup

```bash
# Fork and clone
git clone https://github.com/YOUR_USERNAME/happycmdb.git
cd happycmdb

# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start infrastructure (Neo4j, PostgreSQL, Redis, Kafka)
docker-compose -f infrastructure/docker/docker-compose.yml up -d

# Initialize databases
./scripts/db-init.sh

# Build all packages
npm run build

# Start API server in dev mode
npm run dev:api
```

Or use the all-in-one script:

```bash
./deploy.sh --seed   # Builds everything, starts all services, seeds test data
```

## Project Structure

This is a TypeScript monorepo using npm workspaces. Packages are layered:

1. `packages/common` - Shared types, no dependencies
2. `packages/database` - Database clients (Neo4j, PostgreSQL, Redis)
3. `packages/discovery-engine`, `packages/etl-processor` - Core services
4. `packages/api-server` - REST + GraphQL API
5. `packages/connectors/*` - Integration connectors (TypeScript + JSON)
6. `web-ui` - React dashboard

## Coding Standards

- **TypeScript strict mode** is enforced via `tsconfig.base.json`
- **ESLint** with `@typescript-eslint` rules: `npm run lint`
- **Prettier** for formatting: `npm run format`
- **No `any` types** unless absolutely necessary
- **Async/await** everywhere (no callbacks)
- **Parameterized queries** for all database operations

## Running Tests

```bash
npm run test:unit          # Unit tests (fast, mocked dependencies)
npm run test:integration   # Integration tests (requires running databases)
npm run test:e2e           # End-to-end tests
npm run test:coverage      # All tests with coverage report
```

All PRs must pass the CI pipeline (unit + integration tests).

## Pull Request Process

1. **Fork** the repository and create a branch from `main`
2. **Make your changes** with clear, focused commits
3. **Add tests** for new functionality
4. **Run the full test suite** locally: `npm run test:unit`
5. **Run the linter**: `npm run lint`
6. **Push** your branch and open a PR against `main`
7. **Sign the CLA** when the bot prompts you
8. **Respond to review feedback**

### PR Guidelines

- Keep PRs focused on a single concern
- Write descriptive commit messages (e.g., `feat: add Splunk connector`, `fix: credential rotation race condition`)
- Update documentation if your change affects user-facing behavior
- Do not include unrelated formatting changes

## Adding a Connector

HappyCMDB supports two connector types:

### JSON-Only Connector (for simple REST APIs)
```bash
# Create connector directory
mkdir -p packages/connectors/my-service
# Add connector.json with endpoint definitions, auth config, field mappings
# See packages/connectors/github/connector.json for an example
```

### TypeScript Connector (for complex integrations)
```bash
npm run connector:new my-service
# Implement IConnector interface in src/index.ts
# See packages/connectors/aws/ for an example
```

Full connector development guide: `doc-site/docs/architecture/connector-framework.md`

## Reporting Issues

- **Bugs**: Use the bug report issue template
- **Features**: Use the feature request issue template
- **Security**: See [SECURITY.md](SECURITY.md) — do NOT use public issues

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful.

## Questions?

Open a GitHub Discussion or reach out at community@happy-tech.biz.
