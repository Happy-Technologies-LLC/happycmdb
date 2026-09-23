# HAP-172 / PR19 — remaining checklist (resume notes)

Head 396176a controller correction accepted; NOT modified in this slice.

## Done (this slice, uncommitted in worktree)
- Blocker 1: `packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts`
  rewritten: custom `evaluate()` SQL matcher, SQL-text/param-array asserts and the
  duplicate null-row case removed. SQL now executes on PGlite 0.5.8 (real PostgreSQL
  compiled to WASM) hosted in a forked child
  (`__tests__/fixtures/pglite-host.cjs`, IPC with `serialization: 'advanced'`), because
  PGlite's dynamic `import()` fails inside Jest's VM without `--experimental-vm-modules`
  (observed: `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`).
  Schema = the 3 CREATE TABLE statements read verbatim from
  `packages/database/src/postgres/migrations/001_complete_schema.sql`
  (dim_business_services, business_service_dependencies, ci_business_service_mappings);
  no indexes/other tables. Engine failure = real `relation ... does not exist` via
  table rename. Hostile ids: 404 + data intact afterwards (observable only).
- pg-mem 3.0.14 rejected: cannot parse the accepted controller's parenthesized
  `LEFT JOIN (d JOIN s ...) ON` (probe in /tmp, not added to repo).
- Dev dep: `@electric-sql/pglite ^0.5.8` in `packages/api-server/package.json`
  devDependencies (Apache-2.0, zero deps). `package-lock.json` updated by
  `npm install -D ... -w packages/api-server`; npm also synced PRE-EXISTING
  manifest/lock drift (`@cmdb/ai-discovery` in api-server deps, `@types/pg` in
  another workspace's devDeps) — disclose in receipt.
- Focused runs (cmd from repo root:
  `npx jest --config jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts --verbose=false --noStackTrace`):
  - BEFORE (controller from 160c2fe swapped in via cp, then restored; verified
    identical to 396176a): 4 failed / 8 passed, EXIT=1 — only the 404 cases fail
    (payload/order/empty/401/500 match original). Full output:
    `/home/coder/jobs/e84eca77-ce60-4f67-85f2-c7f31578f18b/tmp/before-pglite.txt`
  - AFTER: 12 passed, EXIT=0. Full output: `.../tmp/after-pglite.txt`

## Remaining
1. Blocker 2: throwaway actual-listener smoke (both endpoints): `app.listen(0,'127.0.0.1')`,
   `http.get`, finally `server.close()` + `host.kill()`; scenarios missing404,
   empty200, linked payload/order equal to original, anonymous401 with zero queries,
   engine-failure500 (table rename). Can be a throwaway jest file reusing the same
   PGlite host; delete after capturing full output.
2. Blocker 3: write `/home/coder/jobs/<job_id>/validation.md` (<16KB): smoke evidence
   FIRST, then complete before/after outputs + exits (files above, unfiltered), exact
   commands, fixture/runtime boundary (PGlite = real Postgres engine in WASM, bounded
   3-table production DDL, auth repo substituted, real AuthMiddleware/AuthService/
   JWTService), disclose earlier integration/globalSetup + superseded smoke failures,
   changed-path list: test file, fixtures/pglite-host.cjs, api-server package.json,
   package-lock.json (+ controller/routes from 396176a), consumer findings.
3. Update PR19 body with the same final evidence. Delete this PLAN.md before commit.
