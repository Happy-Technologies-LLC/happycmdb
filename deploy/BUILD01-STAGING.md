# Build01 staging

Standalone compose project staging-happycmdb. The deployer supplies IMAGE_TAG as full commit SHA (default local).

## Services

| Service | Purpose | Published port |
| --- | --- | --- |
| api-server | REST and GraphQL API | 127.0.0.1:${HAPPYCMDB_API_PORT:-19000} → 3000 |
| web-ui | Nginx React UI, proxies API/GraphQL | 127.0.0.1:${HAPPYCMDB_WEB_PORT:-19080} → 80 |
| postgres | TimescaleDB/PostgreSQL | internal only |
| migrator (profile `migrate`) | One-shot schema migration using the api-server image; opt-in only | internal only |
| neo4j | Graph database | internal only |
| redis | Cache and BullMQ queue | internal only |

Kafka is optional and intentionally omitted, along with Zookeeper, test SSH, Grafana, Metabase, and Kafka UI. Published ports are loopback-only behind the host proxy.

## Environment variable names

Required secret/config names (Infisical /staging path /happycmdb):
- JWT_SECRET — JWT signing secret.
- JWT_ISSUER — required issuer stamped and verified on JWTs.
- JWT_AUDIENCE — required audience stamped and verified on JWTs.
- ENCRYPTION_KEY — credential encryption key consumed as CREDENTIAL_ENCRYPTION_KEY.
- NEO4J_PASSWORD — Neo4j user password.
- POSTGRES_PASSWORD — PostgreSQL user password.
- STAGING_PUBLIC_URL — staging UI origin/hostname used to constrain allowed origins.

Optional names: REDIS_PASSWORD (only when Redis auth enabled), IMAGE_TAG (defaults local), HAPPYCMDB_API_PORT (defaults 19000), HAPPYCMDB_WEB_PORT (defaults 19080). NODE_ENV, database hosts/ports, Kafka brokers, JWT expiration, and internal TLS settings are fixed. See [production parity](PRODUCTION-PARITY.md). Never commit secret values.

## Storage and startup

Named volumes: neo4j_data, neo4j_logs, neo4j_plugins, postgres_data, redis_data. Do not use docker compose down -v unless deletion is intended. A fresh Postgres volume no longer runs the staging initdb SQL: it needs the canonical SQL migrations before API traffic. The migrator is deliberately excluded from ordinary `docker compose up -d`; after building the api-server image, an operator explicitly runs `docker compose -f deploy/build01-staging.compose.yml run --rm migrator` (or enables `--profile migrate`). It uses `/app/packages/database/src/postgres/migrations` in that image, records checksums in `cmdb.schema_migrations`, and exits nonzero on migration failure. Health checks do not confirm migration completion. Existing staging volumes are unchanged by removing the initdb mount; volume backup/rebuild and host deploy changes are separate operator actions, not automatic effects of this compose change. Confirm API at http://127.0.0.1:19000/api/v1/cmdb-health and UI at http://127.0.0.1:19080/.
