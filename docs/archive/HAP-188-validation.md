# HAP-188 validation — rolling service health totals / 30-day success rate

**Outcome: BLOCKED (evidence-only). HAP-188 is NOT complete. No formula change was made.** `getServiceHealth` and its regression test are unchanged. This PR (baseline tests/CI plus evidence) is not HAP-188 delivery.

- Baseline: `main` @ `7704ff94c4a1cf3c105a9393006ddba26251c4bb`, branch `agent/hap-188-rolling-service-health`.
- Scope checked: `GET /api/v1/business-services/:service_id/health`
  (`packages/api-server/src/rest/controllers/business-service.controller.ts`, `getServiceHealth`, lines 637-703).

## 1. Producer-semantic gate: BLOCKED

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

## 2. Baseline reproduction against the unchanged controller

### 2.1 Existing regression (previous run; not re-run this session)

The previous run in this worktree ran the suite. Its recorded result:

```
$ npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
Tests:       24 passed, 24 total
EXIT=0
```

The first attempt exited 1 with `Preset ts-jest not found` because `node_modules` was missing. `npm ci --ignore-scripts --no-audit --no-fund` exited 0 and the suite was re-run.

The previous run also ran a throwaway Jest/supertest probe, now deleted. Its values match 2.2 phases A and B. A Jest test
is not a real listener, so 2.2 replaces it as the runtime proof.

### 2.2 Standalone real-listener baseline (this session; throwaway script deleted after the run)

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
It is **not** proof that the actual producers write additive daily totals. No corrected or post-fix output exists,
because no fix is authorized.

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

## 3. What was not done

- `getServiceHealth` was not changed.
- `business-service-child-reads.test.ts` was not changed.
- No regression test was added: without the producer contract, the new expectations would be invented semantics.
- No listener smoke test was run after a fix, because there is no fix.
- The throwaway `hap188-listener-probe.cjs` was deleted after the run. It is reproduced above and was never committed.
- No controller, test, auth, schema, migration or ingestion files were edited. Nothing was deployed, marked ready or merged.
- HAP-188 is **not complete**. Outcome: BLOCKED (evidence-only). It stays blocked until the §1.5 owner decision is made with producer provenance.
