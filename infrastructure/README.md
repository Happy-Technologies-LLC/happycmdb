# Infrastructure Directory

This directory contains all deployment, configuration, and infrastructure-related files for HappyCMDB.

## Directory Structure

```
infrastructure/
├── docker/                    # Docker configuration files
│   ├── docker-compose.yml    # Main Docker Compose configuration
│   ├── docker-compose.test.yml  # Test environment configuration
│   ├── Dockerfile.api        # API server Dockerfile
│   ├── Dockerfile.web        # Web UI Dockerfile
│   ├── Dockerfile.discovery  # Discovery engine Dockerfile
│   ├── Dockerfile.etl        # ETL processor Dockerfile
│   ├── Dockerfile.agent      # Discovery agent Dockerfile
│   └── .dockerignore         # Docker ignore patterns
├── kubernetes/               # Kubernetes manifests
│   ├── deployments/         # Deployment configurations
│   ├── services/            # Service definitions
│   ├── configmaps/          # Configuration maps
│   ├── secrets/             # Secret templates
│   ├── statefulsets/        # StatefulSet definitions
│   ├── storage/             # Persistent volume configs
│   └── ingress/             # Ingress rules
├── monitoring/              # Monitoring and observability
│   ├── prometheus/          # Prometheus configuration
│   ├── grafana/            # Grafana dashboards
│   └── alerting/           # Alert rules
├── scripts/                # Infrastructure scripts
│   └── seed-data.ts        # Database seeding script
└── config/                 # Configuration templates
    └── templates/          # Environment-specific config templates
        ├── development.json
        ├── staging.json
        └── production.json
```

## Docker Configuration

### Dockerfile Variants

The `docker/` directory contains multiple Dockerfile variants for different use cases:

**Production Dockerfiles** (Multi-stage builds):
- `Dockerfile.api` - API server with full TypeScript build (118 lines)
- `Dockerfile.web` - Web UI with production build
- `Dockerfile.discovery` - Discovery engine
- `Dockerfile.etl` - ETL processor
- `Dockerfile.agent` - Discovery agent

**Development Dockerfiles** (Faster rebuilds):
- `Dockerfile.api.dev` - Uses pre-built artifacts, faster startup
- `Dockerfile.web.dev` - Uses pre-built UI bundle

**Which to use?**
- **Production/CI/CD**: Use standard Dockerfiles (e.g., `Dockerfile.api`)
- **Local development**: Use `.dev` variants if you build locally first

### Running Docker Services

All Docker commands should use the `-f infrastructure/docker/docker-compose.yml` flag:

```bash
# Start all services
docker-compose -f infrastructure/docker/docker-compose.yml up -d

# View logs
docker-compose -f infrastructure/docker/docker-compose.yml logs -f [service-name]

# Stop services
docker-compose -f infrastructure/docker/docker-compose.yml down

# Stop and remove volumes
docker-compose -f infrastructure/docker/docker-compose.yml down -v
```

**Tip**: Use the `deploy.sh` script in the project root for full deployment workflows.

## Configuration Management

Config templates are stored in `infrastructure/config/templates/`. Never commit actual credentials.

For detailed documentation, visit http://localhost:8080 when services are running.
