# Build01 staging

The live staging Compose project is staging-happycmdb, managed by the portfolio `deploy-app.sh` with a per-generation volume override. The deployer supplies IMAGE_TAG as a full commit SHA (Compose defaults to local without it).

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

Named data volumes: neo4j_data, neo4j_logs, neo4j_plugins, postgres_data, redis_data. The bare Compose file declares project-scoped volumes, but the deployer binds live and candidate stacks to external `staging-happycmdb-data-g<N>_*` volumes using `/home/nzitzer/.staging-overrides/happycmdb-g<N>.yml`. At this finding the existing init-postgres-built live Postgres volume is `staging-happycmdb-data-g15_postgres_data`; a fresh candidate would use the next generation, not the live volume or the bare file's `staging-happycmdb_postgres_data`. NEVER use the bare Compose file against the live project: it omits that generation binding and can target the wrong volume or disrupt the live Postgres service. Removing the initdb mount does not change any existing volume.

**Migration safety prerequisite:** Only a fresh NEXT-generation candidate `postgres_data` volume may receive canonical migrations, after a verified backup of the live-generation volume and founder approval. Before any migration, the operator must verify that the resolved volume binding is the fresh candidate generation, not the existing init-postgres-built g15 live volume or a bare-Compose project volume. NEVER migrate the current live generation: it has no `cmdb.schema_migrations`, and migration SQL can partially succeed against its pre-existing schema. This runbook does not authorize migration, volume rebuilding, or host deployment.

A fresh Postgres volume no longer runs staging initdb SQL and needs canonical SQL migrations before API traffic. Default unqualified Compose `up -d` does not start the opt-in-profile migrator. The founder-approved route is a separate portfolio `deploy-app.sh` change: its one-time `STAGING_FRESH_VOLUMES=postgres_data` opt-in creates only the next-generation Postgres volume empty while other data volumes are copied with data services stopped; it runs the migrator on the candidate with the generation override before cutover, never on the live project. Approval of that route does not mean the host script is merged, installed, or authorized to run a rebuild window. The migrator uses `/app/packages/database/src/postgres/migrations` in the candidate's full-SHA image, records checksums in `cmdb.schema_migrations`, and exits nonzero on migration failure. Health checks do not confirm migration completion. Confirm API at http://127.0.0.1:19000/api/v1/cmdb-health and UI at http://127.0.0.1:19080/.
