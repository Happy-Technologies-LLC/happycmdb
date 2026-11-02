# Business Services API: C1 service reference

HappyCMDB owns the business service record and publishes it to the other products through Suite Contracts v2 **C1 (service reference)**. A request in HappyHive and a decision or receipt in HIVE name the service by its `service_id` and read everything else from these two endpoints.

- Design: [CO-1 Design Brief v1, section 3 "C1. Service reference"](https://linear.app/happy-technologies-llc/document/co-1-design-brief-v1-governed-internal-ai-service-value-stream-path-689d1d2a981f) (implementation story HAP-1408, CO-1 S2).
- Contract: [Suite Contracts v2, "Common rules" and "C1. Service reference"](https://linear.app/happy-technologies-llc/document/suite-contracts-v2-the-seams-between-products-c1-to-c14-accepted-2026-4b4749544239). Linear is the authority; this page describes what the API serves today.
- Machine-readable: `GET /api-docs/openapi.yaml`, paths `/business-services/{service_id}` and `/business-services/{service_id}/context`.

Status (2026-11-02): implemented in HappyCMDB for CO-1 S2. Deployment and activation are not covered here.

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
    "criticality": "high",
    "lifecycle": "live",
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

| C1 field | Source today |
| -- | -- |
| `tenant_id` | `organization_id` |
| `owner.display_name` | `owned_by` |
| `owner.principal_id` | always `null`. The accountable owner's identity-provider subject is not stored until HAP-1423 (PoR S2). |
| `criticality` | `business_criticality` (`critical`, `high`, `medium`, `low`) |
| `lifecycle` | derived from `operational_status`: `active` and `maintenance` are `live`, `inactive` is `retiring`, `decommissioned` is `retired`. `planned` is not produced until the record stores its own lifecycle (HAP-1423). |
| `dependencies[]` | the services this service depends on in the caller's organization, newest first |

Not yet served: `owner_group`, `version` and `offerings[]` (C1 PoR extension, HAP-1406 / HAP-1423).

## `GET /api/v1/business-services/{service_id}/context`

This endpoint returns the dependency and impact subgraph. The service's dependencies and dependents are one hop each way. The CIs mapped to the service are expanded along owned `DEPENDS_ON` edges in both directions, using the same CI traversal bounds as `GET /api/v1/cis/{id}/impact`:

| Bound | Value |
| -- | -- |
| `max_depth` | 5 CI hops from each mapped CI |
| `max_nodes` | 100 distinct nodes in the response (and 100 visited CIs) |
| `max_adjacency_rows` | 400 graph adjacency rows, shared by every traversal of the read |
| `statement_timeout_ms` | 5000 per graph statement |
| `service_hops` | 1 |

A subgraph over a bound is refused with `503 {"success":false,"error":"CI traversal resource limit exceeded"}`. A graph statement timeout returns `504 {"success":false,"error":"CI traversal timed out"}`. The read never returns a truncated graph. A `200` reports the bounds it ran under in `bounds`.

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
    "bounds": { "max_depth": 5, "max_nodes": 100, "max_adjacency_rows": 400, "statement_timeout_ms": 5000, "service_hops": 1 }
  }
}
```

- Every edge points from the dependent to what it depends on. Service-to-service edges are `DEPENDS_ON` and carry `dependency_type`. Service-to-CI edges are `MAPPED_CI` and carry `mapping_type`. CI-to-CI edges are the graph's `DEPENDS_ON`.
- `dependencies[]` lists what the service depends on and `impact[]` lists what depends on it. Each entry carries its shortest distance from the service, where 1 means direct.
- A mapped CI is included only if it is a current CI of the caller's organization in both PostgreSQL and the graph, with no pending reconciliation. CIs reached from the mapped CIs are the caller's organization's graph nodes, exactly as in `GET /api/v1/cis/{id}/impact`. All mapped CIs are expanded in one traversal per direction. Another tenant's service, CI or edge never appears.

## Seeded internal IT service

Migration `042_co1_access_request_fulfilment_seed.sql` seeds the first CO-1 service into the internal organization `00000000-0000-0000-0000-000000000000`. This is also HappyHive's Default Organization, so the two products share the id. The migration seeds two rows:

- `bs-11ab0f28-85c8-4494-b220-e90758c6219a`: "Access request fulfilment". Owner Internal IT, criticality `high`, lifecycle `live`.
- `bs-ea0cc18a-823a-429b-9846-470882fbdfa3`: "Identity and access management". The first service depends on it (`platform`).

The migration never overwrites an existing row, and it aborts if either id belongs to another organization. CIs are not seeded: a CI lives in the graph behind the reconciliation journal, which a SQL migration cannot write. Manual rollback: `rollback/042_co1_access_request_fulfilment_seed.down.sql`.

## Verification

The contract tests are `packages/api-server/src/rest/routes/__tests__/business-service-c1-contract.test.ts`, with these scenarios:

- **S1 happy path:** both reads of the seeded service, `tenant_id` = T, and the bounded subgraph.
- **S2 nonexistent id:** `404` on both reads.
- **S3 cross-tenant:** `404` identical to a missing service, and no other-tenant row in the body or the logs.

The tests run against PostgreSQL as the non-superuser application role.
