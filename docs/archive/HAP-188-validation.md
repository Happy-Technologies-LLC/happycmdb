# HAP-188 validation — rolling service health totals / 30-day success rate

## 0. Current: approved consumer contract, formula correction, fresh verification (2026-09-27)

**Outcome: consumer correction implemented and verified locally. Draft PR only; independent implementation/security review and exact-head CI are still pending. They are not implied by the exit codes below.**

**Contract (product decision from main, 2026-09-27; supersedes every earlier loader/provenance gate in this lineage).**
`fact_business_service_incidents` / `fact_business_service_changes` are the consumer API's input as DAILY SERVICE/DATE EVENT
COUNTERS: `incident_count` and `change_count` are additive per-day event totals, and `successful_count` is the successful
subset of the same day's `change_count`. This is the intended input/API semantics. It is **not** a factual attestation about
any discovered producer or deployed data. Producer integration, replay/idempotency, source-to-service mapping and timezone
guarantees remain **UNPROVEN** and are not delivered by this consumer-only change. The bounded research in §1 still stands as
research; it no longer gates this change.

**Changed files**

- `packages/api-server/src/rest/controllers/business-service.controller.ts` (`getServiceHealth`): the single parameterized
  statement rooted at `dim_business_services` with two ungrouped `LATERAL` aggregates and `WHERE s.service_id = $1` is kept.
  - `incidents_7d/30d` and `changes_7d/30d`: `COUNT(*) FILTER (...)` → `COALESCE(SUM(incident_count|change_count) FILTER (...), 0)`.
    Cutoffs unchanged (`date >= CURRENT_DATE - INTERVAL '7 days' | '30 days'`, no upper bound). `SUM(int)` is int8 like `COUNT`,
    so driver serialisation is unchanged.
  - `success_rate_30d`: `SUM(successful_count) FILTER (30d)::float / NULLIF(SUM(change_count) FILTER (30d), 0) * 100`.
    Both terms use the same 30-day predicate. The rate is `null` when there is no in-window change volume; it is not coalesced.
  - Unchanged: `avg_mttr_30d` (AVG), `sla_breaches_30d` (SUM), costs, response names/envelopes, 404/401/500 paths, schema,
    migrations, auth.
- `packages/api-server/src/rest/routes/business-service.routes.ts`: route JSDoc (the existing API explanation for this
  endpoint; no doc-site page covers it) states the daily-counter input contract, the unchanged cutoffs and the nullable ratio.
- `packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts`:
  - Seed incidents now carry explicit `incident_count` 3 @ −1d, 7 @ −10d, 200 @ −60d, foreign 900. Expected bs-app health
    moves from the old row-count / all-time expectation (1/2 incidents, 1/2 changes, rate 50) to 3/10 incidents,
    4/10 changes, rate 90. MTTR 60 / SLA 3, children and costs expectations are unchanged.
  - The rate 90 (in-window 9/10) catches a numerator-only bug (all-time 10/10 → 100) and a denominator-only bug (9/20 → 45)
    independently, because the −90d fact is 10/1.
  - New `daily-counter windows` block: distinct counters at 0/−7/−8/−30/−31 days (−7 and −30 in, −8 and −31 out; one row per
    day because the schema is `UNIQUE (service_id, date)`); and zero in-window denominator (an in-window 0/0 row plus
    −31d 100/100 history) → counts 0, rate `null`.
  - The fixture JWT signing secret is now `randomBytes(32)` generated in memory (it was a literal test-only string).
  - Existing 404 / anonymous 401 with zero data queries / engine-error 500 / hostile-ID parameterization cases are kept for
    `/health` and `/costs`.

**Commands and results (this session)**

| Step | Command | Exit | Result |
|---|---|---|---|
| deps | `npm ci --ignore-scripts --no-audit --no-fund` | 0 | first jest attempt exited 1 with `Preset ts-jest not found` (no `node_modules`) |
| pre-fix | `npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts` (updated test, controller at a60ed369) | 1 | 4 failed / 22 passed: health own-metrics + health hostile-ID (received 1/2, 1/2, 50), cutoff test (received 2/4), zero-window test (received 1/1, rate 100) |
| post-fix | same command | 0 | 26 passed / 26 |
| listener smoke | `node hap188-listener-probe.cjs > out 2> err` (throwaway, deleted after run) | 0 | `SUMMARY 10/10 pass`; stderr empty |

An intermediate pre-fix run of my own also failed the two `/dependencies` child tests, because an edit had dropped the
dependencies seed rows. The seed was restored before the recorded pre-fix run above, and the children suites pass there.

**Historical vs corrected (original fixture, bs-app).** Historical observation at a60ed369 (§2.2 phase A, pre-fix controller):
changes 1/2, rate 50 (row counts, all-time ratio). Corrected on the same original seed: changes 4/10, rate 90. With meaningful
incident counters (phase B), incidents are 3/10 (historically 1/2).

**Listener smoke substitutions (disclosed):** in-process PGlite for PostgreSQL, using the `CREATE TABLE` blocks extracted from
`001_complete_schema.sql` (no TimescaleDB, so the fact tables are plain tables, not hypertables); `Neo4jAuthRepository` →
in-memory single viewer user; `bcrypt` → empty stub (unused by JWT verification). Real Express + `businessServiceRoutes` +
AuthMiddleware/JWTService on `app.listen(0, '127.0.0.1')`, requests via real `fetch`. JWT secret and token are generated in
memory per run and never printed. No production or live data was accessed.

Redaction: bearer tokens / JWTs / secrets in every captured log below are replaced with `<redacted>`. None were present
in these outputs (checked with `grep -E "eyJ|Bearer [A-Za-z0-9]"`, 0 matches).

### 0.1 Pre-fix Jest run (updated test vs a60ed369 controller), EXIT=1

```
2026-09-27 10:21:55 [undefined] [31merror[39m: Error getting mapped CIs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-27T10:21:55.745Z"}}
2026-09-27 10:21:55 [undefined] [31merror[39m: Error getting service dependencies {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-27T10:21:55.834Z"}}
2026-09-27 10:21:55 [undefined] [31merror[39m: Error getting service health {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-27T10:21:55.924Z"}}
2026-09-27 10:21:56 [undefined] [31merror[39m: Error getting service costs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-27T10:21:56.004Z"}}
FAIL UNIT packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
  business-service child reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/cis
      ✓ returns 404 with the parent envelope for an unknown service (36 ms)
      ✓ returns 200 with data [] for an existing service without children (15 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (15 ms)
      ✓ rejects anonymous requests with 401 before any data access (12 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (17 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (20 ms)
    GET /api/v1/business-services/:service_id/dependencies
      ✓ returns 404 with the parent envelope for an unknown service (15 ms)
      ✓ returns 200 with data [] for an existing service without children (15 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (12 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (14 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (16 ms)
  business-service metric reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/health
      ✓ returns 404 with the parent envelope for an unknown service (13 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (14 ms)
      ✕ returns only the service's own metrics with the pre-change expressions (18 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (15 ms)
      ✕ treats injection-shaped ids as unknown services and leaves data intact (18 ms)
    GET /api/v1/business-services/:service_id/costs
      ✓ returns 404 with the parent envelope for an unknown service (13 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (12 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (10 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (13 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (18 ms)
  business-service health: daily-counter windows (PGlite)
    ✕ sums multi-event day counters, including day -7/-30 and excluding day -8/-31 (17 ms)
    ✕ returns a null rate when the 30-day window has no changes, despite older facts (15 ms)

  ● business-service metric reads: missing-parent semantics (PGlite) › GET /api/v1/business-services/:service_id/health › returns only the service's own metrics with the pre-change expressions

    expect(received).toEqual(expected) // deep equality

    - Expected  - 5
    + Received  + 5

      Object {
        "data": Object {
          "changes": Object {
    -       "changes_30d": 10,
    -       "changes_7d": 4,
    -       "success_rate_30d": 90,
    +       "changes_30d": 2,
    +       "changes_7d": 1,
    +       "success_rate_30d": 50,
          },
          "incidents": Object {
            "avg_mttr_30d": 60,
    -       "incidents_30d": 10,
    -       "incidents_7d": 3,
    +       "incidents_30d": 2,
    +       "incidents_7d": 1,
            "sla_breaches_30d": 3,
          },
        },
        "success": true,
      }

      279 |
      280 | describe('business-service metric reads: missing-parent semantics (PGlite)', () => {
    > 281 |   const app = buildApp();
          |                          ^
      282 |   const token = new JWTService(loadConfig().auth.jwt).generateAccessToken(VIEWER_ID, 'viewer', 'viewer');
      283 |   const auth = { Authorization: `Bearer ${token}` };
      284 |

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts:281:30)

  ● business-service metric reads: missing-parent semantics (PGlite) › GET /api/v1/business-services/:service_id/health › treats injection-shaped ids as unknown services and leaves data intact

    expect(received).toEqual(expected) // deep equality

    - Expected  - 5
    + Received  + 5

      Object {
        "data": Object {
          "changes": Object {
    -       "changes_30d": 10,
    -       "changes_7d": 4,
    -       "success_rate_30d": 90,
    +       "changes_30d": 2,
    +       "changes_7d": 1,
    +       "success_rate_30d": 50,
          },
          "incidents": Object {
            "avg_mttr_30d": 60,
    -       "incidents_30d": 10,
    -       "incidents_7d": 3,
    +       "incidents_30d": 2,
    +       "incidents_7d": 1,
            "sla_breaches_30d": 3,
          },
        },
        "success": true,
      }

      307 |     });
      308 |
    > 309 |     it('rejects anonymous requests with 401 before any data access', async () => {
          |                              ^
      310 |       const res = await request(app).get(`/api/v1/business-services/bs-app/${metric}`);
      311 |       expect(res.status).toBe(401);
      312 |       expect(queryCount).toBe(0);

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts:309:30)

  ● business-service health: daily-counter windows (PGlite) › sums multi-event day counters, including day -7/-30 and excluding day -8/-31

    expect(received).toMatchObject(expected)

    - Expected  - 2
    + Received  + 2

      Object {
    -   "incidents_30d": 32,
    -   "incidents_7d": 8,
    +   "incidents_30d": 4,
    +   "incidents_7d": 2,
      }

      334 |       }
      335 |       const res = await request(app).get(`/api/v1/business-services/bs-app/${metric}`).set(auth);
    > 336 |       expect(res.body).toEqual({ success: true, data: APP_METRICS[metric] });
          |                                ^
      337 |     });
      338 |   });
      339 | });

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts:336:32)

  ● business-service health: daily-counter windows (PGlite) › returns a null rate when the 30-day window has no changes, despite older facts

    expect(received).toEqual(expected) // deep equality

    - Expected  - 3
    + Received  + 3

    @@ -1,10 +1,10 @@
      Object {
        "changes": Object {
    -     "changes_30d": 0,
    -     "changes_7d": 0,
    -     "success_rate_30d": null,
    +     "changes_30d": 1,
    +     "changes_7d": 1,
    +     "success_rate_30d": 100,
        },
        "incidents": Object {
          "avg_mttr_30d": null,
          "incidents_30d": 0,
          "incidents_7d": 0,

      344 |   const auth = { Authorization: `Bearer ${token}` };
      345 |   const health = async (serviceId: string) => {
    > 346 |     const res = await request(app).get(`/api/v1/business-services/${serviceId}/health`).set(auth);
          |                                        ^
      347 |     expect(res.status).toBe(200);
      348 |     return res.body.data;
      349 |   };

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts:346:40)

Test Suites: 1 failed, 1 total
Tests:       4 failed, 22 passed, 26 total
Snapshots:   0 total
Time:        2.732 s, estimated 3 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/business-service-child-reads.test.ts/i.
```

### 0.2 Post-fix Jest run, EXIT=0

```
2026-09-27 10:22:09 [undefined] [31merror[39m: Error getting mapped CIs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-27T10:22:09.203Z"}}
2026-09-27 10:22:09 [undefined] [31merror[39m: Error getting service dependencies {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-27T10:22:09.290Z"}}
2026-09-27 10:22:09 [undefined] [31merror[39m: Error getting service health {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-27T10:22:09.375Z"}}
2026-09-27 10:22:09 [undefined] [31merror[39m: Error getting service costs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-27T10:22:09.460Z"}}
PASS UNIT packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
  business-service child reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/cis
      ✓ returns 404 with the parent envelope for an unknown service (35 ms)
      ✓ returns 200 with data [] for an existing service without children (15 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (16 ms)
      ✓ rejects anonymous requests with 401 before any data access (13 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (21 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (19 ms)
    GET /api/v1/business-services/:service_id/dependencies
      ✓ returns 404 with the parent envelope for an unknown service (14 ms)
      ✓ returns 200 with data [] for an existing service without children (14 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (13 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (14 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (18 ms)
  business-service metric reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/health
      ✓ returns 404 with the parent envelope for an unknown service (15 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (14 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (10 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (14 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (18 ms)
    GET /api/v1/business-services/:service_id/costs
      ✓ returns 404 with the parent envelope for an unknown service (14 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (14 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (16 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (19 ms)
  business-service health: daily-counter windows (PGlite)
    ✓ sums multi-event day counters, including day -7/-30 and excluding day -8/-31 (14 ms)
    ✓ returns a null rate when the 30-day window has no changes, despite older facts (14 ms)

Test Suites: 1 passed, 1 total
Tests:       26 passed, 26 total
Snapshots:   0 total
Time:        2.622 s, estimated 3 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/business-service-child-reads.test.ts/i.
```

### 0.3 Post-fix standalone listener smoke, EXIT=0

```
$ node hap188-listener-probe.cjs > /tmp/h188.out 2> /tmp/h188.err; echo EXIT=$?
EXIT=0
--- stdout ---
listener bound 127.0.0.1:40549 (app.listen(0, "127.0.0.1"))
--- phase A: original seed (changes 4/3 -2d, 6/6 -20d, 10/1 -90d; incident_count DEFAULT 0) ---
A: GET /api/v1/business-services/bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":4,"changes_30d":10,"success_rate_30d":90}}}
PASS A bs-app changes 4/10 rate 90 (historical baseline observed 1/2/50); incidents 0/0 (counters default 0); mttr 60 sla 3; 1 query
--- phase B: meaningful incident counters (3/-1d, 7/-10d, 200/-60d; bs-other 900; bs-db 0/0 -5d, 50/5 -60d) ---
B: GET /api/v1/business-services/bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":3,"incidents_30d":10,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":4,"changes_30d":10,"success_rate_30d":90}}}
B: GET /api/v1/business-services/bs-empty/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":null,"sla_breaches_30d":null},"changes":{"changes_7d":0,"changes_30d":0,"success_rate_30d":null}}}
B: GET /api/v1/business-services/bs-db/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":null,"sla_breaches_30d":null},"changes":{"changes_7d":0,"changes_30d":0,"success_rate_30d":null}}}
B: GET /api/v1/business-services/bs-missing/health -> 404 queries=1 {"success":false,"error":"Business service not found"}
B: GET /api/v1/business-services/bs-app/health (anonymous) -> 401 queries=0 {"_error":"Unauthorized","_message":"No authentication credentials provided"}
PASS B bs-app incidents 3/10 mttr 60 sla 3; changes 4/10 rate 90; 1 query
PASS B bs-empty 200 zero counts / null mttr, sla, rate
PASS B bs-db zero in-window denominator (0/0 -5d) with historical 50/5 -60d -> changes 0/0 rate null
PASS B bs-missing 404 envelope, 1 query
PASS B anonymous 401, 0 data queries
--- phase C: + old high-volume low-success bs-app fact (-120d, 1000/1) ---
C: GET /api/v1/business-services/bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":3,"incidents_30d":10,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":4,"changes_30d":10,"success_rate_30d":90}}}
PASS C old fact leaves bs-app metrics (incl. rate 90) unchanged vs B
--- phase D: + foreign bs-other facts (incidents 500 -2d, changes 500/500 -1d) ---
D: GET /api/v1/business-services/bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":3,"incidents_30d":10,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":4,"changes_30d":10,"success_rate_30d":90}}}
PASS D foreign facts leave bs-app unchanged vs C
--- phase E: exact cutoffs on bs-net (-7:1, -8:2, -30:4, -31:8; changes success 1,2,0,8) ---
E: GET /api/v1/business-services/bs-net/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":7,"avg_mttr_30d":20,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":7,"success_rate_30d":42.857142857142854}}}
PASS E incidents 7d=1 (-7 in, -8 out) 30d=7 (-30 in, -31 out); changes 1/7; rate 3/7*100
--- phase F: genuine database error (fact_business_service_changes dropped) ---
2026-09-27 10:22:58 [undefined] [31merror[39m: Error getting service health {"metadata":{"service":"cmdb","error":{"length":130,"name":"error","severity":"ERROR","code":"42P01","position":"1351","file":"parse_relation.c","line":"1469","routine":"parserOpenTable","query":"SELECT i.incidents_7d, i.incidents_30d, i.avg_mttr_30d, i.sla_breaches_30d,\n          c.changes_7d, c.changes_30d, c.success_rate_30d\n        FROM dim_business_services s\n        CROSS JOIN LATERAL (\n          SELECT\n            COALESCE(SUM(incident_count) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '7 days'), 0) as incidents_7d,\n            COALESCE(SUM(incident_count) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days'), 0) as incidents_30d,\n            AVG(mttr_minutes) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days') as avg_mttr_30d,\n            SUM(sla_breaches) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days') as sla_breaches_30d\n          FROM fact_business_service_incidents\n          WHERE service_id = s.service_id\n        ) i\n        CROSS JOIN LATERAL (\n          SELECT\n            COALESCE(SUM(change_count) FILTER (WHERE change_date >= CURRENT_DATE - INTERVAL '7 days'), 0) as changes_7d,\n            COALESCE(SUM(change_count) FILTER (WHERE change_date >= CURRENT_DATE - INTERVAL '30 days'), 0) as changes_30d,\n            (SUM(successful_count) FILTER (WHERE change_date >= CURRENT_DATE - INTERVAL '30 days'))::float\n              / NULLIF(SUM(change_count) FILTER (WHERE change_date >= CURRENT_DATE - INTERVAL '30 days'), 0) * 100 as success_rate_30d\n          FROM fact_business_service_changes\n          WHERE service_id = s.service_id\n        ) c\n        WHERE s.service_id = $1","params":["bs-app"]},"service_id":"bs-app","timestamp":"2026-09-27T10:22:58.420Z"}}
F: GET /api/v1/business-services/bs-app/health -> 500 queries=1 {"success":false,"error":"Failed to get service health metrics","message":"relation \"fact_business_service_changes\" does not exist"}
PASS F 500 envelope with relation error
SUMMARY 10/10 pass
--- stderr (0 bytes) ---
```

Probe source (as run; throwaway, deleted after the run, never committed; contains no secrets):

```js
// THROWAWAY (HAP-188 post-fix listener probe). Deleted after the run; never committed.
// Real Express + businessServiceRoutes + AuthMiddleware/AuthService/JWTService on 127.0.0.1:<ephemeral>,
// real HTTP via fetch, SQL executed by in-process PGlite with CREATE TABLE blocks extracted from
// 001_complete_schema.sql. Substitutions: PGlite for PostgreSQL (no TimescaleDB => plain tables);
// Neo4jAuthRepository -> in-memory single viewer user; bcrypt -> empty stub (unused by JWT verify);
// JWT secret + token generated in memory per run and never printed.
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ts = require('typescript');

const ROOT = __dirname;
Object.assign(process.env, {
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused', LOG_LEVEL: 'error',
});

require.extensions['.ts'] = (m, file) => {
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: false },
  });
  m._compile(out.outputText, file);
};

let db; let queryCount = 0;
const pgClient = { query: async (sql, params = []) => { queryCount++; return { rows: (await db.query(sql, params)).rows }; } };
const VIEWER_ID = 'viewer-user-1';
const virtual = {
  '@cmdb/database': { getPostgresClient: () => pgClient, getNeo4jClient: () => ({}), getAuditService: () => ({}) },
  bcrypt: {},
};
const authRepoFile = path.join(ROOT, 'packages/api-server/src/auth/neo4j-auth.repository.ts');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (virtual[request]) return `virtual:${request}`;
  const m = /^@cmdb\/([^/]+)$/.exec(request);
  if (m) return path.join(ROOT, 'packages', m[1], 'src/index.ts');
  return origResolve.call(this, request, parent, ...rest);
};
for (const [k, v] of Object.entries(virtual)) {
  const mod = new Module(`virtual:${k}`); mod.exports = v; mod.loaded = true; require.cache[`virtual:${k}`] = mod;
}
{
  const mod = new Module(authRepoFile); mod.loaded = true;
  mod.exports = { Neo4jAuthRepository: function () {
    return { findUserById: async id => (id === VIEWER_ID ? { _id: VIEWER_ID, _username: 'viewer', _role: 'viewer', _enabled: true } : null) };
  } };
  require.cache[authRepoFile] = mod;
}

const express = require('express');
const { loadConfig } = require('@cmdb/common');
const { JWTService } = require('./packages/api-server/src/auth/jwt.service');
const { getAuthMiddleware } = require('./packages/api-server/src/auth/auth-bootstrap');
const { businessServiceRoutes } = require('./packages/api-server/src/rest/routes/business-service.routes');

const MIGRATION = path.join(ROOT, 'packages/database/src/postgres/migrations/001_complete_schema.sql');
const TABLES = ['dim_business_services', 'fact_business_service_incidents', 'fact_business_service_changes'];
function ddl() {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  return TABLES.map(t => {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`));
    if (!m) throw new Error(`DDL for ${t} not found`);
    return m[0];
  }).join('\n');
}
// Original business-service-child-reads.test.ts SEED (health-relevant tables only; incident_count left at DEFAULT 0).
const SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status) VALUES
  ('bs-empty','Empty','compute','compute','low','active'), ('bs-app','App','application','application','high','active'),
  ('bs-db','Database Tier','data','data','critical','active'), ('bs-net','Network','network','network','medium','active'),
  ('bs-other','Other','security','security','low','active');
INSERT INTO fact_business_service_incidents (service_id, incident_date, mttr_minutes, sla_breaches) VALUES
  ('bs-app', CURRENT_DATE - 1, 30, 1), ('bs-app', CURRENT_DATE - 10, 90, 2), ('bs-app', CURRENT_DATE - 60, 500, 9),
  ('bs-other', CURRENT_DATE - 3, 1000, 40);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-app', CURRENT_DATE - 2, 4, 3), ('bs-app', CURRENT_DATE - 20, 6, 6), ('bs-app', CURRENT_DATE - 90, 10, 1),
  ('bs-other', CURRENT_DATE - 3, 8, 0);`;
const POPULATE = `
UPDATE fact_business_service_incidents SET incident_count = CASE
  WHEN service_id = 'bs-other' THEN 900 WHEN incident_date = CURRENT_DATE - 1 THEN 3
  WHEN incident_date = CURRENT_DATE - 10 THEN 7 ELSE 200 END;
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-db', CURRENT_DATE - 5, 0, 0), ('bs-db', CURRENT_DATE - 60, 50, 5);`;
const OLD_LOW_SUCCESS = `INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES ('bs-app', CURRENT_DATE - 120, 1000, 1);`;
const FOREIGN = `
INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES ('bs-other', CURRENT_DATE - 2, 500, 5, 5);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES ('bs-other', CURRENT_DATE - 1, 500, 500);`;
// Distinct counters per boundary day so each inclusion/exclusion is identifiable.
const CUTOFF = `
INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES
  ('bs-net', CURRENT_DATE - 7, 1, 10, 1), ('bs-net', CURRENT_DATE - 8, 2, 20, 1), ('bs-net', CURRENT_DATE - 30, 4, 30, 1), ('bs-net', CURRENT_DATE - 31, 8, 40, 1);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-net', CURRENT_DATE - 7, 1, 1), ('bs-net', CURRENT_DATE - 8, 2, 2), ('bs-net', CURRENT_DATE - 30, 4, 0), ('bs-net', CURRENT_DATE - 31, 8, 8);`;

let base; let bearer;
async function get(label, id, { anon = false } = {}) {
  queryCount = 0;
  const res = await fetch(`${base}/api/v1/business-services/${id}/health`, anon ? {} : { headers: { Authorization: bearer } });
  const body = await res.json();
  console.log(`${label}: GET /api/v1/business-services/${id}/health${anon ? ' (anonymous)' : ''} -> ${res.status} queries=${queryCount} ${JSON.stringify(body)}`);
  return { status: res.status, body, queries: queryCount };
}
const results = [];
function check(name, ok) { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const EMPTY = { incidents: { incidents_7d: 0, incidents_30d: 0, avg_mttr_30d: null, sla_breaches_30d: null }, changes: { changes_7d: 0, changes_30d: 0, success_rate_30d: null } };

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(ddl() + SEED);
  bearer = `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken(VIEWER_ID, 'viewer', 'viewer')}`;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/business-services', businessServiceRoutes);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const { address, port } = server.address();
  base = `http://${address}:${port}`;
  console.log(`listener bound ${address}:${port} (app.listen(0, "127.0.0.1"))`);

  console.log('--- phase A: original seed (changes 4/3 -2d, 6/6 -20d, 10/1 -90d; incident_count DEFAULT 0) ---');
  const a = await get('A', 'bs-app');
  check('A bs-app changes 4/10 rate 90 (historical baseline observed 1/2/50); incidents 0/0 (counters default 0); mttr 60 sla 3; 1 query',
    eq(a.body.data, { incidents: { incidents_7d: 0, incidents_30d: 0, avg_mttr_30d: 60, sla_breaches_30d: 3 }, changes: { changes_7d: 4, changes_30d: 10, success_rate_30d: 90 } }) && a.queries === 1);

  console.log('--- phase B: meaningful incident counters (3/-1d, 7/-10d, 200/-60d; bs-other 900; bs-db 0/0 -5d, 50/5 -60d) ---');
  await db.exec(POPULATE);
  const b = await get('B', 'bs-app');
  const e = await get('B', 'bs-empty');
  const d = await get('B', 'bs-db');
  const miss = await get('B', 'bs-missing');
  const anon = await get('B', 'bs-app', { anon: true });
  check('B bs-app incidents 3/10 mttr 60 sla 3; changes 4/10 rate 90; 1 query',
    b.status === 200 && b.queries === 1 && eq(b.body.data, { incidents: { incidents_7d: 3, incidents_30d: 10, avg_mttr_30d: 60, sla_breaches_30d: 3 }, changes: { changes_7d: 4, changes_30d: 10, success_rate_30d: 90 } }));
  check('B bs-empty 200 zero counts / null mttr, sla, rate', e.status === 200 && eq(e.body.data, EMPTY));
  check('B bs-db zero in-window denominator (0/0 -5d) with historical 50/5 -60d -> changes 0/0 rate null', d.status === 200 && eq(d.body.data.changes, { changes_7d: 0, changes_30d: 0, success_rate_30d: null }));
  check('B bs-missing 404 envelope, 1 query', miss.status === 404 && eq(miss.body, { success: false, error: 'Business service not found' }) && miss.queries === 1);
  check('B anonymous 401, 0 data queries', anon.status === 401 && anon.queries === 0);

  console.log('--- phase C: + old high-volume low-success bs-app fact (-120d, 1000/1) ---');
  await db.exec(OLD_LOW_SUCCESS);
  const c = await get('C', 'bs-app');
  check('C old fact leaves bs-app metrics (incl. rate 90) unchanged vs B', eq(c.body.data, b.body.data));

  console.log('--- phase D: + foreign bs-other facts (incidents 500 -2d, changes 500/500 -1d) ---');
  await db.exec(FOREIGN);
  const f = await get('D', 'bs-app');
  check('D foreign facts leave bs-app unchanged vs C', eq(f.body.data, c.body.data));

  console.log('--- phase E: exact cutoffs on bs-net (-7:1, -8:2, -30:4, -31:8; changes success 1,2,0,8) ---');
  await db.exec(CUTOFF);
  const n = await get('E', 'bs-net');
  check('E incidents 7d=1 (-7 in, -8 out) 30d=7 (-30 in, -31 out); changes 1/7; rate 3/7*100',
    n.body.data.incidents.incidents_7d === 1 && n.body.data.incidents.incidents_30d === 7 &&
    n.body.data.changes.changes_7d === 1 && n.body.data.changes.changes_30d === 7 &&
    Math.abs(n.body.data.changes.success_rate_30d - (3 / 7) * 100) < 1e-9);

  console.log('--- phase F: genuine database error (fact_business_service_changes dropped) ---');
  await db.exec('DROP TABLE fact_business_service_changes;');
  const err = await get('F', 'bs-app');
  check('F 500 envelope with relation error', err.status === 500 && err.body.error === 'Failed to get service health metrics' && /does not exist/.test(err.body.message));

  await new Promise(r => server.close(r));
  await db.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`SUMMARY ${results.length - failed}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('HARNESS ERROR', err && err.message); process.exit(3); });
```

---

# Historical record (a60ed369 and earlier): BLOCKED evidence-only admission, superseded as a gate

Everything below §0 is preserved history. At a60ed369 the outcome was "BLOCKED (evidence-only)", no formula change had been
made, and `getServiceHealth` and its regression test were unchanged. The 2026-09-27 product decision (§0) superseded that gate.
The research findings below remain valid as bounded research. They do **not** identify a production writer, and no review
PASS given to that evidence-only head applies to the corrected code.

- Baseline: `main` @ `7704ff94c4a1cf3c105a9393006ddba26251c4bb`, branch `agent/hap-188-rolling-service-health`.
- Scope checked: `GET /api/v1/business-services/:service_id/health`
  (`packages/api-server/src/rest/controllers/business-service.controller.ts`, `getServiceHealth`, lines 637-703).

## 1. Producer-semantic gate (historical; superseded as a gate by the §0 decision)

The gate needs a writer, and the path that calls it, for `fact_business_service_incidents.incident_count` and
`fact_business_service_changes.change_count` / `successful_count`. **The listed searches and the files read in 1.2 did not
establish any writer or writer contract for these columns.** That is a bounded result. Literal and `git log -S` searches
cannot rule out a writer whose table name is chosen at runtime (for example a connector `target_table`), code outside
this repository, or manual/DBA loads. This is not a claim that no writer exists.

Evidence provenance: the searches and file reads below were run by the worker in this worktree. Earlier partial inputs
(the parent's GitHub code search, which returned `incomplete_results=true`, and the legacy HAP-187 archive) are listed
only as inputs. They are not verification of the source, and no PM/scout verification of the source is claimed.

### 1.1 Searches run by the previous run in this worktree (tracked files, `.gitignore` respected; literal/regex only)

| Pattern | Scope | Non-writer hits |
|---|---|---|
| `fact_business_service_(incidents\|changes)` | whole repo | migration `001_complete_schema.sql` (DDL, `create_hypertable`, indexes, `GRANT SELECT, INSERT`, `COMMENT`, view `v_business_service_health`), `005_fix_business_service_hypertable_pks.sql` (PK/unique repair only), legacy fixture schema copy, controller read, test fixture seed, HAP-187 archive, `feature-audit/stories/financial.json` |
| `successful_count`, `incident_count`, `change_count` | whole repo / `packages` | same schema/view/controller/test hits. Other hits are unrelated: `itil_attributes.incident_count_30d` / `change_count_30d` JSON, row-count aliases in ai-ml-engine and analytics over `ci_change_history`, Metabase/infra views over `itil_incidents` |
| `INSERT INTO ${`, `INSERT INTO fact_`, `target_table`, `targetTable` | `packages` | `fact_ci_changes`, `fact_ci_discovery`, `fact_ci_relationships` (etl-processor); `target_table` appears only in `connectors/CONNECTOR_DATA_CLASSIFICATION.md` examples (`tbm_cost_pools`, `fact_incidents`, `fact_vulnerabilities`) |
| `(INSERT INTO\|UPDATE\|COPY) <table>` | etl-processor/src, integration-framework/src, connectors, bsm-impact-engine/src, itil-service-manager/src, tbm-cost-engine/src | none write the two fact tables (destinations listed in 1.2) |
| `dim_business_services` writers | packages, infrastructure, scripts | controller CRUD, `database/seed-data/load-business-services.ts` (dimension only) |
| `git log --all -S fact_business_service_incidents` / `-S successful_count` | full history | commits `fbe41ee`, `cae2bbc`, `5c0adc7`, `a7816f4`, `543b20a`, `3e9be8d`, `15c0a58`, `195cb23`, `51576bc`. Diff grep for `INSERT INTO/UPDATE/COPY fact_business_service` or counter assignment finds only the test fixture seed in `195cb23`. `5c0adc7` (ETL_PIPELINE_GUIDE.md) names the tables but has no writer. |

### 1.2 Files read, and the tables each one actually writes

**Read this session (source locators and excerpts):**

- `packages/event-processor/src/index.ts` lines 16-26: the only processors started are `new ChangeEventProcessor()` and
  `new MetricsAggregator()`.
- `packages/event-processor/src/processors/change-event-processor.ts`: subscribes `[KAFKA_TOPICS.CI_EVENTS, KAFKA_TOPICS.CI_CHANGES]`
  (line 33) with handlers for `CI_DISCOVERED`/`CI_UPDATED`/`CI_DELETED` (36-38). Destinations:
  `INSERT INTO ci_change_history` (60, 109, 158);
  `INSERT INTO ci_change_statistics … ON CONFLICT (ci_id) DO UPDATE SET … total_changes = ci_change_statistics.total_changes + 1` (199-205);
  `INSERT INTO ci_change_alerts` (223). Keyed on `ci_id`. No service attribution and no per-service daily grain.
- `packages/event-processor/src/processors/metrics-aggregator.ts`: subscribes CI/connector-metrics/reconciliation topics
  (45-48) with handlers at 52-55. Destinations: `INSERT INTO metrics_timeseries (metric_name, value, tags)` (220) and
  `INSERT INTO metrics_aggregated (window, window_start, metric_name, count, …)` (300).
- `packages/event-processor/src/kafka/event-consumer.ts`: transport. `subscribe()` (78) and a wildcard `onAny()` →
  `this.on('*', handler)` (113-114). **Coverage limit:** a regex for `onAny|on('*'` over `packages/event-processor/src`
  found only the definition and no caller. Callers outside that directory were not searched.
- `packages/etl-processor/src/jobs/*.ts` and legacy `*.js`: this session covered them with a regex
  (`(INSERT INTO|UPDATE|COPY) \w+`) only, and did not read them in full. Every destination hit:
  `change-detection.job.{js,ts}` → `fact_ci_changes` / `cmdb.fact_ci_changes`;
  `full-refresh.job.{js,ts}` and `neo4j-to-postgres.job.{js,ts}` → `dim_ci` / `cmdb.dim_ci`, `fact_ci_discovery` /
  `cmdb.fact_discovery`, `fact_ci_relationships` / `cmdb.fact_ci_relationships`;
  `reconciliation.job.{js,ts}` and `sync-cis-to-datamart.job.ts` → `dim_ci` / `cmdb.dim_ci`;
  `sync-costs-to-datamart.job.ts:378` → `UPDATE tbm_cost_pools`;
  `sync-incidents-to-datamart.job.ts:434` → `UPDATE itil_incidents`;
  `processors/etl-processor.ts:174` → `INSERT INTO dim_ci … ON CONFLICT (ci_id)`.
  None of these hits names either service fact table. The regex does not catch a table name built at runtime.

**Read by the previous run in this worktree (not re-read this session):**

- integration-framework `integration-manager.ts` / `connector-executor.ts`: write `connector_run_history`, `connector_runs`,
  `connector_run_log_entries`.
- `connector-registry.ts`: writes `installed_connectors`.
- itil-service-manager `incident-repository.ts` / `change-repository.ts`: write single `itil_incidents` / `itil_changes` rows.
- tbm-cost-engine `cost-sync.service.ts`: writes `resource_costs` / `license_costs`.

**Regex-only or not inspected:**

- Dynamic connector handlers: TypeScript connectors and JSON connectors whose destination is resolved at runtime
  (`target_table`-style) were covered only by the literal patterns in 1.1. They were not traced through the
  connector-executor dispatch.
- Runtime-installed connector packages that are not tracked here, external ITSM loaders or SQL jobs, and manual/DBA
  inserts (`GRANT … INSERT` on these tables allows them).
- The parent's GitHub code search returned `incomplete_results=true` and is not evidence.

### 1.3 What is directly supported, and what is only intent

Supported by evidence:

- The schema: one row per (`service_id`, date) unique key after `005`, with integer counter columns.
- The consumer: `v_business_service_health` `SUM`s the counters.
- The current API behavior, observed in §2: it counts rows, and `success_rate_30d` is computed over all time.

Intent only, not producer evidence:

- the schema comments "Daily aggregated … from ITSM connectors";
- the view's `SUM`;
- the test fixtures;
- the feature-audit story.

None of these shows what a writer actually stores.

### 1.4 UNRESOLVED producer contract

1. Source event selection: which incidents and which changes are counted.
2. Service attribution: how an event is mapped to `service_id`.
3. Date attribution: which timestamp is used, and in which timezone the calendar date is taken.
4. Whether each row is a per-service/per-date aggregate of events on that date, or a rolling/cumulative snapshot.
5. Whether `successful_count` counts a subset of the same changes counted in that row's `change_count`.
6. Insert, upsert and replay behavior: whether a re-run overwrites the day's total or adds to it (double-counting).

### 1.5 Decision needed (smallest)

**Question for the product owner / table owner:** For every row in `fact_business_service_incidents` and
`fact_business_service_changes`:

- Is `incident_count` / `change_count` the total of events for that `service_id` on that calendar date (state the
  timestamp and timezone)?
- Is `successful_count` a subset of that same `change_count`?
- Is a replay or re-run an idempotent overwrite, not an addition?

An answer of "yes" is enough only if it comes from whoever owns the actual producer. That can be a code pointer, an
external loader, or a runbook. Without producer provenance, the answer is intent, and it stays at the same level as the
schema comments.

**Proposed default (NOT authorized by this PR):** if the owner attests yes, change the formulas to use `SUM` of the
counters inside each window. Compute `success_rate_30d` over in-window facts only, and return `null` when the in-window
`change_count` is 0. If the owner cannot attest, keep the current formulas and treat the fields as row counts.

## 2. Historical baseline reproduction against the pre-fix controller (a60ed369)

### 2.1 Existing regression (recorded by an earlier run; not re-run in the a60ed369 session)

The previous run in this worktree ran the suite. Its recorded result:

```
$ npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
Tests:       24 passed, 24 total
EXIT=0
```

The first attempt exited 1 with `Preset ts-jest not found` because `node_modules` was missing. `npm ci --ignore-scripts --no-audit --no-fund` exited 0 and the suite was re-run.

The previous run also ran a throwaway Jest/supertest probe, now deleted. Its values match 2.2 phases A and B. A Jest test
is not a real listener, so 2.2 replaces it as the runtime proof.

### 2.2 Standalone real-listener baseline (a60ed369 session; throwaway script deleted after the run)

Setup:

- A throwaway `hap188-listener-probe.cjs` at the repo root.
- The real `express`, `businessServiceRoutes`, `getAuthMiddleware().authenticate()` (`AuthMiddleware` / `AuthService`) and
  `JWTService`, bound with `app.listen(0, '127.0.0.1')`.
- Real HTTP `fetch` requests sent to the bound port.
- The controller (lines 637-703) is unchanged.
- TypeScript is transpiled in-process with the repo's `typescript` (`transpileModule`).
- `@cmdb/*` resolves to `packages/*/src`.

SQL:

- Executed by in-process PGlite.
- The schema is the `CREATE TABLE` blocks for `dim_business_services`, `fact_business_service_incidents` and
  `fact_business_service_changes`, extracted from `001_complete_schema.sql` at runtime.
- No SQL results are mocked. `getPostgresClient().query` forwards to PGlite and counts calls.

Substitutions:

- PGlite stands in for PostgreSQL. There is no TimescaleDB, so the fact tables are plain tables.
- `Neo4jAuthRepository` is replaced by an in-memory store with one enabled viewer.
- `bcrypt` is replaced by an empty stub; JWT verification never calls it.
- `JWT_SECRET` is `crypto.randomBytes(32)` and the token is generated in memory for each run. Neither is printed.
- Other config env values are the placeholder `unused`.

Phases:

| Phase | Fixture change | What it tests |
|---|---|---|
| A | Original suite seed; bs-app changes 4/3 (−2d), 6/6 (−20d), 10/1 (−90d) | Baseline result |
| B | bs-app `incident_count` set to 3 (−1d), 7 (−10d), 200 (−60d); bs-other set to 900; bs-db changes added (−5d, 0/0) and (−60d, 50/5) | Populated fixture |
| C | Adds an old, high-volume, low-success bs-app fact (−120d, 1000/1) | Which fields an old fact moves |
| D | Adds foreign bs-other facts: incidents 500 (−2d), changes 500/500 (−1d) | Isolation from other services |
| E | Adds bs-net rows at exactly −7, −8, −30 and −31 days | Window cutoffs |
| F | `DROP TABLE fact_business_service_changes` | Genuine database error (500) |

Checks:

- CONTROL checks must pass.
- CONDITIONAL checks encode the proposed additive interpretation (§1.5). They are expected to fail on the current
  controller, and the script exits 1 when they do.

```
$ node hap188-listener-probe.cjs > /tmp/h188.out 2> /tmp/h188.err; echo EXIT=$?
EXIT=1
```

stdout (complete; line 29 is the controller's `logger.error` for phase F, which includes the controller SQL text):

```
listener bound 127.0.0.1:43241 (app.listen(0, "127.0.0.1"))
--- phase A: original seed (changes 4/3 -2d, 6/6 -20d, 10/1 -90d; incident_count default) ---
A: GET /api/v1/business-services/bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":2,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":2,"success_rate_30d":50}}}
CONTROL PASS A bs-app original seed changes 1/2 rate 50 incidents 1/2 mttr 60 sla 3
--- phase B: populated (incident_count 3/-1d, 7/-10d, 200/-60d; bs-other 900; bs-db 0/0 -5d, 50/5 -60d) ---
B: GET /api/v1/business-services/bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":2,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":2,"success_rate_30d":50}}}
B: GET /api/v1/business-services/bs-empty/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":null,"sla_breaches_30d":null},"changes":{"changes_7d":0,"changes_30d":0,"success_rate_30d":null}}}
B: GET /api/v1/business-services/bs-db/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":null,"sla_breaches_30d":null},"changes":{"changes_7d":1,"changes_30d":1,"success_rate_30d":10}}}
B: GET /api/v1/business-services/bs-missing/health -> 404 queries=1 {"success":false,"error":"Business service not found"}
B: GET /api/v1/business-services/bs-app/health (anonymous) -> 401 queries=0 {"_error":"Unauthorized","_message":"No authentication credentials provided"}
CONTROL PASS bs-empty no-data contract 0/0 null/null, rate null
CONTROL PASS bs-missing 404 envelope, 1 query
CONTROL PASS anonymous 401, 0 data queries
CONTROL PASS bs-app authenticated 200, 1 query
CONDITIONAL FAIL bs-app incidents_7d/30d = 3/10 (SUM incident_count)
CONDITIONAL FAIL bs-app changes_7d/30d = 4/10 (SUM change_count)
CONDITIONAL FAIL bs-app success_rate_30d = 90 (in-window 9/10)
CONDITIONAL FAIL bs-db success_rate_30d = null (in-window denominator 0)
--- phase C: + old high-volume low-success bs-app fact (-120d, 1000/1) ---
C: GET /api/v1/business-services/bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":2,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":2,"success_rate_30d":1.0784313725490196}}}
CONTROL PASS C only success_rate_30d moved vs B
--- phase D: + foreign bs-other facts (incidents 500 -2d, changes 500/500 -1d) ---
D: GET /api/v1/business-services/bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":2,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":2,"success_rate_30d":1.0784313725490196}}}
CONTROL PASS D foreign facts leave bs-app unchanged vs C
--- phase E: exact cutoffs on bs-net (-7, -8, -30, -31 days; one row each) ---
E: GET /api/v1/business-services/bs-net/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":3,"avg_mttr_30d":20,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":3,"success_rate_30d":75}}}
CONTROL PASS E -7 inside 7d, -8 outside; -30 inside 30d, -31 outside (rows 2/3)
--- phase F: genuine database error (fact_business_service_changes dropped) ---
2026-09-26 23:48:04 [undefined] [31merror[39m: Error getting service health {"metadata":{"service":"cmdb","error":{"length":130,"name":"error","severity":"ERROR","code":"42P01","position":"1115","file":"parse_relation.c","line":"1469","routine":"parserOpenTable","query":"SELECT i.incidents_7d, i.incidents_30d, i.avg_mttr_30d, i.sla_breaches_30d,\n          c.changes_7d, c.changes_30d, c.success_rate_30d\n        FROM dim_business_services s\n        CROSS JOIN LATERAL (\n          SELECT\n            COUNT(*) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '7 days') as incidents_7d,\n            COUNT(*) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days') as incidents_30d,\n            AVG(mttr_minutes) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days') as avg_mttr_30d,\n            SUM(sla_breaches) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days') as sla_breaches_30d\n          FROM fact_business_service_incidents\n          WHERE service_id = s.service_id\n        ) i\n        CROSS JOIN LATERAL (\n          SELECT\n            COUNT(*) FILTER (WHERE change_date >= CURRENT_DATE - INTERVAL '7 days') as changes_7d,\n            COUNT(*) FILTER (WHERE change_date >= CURRENT_DATE - INTERVAL '30 days') as changes_30d,\n            SUM(successful_count)::float / NULLIF(SUM(change_count), 0) * 100 as success_rate_30d\n          FROM fact_business_service_changes\n          WHERE service_id = s.service_id\n        ) c\n        WHERE s.service_id = $1","params":["bs-app"]},"service_id":"bs-app","timestamp":"2026-09-26T23:48:04.758Z"}}
F: GET /api/v1/business-services/bs-app/health -> 500 queries=1 {"success":false,"error":"Failed to get service health metrics","message":"relation \"fact_business_service_changes\" does not exist"}
CONTROL PASS F 500 envelope with relation error
SUMMARY control 9/9 pass; conditional-acceptance 0/4 pass
```

stderr (complete):

```
EXPECTED FAILURE: baseline controller does not meet CONDITIONAL additive-daily acceptance (synthetic consumer mismatch; not producer proof)
```

A secret scan (`grep -ciE 'bearer|eyJ|secret|password|token'`) over both captures returned 0 for each file.

What the listener run shows about the current API behavior:

- **Row counts.** Incident and change counts are fact rows. In phase B, bs-app returns incidents 1/2 although the stored
  `incident_count` values are 3 and 7, and changes 1/2 although the stored `change_count` values are 4 and 6.
- **All-time success rate.**
  - Phase A: bs-app returns `success_rate_30d` 50, which is 10/20 across −2d, −20d and −90d.
  - Phase B: bs-db returns 10. That value comes from the −60d 50/5 row, although the in-window denominator is 0.
  - Phase C: one −120d fact moves only `success_rate_30d` (50 → 1.0784…). The counts, MTTR and SLA do not change.
- **Service isolation.** In phase D, foreign bs-other facts leave bs-app unchanged.
- **Window cutoffs.** −7d is inside the 7-day window and −8d is outside. −30d is inside the 30-day window and −31d is outside.
  `avg_mttr_30d` and `sla_breaches_30d` are already windowed.
- **No-data contract.** bs-empty (no facts at all) returns counts 0, `null` averages/sums and `success_rate_30d` `null`.
  This is different from bs-db (no in-window changes, but a nonzero historical row), which returns 10 now and would
  return `null` under the conditional interpretation.
- **Query count.** Every authenticated request makes exactly one data query (200 and 404 responses, and the 500 in phase F).
  The anonymous request returns 401 with zero data queries.

**Conditional expectations** (these apply only if the producer contract in §1.5 is attested):

| Service | Metric | Current | Conditional |
|---|---|---|---|
| bs-app | incidents_7d / incidents_30d | 1 / 2 | 3 / 10 |
| bs-app | changes_7d / changes_30d | 1 / 2 | 4 / 10 |
| bs-app | success_rate_30d | 50 | 90 |
| bs-db | success_rate_30d | 10 | `null` |

MTTR 60 and SLA 3 would stay the same. This is a synthetic consumer mismatch under the proposed additive interpretation.
It is **not** proof that the actual producers write additive daily totals. At that time no corrected or post-fix output
existed, because no fix was authorized. The corrected post-fix output is in §0.

Reproduction script (as run; contains no secrets):

```js
// THROWAWAY (HAP-188 baseline listener probe). Deleted after the run; never committed.
// Real Express + businessServiceRoutes + AuthMiddleware/AuthService/JWTService on 127.0.0.1:<ephemeral>,
// real HTTP via fetch, SQL executed by in-process PGlite with CREATE TABLE blocks extracted from
// 001_complete_schema.sql. Substitutions: PGlite for PostgreSQL (no TimescaleDB => plain tables);
// Neo4jAuthRepository -> in-memory single viewer user; bcrypt -> empty stub (unused by JWT verify);
// JWT secret + token generated in memory per run and never printed.
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ts = require('typescript');

const ROOT = __dirname;
Object.assign(process.env, {
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused', LOG_LEVEL: 'error',
});

require.extensions['.ts'] = (m, file) => {
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: false },
  });
  m._compile(out.outputText, file);
};

let db; let queryCount = 0;
const pgClient = { query: async (sql, params = []) => { queryCount++; return { rows: (await db.query(sql, params)).rows }; } };
const VIEWER_ID = 'viewer-user-1';
const virtual = {
  '@cmdb/database': { getPostgresClient: () => pgClient, getNeo4jClient: () => ({}), getAuditService: () => ({}) },
  bcrypt: {},
};
const authRepoFile = path.join(ROOT, 'packages/api-server/src/auth/neo4j-auth.repository.ts');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (virtual[request]) return `virtual:${request}`;
  const m = /^@cmdb\/([^/]+)$/.exec(request);
  if (m) return path.join(ROOT, 'packages', m[1], 'src/index.ts');
  return origResolve.call(this, request, parent, ...rest);
};
for (const [k, v] of Object.entries(virtual)) {
  const mod = new Module(`virtual:${k}`); mod.exports = v; mod.loaded = true; require.cache[`virtual:${k}`] = mod;
}
{
  const mod = new Module(authRepoFile); mod.loaded = true;
  mod.exports = { Neo4jAuthRepository: function () {
    return { findUserById: async id => (id === VIEWER_ID ? { _id: VIEWER_ID, _username: 'viewer', _role: 'viewer', _enabled: true } : null) };
  } };
  require.cache[authRepoFile] = mod;
}

const express = require('express');
const { loadConfig } = require('@cmdb/common');
const { JWTService } = require('./packages/api-server/src/auth/jwt.service');
const { getAuthMiddleware } = require('./packages/api-server/src/auth/auth-bootstrap');
const { businessServiceRoutes } = require('./packages/api-server/src/rest/routes/business-service.routes');

const MIGRATION = path.join(ROOT, 'packages/database/src/postgres/migrations/001_complete_schema.sql');
const TABLES = ['dim_business_services', 'fact_business_service_incidents', 'fact_business_service_changes'];
function ddl() {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  return TABLES.map(t => {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`));
    if (!m) throw new Error(`DDL for ${t} not found`);
    return m[0];
  }).join('\n');
}
// Original business-service-child-reads.test.ts SEED (health-relevant tables only).
const SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status) VALUES
  ('bs-empty','Empty','compute','compute','low','active'), ('bs-app','App','application','application','high','active'),
  ('bs-db','Database Tier','data','data','critical','active'), ('bs-net','Network','network','network','medium','active'),
  ('bs-other','Other','security','security','low','active');
INSERT INTO fact_business_service_incidents (service_id, incident_date, mttr_minutes, sla_breaches) VALUES
  ('bs-app', CURRENT_DATE - 1, 30, 1), ('bs-app', CURRENT_DATE - 10, 90, 2), ('bs-app', CURRENT_DATE - 60, 500, 9),
  ('bs-other', CURRENT_DATE - 3, 1000, 40);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-app', CURRENT_DATE - 2, 4, 3), ('bs-app', CURRENT_DATE - 20, 6, 6), ('bs-app', CURRENT_DATE - 90, 10, 1),
  ('bs-other', CURRENT_DATE - 3, 8, 0);`;
const POPULATE = `
UPDATE fact_business_service_incidents SET incident_count = CASE
  WHEN service_id = 'bs-other' THEN 900 WHEN incident_date = CURRENT_DATE - 1 THEN 3
  WHEN incident_date = CURRENT_DATE - 10 THEN 7 ELSE 200 END;
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-db', CURRENT_DATE - 5, 0, 0), ('bs-db', CURRENT_DATE - 60, 50, 5);`;
const OLD_LOW_SUCCESS = `INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES ('bs-app', CURRENT_DATE - 120, 1000, 1);`;
const FOREIGN = `
INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES ('bs-other', CURRENT_DATE - 2, 500, 5, 5);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES ('bs-other', CURRENT_DATE - 1, 500, 500);`;
const CUTOFF = `
INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES
  ('bs-net', CURRENT_DATE - 7, 1, 10, 1), ('bs-net', CURRENT_DATE - 8, 1, 20, 1), ('bs-net', CURRENT_DATE - 30, 1, 30, 1), ('bs-net', CURRENT_DATE - 31, 1, 40, 1);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-net', CURRENT_DATE - 7, 1, 1), ('bs-net', CURRENT_DATE - 8, 1, 1), ('bs-net', CURRENT_DATE - 30, 1, 1), ('bs-net', CURRENT_DATE - 31, 1, 0);`;

let base; let bearer;
async function get(label, id, { anon = false } = {}) {
  queryCount = 0;
  const res = await fetch(`${base}/api/v1/business-services/${id}/health`, anon ? {} : { headers: { Authorization: bearer } });
  const body = await res.json();
  console.log(`${label}: GET /api/v1/business-services/${id}/health${anon ? ' (anonymous)' : ''} -> ${res.status} queries=${queryCount} ${JSON.stringify(body)}`);
  return { status: res.status, body, queries: queryCount };
}
const results = { control: [], conditional: [] };
function check(kind, name, ok) { results[kind].push([name, ok]); console.log(`${kind.toUpperCase()} ${ok ? 'PASS' : 'FAIL'} ${name}`); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(ddl() + SEED);
  bearer = `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken(VIEWER_ID, 'viewer', 'viewer')}`;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/business-services', businessServiceRoutes);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const { address, port } = server.address();
  base = `http://${address}:${port}`;
  console.log(`listener bound ${address}:${port} (app.listen(0, "127.0.0.1"))`);

  console.log('--- phase A: original seed (changes 4/3 -2d, 6/6 -20d, 10/1 -90d; incident_count default) ---');
  const a = await get('A', 'bs-app');
  check('control', 'A bs-app original seed changes 1/2 rate 50 incidents 1/2 mttr 60 sla 3',
    eq(a.body.data, { incidents: { incidents_7d: 1, incidents_30d: 2, avg_mttr_30d: 60, sla_breaches_30d: 3 }, changes: { changes_7d: 1, changes_30d: 2, success_rate_30d: 50 } }) && a.queries === 1);

  console.log('--- phase B: populated (incident_count 3/-1d, 7/-10d, 200/-60d; bs-other 900; bs-db 0/0 -5d, 50/5 -60d) ---');
  await db.exec(POPULATE);
  const b = await get('B', 'bs-app');
  const e = await get('B', 'bs-empty');
  const d = await get('B', 'bs-db');
  const miss = await get('B', 'bs-missing');
  const anon = await get('B', 'bs-app', { anon: true });
  check('control', 'bs-empty no-data contract 0/0 null/null, rate null', eq(e.body.data, { incidents: { incidents_7d: 0, incidents_30d: 0, avg_mttr_30d: null, sla_breaches_30d: null }, changes: { changes_7d: 0, changes_30d: 0, success_rate_30d: null } }));
  check('control', 'bs-missing 404 envelope, 1 query', miss.status === 404 && eq(miss.body, { success: false, error: 'Business service not found' }) && miss.queries === 1);
  check('control', 'anonymous 401, 0 data queries', anon.status === 401 && anon.queries === 0);
  check('control', 'bs-app authenticated 200, 1 query', b.status === 200 && b.queries === 1);
  check('conditional', 'bs-app incidents_7d/30d = 3/10 (SUM incident_count)', b.body.data.incidents.incidents_7d === 3 && b.body.data.incidents.incidents_30d === 10);
  check('conditional', 'bs-app changes_7d/30d = 4/10 (SUM change_count)', b.body.data.changes.changes_7d === 4 && b.body.data.changes.changes_30d === 10);
  check('conditional', 'bs-app success_rate_30d = 90 (in-window 9/10)', b.body.data.changes.success_rate_30d === 90);
  check('conditional', 'bs-db success_rate_30d = null (in-window denominator 0)', d.body.data.changes.success_rate_30d === null);

  console.log('--- phase C: + old high-volume low-success bs-app fact (-120d, 1000/1) ---');
  await db.exec(OLD_LOW_SUCCESS);
  const c = await get('C', 'bs-app');
  check('control', 'C only success_rate_30d moved vs B', eq(c.body.data.incidents, b.body.data.incidents) && c.body.data.changes.changes_7d === b.body.data.changes.changes_7d && c.body.data.changes.changes_30d === b.body.data.changes.changes_30d && c.body.data.changes.success_rate_30d !== b.body.data.changes.success_rate_30d);

  console.log('--- phase D: + foreign bs-other facts (incidents 500 -2d, changes 500/500 -1d) ---');
  await db.exec(FOREIGN);
  const f = await get('D', 'bs-app');
  check('control', 'D foreign facts leave bs-app unchanged vs C', eq(f.body.data, c.body.data));

  console.log('--- phase E: exact cutoffs on bs-net (-7, -8, -30, -31 days; one row each) ---');
  await db.exec(CUTOFF);
  const n = await get('E', 'bs-net');
  check('control', 'E -7 inside 7d, -8 outside; -30 inside 30d, -31 outside (rows 2/3)', n.body.data.incidents.incidents_7d === 1 && n.body.data.incidents.incidents_30d === 3 && n.body.data.changes.changes_7d === 1 && n.body.data.changes.changes_30d === 3);

  console.log('--- phase F: genuine database error (fact_business_service_changes dropped) ---');
  await db.exec('DROP TABLE fact_business_service_changes;');
  const err = await get('F', 'bs-app');
  check('control', 'F 500 envelope with relation error', err.status === 500 && err.body.error === 'Failed to get service health metrics' && /does not exist/.test(err.body.message));

  await new Promise(r => server.close(r));
  await db.close();
  const cf = results.control.filter(([, ok]) => !ok).length;
  const qf = results.conditional.filter(([, ok]) => !ok).length;
  console.log(`SUMMARY control ${results.control.length - cf}/${results.control.length} pass; conditional-acceptance ${results.conditional.length - qf}/${results.conditional.length} pass`);
  if (cf) { console.error('UNEXPECTED: control check failed'); process.exit(2); }
  if (qf) { console.error('EXPECTED FAILURE: baseline controller does not meet CONDITIONAL additive-daily acceptance (synthetic consumer mismatch; not producer proof)'); process.exit(1); }
  process.exit(0);
})().catch(err => { console.error('HARNESS ERROR', err && err.message); process.exit(3); });
```

## 3. What the historical evidence-only run did not do (superseded by §0)

At a60ed369:

- `getServiceHealth` and `business-service-child-reads.test.ts` were not changed, and no regression test was added.
- No post-fix listener smoke test was run, because there was no fix.
- The throwaway `hap188-listener-probe.cjs` was deleted after the run. It is reproduced above and was never committed.
- No auth, schema, migration or ingestion files were edited. Nothing was deployed, marked ready or merged.
- The run's outcome was BLOCKED (evidence-only) pending the §1.5 owner decision. The §0 product decision has since replaced
  that gate. The producer questions in §1.4 are still unproven; they are outside the consumer-only correction.
