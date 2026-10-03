---
title: Authentication
description: JWT authentication, role-based access control, and security best practices
---

# Authentication

JWT-based authentication system with role-based access control.

## Quick Integration

### 1. Update App.tsx Router

Add authentication routes and protect existing routes:

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { UserMenu } from './components/auth/UserMenu';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public route */}
        <Route path="/login" element={<Login />} />

        {/* Protected routes */}
        <Route path="/" element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        } />

        <Route path="/settings" element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        } />

        {/* Admin-only route example */}
        <Route path="/admin" element={
          <ProtectedRoute requiredRoles={['admin']}>
            <AdminPanel />
          </ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  );
}
```

### 2. Add UserMenu to Header/Navbar

```tsx
import { UserMenu } from './components/auth/UserMenu';

function AppHeader() {
  return (
    <AppBar>
      <Toolbar>
        <Typography variant="h6">HappyCMDB</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <UserMenu />
      </Toolbar>
    </AppBar>
  );
}
```

### 3. Use Authentication in Components

```tsx
import { useAuth } from './hooks/useAuth';

function MyComponent() {
  const { user, isAuthenticated, hasRole, logout } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return (
    <div>
      <h1>Welcome, {user?.name}</h1>

      {hasRole(['admin', 'operator']) && (
        <Button onClick={startDiscovery}>Start Discovery</Button>
      )}

      <Button onClick={logout}>Logout</Button>
    </div>
  );
}
```

## Environment Variables

Add to your `.env` file:

```env
VITE_API_URL=http://localhost:3000
```

## Backend API Endpoints

Implement these endpoints in your backend:

### Authentication
```
POST   /api/v1/auth/login           - { email, password } → { token, user }
POST   /api/v1/auth/logout          - Logout user
GET    /api/v1/auth/me              - Get current user
PUT    /api/v1/auth/profile         - { name, avatar }
PUT    /api/v1/auth/password        - { currentPassword, newPassword }
DELETE /api/v1/auth/account         - Delete account
```

### Settings
```
GET    /api/v1/settings             - Get general settings
PUT    /api/v1/settings             - Update general settings
PUT    /api/v1/settings/notifications - Update notification settings
PUT    /api/v1/settings/discovery/{provider} - Update provider credentials
POST   /api/v1/discovery/test-connection - Test provider connection
GET    /api/v1/settings/database   - Get database status (admin only)
```

### API Keys
```
GET    /api/v1/auth/api-keys        - List user's API keys
POST   /api/v1/auth/api-keys        - { name, scopes[] } → { key }
DELETE /api/v1/auth/api-keys/:id    - Revoke API key
```

## JWT Token Structure

Your backend should generate JWT tokens with this payload:

```json
{
  "id": "user-id",
  "email": "user@example.com",
  "roles": ["admin"],
  "iat": 1234567890,
  "exp": 1234571490
}
```

## Tenant Scoping (Organization Claim)

Business services are tenant-scoped. The tenant of a request is the `_organizationId`
(a UUID) of the authenticated user, read from the Neo4j `User` node property
`_organizationId` (or `organizationId`) on **every request**, for both bearer tokens and API keys.
Access tokens also carry it as a claim minted at login and refresh. That claim is
informational only: it is replaced by the user's current organization, so moving or
removing a user's organization takes effect immediately. Request bodies can never set it.
Refresh tokens are accepted only by the refresh endpoint; as a bearer token they get **401**.

- `/api/v1/business-services/**` and `/api/v1/architecture/business-services/:serviceId/analysis`
  return **403** `{"_error":"Forbidden","_message":"Organization claim required"}` when the
  user has no organization or it is not a UUID. The check runs before any data access.
- Reads and writes only see rows whose `dim_business_services.organization_id`
  equals the tenant. Another organization's service returns the same **404**
  as a service that does not exist.
- `organization_id` in a create or update body is rejected with **400**.
- **Accepted limitation (founder-approved, 2026-09-30):** `service_id` is unique across
  all organizations. Creating a service with an id another organization already uses
  returns **409** and leaves that row untouched, but the 409 reveals that the id exists.
  No key change is planned.
- Migration `008_business_service_organization_scope.sql` backfills existing
  services to the internal organization `00000000-0000-0000-0000-000000000000`.
  Users need `organizationId` set (the seeded admin has the internal organization).
- Migration `009_business_service_views_org_scope.sql` adds `organization_id` to the
  SQL views `v_business_service_health` and `v_tbm_tower_summary` (tower counts are
  per organization). `avg_mttr_minutes` is weighted by `incident_count` over days with
  a recorded MTTR (NULL when there are none), matching
  `GET /api/v1/business-services/:id/health`.
- Migration `010_business_service_views_org_functions.sql` revokes PUBLIC `SELECT` on
  both views and adds `cmdb.fn_business_service_health(p_org uuid)` and
  `cmdb.fn_tbm_tower_summary(p_org uuid)`, which return one organization's rows and
  raise on a NULL organization. Readers must call the functions with the token's
  `_organizationId`. 010 also revokes `EXECUTE` on both functions from PUBLIC, and the
  functions are `SECURITY INVOKER`, so a non-owner reader (for example a BI or
  read-only role) needs `GRANT EXECUTE` on the function plus `GRANT SELECT` on its
  view. That `SELECT` grant also lets the role read every organization from the view
  directly; see the role model in the 010 header (lines 15-23). This is not a
  tenant-isolation boundary for database roles:
  - The views have no row-level security. The owning role (the migration/API role),
    superusers, `pg_read_all_data` members and any role granted `SELECT` on a view
    outside migrations (for example `metabase_readonly` via
    `infrastructure/database/metabase-init.sql`) still read every organization.
  - The base tables keep their PUBLIC grants from 001 (`SELECT` and `INSERT` on
    `dim_business_services`, `ci_business_service_mappings` and both fact tables;
    also `UPDATE`/`DELETE` on the first two), so any role can recompute both views
    for every organization and write rows that feed them.

  Check the view ACLs after deploying 010:
  `SELECT relname, relacl FROM pg_class WHERE relname IN ('v_business_service_health', 'v_tbm_tower_summary');`

```cypher
// Assign an existing user to the internal organization
MATCH (u:User) WHERE u._username = 'svc-happyhive' OR u.username = 'svc-happyhive'
SET u.organizationId = '00000000-0000-0000-0000-000000000000';
```

### Neo4j `:BusinessService.organization_id`

Service ids are chosen by the client, so an organization can own (in Postgres) an id
that names another organization's Neo4j `:BusinessService` node, for example a node
left behind after its service row was deleted. Every TBM, dashboard and
pool-aggregation Cypher that matches `:BusinessService` therefore also requires
`organization_id` on the node to equal the token organization, in addition to the
Postgres ownership check:

- `GET /api/v1/tbm/costs/by-service/:id` returns the same **404** as a missing service when
  the node belongs to another organization, has no `organization_id`, or does not exist.
  `GET /api/v1/dashboards/business-service/:serviceId` (and `?serviceId=`) returns that
  **404** when a node with the id exists but belongs to another organization or has no
  `organization_id`; an owned service with no node keeps its CI-only dashboard.
  `GET /api/v1/tbm/costs/by-capability/:id` leaves such services out. The TBM GraphQL
  resolvers (not registered in the server) apply the same filter.
- No API route writes `:BusinessService` nodes, and no property-map write
  (`SET bs += $map`) targets them, so `organization_id` cannot be set or changed through
  the API. The sample services in `packages/database/src/neo4j/v3-sample-data.cypher`
  are in the internal organization; a reseed only creates them or updates nodes that are
  internal or have no organization, and attaches sample relationships only where both the
  service and the CI are internal, so on its own it never takes over, or links samples to,
  a node (service or CI) another organization owns. Caveat: `scripts/db-init.sh` runs
  `infrastructure/scripts/init-neo4j.cypher` first, and that script still sets the
  internal organization on every sample-id CI unconditionally (T3a); a tenant CI that
  reuses a deleted sample CI id is moved to the internal organization by a db-init rerun.
- **Existing nodes have no `organization_id` until the backfill runs, so the reads above
  return 404 for them.** The backfill
  `packages/api-server/src/scripts/backfill-business-service-organization.ts` sets
  `organization_id` only on nodes that have none, from the `dim_business_services` row
  with the same `service_id`, and only from rows created before the required
  `--created-before` cutover (use the time migration 008 was applied: tenants choose
  service ids, so a newer row could claim a node that was never theirs). `created_at` has
  no zone, so the required `--writer-timezone` (the API sessions' TimeZone, as a zone
  file name such as `Etc/UTC`) says how to read it; the backfill session's own TimeZone
  plays no part. A name missing from `pg_timezone_names`, a POSIX offset such as `+05`,
  or a name that is also an abbreviation (`UTC`, `EST`, read from the session's
  `timezone_abbreviations`) stops the run before any graph statement. An org-less
  node whose only row is newer stays without an organization and is listed in
  `needs_review`; nodes without a Postgres row stay without an organization (invisible);
  nodes that already have one are never changed. It runs in three separately invoked
  steps, each an FD-7 operator action:
  1. `--prepare` (needs only the `CMDB_BACKFILL_NEO4J_*` variables) creates the
     uniqueness constraint on `:BusinessServiceBackfillIncarnation(uuid)` and, in one
     Neo4j transaction, links every org-less `:BusinessService` that has no anchor to a
     new anchor node with a random UUID (`HAS_BACKFILL_INCARNATION`). It writes no
     organization and prints the `prepared` id/UUID pairs; rerunning it only anchors
     nodes that have none. Anchors are an append-only record: never delete or relink
     them, and do not run two `--prepare`s at once.
  2. The dry run (the default) writes nothing. Save its complete one-line summary to
     a protected file; its `plan` holds every Postgres owner and, per proposed node,
     its id, `elementId` and anchor UUID. Trusted org-less nodes without an anchor are
     listed in `needs_prepare` and are not planned (rerun `--prepare`, then a new dry
     run); a node with more than one anchor stops the run. Review `filled`,
     `needs_review`, `needs_prepare`, `conflicting`, `unmatched`, the plan owners and
     `plan_sha256` independently.
  3. `--apply --plan <file> --sha256 <plan_sha256>` with the same `--created-before`
     and `--writer-timezone`. The digest pins the plan contents, not the operator's
     authorization: do not copy an unreviewed digest from a changed file. Apply
     re-reads every Postgres owner with `SELECT ... FOR SHARE` inside a transaction and
     aborts on any drift from the plan. Then, in one Neo4j transaction, it write-locks
     each planned node and its anchor, rechecks that the node is still linked to the
     planned anchor (exactly one anchor edge on each side), has the planned
     `elementId` and still has no organization, and only then writes the organization.
     Any missing, replaced, changed or duplicated target rolls back the whole graph
     transaction. Postgres locks are held until the graph work completes.

  Why the anchor: Neo4j guarantees an `elementId` only within one transaction and may
  reuse it after a deletion, so id + `elementId` cannot tell the reviewed node from a
  same-id replacement. Deleting a node removes its anchor edge, and a replacement, even
  with every property copied, is not linked to the reviewed anchor (a later
  `--prepare` gives it a new one). This holds while only the application and this
  script write `:BusinessService` nodes: a privileged user who manually relinks an
  anchor to another node is outside what the check proves, so prevent that
  operationally (or escalate) for the whole prepare → review → apply window.
  The databases **do not share an atomic commit**: a process/commit failure after the
  Neo4j commit may leave graph writes even when apply exits with an error. Inspect
  both stores and the saved summary before any retry.
  It connects only through `CMDB_BACKFILL_*` variables (see the script header).
  It trusts `dim_business_services`: `created_at` and `organization_id` are not
  writable through the API, but the PUBLIC grants above let any database role write
  them, so run it only after confirming no non-API role has written to that table.
  Running it against a live database is an operator action (FD-7), not an automatic
  migration. Preserve the prepare, dry-run and apply output as audit evidence.

#### Reversing a mistaken backfill

**There is no automatic safe undo.** The apply summary's `filled` entries (id,
organization, anchor UUID) identify which node incarnation the run wrote, but not
whether the organization it carries now is still the one that run wrote: it can be
changed and restored to the same value. Never run a bulk `REMOVE` selected by
id/org/anchor or by the saved plan. A mistaken apply requires a separately authorized
manual incident action under FD-7:

1. Freeze other business-service writers/backfills and preserve the prepare output,
   dry-run plan, apply output, current graph snapshot (including id, `elementId`,
   anchor UUID, organization and relationships) and current PostgreSQL owner rows.
   Compare every proposed reversal with the pre-apply snapshot and audit history for
   deletion/recreation and organization flips/restores. The apply output alone is
   insufficient evidence.
2. Stop on a missing, duplicated or conflicting node, a changed owner, a node no longer
   linked to the anchor UUID in the apply output, or incomplete provenance; resolve
   each id manually. Only explicitly confirmed unchanged nodes can be individually
   reverted, in a transaction with the anchor edge, current-organization and snapshot
   predicates rechecked at write time. Count each conditional write and
   abort/rollback on any mismatch; do not widen a predicate to make it succeed. If
   provenance cannot be established, leave the property in place and escalate rather
   than stripping another operator's value.
3. Org-less nodes are invisible until a new reviewed dry-run and separately
   authorized apply with corrected parameters. Never reuse the mistaken plan. Leave
   the anchors in place: they are the append-only incarnation record.

### Rolling back migrations 010, 009 and 008

Roll back in reverse order. 010's functions return the views' row types, so 009's
rollback fails while they exist. The 010 rollback drops the functions, restores 009's
view grants (including `SELECT` to PUBLIC) and comments, and deletes its
`cmdb.schema_migrations` row:

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/src/postgres/migrations/rollback/010_business_service_views_org_functions.down.sql
```

009's views depend on `organization_id`, so 008's rollback fails (and changes
nothing) while they exist. The 009 rollback restores the 001 view definitions and
deletes its `cmdb.schema_migrations` row:

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/src/postgres/migrations/rollback/009_business_service_views_org_scope.down.sql
```

API images built before 008 insert business services without `organization_id`, so
every create fails with `23502` while the column exists. Before deploying such an
image, run the manual rollback (no migration runner executes it):

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/src/postgres/migrations/rollback/008_business_service_organization_scope.down.sql
```

It drops the index and the column, which discards every organization assignment,
and deletes the `cmdb.schema_migrations` row so 008 applies again later. Re-applying
008 puts all services back in the internal organization. Until the old image is
running, the 008-aware API returns 500 on business-service routes.

### CI dimension (`cmdb.dim_ci`, migration 011)

Every `cmdb.dim_ci` row carries `organization_id` (UUID, `NOT NULL`, no default): the
organization of the `:CI` node it versions.

- Migration `011_ci_organization_scope.sql` backfills every existing row (all SCD
  versions) to the internal organization `00000000-0000-0000-0000-000000000000` (FD-4)
  and marks those rows, and only those, `org_backfilled = TRUE`. No writer sets the
  marker; rows written after 011 are `FALSE`.
- The ETL writers (neo4j-to-postgres, full refresh, sync-cis-to-datamart,
  reconciliation, the ETL processor sync job) and `DataMartClient.upsertCI` write the
  organization explicitly. **No stored row ever changes organization**: a pre-011
  `ci_id` can carry more than one lineage (a CI deleted and its id reused). When a CI
  whose current row is a 011 backfill label has a node naming an organization, the ETL
  writes a **new current version** in that organization, built from the node alone; the
  backfilled history (and its `tbm_attributes`) stays internal, so that organization's
  mapping, `/costs` and cost trends read none of it. Rows labelled internal after 011
  and customer organizations never get a version in another organization, and the
  decision uses no client-writable data (a node's `created_at`, for example, is not
  consulted). A node that conflicts with the stored history (another organization than
  the stored one, outside the backfill case) is skipped and logged: nothing is written
  for it. A CI new to `cmdb.dim_ci` takes its node's organization, or the internal
  organization when the node has none (written by discovery, connectors, ETL or
  reconciliation), as the Neo4j backfill does. An org-less node whose ID matches
  an existing customer CI is skipped and logged, not assigned that customer's
  organization: a reconciliation merge can recreate a deleted customer's ID
  from another organization's supplied attributes. The `postgres-wins`
  reconciliation restore is distinct: it reads the surviving current
  `cmdb.dim_ci` row and stamps that row's organization on the recreated Neo4j
  node. The untrusted merge has no such provenance and stays org-less. A
  conflicting node's stored customer row stays unchanged; only a node naming
  that organization may update it. The full refresh applies the same
  stored-organization rule to any current row it finds (none after its
  truncate, unless another writer has written since; any with
  `truncateTables: false`). A node without an organization never puts a CI in
  a customer organization.
  `neo4j-wins` reconciliation inserts attributes and organization from one
  current-node match, not from separate generations of a reused ID. If that
  node disappears before the match, the conflict remains unresolved and no
  dimension is inserted; its stale attributes are not returned as current.
  Reconciliation auto-resolves a status mismatch only when the node, read in
  one match with its status, is in the current row's organization (an org-less
  node counts as internal). Its PostgreSQL update and Neo4j update are both
  restricted to that organization. A node of another organization reusing the
  ID, including a node naming an organization for a 011-backfilled internal row,
  leaves the conflict unresolved and neither side changes.
- Complete neo4j-to-postgres syncs and full refreshes write relationship facts
  only when both endpoints were resolved from committed CI batches. A
  `ciTypes`-filtered complete sync does not extract the other endpoint of an
  edge to a CI outside its filter. That endpoint is identified by the
  organization the same graph match reads, and its existing current
  `cmdb.dim_ci` row must be in that organization. An endpoint the sync did
  extract always needs a committed identity. Full
  refresh uses per-CI savepoints so a failed dimension does not enter that set.
  One Neo4j match reads each edge and both *current* endpoint IDs and organizations;
  both must match the accepted identities, and the current `cmdb.dim_ci` rows
  must still match those organizations. A node replaced after its dimension
  batch cannot supply an edge under the former customer's `ci_key`. Neo4j and
  PostgreSQL do not share a transaction or global snapshot: an edge changed
  after that graph match cannot become a new edge in its result. This assumes
  untrusted writers cannot stamp another organization's node label; it does
  not protect against a privileged writer deliberately forging that label.
- Concurrent dimension writers recheck the current organization under a
  per-`ci_id` PostgreSQL transaction advisory lock, held through SCD expiry
  and insertion. Those writers are `DataMartClient` (first insert and
  backfill claims), neo4j-to-postgres, sync-cis-to-datamart, the full refresh
  and the `neo4j-wins` reconciliation insert. Each ETL batch takes all of its
  locks before reading any current row, once per lock key and in ascending key
  order. Batches that share a CI, or a lock key (two ids can share a
  `hashtext` key), still wait for each other, but never in a cycle, so they
  do not deadlock. Two writers that see different organizations for the same
  CI cannot both replace its current version, nor both write its first one:
  the second re-reads the first's version and refuses it as a conflict (the
  reconciliation insert and `DataMartClient`'s first insert refuse any
  current row). The old costs stay in the original version. Residual: the
  reconciliation status update (an in-place update restricted to the row's
  organization), the complete-sync marker clear and `DataMartClient`'s
  unchanged-CI marker clear take no lock. These only clear a marker or change
  a status within its organization, but `DataMartClient` can return the key of
  a version a concurrent writer has just retired.
- Availability residual (no cross-organization write): one CI node's
  client-writable values can still fail a whole ETL batch, which holds CIs of
  every organization. sync-cis-to-datamart writes a node's `metadata` string to
  a JSONB column unparsed, so non-JSON metadata fails its batch of up to 100
  CIs on every run; neo4j-to-postgres writes `metadata.discovery_method` and
  `discovery_source` to `VARCHAR(50)` discovery facts, so a longer value fails
  its batch. Those CIs' dimensions, and with them mapping, `/costs` and trends,
  stay stale until the node is repaired.
- The dimension writers that read CIs from Neo4j (neo4j-to-postgres,
  sync-cis-to-datamart, full refresh, reconciliation) identify a CI's
  `cmdb.dim_ci` history only by its node's unique `id`, and only when that
  `id` is stored and compared unchanged as a `ci_id`: a non-empty string of at
  most 100 characters, without NUL or an unpaired surrogate. Other nodes, and
  other `ciIds` given to a reconciliation job, are skipped and logged before
  any lock or read; a reconciliation write also requires the node it reads to
  carry exactly that `id`. A reconciliation merge can set a node's `id` to a
  number such as `12345`, which Neo4j keeps apart from the string `'12345'`
  but PostgreSQL would read as the same `ci_id`; `VARCHAR(100)` silently
  drops trailing spaces past 100 characters; UTF-8 encoding turns an unpaired
  surrogate into U+FFFD. sync-cis-to-datamart ignores any `ci_id` node
  property: a merge can copy one onto a node of another organization, or of
  none, and must not claim or end a backfilled CI's history through it.
- **Rollout:** CIs created in a customer organization through `POST /api/v1/cis` and
  synced before 011 are backfilled to the internal organization. Right after applying
  011, run a complete neo4j-to-postgres sync (no `incrementalSince`, no `ciTypes`) so
  every such CI gets its new version in its node's organization. That run clears the
  backfill marker of every CI without a live node, even when some batches fail, so a
  node created later with such an id cannot take the backfilled CI over. CIs whose batch
  failed keep their marker until a later run processes them. A node whose `metadata`
  property is not JSON (a reconciliation merge can store one) is skipped and logged by
  neo4j-to-postgres and the full refresh; it still counts as live, so its CI keeps its
  marker until the node is readable. Until a run completes, the internal organization
  can map those CIs; such mapping rows stay listed by `GET /:id/cis` afterwards but add
  nothing to `/costs`.
- `POST /api/v1/cis` rejects an `id` longer than 100 characters or an `external_id`
  longer than 200 (the `cmdb.dim_ci` column widths) with **400**, so no CI that can never
  be synced is created.
- `POST /api/v1/itil/baselines/:id/restore` never writes a CI's `created_at` (nor its
  `organization_id`, `id` or `updated_at`) from a snapshot.
- `POST /api/v1/business-services/:id/cis` maps only CIs with a current `cmdb.dim_ci`
  row in the service's organization. A CI of another organization, or one with no
  current row (for example not yet synced by the ETL), returns **404**
  `{"success":false,"error":"CI not found"}` and nothing is written, including the
  other CIs in the request and an update of an existing mapping.
- `GET /api/v1/business-services/:id/costs` counts only the caller organization's
  current `cmdb.dim_ci` rows: a mapping row that names another organization's CI adds
  nothing to `ci_count`, `total_monthly_cost` or `cost_by_tower`.
- `GET /api/v1/tbm/costs/trends` and GraphQL `costTrends` (both admin-only) sum only
  the caller organization's CIs. GraphQL `costTrends` now reads `cmdb.dim_ci`, like
  REST.
- Not covered: `/api/v1/analytics` still reads `cmdb.dim_ci` across organizations.

ETL (`etl-processor`) images built before 011, and any other `cmdb.dim_ci` writer
(`DataMartClient`, `PostgresClient`) of that age, insert rows without `organization_id`,
so every insert fails with `23502` while the column exists. Before deploying such an
image, run the manual rollback (no migration runner executes it). The API does not
write `cmdb.dim_ci`: an API image older than 011 runs against the 011 schema without
the rollback (but without 011's CI tenancy checks).

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/src/postgres/migrations/rollback/011_ci_organization_scope.down.sql
```

It drops the indexes and the columns, which discards every CI's organization, and
deletes the `cmdb.schema_migrations` row so 011 applies again later (all rows back in
the internal organization, marked backfilled, until a complete neo4j-to-postgres sync
writes new versions in their nodes' organizations). Until the old
images are running, the 011-aware API returns 500 on CI mapping, service costs and cost
trends, and the 011-aware ETL fails its `cmdb.dim_ci` reads and writes.

### Configuration items (`/api/v1/cis` and GraphQL CI operations)

Neo4j `:CI` nodes carry an `organization_id` property, set only from the token's
organization when a CI is created through `POST /api/v1/cis` or GraphQL `createCI`.

- Every `/api/v1/cis/**` route returns **403** `{"_error":"Forbidden","_message":"Organization claim required"}`
  without an organization claim, before any Neo4j query.
- List, search, read, update, delete, relationships, dependencies, impact and audit
  history only match CIs whose `organization_id` equals the tenant. Another
  organization's CI returns the same **404** body as a missing one
  (`{"success":false,"error":"Not Found","message":"CI not found"}`), and a foreign
  `DELETE` deletes nothing. Relationship, dependency and impact traversals only
  follow paths whose every node belongs to the tenant.
- `organization_id` in a create or update body is rejected with **400**.
- CI ids (and `external_id`s) are unique across all organizations: creating a CI
  with an id another organization uses returns **409**, which reveals that the id exists.
- CIs written by discovery, connectors, ETL and reconciliation carry no
  `organization_id` and are invisible to every organization through `/api/v1/cis`,
  `/api/v1/dashboards` and the GraphQL CI operations.
- No writer copies `organization_id` from request or stored data onto a CI: the
  reconciliation merge and create (`/api/v1/reconciliation/merge`, GraphQL
  `_reconciliation { mergeCI }`) drop it from `attributes`/`identifiers`, and an ITIL
  baseline restore skips it. A merge or restore never changes a CI's organization.
- GraphQL `getCIs`, `getCI`, `searchCIs`, `getCIRelationships`, `getCIDependencies`,
  `getImpactAnalysis`, the CI `_relationships`/`_dependents`/`_dependencies` fields,
  `createCI`, `updateCI`, `deleteCI`, `createRelationship` and `deleteRelationship`
  apply the same rules. Without an organization claim they return `FORBIDDEN`
  (`Organization claim required`) before any Neo4j query. A foreign CI reads as
  `null` from `getCI`, like a missing one. `getCIRelationships`, `getCIDependencies`,
  `getImpactAnalysis`, `updateCI`, `deleteCI` and `createRelationship` on a foreign
  or missing CI return `NOT_FOUND` (`CI not found`, like the REST 404) and write
  nothing, so a relationship can only link two CIs of the caller's organization;
  `deleteRelationship` across organizations returns `NOT_FOUND`
  (`Relationship not found`), like a missing relationship. `createCI` takes the
  organization only from the token (`CreateCIInput` has no organization field) and
  `updateCI` cannot change it. Unlike REST, GraphQL `createCI` assigns the CI id
  itself and accepts no `_id` or `_externalId`, so it cannot be used to test whether
  another organization uses an id or external id. The per-request dataloaders key
  their cache by organization and CI id.
- **Not yet tenant-scoped.** Only `/api/v1/cis/**`, `/api/v1/dashboards/**` and the
  GraphQL CI operations above are scoped. Until the later slices land, every other
  route and GraphQL resolver that touches CIs can still read other tenants' CIs, and
  some can modify or delete them:
  - REST `/api/v1/relationships`;
  - ITIL writes to CI properties by id: `/api/v1/itil/configuration-items/:id/lifecycle`,
    `/:id/status`, `/:id/audit` and `/:id/audit/complete`, plus
    `/api/v1/itil/baselines/:id/restore`;
  - `/api/v1/reconciliation/match` and `/merge`, and GraphQL `_reconciliation { mergeCI }`:
    matching runs across all organizations, and merge overwrites the matched CI's
    attributes even when it belongs to another organization (but not its
    `organization_id`);
  - `/api/v1/search/*`;
  - `/api/v1/drift` and `/api/v1/impact`, which look CIs up without an organization filter;
  - analytics and TBM CI reads, which return individual CIs as well as aggregates.
- The sample CIs seeded by `db-init` (`infrastructure/scripts/init-neo4j.cypher`) and by
  `infrastructure/scripts/seed-data.ts` are in the internal organization, the seeded
  admin's. Other existing CIs stay invisible until backfilled. The backfill is not run
  automatically. It assigns every CI without `organization_id` to the internal
  organization `00000000-0000-0000-0000-000000000000` and is idempotent:

```bash
cypher-shell -a bolt://<host>:7687 -u <user> -f packages/database/src/neo4j/migrations/001_ci_organization_backfill.cypher
```

### Tenant fixture seed (acceptance testing, scratch databases only)

`packages/api-server/src/scripts/seed-tenant-fixture.ts` prepares a **scratch** CMDB
for tenant-scoping acceptance tests (the CO-1 runner). The api-server image build does not
compile it (`tsconfig.json` excludes `src/scripts`), and it has its own build. The runtime
image still ships the `.ts` source and a TypeScript toolchain, so the guards below, not
packaging, are what keep it away from real databases. It:

1. claims the PostgreSQL database (`cmdb.tenant_fixture_marker` table) and the Neo4j
   graph (`(:TenantFixtureMarker)` node) as tenant-fixture scratch stores;
2. runs the PostgreSQL migrations;
3. upserts an active and an inactive business service owned by `--organization-id`,
   and an active one owned by `--other-organization-id`;
4. upserts two enabled `viewer` users: `--service-user` with that organization,
   and `--no-org-user` with none.

It fails closed before connecting to anything:

- `--target scratch` is required.
- `NODE_ENV=production` is refused.
- Connections come only from the dedicated variables `CMDB_SEED_POSTGRES_HOST/PORT/DB/USER/PASSWORD`
  and `CMDB_SEED_NEO4J_URI/USERNAME/PASSWORD`, never from the api-server's `POSTGRES_*` or `NEO4J_*`.
  Both hosts must be loopback (`127.0.0.1`, `::1`, `localhost`). Neo4j must be a direct
  `bolt://host[:port]` URI: routing schemes (`neo4j://`, `neo4j+s://`, `bolt+routing://`)
  are refused, because a routing driver connects to server-advertised addresses the
  loopback check never sees.
- It opens no Redis connection.

Before writing, it refuses a PostgreSQL database that has tables but no marker, and a graph
that has nodes but no marker. It only ever modifies services (`metadata.tenant_fixture`) and
users (`_tenantFixture`) that it created itself, in the same organization. Any other existing
service id or username is refused and left untouched. The internal organization
`00000000-0000-0000-0000-000000000000` is refused for both organizations.

Passwords come only from `CMDB_SEED_SERVICE_USER_PASSWORD` and
`CMDB_SEED_NO_ORG_USER_PASSWORD` (at least 8 characters). They are stored as bcrypt
hashes and never printed. Tokens come from `POST /api/v1/auth/login`. Usernames must
pass the login schema (alphanumeric, 3–30 characters).

```bash
npm run build:tenant-fixture --workspace=packages/api-server
CMDB_SEED_POSTGRES_HOST=127.0.0.1 CMDB_SEED_POSTGRES_PORT=5432 CMDB_SEED_POSTGRES_DB=cmdb_scratch \
CMDB_SEED_POSTGRES_USER=... CMDB_SEED_POSTGRES_PASSWORD=... \
CMDB_SEED_NEO4J_URI=bolt://127.0.0.1:7687 CMDB_SEED_NEO4J_USERNAME=neo4j CMDB_SEED_NEO4J_PASSWORD=... \
CMDB_SEED_SERVICE_USER_PASSWORD=... CMDB_SEED_NO_ORG_USER_PASSWORD=... \
node packages/api-server/dist/tenant-fixture/api-server/src/scripts/seed-tenant-fixture.js --target scratch \
  --organization-id 6f1c2a9e-4b7d-4e2a-9c31-8d5e0f7a2b64 --service-id bs-fulfillment \
  --inactive-service-id bs-retired --other-organization-id 0d9b4e17-3c62-4f88-a5d1-72e9c4b6f305 \
  --other-service-id bs-foreign --service-user hiveservice --no-org-user noorguser
```

Re-running converges to the same state and re-hashes the passwords. stdout carries
exactly one JSON line naming what was seeded, and every log line goes to stderr.
Migration 001 needs the `timescaledb` and `uuid-ossp` extensions, so the target
PostgreSQL must provide them.

## Backend JWT Middleware

### Express Middleware

```typescript
import jwt from 'jsonwebtoken';

export const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Role-based middleware
export const requireRole = (roles: string[]) => {
  return (req, res, next) => {
    if (!req.user || !roles.some(role => req.user.roles.includes(role))) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
};
```

## Testing the Authentication Flow

### Manual Testing Steps

1. **Test Login**:
   - Navigate to `/login`
   - Enter credentials
   - Verify redirect to dashboard
   - Verify token in localStorage

2. **Test Protected Routes**:
   - Clear localStorage
   - Try accessing `/settings`
   - Verify redirect to `/login`

3. **Test Role-Based Access**:
   - Login as viewer
   - Try accessing Settings > Database tab
   - Verify tab is hidden

4. **Test Logout**:
   - Click user menu > Logout
   - Verify redirect to `/login`
   - Verify token removed from localStorage

5. **Test Token Expiration**:
   - Generate expired token
   - Make API request
   - Verify auto-logout and redirect

### Unit Test Example

```typescript
import { renderHook, act } from '@testing-library/react';
import { useAuth } from './hooks/useAuth';

describe('useAuth', () => {
  it('should login successfully', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.login({
        email: 'admin@example.com',
        password: 'password123',
      });
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.email).toBe('admin@example.com');
  });
});
```

## Common Issues and Solutions

### Issue: Token not being sent with requests
**Solution**: Ensure axios interceptor is configured in auth.service.ts

### Issue: Infinite redirect loop
**Solution**: Check that Login page doesn't require authentication

### Issue: 401 errors after token expires
**Solution**: Token expiration is handled automatically, ensure backend JWT exp is set correctly

### Issue: Role-based access not working
**Solution**: Verify JWT payload includes roles array

## Security Best Practices

1. **Always use HTTPS in production**
2. **Set JWT expiration time (recommended: 1 hour)**
3. **Implement refresh token mechanism** (future enhancement)
4. **Never log tokens in production**
5. **Validate all inputs on backend**
6. **Use secure password hashing (bcrypt)**
7. **Implement rate limiting on login endpoint**
8. **Add CSRF protection if needed**

## Quick Start Checklist

- [ ] Add Login and Settings routes to App.tsx
- [ ] Add UserMenu to app header
- [ ] Wrap protected routes with ProtectedRoute
- [ ] Set VITE_API_URL in .env
- [ ] Implement backend auth endpoints
- [ ] Generate JWT tokens with correct payload
- [ ] Add JWT authentication middleware
- [ ] Test login/logout flow
- [ ] Test role-based access
- [ ] Test token expiration handling

## Example: Complete Authentication Flow

### Frontend Login Component

```tsx
import React from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '@hooks/useAuth';
import { Box, TextField, Button, Card } from '@mui/material';

export const Login: React.FC = () => {
  const { login } = useAuth();
  const { register, handleSubmit, formState: { errors } } = useForm();

  const onSubmit = async (data: any) => {
    try {
      await login(data.email, data.password);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Card sx={{ p: 4, maxWidth: 400, width: '100%' }}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <TextField
            fullWidth
            label="Email"
            margin="normal"
            {...register('email', { required: 'Email is required' })}
            error={!!errors.email}
            helperText={errors.email?.message}
          />
          <TextField
            fullWidth
            label="Password"
            type="password"
            margin="normal"
            {...register('password', { required: 'Password is required' })}
            error={!!errors.password}
            helperText={errors.password?.message}
          />
          <Button type="submit" variant="contained" fullWidth sx={{ mt: 2 }}>
            Login
          </Button>
        </form>
      </Card>
    </Box>
  );
};
```

### Backend Login Endpoint

```typescript
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user in database
    const user = await db.users.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        roles: user.roles,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
```

## See Also

- [Web UI Guide](/components/web-ui)
- [Configuration Reference](/configuration/environment-variables)
- [Security Best Practices](/guides/security)
