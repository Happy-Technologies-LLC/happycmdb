# Business Services API: C1 service reference

HappyCMDB owns the business service record and publishes it to the other products through Suite Contracts v2 **C1 (service reference)**. A request in HappyHive and a decision or receipt in HIVE name the service by its `service_id` and read everything else from these endpoints; a consumer that needs the portfolio pages the C1 list.

- Design: [CO-1 Design Brief v1, section 3 "C1. Service reference"](https://linear.app/happy-technologies-llc/document/co-1-design-brief-v1-governed-internal-ai-service-value-stream-path-689d1d2a981f) (implementation story HAP-1408, CO-1 S2).
- Contract: [Suite Contracts v2, "Common rules" and "C1. Service reference"](https://linear.app/happy-technologies-llc/document/suite-contracts-v2-the-seams-between-products-c1-to-c14-accepted-2026-4b4749544239). Linear is the authority; this page describes what the API serves today.
- Machine-readable: the in-repo `packages/api-server/src/openapi/openapi.yaml`, or `GET /api-docs/openapi.yaml` where `API_DOCS_ENABLED=true` (off by default; unauthenticated when on, see `API_DOCS_ENABLED` in [Environment Variables](/configuration/environment-variables)). Paths: `/business-services` (list), `/business-services/{service_id}`, `/business-services/{service_id}/context`, `/business-services/{service_id}/offerings` and `/service-offerings/{offering_id}`.

Status (2026-11-05): reads implemented for CO-1 S2 (HAP-1408); the stored record and audited writes for PoR S2 (HAP-1423, migration `043_business_service_record_c1.sql`); service offerings for PoR S3 (HAP-1424, migration `046_service_offerings.sql`). HAP-1422: migration `044_business_service_journal_read_acl.sql` grants `cmdb_user` SELECT on `ci_reconciliation_operations`, which `GET /{service_id}/cis`, `POST /{service_id}/cis` and `GET /{service_id}/context` read; without it a non-owner app login gets 500 on those routes. Deployment and activation are not covered here.

HAP-2028: `GET /{service_id}/context` now also reads `ci_source_lineage` (the coverage envelope below). Migration `053_business_service_lineage_read_acl.sql` grants `cmdb_user` `SELECT (organization_id, ci_id)` on it, for the same reason as 044; `cmdb_app` already has it through 045. Manual rollback: `rollback/053_business_service_lineage_read_acl.down.sql`.

## Rules

- **Identifier.** `service_id` is `bs-` followed by a lowercase UUID v4 (Suite Contracts v2 F1). Consumers store it as opaque text. Ids created before C1 are not reformatted.
- **Tenant.** The tenant is the caller's verified organization from the access token. No read takes it from a query parameter or body. A token without an organization claim gets `403`.
- **Not found.** A missing service and another tenant's service return the same `404 {"success":false,"error":"Business service not found"}`, with no echoed id. A known service is never an empty `200`.
- **Additive.** C1 fields are added to the existing `data` object. The stored columns (`organization_id`, `business_criticality`, `operational_status`, `owned_by`, ...) keep their names and meanings.

## `GET /api/v1/business-services/{service_id}`

```json
{
  "success": true,
  "data": {
    "service_id": "bs-11ab0f28-85c8-4494-b220-e90758c6219a",
    "name": "Access request fulfilment",
    "tenant_id": "00000000-0000-0000-0000-000000000000",
    "owner": { "principal_id": null, "display_name": "Internal IT" },
    "owner_valid": false,
    "owner_group": null,
    "criticality": "high",
    "lifecycle": "live",
    "version": 1,
    "dependencies": [
      {
        "service_id": "bs-ea0cc18a-823a-429b-9846-470882fbdfa3",
        "name": "Identity and access management",
        "criticality": "critical",
        "lifecycle": "live",
        "dependency_type": "platform"
      }
    ],
    "offerings": [
      { "offering_id": "so-3f0c6e2a-9b1d-4c5e-8f7a-1b2c3d4e5f60", "name": "Standard access request", "lifecycle": "live" }
    ],
    "updated_at": "2026-11-02T14:30:00.000Z",
    "organization_id": "00000000-0000-0000-0000-000000000000",
    "business_criticality": "high",
    "operational_status": "active",
    "owned_by": "Internal IT",
    "mapped_cis_count": 0,
    "dependencies_count": 1
  }
}
```

The response above is abbreviated: the other stored columns are also returned.

| C1 field | Source |
| -- | -- |
| `tenant_id` | `organization_id` |
| `owner.display_name` | `owned_by` |
| `owner.principal_id` | `owner_principal_id`: the identity-provider subject of the one accountable human owner (F14). HIVE uses it as the D15 tier-change approver. `null` until set; the seeded service has none yet. |
| `owner_valid` | `true` when `owner.principal_id` is set and, at read time, resolves to an enabled user of the service's organization (the same enabled-user and organization comparison as an owner write). `false` for a `null` principal, an unknown, disabled, ambiguous (two identity nodes) or other-organization user, and when the identity store cannot answer or does not answer in time: that failure is logged once per read (error fields only, never an id or a value) and never fails the read, so `false` can also mean "could not verify". HIVE's D15 approver routing must refuse an owner whose `owner_valid` is `false`. One batched identity-store lookup per read covers every distinct owner of the page (at most 100). It is bounded by `OWNER_VALIDITY_TIMEOUT_MS` (3000 ms by default; a positive integer in milliseconds, at most 2147483647, any other value falls back to the default), which is also handed to the Neo4j transaction as its server-side timeout. A timeout or failure marks every owner of that page `false`, not only one. |
| `owner_group` | `owner_group` (optional) |
| `criticality` | `business_criticality` (`critical`, `high`, `medium`, `low`) |
| `lifecycle` | `lifecycle`, stored and separate from `operational_status`: `planned`, `live`, `retiring`, `retired`. Migration 043 backfilled rows that existed before it: `live` when `operational_status` was `active`, else `planned` (so `maintenance`, `inactive` and `decommissioned` rows read `planned`; retire them with `PATCH {"lifecycle":"retired"}`). Before 043 the value was derived from `operational_status`. |
| `version` | `version`: 1 on create, +1 on every accepted update |
| `dependencies[]` | the services this service depends on in the caller's organization, newest first |
| `offerings[]` | the service's offerings (`offering_id`, `name`, `lifecycle`), oldest first; the full record is `GET /api/v1/service-offerings/{offering_id}` |

## `GET /api/v1/business-services` (C1 list)

PoR S4 (HAP-1425; Suite Contracts v2 common paging rule). Parameters: `lifecycle` (`planned`, `live`, `retiring`, `retired`), `cursor`, `limit` (1 to 100, default 50).

```json
{
  "success": true,
  "items": [ { "service_id": "bs-…", "tenant_id": "…", "lifecycle": "live", "version": 3, "offerings": [], "…": "…" } ],
  "next_cursor": "eyJ0cyI6…",
  "as_of": "2026-11-05T17:30:00.000Z"
}
```

- **Items.** Each item is the same object as `data` of `GET /api/v1/business-services/{service_id}` (C1 fields, counts, `dependencies[]`, `offerings[]`), in a stable order: `created_at`, then `service_id`, oldest first.
- **Paging.** Pass `next_cursor` back as `cursor` until it is `null`. A service created or deleted between page reads never makes another repeat or go missing; a service created after the cursor's position appears on a later page.
- **Cursor.** Opaque, signed with the server's token secret, bound to the token's organization and valid for one hour. An altered cursor, another organization's cursor or an expired one is `404 {"success":false,"error":"Cursor not found"}`: start again without `cursor`.
- **Tenant.** A `tenant_id` or `organization_id` parameter is `400`, as is an unknown `lifecycle` or `page` together with `cursor`.
- **Deprecated.** `page` keeps the old offset pages (`{success, data, pagination}`, newest first) for existing callers; it will be removed. Its `data` rows are the stored columns only: they carry no `owner_valid` and none of the other computed C1 fields (`owner`, `tenant_id`, `dependencies[]`, `offerings[]`). Read `owner_valid` from the cursor envelope above.
- **Consumers.** HappyHive and HIVE read with a `viewer` principal (an API key or token with the `read` permission only). Every write route answers it `403` and writes nothing.

## Writes (HappyCMDB UI and migrations only)

`POST`, `PATCH` and `DELETE /api/v1/business-services[/{service_id}]` need the `write` permission and follow the HAP-443 request-shape rules (a reserved key such as `id` or `organization_id` is `400 Invalid request`). HappyHive and HIVE never write.

- **Lifecycle** moves only forward (`planned` → `live` → `retiring` → `retired`, skipping allowed); a backward move or any move out of `retired` is `409`. A create or move into `live` or `retiring` without `owner_principal_id`, or clearing `owner_principal_id` on such a service, is `422`. A service that was `live` before migration 043 without a principal stays editable until its lifecycle changes.
- **Owner principal (D38).** Only the `admin` role may set, change or clear `owner_principal_id`, on `POST` and `PATCH`. Any other writer whose otherwise valid body names the field (on `PATCH`, `null` included) gets `403 {"success":false,"error":"Forbidden","message":"owner_principal_id can be set or changed only by an admin"}` and nothing is written (no audit row); an invalid body is `400` first. A create without it leaves the owner `null`, never the caller, so a non-admin creates only `planned` or `retired` services. Other fields stay writable with `write`; the audit actor is recorded on every write.
- **Owner must belong to your organization.** A non-null `owner_principal_id` (an admin's `POST` or `PATCH`, after the `403` gate and body validation) must be the id of an enabled user of the caller's organization. A user of another organization, an id that does not exist and a disabled user all get the same `422 {"success":false,"error":"Unprocessable Entity","message":"owner_principal_id must be an enabled user of your organization"}`; the body echoes nothing from the request, so it cannot tell which ids exist in other tenants. Nothing is written and no audit row is appended. A non-admin never reaches the check for a body that names the owner (the `403` above comes first, with no lookup). `null` still clears the owner without a lookup. If the identity store cannot answer, the write is `503` (`Business service write temporarily unavailable`) and nothing is written.
- **A move into `live` or `retiring` that names no owner** (`PATCH {"lifecycle":"live"}`) makes the stored owner the D15 approver, so the stored `owner_principal_id` gets the same check, for any writer (a lifecycle move needs no `owner_principal_id` and no admin): when it does not resolve to an enabled user of the caller's organization, the answer is the same `422` body as above, nothing is written and no audit row is appended. The owner is read before the transaction and compared again under the row lock (`FOR NO KEY UPDATE`); an owner changed in between is `409 {"message":"Business service changed; retry"}`. A `PATCH` that leaves the lifecycle as it is (or names the owner) does no stored-owner lookup, so a service whose stored owner went stale stays editable: fix it by naming a valid owner, or find it with the report below. An identity-store failure is `503` as above. A stored owner of `null` is still `422` (`owner_principal_id is required for a live or retiring service`).
- **Owner checks are not atomic with the commit (cross-store TOCTOU).** The identity store (Neo4j) and `dim_business_services` (PostgreSQL) cannot share a transaction, so each owner check (the named owner, and the stored owner of a move into `live` or `retiring`) runs before the write's transaction. An owner who is disabled, deleted or moved to another organization in the identity store after that check and before the `COMMIT` is accepted: the write lands with an owner that no longer resolves. It is caught afterwards, by `owner_valid: false` on the C1 read and by the stale owners report below. The row-lock comparison above closes only the PostgreSQL side of the race (a changed stored owner), not this one.
- **Order of refusals on `PATCH`.** The owner checks run before the transaction and the `If-Match` version is compared inside it, so an owner `422` (named or stored) or an identity-store `503` comes before a stale-version `409`: a `PATCH` with a stale `If-Match` and an owner that does not resolve gets the `422` (or `503`), not `409 Version mismatch`. Only when the owner checks pass do the version, then the lifecycle rule, then the owner-required rule apply, in that order.
- **Stale owners report.** `packages/api-server/src/scripts/unresolved-business-service-owners.ts` is a read-only operator report: it lists, per organization, the services whose stored owner does not resolve (reason `unknown`, `disabled`, `other_organization`, `no_organization`, `ambiguous_identity`; `no_owner` for a `live` or `retiring` service without a principal). It writes nothing: the PostgreSQL read runs in a `READ ONLY` transaction and the graph read is a `MATCH ... RETURN` in a `READ`-mode session (`defaultAccessMode: READ`), so the Neo4j server itself refuses a write Cypher through it. Build with `npm run build:tenant-fixture --workspace=packages/api-server`, then run the compiled `dist/tenant-fixture/api-server/src/scripts/unresolved-business-service-owners.js` with the `CMDB_ROTATE_*` connection variables of the other operator scripts (a read-only login is enough). It prints one JSON object `{"checked","unresolved","organizations":[{"organization_id","services":[{"service_id","name","lifecycle","owner_principal_id","reason"}]}]}`; exit `0` when the report is complete, `1` (nothing listed) when a store could not be read. **The output is operator-confidential:** stdout (and any file it is redirected to) holds every organization's service names and owner principal ids, across tenants. Keep it with the operator who ran it; never attach it to a ticket or a pull request, and never paste it into a chat. Only the `checked` and `unresolved` counts are safe to quote.
- **`operational_status`** accepts exactly the table's values (`active`, `inactive`, `maintenance`, `decommissioned`); anything else is `400`.
- **Version.** `PATCH` takes an optional `If-Match: "<version>"` (quoted or bare digits; `*` matches any; a weak tag such as `W/"3"` is `400`). A stale version is `409 {"message":"Version mismatch","version":<current>}` and changes nothing. Every accepted `PATCH` increments `version` by one, with or without `If-Match`. `version` in a body is `400`. `POST` and `PATCH` responses carry `ETag: "<version>"`; the `GET` read does not (its body also carries `dependencies[]` and counts that change without a version bump), so take `version` from the read body.
- **Delete** is `409` while the service has CI mappings, dependencies from or to it, or offerings: retire it instead.
- **Live offerings.** A service with a `live` offering cannot move out of `live` (`409`): move its offerings out of `live` first.
- **Audit.** Each accepted create, update, retire or delete appends exactly one row to HappyCMDB's hash-chained `audit_log` in the same transaction (`entity_type = BUSINESS_SERVICE`, actor = the verified token subject, `metadata.operation` = `create`, `update`, `retire` or `delete`, `metadata.version`). A failed write appends nothing and bumps no version. Portfolio writes are not HIVE ledger events (Suite Contracts v2 F2). Without `AUDIT_CHAIN_KEY`, or on a chain-lock timeout, a write is `503` and changes nothing.

## `GET /api/v1/business-services/{service_id}/context`

This endpoint returns the dependency and impact subgraph. It walks the service's dependencies in both directions:

- **Services** are reached transitively: what the service depends on, and what depends on it. Every hop joins only services of the caller's organization. Another organization's service ends that branch and never appears, and it never causes a refusal.
- **CIs mapped to the service** are expanded along owned `DEPENDS_ON` edges in both directions, with the CI traversal limits of `GET /api/v1/cis/{id}/impact`.

Unlike `GET /api/v1/cis/{id}/impact`, depth here is a refusing bound. Every walk of the read shares these bounds:

| Bound | Value |
| -- | -- |
| `max_depth` | 5 hops, counted from the service for services and from the mapped CIs for CIs. If a walk could continue past its last hop in its own direction (to a new node or back into the result), the read is refused. |
| `max_nodes` | 100 distinct nodes in the response (services and CIs together), and 100 visited CIs |
| `max_adjacency_rows` | 400 adjacency rows, shared by every walk of the read. The service walks count one row per path step. |
| `statement_timeout_ms` | 5000 per statement: the service walk statement, the ownership check of the mapped CIs, and each graph statement |

A subgraph over a bound is refused with `503 {"success":false,"error":"CI traversal resource limit exceeded"}`. A statement timeout returns `504 {"success":false,"error":"CI traversal timed out"}`. The read never returns a truncated graph. A `200` reports the bounds it ran under in `bounds`.

The `200` also carries `basis` (`"declared_graph_reachability"`), `runtime_blast_radius` (`"not_established"`) and `coverage` beside `data` (HAP-2028). `coverage.unreported_ci_ids` lists the CI nodes of the subgraph that no source has reported (no `ci_source_lineage` row in the caller's organization; another organization's lineage does not count), `coverage.ci_nodes_in_scope` counts those CI nodes (services are not counted), `coverage.runtime_observed_receipts_in_scope` is `false`, and `coverage.note` states that a missing edge is not evidence of no dependency. The same envelope is returned by `GET /api/v1/cis/{id}/impact`, `GET /api/v1/cis/{id}/dependencies` and `GET /api/v1/impact/graph/{rootCiId}`.

The `coverage` read of `ci_source_lineage` runs in its own short transaction under a PostgreSQL `statement_timeout` (HAP-2071): 3000 ms by default, set by `IMPACT_LINEAGE_TIMEOUT_MS` (a positive integer in milliseconds, at most 2147483647, the PostgreSQL maximum; any other value, including a larger one, falls back to the default). When it fires, the endpoint answers its `504` timeout response and sends no `basis`, `runtime_blast_radius` or `coverage`, so a response never claims coverage it did not compute. The connection is released.

The per-edge evidence read of the same endpoint (HAP-2030) has its own bound: one PostgreSQL statement under a `statement_timeout` of 3000 ms by default, set by `IMPACT_EVIDENCE_TIMEOUT_MS` (same rules as `IMPACT_LINEAGE_TIMEOUT_MS`). When it fires, or the edge limit (1000) is exceeded, the endpoint answers its `504` or `503` response with no partial body. CI-to-CI edges of `GET /api/v1/business-services/{service_id}/context` carry `currentness` and `evidence`; service-to-service and `MAPPED_CI` edges carry neither. See [Evidence-qualified relationships and impact](/architecture/system-overview#evidence-qualified-relationships-and-impact-proposed).

```json
{
  "success": true,
  "data": {
    "service_id": "bs-11ab0f28-85c8-4494-b220-e90758c6219a",
    "tenant_id": "00000000-0000-0000-0000-000000000000",
    "nodes": [
      { "kind": "business_service", "id": "bs-11ab0f28-85c8-4494-b220-e90758c6219a", "name": "Access request fulfilment", "criticality": "high", "lifecycle": "live" },
      { "kind": "business_service", "id": "bs-ea0cc18a-823a-429b-9846-470882fbdfa3", "name": "Identity and access management", "criticality": "critical", "lifecycle": "live" }
    ],
    "edges": [
      { "from": "bs-11ab0f28-85c8-4494-b220-e90758c6219a", "to": "bs-ea0cc18a-823a-429b-9846-470882fbdfa3", "type": "DEPENDS_ON", "dependency_type": "platform" }
    ],
    "dependencies": [ { "kind": "business_service", "id": "bs-ea0cc18a-823a-429b-9846-470882fbdfa3", "distance": 1 } ],
    "impact": [],
    "bounds": { "max_depth": 5, "max_nodes": 100, "max_adjacency_rows": 400, "statement_timeout_ms": 5000 }
  }
}
```

- Every edge points from the dependent to what it depends on. Service-to-service edges are `DEPENDS_ON` and carry `dependency_type`. Service-to-CI edges are `MAPPED_CI` and carry `mapping_type`. CI-to-CI edges are the graph's `DEPENDS_ON`.
- `dependencies[]` lists everything the service depends on: services (direct or transitive), its mapped CIs (distance 1) and the CIs those depend on.
- `impact[]` lists everything impacted when the service fails: services that depend on it (direct or transitive), and CIs that depend on one of its mapped CIs. The service is realised by its mapped CIs, so a CI that depends on one of them is impacted. Its path in `edges` runs through that mapped CI, not through the service node.
- Each entry in either list carries its shortest distance from the service, where 1 means direct.
- A mapped CI is included only if it is a current CI of the caller's organization in both PostgreSQL and the graph, with no pending reconciliation. CIs reached from the mapped CIs are the caller's organization's graph nodes, exactly as in `GET /api/v1/cis/{id}/impact`. All mapped CIs are expanded in one traversal per direction. Another tenant's service, CI or edge never appears.

## Service offerings

An offering is a record under one business service (PoR S3, HAP-1424; Suite Contracts v2 C1). HappyHive and HIVE read it; only the HappyCMDB UI writes it (the Business Services page, **Offerings** on a service row).

### `GET /api/v1/service-offerings/{offering_id}` and `GET /api/v1/business-services/{service_id}/offerings`

```json
{
  "success": true,
  "data": {
    "offering_id": "so-3f0c6e2a-9b1d-4c5e-8f7a-1b2c3d4e5f60",
    "service_id": "bs-11ab0f28-85c8-4494-b220-e90758c6219a",
    "tenant_id": "00000000-0000-0000-0000-000000000000",
    "name": "Standard access request",
    "description": "One application account for one person",
    "audience": "internal",
    "lifecycle": "live",
    "service_level": { "availability_target": 99.9, "response_target_hours": 4, "support_hours": "business hours" },
    "version": 1,
    "updated_at": "2026-11-05T10:00:00.000Z"
  }
}
```

The list route returns an array of these, oldest first (empty when the service has none). The single read carries `ETag: "<version>"`.

- **Identifier.** `offering_id` is `so-` followed by a lowercase UUID v4, assigned by the server.
- **Tenant.** `tenant_id` is always the service's tenant. Another tenant's offering, or another tenant's service on the list route, is the same `404` as a missing one (`Service offering not found` / `Business service not found`). Migration 046's composite foreign key `(service_id, organization_id)` also makes the database refuse an offering whose service belongs to another tenant.
- **`audience`** is `internal` or `customer`; **`lifecycle`** is the C1 vocabulary; **`service_level`** holds only `availability_target` (percent), `response_target_hours` and `support_hours` (other members are dropped). Tiers, release records and delivery definitions are not stored here.

### Writes

`POST /api/v1/business-services/{service_id}/offerings` (create; `name` required, `audience` defaults to `internal`, `lifecycle` to `planned`) and `PATCH /api/v1/service-offerings/{offering_id}` (update; retire is `{"lifecycle":"retired"}`) need the `write` permission (a `viewer` gets `403`) and follow the same request-shape rules as service writes. `offering_id`, `service_id`, `organization_id`, `tenant_id` and `version` in a body are `400`. There is no delete.

- **Lifecycle.** An offering can be `live` only under a `live` service, and a `retired` service takes no new offering (`409`). Moves go only forward and `retired` is terminal (`409`).
- **Version.** As for services: optional `If-Match: "<version>"` on `PATCH`, `409` with the current `version` when stale, `ETag: "<version>"` on every response.
- **Audit.** Each accepted create, update or retire appends one hash-chained `audit_log` row with `entity_type = SERVICE_OFFERING` (`metadata.operation` = `create`, `update` or `retire`). No ledger event.

## Seeded internal IT service

Migration `042_co1_access_request_fulfilment_seed.sql` seeds the first CO-1 service into the internal organization `00000000-0000-0000-0000-000000000000`. This is also HappyHive's Default Organization, so the two products share the id. The migration seeds two rows:

- `bs-11ab0f28-85c8-4494-b220-e90758c6219a`: "Access request fulfilment". Owner Internal IT, criticality `high`, lifecycle `live` (043 backfill), no owner principal yet.
- `bs-ea0cc18a-823a-429b-9846-470882fbdfa3`: "Identity and access management". The first service depends on it (`platform`).

The migration never overwrites an existing row, and it aborts if either id belongs to another organization. CIs are not seeded: a CI lives in the graph behind the reconciliation journal, which a SQL migration cannot write. Manual rollback: `rollback/042_co1_access_request_fulfilment_seed.down.sql`.

## Verification

The contract tests are `packages/api-server/src/rest/routes/__tests__/business-service-c1-contract.test.ts`, with these scenarios:

- **S1 happy path:** both reads of the seeded service, `tenant_id` = T, and the bounded subgraph.
- **S2 nonexistent id:** `404` on both reads.
- **S3 cross-tenant:** `404` identical to a missing service, and no other-tenant row in the body or the logs.

The record and write rules (HAP-1423 scenarios 1 to 6, cross-tenant writes, rollback of a failed audit append) are in `business-service-record.test.ts` next to it; migration 043 and its rollback in `packages/database/src/postgres/migrations/__tests__/business-service-record-c1.test.ts`. The offering scenarios (HAP-1424 1, 2, 5 and 6) are in `business-service-record.test.ts`; the cross-tenant route controls (4) and the database guard as the app login (3) in `fixtures/business-service-a1.ts`; migration 046 and its rollback in `service-offerings-046.test.ts`.

The C1 list scenarios (HAP-1425 1 to 3: paging under inserts, lifecycle filter, cursor replay/alteration/expiry) and the consumer controls (5: both `viewer` keys read, and every write route is `403` for them with nothing written) are in `fixtures/business-service-c1-consumer.ts`; the tenant-parameter control (4) is the `GET /` case in `fixtures/business-service-a1.ts`. Both run in `business-service-tenant-isolation.test.ts` and, against PostgreSQL, `tests/integration/database/hap1422-portfolio-app-login.integration.test.ts`.

The tests run against PostgreSQL (PGlite) as the non-superuser application role.
