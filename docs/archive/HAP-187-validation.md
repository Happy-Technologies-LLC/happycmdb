# HAP-187 validation evidence

STATUS: IMPLEMENTATION ONLY — NO COMMAND HAS BEEN RUN; parent releases validation in a later continuation.

Every test and command below is UNRUN. No output in this file has been observed.

- Linear: HAP-187 (parent HAP-94, "Now — Minimum service-context contract").
- Base: `ade7f70bee55d496f0e02b4d33188b8ff7d62329` (main).
  - `HEAD:packages/api-server/src/rest/controllers/business-service.controller.ts` = `1d19f63c0eeb77edae4dbbbac6171083b1f1ff24` (confirmed with `git rev-parse` before editing).
  - `HEAD:packages/api-server/src/rest/routes/business-service.routes.ts` = `c5d1d0e3251cd6dc82f81f8db1e8e19372c43d45` (confirmed).

## Change

`GET /api/v1/business-services/:service_id/health` and `/costs` returned 200 for a nonexistent service, because
ungrouped aggregates always return one row. Both are now one parameterized statement rooted at
`dim_business_services`. Zero rows means an unknown service: 404 `{ success: false, error: 'Business service not found' }`.
This is the HAP-172 pattern (`getMappedCIs`, `getServiceDependencies`).

- `/health`: `dim_business_services s CROSS JOIN LATERAL (<incident aggregates>) i CROSS JOIN LATERAL (<change aggregates>) c WHERE s.service_id = $1`.
  The metric expressions are byte-for-byte unchanged. The response is built explicitly in the previous key order.
- `/costs`: the first CTE is `parent`; `ci_costs` is rooted at `parent p JOIN ci_business_service_mappings m`; the final SELECT reads
  `FROM parent`. The unreachable `|| { ci_count: 0, ... }` fallback was removed.
- DB errors still go through the existing catch and return 500 with `{success:false, error, message}`. Auth is unchanged.

### Out of scope (pre-existing, deliberately preserved)

- `incidents_7d` / `incidents_30d` use `COUNT(*)` over daily fact rows, not `SUM(incident_count)`.
- `success_rate_30d` has no date filter, so it is an all-time ratio.
- Costs are summed once per mapping row, so a CI mapped under several `mapping_type`s is counted more than once in totals (no dedup).

### Files changed

- `packages/api-server/src/rest/controllers/business-service.controller.ts`: `getServiceHealth` and `getServiceCosts` only.
- `packages/api-server/src/rest/routes/business-service.routes.ts`: JSDoc `@desc` for `/health` and `/costs` only.
- `packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts`: DDL extraction extended (two fact
  tables and `cmdb.dim_ci`, with a `cmdb` schema prefix), seed, new `business-service metric reads` describe block. The
  `beforeAll`/`afterAll` hooks were moved to file scope so the PGlite host is not killed before the second block. The cis and
  dependencies tests are otherwise unchanged.
- `docs/archive/HAP-187-validation.md` (this file).

OpenAPI: `packages/api-server/src/openapi/` has no business-services `/health` or `/costs` path entry (grep found no matches), so nothing was added.

### Consumers (read-only grep of `web-ui/src`, `packages/`)

None found. No caller of `business-services/:id/health` or `business-services/:id/costs` exists outside the API server itself.
`web-ui/src/pages/BusinessServices.tsx` only calls list/create/patch/delete. The only references are:
- `packages/api-server/src/rest/routes/business-service.routes.ts:236-252` (route wiring, unchanged).
- `packages/api-server/src/rest/routes/__tests__/business-service.routes.test.ts:105-106`: an auth/route matrix using
  `bs-web`. That file is not modified. It asserts against `mockRouteHandler` (the controller is mocked), so the controller change
  should not affect it [INFERENCE from reading lines 148-173, UNRUN].
- `packages/cli/src/commands/datamart.command.ts:118` calls `/datamart/health`, which is a different endpoint and is unaffected.

No consumer would observe the new 404.

## 1. Focused regression and mounted-route/PGlite smoke (UNRUN)

Jest config was confirmed by reading it: root `jest.config.unit.js`, whose `testMatch` includes `**/packages/**/src/**/__tests__/**/*.test.ts`.

```
npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts \
  > /tmp/hap187-fixed.out 2> /tmp/hap187-fixed.err; echo "EXIT=$?"
```

Expected: every test passes. That means cis/dependencies × 5 cases and health/costs × 6 cases (a–f).

Raw output:

## 2. Baseline-failing proof (UNRUN)

```
cp packages/api-server/src/rest/controllers/business-service.controller.ts /tmp/hap187-fixed-controller.ts
git show ade7f70bee55d496f0e02b4d33188b8ff7d62329:packages/api-server/src/rest/controllers/business-service.controller.ts \
  > packages/api-server/src/rest/controllers/business-service.controller.ts
npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts \
  > /tmp/hap187-baseline.out 2> /tmp/hap187-baseline.err; echo "EXIT=$?"
cp /tmp/hap187-fixed-controller.ts packages/api-server/src/rest/controllers/business-service.controller.ts
git diff --stat
```

Expected on baseline:
- The health and costs cases (a), unknown service → 404, and (f), injection-shaped ids → 404, FAIL, because baseline returns 200.
- (b) empty, (c) populated, (d) anonymous 401, (e) engine failure 500, and every cis/dependencies case PASS.

This split is the payload-preservation proof: the fixed controller returns the same body as baseline for existing services.
After the restore, `git diff --stat` must show the same file set as before the swap.

Raw output:

## 3. Substitutions and limitations

- PostgreSQL: PGlite (WASM) in a forked child process (`fixtures/pglite-host.cjs`). It has no TimescaleDB, so
  `fact_business_service_incidents` and `fact_business_service_changes` are plain tables: only their `CREATE TABLE` blocks are
  extracted from `001_complete_schema.sql`, without `create_hypertable` or indexes.
- User store: `Neo4jAuthRepository` is replaced by an in-memory store with one enabled viewer user.
- JWT: a test-only secret (`JWT_SECRET` set in the test file). The tokens are real `JWTService` tokens, verified by the real `authenticate()`.
- HTTP: supertest against an ephemeral loopback server hosting the real `businessServiceRoutes` at `/api/v1/business-services`.
- Driver serialization [INFERENCE, UNRUN]: int8 is assumed to arrive as a JS number when safe, NUMERIC as a string (`'150.5'`),
  and json parsed into an object. If the run disagrees, adjust only the test expectations, not the controller.
- Limitations: no production PostgreSQL/TimescaleDB and no deployment was exercised.
