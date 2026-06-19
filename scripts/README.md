# Scripts Directory

This directory contains utility scripts for HappyCMDB development and deployment.

## Scripts Overview

### Development & Build Scripts

**build-all.sh**
- Builds all TypeScript packages in dependency order
- Cleans build cache before building
- Usage: `./scripts/build-all.sh`

**clean.sh**
- Removes all build artifacts (dist/, node_modules/, *.tsbuildinfo)
- Usage: `./scripts/clean.sh`

**setup-dev.sh**
- Sets up development environment
- Installs dependencies, builds packages
- Usage: `./scripts/setup-dev.sh`

### Database Scripts

**db-init.sh**
- Initializes PostgreSQL and Neo4j databases
- Creates schemas, constraints, indexes
- Usage: `./scripts/db-init.sh`

**db-migrate.sh**
- Runs PostgreSQL migrations
- Usage: `./scripts/db-migrate.sh`

### Testing Scripts

**test-all.sh**
- Runs all tests (unit, integration, e2e)
- Usage: `./scripts/test-all.sh`

**test.sh**
- Runs specific test suites
- Usage: `./scripts/test.sh [unit|integration|e2e]`

### Deployment Scripts

**start-full-stack.sh**
- Starts all services (API, discovery, ETL, UI)
- Usage: `./scripts/start-full-stack.sh`

**load-connectors.ts**
- Loads connector metadata into PostgreSQL
- Usage: `npx ts-node scripts/load-connectors.ts`
- Options: `--clear` (clears existing connectors first)

### Maintenance Scripts

**fix-connectors.sh**
- One-time script to fix connector categories and names
- Already applied, kept for reference
- Usage: `./scripts/fix-connectors.sh`

**fix-codebase.sh**
- Fixes common codebase issues (imports, formatting)
- Usage: `./scripts/fix-codebase.sh`

## Script Organization

- **Root scripts**: Only `deploy.sh` stays in root (main deployment entry point)
- **Development scripts**: In `/scripts/` (build, test, setup)
- **Infrastructure scripts**: In `/infrastructure/scripts/` (seed data, migrations)

## Best Practices

1. **Always use deploy.sh for deployments**: `./deploy.sh --clean --seed`
2. **Build before testing**: `./scripts/build-all.sh && ./scripts/test-all.sh`
3. **Clean when stuck**: `./scripts/clean.sh && npm install && ./scripts/build-all.sh`
4. **Initialize DB manually**: `./scripts/db-init.sh` (only needed once or after clean)

## Environment Variables

Most scripts respect environment variables from `.env` file:
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REDIS_HOST`, `REDIS_PORT`

Create `.env` from `.env.example` before running scripts.

## Troubleshooting

**Script fails with "command not found"**:
- Ensure script is executable: `chmod +x scripts/<script-name>.sh`

**Database connection errors**:
- Verify services are running: `docker-compose -f infrastructure/docker/docker-compose.yml ps`
- Check `.env` credentials match your Docker setup

**Build failures**:
- Clean and rebuild: `./scripts/clean.sh && ./scripts/build-all.sh`
- Check for TypeScript errors in affected packages

## Related Documentation

- Main deployment: `/deploy.sh` in project root
- Infrastructure scripts: `/infrastructure/scripts/`
- Docker operations: `/infrastructure/README.md`
- Full documentation: http://localhost:8080 (when running)
