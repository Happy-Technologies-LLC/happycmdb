# Build01 staging

The live staging Compose project is staging-happycmdb, managed by the portfolio `deploy-app.sh` with a per-generation volume override. The deployer supplies IMAGE_TAG as a full commit SHA (Compose defaults to local without it).

## Services

| Service | Purpose | Published port |
| --- | --- | --- |
| api-server | REST and GraphQL API | 127.0.0.1:${HAPPYCMDB_API_PORT:-19000} → 3000 |
| web-ui | Nginx React UI, proxies API/GraphQL | 127.0.0.1:${HAPPYCMDB_WEB_PORT:-19080} → 80 |
| postgres | TimescaleDB/PostgreSQL | internal only |
| migrator (profile `migrate`) | One-shot schema migration using the api-server image, as the owner login; opt-in only | internal only |
| app-login (profile `migrate`) | One-shot, as the owner login: creates or re-asserts the API login `cmdb_app` before every migrator run | internal only |
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
- POSTGRES_PASSWORD — password of the PostgreSQL owner login `cmdb_user` (migrator, app-login, rollback).
- POSTGRES_APP_PASSWORD — password of the API login `cmdb_app`; random, at least 32 characters, generated on Build01 (HAP-1562).
- STAGING_PUBLIC_URL — staging UI origin/hostname used to constrain allowed origins.
- AUDIT_CHAIN_KEY — audit hash-chain HMAC key (32-byte hex); journaled CI writes fail closed (503) without it; never rotate without a re-chain plan.

Optional names: POSTGRES_APP_USER (the API's PostgreSQL login; defaults `cmdb_app`, set to `cmdb_user` only to roll back, see below), REDIS_PASSWORD (only when Redis auth enabled), IMAGE_TAG (defaults local), HAPPYCMDB_API_PORT (defaults 19000), HAPPYCMDB_WEB_PORT (defaults 19080), METRICS_SCRAPE_TOKEN (bearer token for root `/metrics`, at least 32 characters; unset or shorter answers 404). NODE_ENV, database hosts/ports, Kafka brokers, JWT expiration, and internal TLS settings are fixed. See [production parity](PRODUCTION-PARITY.md). Never commit secret values.

## PostgreSQL logins (HAP-1562)

- `cmdb_user` is the owner login (the image's bootstrap superuser, owner of every table). Only the migrator and app-login use it.
- `cmdb_app` is the API login: NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, owns nothing. Its privileges come only from migration 045 (`045_staging_app_login_acl.sql`): the tables, columns and sequences the API reads and writes, including the reconciliation journal and `ci_reconciliation_epochs`. It cannot run DDL.
- Order: `--profile migrate run --rm migrator` first runs app-login (Compose `depends_on`), which creates `cmdb_app` with POSTGRES_APP_PASSWORD, so the role exists before 045 grants it and before the API cuts over. app-login re-applies 045 when it is already recorded, so a re-created `cmdb_app` is never left without grants. The password never appears in output or the server log.
- Done-when probe (read-only; one SELECT in a READ ONLY transaction, rolled back), with the same `-p`/`-f` arguments the deployer uses for the project:
  `docker compose -p <project> -f deploy/build01-staging.compose.yml -f <generation override> exec -T api-server node - < deploy/api-db-role-probe.cjs`
  It prints `current_user=cmdb_app rolsuper=false` and exits 0; it exits 2 when the API runs as a superuser and 1 when the probe cannot connect. It never prints a password.
- A new API-side table or query needs a grant to `cmdb_app` in its migration; the `hap1562-real-store` CI job runs the API's queries as `cmdb_app`.
- Prerequisites before deploying this change: POSTGRES_APP_PASSWORD exists for the project (every Compose command refuses to start without it) and the target generation is migrated (`cmdb.schema_migrations` exists), so app-login and 045 run. An init-built generation without the ledger (g15) is never migrated (below) and has no `cmdb_app`: run it with the rollback settings, never with the default `cmdb_app`.

**Rollback to `cmdb_user`** (under the staging-happycmdb lock): set POSTGRES_APP_USER=`cmdb_user` and POSTGRES_APP_PASSWORD to the POSTGRES_PASSWORD value for the project, then recreate only the API: `docker compose -p <project> -f deploy/build01-staging.compose.yml -f <generation override> up -d --no-deps api-server`. The probe then prints `current_user=cmdb_user rolsuper=true` (exit 2, expected after a rollback). In this mode app-login does nothing and the migrator still runs as `cmdb_user`. To return to `cmdb_app`, unset POSTGRES_APP_USER and restore the generated POSTGRES_APP_PASSWORD; app-login refuses the owner password for `cmdb_app`. Removing `cmdb_app` is optional and only after no session uses it: `045_staging_app_login_acl.down.sql` (refuses while a `cmdb_app` session is open) and then `DROP OWNED BY cmdb_app; DROP ROLE cmdb_app;` as `cmdb_user`. `deploy/test-staging-migrations.sh` exercises this rollback in CI.

## Storage and startup

Named data volumes: neo4j_data, neo4j_logs, neo4j_plugins, postgres_data, redis_data. The bare Compose file declares project-scoped volumes, but the deployer binds live and candidate stacks to external `staging-happycmdb-data-g<N>_*` volumes using `/home/nzitzer/.staging-overrides/happycmdb-g<N>.yml`. At this finding the existing init-postgres-built live Postgres volume is `staging-happycmdb-data-g15_postgres_data`; a fresh candidate would use the next generation, not the live volume or the bare file's `staging-happycmdb_postgres_data`. NEVER use the bare Compose file against the live project: it omits that generation binding and can target the wrong volume or disrupt the live Postgres service. Removing the initdb mount does not change any existing volume.

**Migration safety prerequisite:** Only a fresh NEXT-generation candidate `postgres_data` volume may receive canonical migrations, after a verified backup of the live-generation volume and founder approval. Before any migration, the operator must verify that the resolved volume binding is the fresh candidate generation, not the existing init-postgres-built g15 live volume or a bare-Compose project volume. NEVER migrate the current live generation: it has no `cmdb.schema_migrations`, and migration SQL can partially succeed against its pre-existing schema. This runbook does not authorize migration, volume rebuilding, or host deployment.

A fresh Postgres volume no longer runs staging initdb SQL and needs canonical SQL migrations before API traffic. Default unqualified Compose `up -d` does not start the opt-in-profile migrator. The founder-approved route is a separate portfolio `deploy-app.sh` change: its one-time `STAGING_FRESH_VOLUMES=postgres_data` opt-in creates only the next-generation Postgres volume empty while other data volumes are copied with data services stopped; it runs the migrator on the candidate with the generation override before cutover, never on the live project. Approval of that route does not mean the host script is merged, installed, or authorized to run a rebuild window. The migrator uses `/app/packages/database/src/postgres/migrations` in the candidate's full-SHA image, records checksums in `cmdb.schema_migrations`, and exits nonzero on migration failure. Health checks do not confirm migration completion. Confirm API at http://127.0.0.1:19000/api/v1/cmdb-health and UI at http://127.0.0.1:19080/.
