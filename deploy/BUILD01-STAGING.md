# Build01 staging

This compose file is standalone because the development compose file assigns fixed [0mcontainer_name[0m values. Run it from the happycmdb repository root with project name [0mstaging-happycmdb[0m; the deployer supplies [0mIMAGE_TAG[0m as the full commit SHA (default [0mlocal[0m).

## Services

| Service | Purpose | Published port |
| --- | --- | --- |
| [0mapi-server[0m | REST and GraphQL API | [0m127.0.0.1:19000[0m → 3000 |
| [0mweb-ui[0m | Nginx React UI, proxies API/GraphQL | [0m127.0.0.1:19080[0m → 80 |
| [0mpostgres[0m | TimescaleDB/PostgreSQL | internal only |
| [0mneo4j[0m | Graph database | internal only |
| [0mredis[0m | Cache and BullMQ queue | internal only |

Kafka and Zookeeper are omitted: Kafka is documented as optional and disabled by default, and API startup does not initialize a Kafka connection. Kafka health is reported unhealthy if brokers are absent, but the aggregate health endpoint remains HTTP 200 in degraded state. The staging environment intentionally configures no brokers. Test SSH, Grafana, Metabase, and Kafka UI are not in this standalone service set.

All published ports are loopback-only; the UI is reachable through the host's chosen tailnet proxy. The health URL is [0mhttp://127.0.0.1:19000/api/v1/cmdb-health[0m.

## Environment variable names

Required staging secrets (provide via Infisical at [0m/staging[0m path [0m/happycmdb[0m):

- [0mJWT_SECRET[0m — signing secret for API JWTs; use a high-entropy value.
- [0mENCRYPTION_KEY[0m — credential encryption key consumed as [0mCREDENTIAL_ENCRYPTION_KEY[0m; use a strong key of at least 32 characters.
- [0mNEO4J_PASSWORD[0m — Neo4j [0mneo4j[0m user password.
- [0mPOSTGRES_PASSWORD[0m — PostgreSQL [0mcmdb_user[0m password.

Optional:

- [0mREDIS_PASSWORD[0m — unset/empty by default; set only if Redis authentication is separately enabled.
- [0mIMAGE_TAG[0m — deployer-controlled image tag; defaults to [0mlocal[0m for manual local checks.

Other settings are fixed in compose: [0mNODE_ENV[0m, database hosts/ports, Kafka brokers (empty), JWT expiration, and TLS disabled for internal staging traffic. No secret values belong in this file or source control.

## Storage

Compose named volumes persist state and are scoped by compose project [0mstaging-happycmdb[0m: [0mneo4j_data[0m, [0mneo4j_logs[0m, [0mneo4j_plugins[0m, [0mpostgres_data[0m, and [0mredis_data[0m. Do not run [0mdocker compose down -v[0m unless permanently deleting staging data is intended.

## First run and schema migration

1. Populate the required Infisical secret names before the founder-authorized first deploy. No secret values are committed here.
2. From the repo root, build and start using [0mdeploy/build01-staging.compose.yml[0m, project [0mstaging-happycmdb[0m, and those injected variables.
3. Postgres runs [0minfrastructure/scripts/init-postgres.sql[0m once against a fresh named volume. Apply subsequent schema migrations using the repository's migration scripts before directing staging users to the UI; the deployer health check confirms API health, not schema migration completion.
4. Wait for the API health URL to return HTTP 200 and confirm the UI at [0mhttp://127.0.0.1:19080/[0m. Preserve named volumes across redeploys and rollbacks.
