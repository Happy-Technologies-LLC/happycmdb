# HappyCMDB OpenAPI Documentation

This directory contains the comprehensive OpenAPI 3.0 specification for the HappyCMDB REST API.

## Overview

- **OpenAPI Version**: 3.0.0
- **API Version**: 2.0.0
- **Total Endpoints**: 100+
- **Specification File**: `openapi.yaml`

## Quick Start

### Access Swagger UI

When the API server is running:

```
http://localhost:3000/api-docs
```

This provides an interactive UI to explore and test all API endpoints.

### Download OpenAPI Specification

**JSON Format**:
```
http://localhost:3000/api-docs/openapi.json
```

**YAML Format**:
```
http://localhost:3000/api-docs/openapi.yaml
```

## API Endpoints Overview
### AI discovery tenancy (`/api/v1/ai`)

`GET /sessions`, `GET /sessions/{sessionId}` and
`POST /sessions/{sessionId}/analyze` require an authenticated, valid organization
claim. Session lists and analysis candidates use only rows stamped for that
organization. Foreign, missing and legacy `NULL` organization session IDs
receive the same 404 response for detail/analysis; legacy rows are not
backfilled from hosts, IDs, or pattern references. Migration
`027_ai_session_provenance.sql` adds nullable organization metadata to sessions
and patterns only. The current image has no trusted writer of real AI discovery
session or pattern ownership; real legacy sessions and unattributed patterns
remain unavailable until a verified owner-aware writer/recovery process exists.
Pattern-matcher telemetry stays synthetic and does not grant ownership to
historical sessions.

`GET /patterns`, `GET /patterns/{patternId}`,
`GET /patterns/{patternId}/history`, `POST /patterns/{patternId}/validate`
and `GET /patterns/{patternId}/usage` expose only caller-attributed patterns.
Usage additionally requires the joined execution session to carry the same
organization; foreign and legacy NULL session hosts/ports stay hidden even
when the pattern itself belongs to the caller. Foreign, unattributed and
missing pattern IDs all return the same 404. No existing explicit curated
global source marker or platform administrator authority exists on main:
seeded industry patterns, authors and filenames do not imply tenant or
platform ownership. `GET /analytics/cost` and `/analytics/learning` aggregate
only caller-attributed sessions, usage, patterns and approval history; a tenant
with no attributable rows receives zero/empty results.

`POST /patterns/compile`, `DELETE /patterns/{patternId}` and the five
`POST /patterns/{patternId}/{submit|approve|reject|activate|deactivate}`
transitions return 403 for every tenant role, including admin, regardless of
pattern ID. Shared storage/workflow lifecycle entry points also refuse writes.
No platform authority is implemented on main; HP1-S6/P-6 must establish it
before these global operations can be restored. This change does not gate
internal pattern-matcher execution telemetry.

Candidate rollout order is installed snapshot, `027` candidate migrator, then
the matching image. The forward migration is metadata-only, with no backfill
or index scan. Manual rollback is transactional, uses bounded lock/statement
timeouts, drops both metadata columns, and removes its migration ledger entry
for reapply; revert the `027`-aware image first. Dropping stamped ownership
destroys provenance, so preserve it before any authorized rollback. Reverting
to an older unscoped image reopens the original exposures; this is not a
live recovery instruction or approval. No staging/live migration or rollout
is performed by this change.


### Authentication (`/api/v1/auth`)
- `POST /auth/login` - User login with JWT
- `POST /auth/api-keys` - Create API key
- `GET /auth/api-keys` - List API keys
- `DELETE /auth/api-keys/{keyId}` - Revoke API key

### Configuration Items (`/api/v1/cis`)
- `GET /cis` - List all CIs with filtering
- `POST /cis` - Create a CI with server-assigned `id`; omit `id`, `external_id`, `organization_id`
- `GET /cis/{id}` - Get CI by ID
- `PUT /cis/{id}` - Update CI
- `DELETE /cis/{id}` - Delete CI
- `POST /cis/search` - Search CIs
- `GET /cis/{id}/relationships` - Get CI relationships
- `GET /cis/{id}/dependencies` - Get dependency tree
- `GET /cis/{id}/impact` - Impact analysis
- `GET /cis/{id}/audit` - Audit history

Every REST/GraphQL CI and relationship write (create, update, delete, ITIL
lifecycle/status/audit, baseline restore) is one journaled operation (HP1 v16
§3–§4, HP1-S4a): a PostgreSQL intent row, one auto-commit Neo4j statement that
also creates a `:ReconciliationOp` fence, then a PostgreSQL commit of the
evidence. An unproven graph outcome answers 503 with `correlation_id`; until the
recovery sweep proves the fence, the owner gets 409 `CI is temporarily
unavailable` on that CI and lists mask it, while other organizations still get
the identical 404. A delete writes exactly one organization-stamped `deleted`
history row and, in the same transaction, removes only the deleted
incarnation's (or unmarked legacy) `baseline_snapshots`,
`drift_detection_results`, `impact_analyses` and `ci_criticality_scores` rows.
Prior change history is evidence and is never purged. Derived reads require an exact match
to the current tenant-owned graph CI's UUID; NULL legacy SQL markers and rows
from former incarnations fail closed regardless of timestamps. A legacy graph
CI gets a UUID only on its next owner-scoped derived write; old SQL rows are
never backfilled. Migration `025_ci_derived_incarnation.sql` is source-only
until the separately approved fresh-database staging window for 001–025.
A dark, Nick-run purge needs separate approval, offline affected-ID and stale-row
enumeration, and reviewed tenant-by-tenant dry-run counts. This PR does not
execute or schedule a live purge, backfill, or direct staging migration.
Drift baselines, drift results and impact analyses also carry the writer's
authenticated `organization_id` (HP1-S4c, migration `038`, `NOT VALID` checks):
derived reads additionally require that organization, so legacy org-less and
foreign-org rows fail closed; legacy rows are kept, never backfilled, and an
org-less (pre-S4c) writer is refused with SQLSTATE 23514.
`POST /drift/detect/{ciId}`, `POST /drift/baseline`, `POST /impact/predict` and
`GET /impact/criticality/{ciId}` persist only in one admission transaction (HP1-S4d,
AP-P′) after a gap check over the root and every CI the result read: while any is
pending/failed for the caller's organization they answer 409 `CI is temporarily
unavailable` with no row or event; an admission lock timeout answers 503.

Per-organization read gate (HAP-850, X-29): `GET /cis`, `POST /cis/search`, the four
`/search` endpoints and `GET /impact/graph/{rootCiId}` run at most 2 at once per verified
organization per API process. Others wait FIFO (at most 64, admitted at least 50 ms apart,
for at most 5 s); overflow or an expired wait gets the route's existing body: 503 `CI list
temporarily unavailable`, or 429 `Impact analysis rate limit exceeded` on the impact graph.
A slot is held until the handler's work settles, even after a timed-out response. Writes,
other reads and GraphQL are not gated, and other organizations never wait.
Journaled writes (HAP-873): per organization and API process, only one write at a time waits for the
admission lock while holding a database connection; later ones queue in arrival order without one. The
same 12 s budget covers both waits, and expiry answers the existing 503 `CI write temporarily unavailable`.
CI-referencing writes that hold the admission lock shared (AP-P′: the persisting drift/impact endpoints above, ITIL
incidents, changes and baselines, business-service CI mappings; HAP-879) do the same: one waits per organization and
API process with a database connection, the rest wait without one. One 5 s budget covers the queue and the lock wait
(the connection checkout keeps the pool's own 2 s bound); expiry answers the route's existing 503. Behind a sustained
stream of the same organization's CI writes, about one queued referenced write per process enters per CI write.

### Relationships (`/api/v1/relationships`)
- `GET /relationships` - List relationships
- `POST /relationships` - Create relationship
- `DELETE /relationships/{id}` - Delete relationship
- `GET /relationships/type/{type}` - Get by type

### Search (`/api/v1/search`)
- `POST /search/advanced` - Advanced search with filters
- `POST /search/fulltext` - Full-text search
- `POST /search/relationships` - Search by relationship pattern
- `GET /search/orphaned` - Get orphaned CIs

### Credentials (`/api/v1/credentials`)
- `GET /credentials` - List credentials
- `POST /credentials` - Create credential
- `GET /credentials/{id}` - Get credential
- `PUT /credentials/{id}` - Update credential
- `DELETE /credentials/{id}` - Delete credential
- `POST /credentials/match` - Match best credential
- `POST /credentials/rank` - Rank credentials
- `POST /credentials/{id}/validate` - Validate credential

### Credential Sets (`/api/v1/credential-sets`)
- `GET /credential-sets` - List sets
- `POST /credential-sets` - Create set
- `GET /credential-sets/{id}` - Get set
- `PUT /credential-sets/{id}` - Update set
- `DELETE /credential-sets/{id}` - Delete set
- `POST /credential-sets/{id}/select` - Select credentials

### Discovery Definitions (`/api/v1/discovery/definitions`)
- `GET /discovery/definitions` - List definitions
- `POST /discovery/definitions` - Create definition
- `GET /discovery/definitions/{id}` - Get definition
- `PUT /discovery/definitions/{id}` - Update definition
- `DELETE /discovery/definitions/{id}` - Delete definition
- `POST /discovery/definitions/{id}/run` - Run discovery
- `POST /discovery/definitions/{id}/schedule/enable` - Enable schedule
- `POST /discovery/definitions/{id}/schedule/disable` - Disable schedule
Definitions require a verified organization claim. New definitions are owned by
that organization; pre-existing NULL-owner definitions are inaccessible until an
independently reviewed owner mapping exists. Foreign and missing IDs return the
same 404. Credential IDs must belong to the same organization. Credential-backed
manual runs and schedule enables return the same fixed 409 for every caller
(including admins); they do not resolve credentials or queue jobs. SSH manual jobs,
definition runs and schedule enables return the fixed 409, including legacy
credentialless SSH definitions. Credentialless Active Directory/SNMP definitions
cannot be created or changed to those providers; legacy credentialless definitions
also return 409 on run/enable and are excluded from definition scheduling.
Background SSH triggers, schedules and workers fail closed; disabling schedules
remains available. Discovery definition writes reject malformed targets and
nonboolean scan-mode flags with a fixed 400. Credential-free Nmap definition
manual runs and repeatable definition jobs queue only scan targets, an organization
stamp and boolean `scanOptions.aggressive`, `osDetection`, `serviceDetection`,
`fullPortScan` and `portScan` switches. Opaque config and credentials are not
queued by discovery definition producers. Legacy `POST /discovery/schedule`
also queues only allowlisted Nmap targets and scan switches with a verified
organization stamp; SSH/AD/SNMP return fixed 409. Legacy job list/detail/cancel
require the session organization, hide orgless jobs and return only safe provider,
timestamps, progress counters, numeric discovered-CI summary and fixed failure
codes. Raw worker results, errors and configuration remain inaccessible.
Production scheduler startup/registration
is tracked separately as HAP-546; direct repeatable-job proof is not proof of
production scheduling. Credential-backed discovery is restored by HP1-S5
(v16 §10.2.4-10.2.6 org-owned credential sets and run pipeline), tracked as HAP-444.


### Discovery Agents (`/api/v1/agents`)
- `GET /agents` - List agents
- `POST /agents/register` - Omit `agent_id` to create and retain issued ID for heartbeat; provide issued ID to retry/update an existing agent owned by the caller. Foreign/missing IDs both return 404.
- `POST /agents/heartbeat` - Update heartbeat
- `POST /agents/find-best` - Find best agent
- `GET /agents/{agentId}` - Get agent
- `DELETE /agents/{agentId}` - Delete agent

### Connectors (`/api/v1/connectors`)
- `GET /connectors/registry` - Browse registry
- `GET /connectors/registry/{type}` - Get connector details
- `GET /connectors/installed` - List installed
- `GET /connectors/installed/{type}` - Get installed details
- `GET /connectors/outdated` - Check for available updates
- `POST /connectors/install`, `PUT /connectors/{type}/update`, `DELETE /connectors/{type}`, `POST /connectors/{type}/verify`, `POST /connectors/cache/refresh` - Always return 403 `Platform administrator access unavailable` after authentication. Connector code changes occur only through deployment packaging/file placement outside the application.

### Reconciliation (`/api/v1/reconciliation`)
- `POST /reconciliation/match` - Find matching CIs
- `POST /reconciliation/merge` - Merge CI; 200 updated, or 202 `pending_review` with stable `conflict_ids` when a manual-review field holds the whole merge (no CI change)
- `GET /reconciliation/conflicts` - List the caller organization's conflicts with typed values and `revision`; page and total from one statement
- `POST /reconciliation/conflicts/{id}/resolve` - `accept_source | accept_target | merge | dismiss_stale` at `expected_revision`; stale or changed revision 409, foreign/missing 404
- `GET/POST /reconciliation/rules`, `PUT/DELETE /reconciliation/rules/{id}`, `GET /reconciliation/source-authorities`, `PUT /reconciliation/source-authorities/{source}` - The caller organization's policy only (writes need admin); foreign, missing and legacy rules share one 404. `?scope=global` is 403 for every role, and legacy organization-less rows are inert (founder decision 2026-10-20). GraphQL getRules/getSourceAuthorities/createRule/updateSourceAuthority remain refused.
- `GET /reconciliation/lineage/{ci_id}`, `GET /reconciliation/field-sources/{ci_id}` - Caller-owned CI lineage and field sources; foreign and missing CIs share one 404 (GraphQL `getCILineage`/`getCIFieldSources` NOT_FOUND). After the organization guard, both and their GraphQL counterparts return 503 `Service Unavailable` (GraphQL `SERVICE_UNAVAILABLE`) before any data query while the HP1 schema or the Neo4j fence constraint is missing (v16 §3.2)

### Analytics (`/api/v1/analytics`)
- `GET /analytics/dashboard` - Dashboard statistics
- `GET /analytics/ci-counts` - CI counts by type
- `GET /analytics/discovery-stats` - Discovery statistics
- `GET /analytics/dependency-depth` and GraphQL `getDependencyDepthStats` share a bounded tenant-edge traversal (128 edges, depth 10, 5-second SQL timeout). Larger graphs return a fixed resource-limit failure; request admission holds REST slots until work finishes.

### Anomalies (`/api/v1/anomalies`)
- All routes require a verified token organization. Recent, per-CI and stats reads include only rows explicitly stamped with that organization and the graph CI's current incarnation; old rows remain inaccessible.
- `GET /anomalies/recent`, `GET /anomalies/stats` - Tenant-proven anomalies only. The two UI reads share dedicated anomaly admission: at most 2 in flight per principal and 4 per organization, with 10 requests/principal/minute and 40/organization/minute; unrelated analytics retain their own limits. Scoped keyset pagination accepts up to 4096 graph CIs in 512-CI pages; each SQL page has a 5-second statement timeout, the request has a 12-second response deadline with admission held through work completion, and an exceeded budget returns fixed 503 without partial results.
- `GET /anomalies/ci/{ciId}` - Tenant-proven current-incarnation anomalies; foreign and missing CI IDs return identical 404.
- `PATCH /anomalies/{id}/status` - Look up only a caller-attributed row, verify its current graph CI directly, then mutate with atomic SQL row-owner/incarnation predicates; foreign, stale and missing IDs return identical 404 regardless of tenant graph size.
- `POST /anomalies/detect` - Fixed 403 for all callers. Scheduled global producers continue to create unstamped rows; never infer their provenance from a matching CI ID.

### Jobs (`/api/v1/jobs`)
- `GET /jobs/stats` - Global job statistics (fixed 403)
- `GET /jobs/discovery` - List discovery jobs
- `POST /jobs/discovery/{provider}` - Trigger discovery
- `GET /jobs/{queueName}/{jobId}` - Get job status
- `DELETE /jobs/{queueName}/{jobId}` - Cancel job
- `POST /jobs/{queueName}/{jobId}/retry` - Retry job
Job detail, queue lists, failed jobs, discovery lists, cancel/retry, and logs
require a verified organization claim. Jobs without a matching organization
stamp (including legacy jobs) are inaccessible; foreign and missing IDs return
the same 404. Job data, results, failures, progress and free-form logs are not
returned. Schedule responses omit stored configuration. Queue and failed-job
lists accept non-negative integer `start`/`end` and optional `limit`, reject
invalid ranges with fixed 400, and read at most 100 BullMQ jobs per request
before filtering by organization. Pagination reports queue offsets, bounded
`limit`, and `truncated: true` for every non-empty page: ownership filtering
can make the bounded sample incomplete, and the flag does not reveal queue
occupancy. It does not expose cross-tenant totals. Global queue clean,
pause/resume, stats (including repeatable job metadata), worker status, queue
health and metrics, discovery aggregates, schedule listings and both discovery
and ETL provider/type schedule updates return the same fixed 403 for every
authenticated role until the global-operation policy exists. The web UI shows
the global queue/schedule controls as unavailable without requesting them;
organization-owned job lists continue to load.
Legacy `GET /discovery/jobs` accepts `limit` 1–100 and non-negative `offset`;
larger limits receive 400. `limit` applies **per discovery queue/state**, not
to the merged response: each queue/state reads at most `limit` BullMQ jobs
starting at `offset`, and the response returns every owned job in those windows,
sorted by timestamp (up to 16 × `limit` with four queues and four states).
This reaches later windows without scanning preceding foreign jobs. Pagination
reports `count` (returned jobs), `offset`, `limit` (per-source window), and
`truncated: true`; it deliberately omits exact `total`. These windows are not
a tenant-wide ranking: under mixed states/queues or high foreign volume, pages
can be incomplete or overlap. A tenant-exact pagination contract remains HAP-546.

`cmdb jobs run:discovery nmap --config '{"targets":["192.0.2.1"]}'`
calls the authenticated `POST /jobs/discovery/{provider}` endpoint rather than
writing to BullMQ directly. Set `CMDB_API_URL` (or global `--url`) and supply
`CMDB_API_KEY` (or global `--key`) via the configured `API_KEY_HEADER_NAME`
(default `X-API-Key`), or a JWT via `CMDB_ACCESS_TOKEN` (or `--token`).
The API derives the organization from the verified credential; missing,
invalid, or tenantless credentials fail without queueing a job. Authenticated
SSH requests to either `POST /jobs/discovery/ssh` or the legacy
`POST /discovery/schedule` return the same fixed 409 regardless of target shape;
SSH credential-backed execution is restored by HP1-S5.



### Business Services (`/api/v1/business-services`)
Scoped to the caller's organization: 403 without an organization claim; a service outside the caller's organization returns the same 404 as a missing one. Create assigns a globally unique `service_id`; supplied IDs are rejected with 400.
- `GET /business-services` - List business services
- `POST /business-services` - Create business service
- `GET /business-services/{service_id}` - Get business service with mapped-CI and dependency counts
- `PATCH /business-services/{service_id}` - Update business service
- `DELETE /business-services/{service_id}` - Delete business service
- `GET /business-services/{service_id}/cis` - Mapped CIs
- `POST /business-services/{service_id}/cis` - Map CIs
- `DELETE /business-services/{service_id}/cis/{ci_id}` - Unmap CI
- `GET /business-services/{service_id}/dependencies` - Service dependencies
- `POST /business-services/{service_id}/dependencies` - Create dependency
- `DELETE /business-services/{service_id}/dependencies/{depends_on_service_id}` - Delete dependency
- `GET /business-services/{service_id}/health` - Incident and change metrics (7/30-day UTC windows)
- `GET /business-services/{service_id}/costs` - Monthly cost summary

### Health (`/api/v1/cmdb-health`)
- `GET /cmdb-health`, `/ready` - Public dependency status (`{ "_status": "healthy" | "unhealthy" }` or `{ "_ready": boolean }`); 200 when ready, 503 otherwise. Both routes share a five-second completion-based cache, including failures, and a two-second response deadline. At most one physical operation per dependency is outstanding, even after a timeout; no further probe begins on that dependency until it settles. No dependency details, version, uptime, timestamp, capacity or raw errors are public. `GET /alive` is a public process-only liveness probe returning 200 `{ "_alive": true }` without dependency I/O.
  Supplying credentials to these public paths does not enable detailed output; authenticated UI and operator diagnostics remain on `/cmdb-health/services`.
- `GET /cmdb-health/services` - Authenticated service status and latency (JWT or API key); probes share an in-flight request and are cached for 5 seconds, including down statuses. Each physical dependency is limited to one outstanding probe; a two-second timeout returns down without starting another probe until the old operation settles. Header and HealthDashboard use the authenticated `apiClient`.
- `GET /cmdb-health/metrics`, `/timeseries` - Authentication required, then fixed 403 for every role; global counts and trends are not tenant-scoped. The Health dashboard shows service availability without polling refused aggregates.

## Authentication

All API endpoints except `/auth` public actions, `/cmdb-health`, `/cmdb-health/ready`, `/cmdb-health/alive` and `/api-docs` require authentication. `/cmdb-health/metrics` and `/timeseries` authenticate before their fixed refusal; `/cmdb-health/services` authenticates before probing.
Root Prometheus `/metrics` (outside `/api/v1`) accepts only `Authorization: Bearer $METRICS_SCRAPE_TOKEN` (401 otherwise) and answers 404 while that token is unset or shorter than 32 characters.

### JWT Token Authentication

1. Login to get token:
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password123"}'
```

2. Use token in requests:
```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/api/v1/cis
```

### API Key Authentication

1. Create API key:
```bash
curl -X POST http://localhost:3000/api/v1/auth/api-keys \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Production Automation"}'
```

2. Use API key in requests:
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  http://localhost:3000/api/v1/cis
```

## Rate Limiting

- **Standard**: 1000 requests/hour
- **Burst**: 100 requests/minute

Rate limit headers in responses:
- `X-RateLimit-Limit`: Maximum requests
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Reset timestamp

## Common Response Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 204 | No Content (successful deletion) |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (authentication required) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not Found |
| 409 | Conflict (duplicate resource) |
| 429 | Too Many Requests (rate limit) |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

## Reusable Schemas

The OpenAPI spec defines comprehensive schemas for:

### Core Types
- `CI` - Configuration Item
- `CIType` - CI type enumeration (24 types)
- `CIStatus` - CI status (active, inactive, maintenance, decommissioned)
- `Environment` - Deployment environment
- `Relationship` - CI relationship
- `RelationshipType` - Relationship types (18 types)

### Credentials
- `Credential` - Unified credential
- `CredentialSummary` - Credential list item
- `AuthProtocol` - Authentication protocols (14 protocols)
- `CredentialScope` - Credential scopes
- `CredentialAffinity` - Affinity matching rules
- `CredentialSet` - Credential set with fallback

### Discovery
- `DiscoveryDefinition` - Discovery configuration
- `DiscoveryProvider` - Provider types (14 providers)
- `DiscoveryMethod` - connector vs agent
- `DiscoveryAgent` - Agent registration

### Connectors
- `ConnectorRegistryEntry` - Registry metadata
- `InstalledConnector` - Local installation

### Reconciliation
- `MatchRequest` - CI matching request
- `MergeRequest` - CI merge request
- `ReconciliationConflict` - Conflict details
- `ReconciliationRule` - Reconciliation rules

### Analytics & Monitoring
- `Anomaly` - Anomaly detection result
- `Job` - Background job status
- `AuditEntry` - Audit trail entry

### Business Services
- `BusinessService`, `BusinessServiceDetail` - Service (detail adds counts)
- `BusinessServiceInput`, `BusinessServiceUpdate` - Create / update bodies
- `BusinessServiceCIMapping`, `BusinessServiceDependency` - Child read items
- `BusinessServiceHealth`, `BusinessServiceCosts` - Metric bodies
- `CountValue` - Integer count, emitted as a decimal string

## Code Generation

### Generate TypeScript Client

```bash
npm install -g @openapitools/openapi-generator-cli

openapi-generator-cli generate \
  -i http://localhost:3000/api-docs/openapi.json \
  -g typescript-axios \
  -o ./generated-client
```

### Generate Python Client

```bash
openapi-generator-cli generate \
  -i http://localhost:3000/api-docs/openapi.json \
  -g python \
  -o ./generated-client-python
```

### Generate Java Client

```bash
openapi-generator-cli generate \
  -i http://localhost:3000/api-docs/openapi.json \
  -g java \
  -o ./generated-client-java
```

## Testing with Swagger UI

1. Open Swagger UI: `http://localhost:3000/api-docs`
2. Click "Authorize" button
3. Enter JWT token or API key
4. Explore endpoints and execute test requests

## Best Practices

### Pagination
Most list endpoints support pagination:
```
GET /api/v1/cis?_limit=100&_offset=0
```

### Filtering
Use query parameters for filtering:
```
GET /api/v1/cis?_type=server&_status=active&_environment=production
```

### Metadata Filtering
Search CIs by metadata fields:
```json
POST /api/v1/search/advanced
{
  "_query": "web",
  "_metadata_filters": {
    "os": "Ubuntu",
    "cpu_cores": 8
  }
}
```

### Error Handling
All errors follow standard format:
```json
{
  "error": "Validation Error",
  "message": "Invalid CI type provided",
  "details": [
    {
      "field": "_type",
      "error": "must be one of [server, virtual-machine, ...]"
    }
  ]
}
```

## Validation

The API uses Joi validation schemas with comprehensive rules:

- String length limits
- Enum validation
- UUID format validation
- CIDR network format
- Date/time format
- Nested object validation
- Array item validation

## Security

### Authentication Methods
1. **JWT Tokens**: Short-lived session tokens
2. **API Keys**: Long-lived programmatic access

### Security Headers
- Content Security Policy (CSP)
- CORS enabled
- Helmet security middleware

### Credential Encryption
All credentials stored with AES-256 encryption:
- Credentials encrypted at rest
- Secrets redacted in responses
- Audit logging for credential access

## Monitoring

### Health Check
```bash
curl http://localhost:3000/api/v1/cmdb-health
```

Response (200; returns 503 with `{ "_status": "unhealthy" }` if unavailable):
```json
{ "_status": "healthy" }
```

### API Documentation Health
```bash
curl http://localhost:3000/api-docs/health
```

Response:
```json
{
  "status": "ok",
  "openapi_version": "3.0.0",
  "api_version": "2.0.0",
  "paths_count": 100,
  "schemas_count": 45
}
```

## Updating the Specification

When adding new endpoints:

1. Edit `openapi.yaml`
2. Add path definition under `paths:`
3. Define request/response schemas under `components/schemas:`
4. Add examples for request bodies
5. Document all parameters and responses
6. Restart API server to reload spec

## Additional Resources

- **Swagger Editor**: https://editor.swagger.io/ (paste YAML for validation)
- **OpenAPI Specification**: https://swagger.io/specification/
- **Swagger UI Documentation**: https://swagger.io/tools/swagger-ui/
- **HappyCMDB Docs**: http://localhost:8080

## Support

For issues or questions about the API:
- GitHub Issues: https://github.com/happycmdb/happycmdb/issues
- Documentation: http://localhost:8080
- Email: support@happycmdb.io
