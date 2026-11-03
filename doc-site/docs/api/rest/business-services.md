# Business Services API: C1 service reference

HappyCMDB owns the business service record and publishes it to the other products through Suite Contracts v2 **C1 (service reference)**. A request in HappyHive and a decision or receipt in HIVE name the service by its `service_id` and read everything else from these two endpoints.

- Design: [CO-1 Design Brief v1, section 3 "C1. Service reference"](https://linear.app/happy-technologies-llc/document/co-1-design-brief-v1-governed-internal-ai-service-value-stream-path-689d1d2a981f) (implementation story HAP-1408, CO-1 S2).
- Contract: [Suite Contracts v2, "Common rules" and "C1. Service reference"](https://linear.app/happy-technologies-llc/document/suite-contracts-v2-the-seams-between-products-c1-to-c14-accepted-2026-4b4749544239). Linear is the authority; this page describes what the API serves today.
- Machine-readable: `GET /api-docs/openapi.yaml`, paths `/business-services/{service_id}` and `/business-services/{service_id}/context`.

Status (2026-11-03): reads implemented for CO-1 S2 (HAP-1408); the stored record and audited writes for PoR S2 (HAP-1423, migration `043_business_service_record_c1.sql`). Deployment and activation are not covered here.

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
| `owner_group` | `owner_group` (optional) |
| `criticality` | `business_criticality` (`critical`, `high`, `medium`, `low`) |
| `lifecycle` | `lifecycle`, stored and separate from `operational_status`: `planned`, `live`, `retiring`, `retired`. Migration 043 backfilled rows that existed before it: `live` when `operational_status` was `active`, else `planned` (so `maintenance`, `inactive` and `decommissioned` rows read `planned`; retire them with `PATCH {"lifecycle":"retired"}`). Before 043 the value was derived from `operational_status`. |
| `version` | `version`: 1 on create, +1 on every accepted update |
| `dependencies[]` | the services this service depends on in the caller's organization, newest first |

Not yet served: `offerings[]` (PoR S3, HAP-1424).

## Writes (HappyCMDB UI and migrations only)

`POST`, `PATCH` and `DELETE /api/v1/business-services[/{service_id}]` need the `write` permission and follow the HAP-443 request-shape rules (a reserved key such as `id` or `organization_id` is `400 Invalid request`). HappyHive and HIVE never write.

- **Lifecycle** moves only forward (`planned` → `live` → `retiring` → `retired`, skipping allowed); a backward move or any move out of `retired` is `409`. A create or move into `live` or `retiring` without `owner_principal_id`, or clearing `owner_principal_id` on such a service, is `422`. A service that was `live` before migration 043 without a principal stays editable until its lifecycle changes.
- **`operational_status`** accepts exactly the table's values (`active`, `inactive`, `maintenance`, `decommissioned`); anything else is `400`.
- **Version.** `PATCH` takes an optional `If-Match: "<version>"`. A stale version is `409 {"message":"Version mismatch","version":<current>}` and changes nothing. Every accepted `PATCH` increments `version` by one, with or without `If-Match`. `version` in a body is `400`.
- **Delete** is `409` while the service has CI mappings or dependencies from or to it: retire it instead.
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

The record and write rules (HAP-1423 scenarios 1 to 6, cross-tenant writes, rollback of a failed audit append) are in `business-service-record.test.ts` next to it; migration 043 and its rollback in `packages/database/src/postgres/migrations/__tests__/business-service-record-c1.test.ts`.

The tests run against PostgreSQL (PGlite) as the non-superuser application role.
