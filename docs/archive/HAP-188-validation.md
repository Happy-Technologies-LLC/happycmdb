# HAP-188 validation — rolling service health totals / 30-day success rate

**Outcome: BLOCKED (evidence-only). No formula change was made.** `getServiceHealth` and its regression test are unchanged.

- Baseline: `main` @ `7704ff94c4a1cf3c105a9393006ddba26251c4bb`, branch `agent/hap-188-rolling-service-health`.
- Scope checked: `GET /api/v1/business-services/:service_id/health`
  (`packages/api-server/src/rest/controllers/business-service.controller.ts`, `getServiceHealth`).

## 1. Producer-semantic gate: BLOCKED

The gate needs source code that writes `fact_business_service_incidents.incident_count` and
`fact_business_service_changes.change_count` / `successful_count`, plus the path that calls that code. No such writer
exists in this repository at this SHA or in its git history. So the repository does not settle whether:

- the counters are additive daily event aggregates or cumulative/rolling snapshots;
- `successful_count` is the aligned subset of `change_count`.

### 1.1 Searches run (tracked files, `.gitignore` respected)

| Pattern | Scope | Non-writer hits |
|---|---|---|
| `fact_business_service_(incidents\|changes)` | whole repo | migration `001_complete_schema.sql` (DDL, `create_hypertable`, indexes, `GRANT SELECT, INSERT`, `COMMENT`, view `v_business_service_health`), `005_fix_business_service_hypertable_pks.sql` (PK/unique repair only), legacy fixture schema copy, controller read, test fixture seed, HAP-187 archive, `feature-audit/stories/financial.json` |
| `successful_count`, `incident_count`, `change_count` | whole repo / `packages` | same schema/view/controller/test hits. Other hits are unrelated: `itil_attributes.incident_count_30d` / `change_count_30d` JSON, row-count aliases in ai-ml-engine and analytics over `ci_change_history`, Metabase/infra views over `itil_incidents` |
| `INSERT INTO ${`, `INSERT INTO fact_`, `target_table`, `targetTable` | `packages` | `fact_ci_changes`, `fact_ci_discovery`, `fact_ci_relationships` (etl-processor); `target_table` appears only in `connectors/CONNECTOR_DATA_CLASSIFICATION.md` examples (`tbm_cost_pools`, `fact_incidents`, `fact_vulnerabilities`) |
| `(INSERT INTO\|UPDATE\|COPY) <table>` | etl-processor/src, integration-framework/src, connectors, bsm-impact-engine/src, itil-service-manager/src, tbm-cost-engine/src | none write the two fact tables (destinations listed in 1.2) |
| `dim_business_services` writers | packages, infrastructure, scripts | controller CRUD, `database/seed-data/load-business-services.ts` (dimension only) |
| `git log --all -S fact_business_service_incidents` / `-S successful_count` | full history | commits `fbe41ee`, `cae2bbc`, `5c0adc7`, `a7816f4`, `543b20a`, `3e9be8d`, `15c0a58`, `195cb23`, `51576bc`. Diff grep for `INSERT INTO/UPDATE/COPY fact_business_service` or counter assignment finds only the test fixture seed in `195cb23`. `5c0adc7` (ETL_PIPELINE_GUIDE.md) names the tables but has no writer. |

### 1.2 Write paths read and what each one writes

- `packages/event-processor/src/processors/change-event-processor.ts`: writes `ci_change_history`, `ci_change_statistics`
  (upsert, keyed on `ci_id`), `ci_change_alerts`. No service mapping and no daily service grain.
- `packages/event-processor/src/processors/metrics-aggregator.ts`: writes `metrics_timeseries` and `metrics_aggregated`.
- `packages/event-processor/src/kafka/*`: transport only (producer, consumer, topics).
- `packages/etl-processor/src/jobs/sync-incidents-to-datamart.job.ts`: operational `UPDATE itil_incidents`
  (`enrichIncident`); `enrichChange` is a placeholder. This does not write the service facts.
- etl-processor `change-detection`, `full-refresh`, `neo4j-to-postgres`, `reconciliation`, `sync-cis-to-datamart`
  (`.ts` and legacy `.js`): write `dim_ci`, `fact_ci_changes`, `fact_discovery` / `fact_ci_discovery`, `fact_ci_relationships`.
- `sync-costs-to-datamart.job.ts`: writes `tbm_cost_pools`. `processors/etl-processor.ts`: writes `dim_ci`.
- integration-framework `integration-manager.ts` and `connector-executor.ts`: write run bookkeeping only
  (`connector_run_history`, `connector_runs`, `connector_run_log_entries`). Records are counted from connector events;
  the executor has no table write.
- `connector-registry.ts`: writes `installed_connectors`.
- itil-service-manager `incident-repository.ts` / `change-repository.ts`: write individual operational `itil_incidents` / `itil_changes` rows.
- tbm-cost-engine `cost-sync.service.ts`: writes `resource_costs` and `license_costs`.

### 1.3 Evidence that does not count as producer proof

These sources do not satisfy the gate:

- the schema comments "Daily aggregated … from ITSM connectors";
- `v_business_service_health`, which `SUM`s the counters;
- the `005` unique repair;
- the test fixtures;
- the feature-audit story.

They describe intent or consumer behavior. They do not implement a producer.

### 1.4 Not inspected

- Anything outside this repository: external ITSM connectors, loaders or SQL jobs, and manual/DBA inserts. `GRANT INSERT … TO PUBLIC` allows these.
- Runtime-installed connector packages that are not tracked here.
- The GitHub code search the parent ran returned `incomplete_results=true` and is not evidence.

This result is limited to the searches above. It does not show that no writer exists anywhere.

### 1.5 What would unblock this

A writer contract, either in source or authoritative from the owning team, for both tables that specifies:

1. the source event selection;
2. service attribution;
3. date attribution (which timestamp, which timezone);
4. grouping to (`service_id`, date);
5. insert/upsert/replay behavior (additive, overwrite, or cumulative);
6. that `successful_count ⊆ change_count` for the same day and service.

## 2. Baseline reproduction against the unchanged controller

Test setup:

- real `businessServiceRoutes`, real `AuthMiddleware` / `AuthService` / `JWTService`, driven through supertest at `/api/v1/business-services`;
- real PGlite SQL for the relevant `CREATE TABLE` blocks, extracted at runtime from `001_complete_schema.sql`;
- the existing suite's harness, reused unchanged.

Substitutions:

- PGlite stands in for PostgreSQL. There is no TimescaleDB, so the fact tables are plain tables.
- The Neo4j auth repository is replaced by an in-memory store.
- The native `bcrypt` binding is stubbed and not used.
- JWTs are generated in memory with a test-only secret and are never emitted.

### 2.1 Existing regression

```
$ npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
Tests:       24 passed, 24 total
EXIT=0
```

(The first attempt exited 1 with `Preset ts-jest not found` because `node_modules` was missing. `npm ci --ignore-scripts --no-audit --no-fund` exited 0 and the suite was re-run.)

### 2.2 Throwaway probe (deleted after the run, never committed)

The probe copied the suite harness and applied the same seed. It then:

- set `incident_count` to 3 (−1d), 7 (−10d), 200 (−60d) for bs-app, and 900 for the foreign `bs-other` row;
- added `bs-db` change facts (−5d, 0/0) and (−60d, 50/5).

```
$ npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/hap188-probe.test.ts -t 'HAP-188'
GET bs-app/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":2,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":2,"success_rate_30d":50}}}
GET bs-empty/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":null,"sla_breaches_30d":null},"changes":{"changes_7d":0,"changes_30d":0,"success_rate_30d":null}}}
GET bs-db/health -> 200 queries=1 {"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":null,"sla_breaches_30d":null},"changes":{"changes_7d":1,"changes_30d":1,"success_rate_30d":10}}}
GET bs-missing/health -> 404 queries=1 {"success":false,"error":"Business service not found"}
GET bs-app/health (anonymous) -> 401 queries=0
GET bs-app/health (changes table offline) -> 500 {"success":false,"error":"Failed to get service health metrics","message":"relation \"fact_business_service_changes\" does not exist"}
Tests:       12 skipped, 1 passed, 13 total
EXIT=0
```

What the probe showed:

- The response counts fact **rows**: bs-app shows 1/2 even though the stored `incident_count` values are 3 and 7.
- `success_rate_30d` covers **all time**:
  - bs-app returns 50 (10/20 across −2d, −20d and −90d).
  - bs-db returns 10, which comes entirely from the −60d facts; its in-window change count is 0.
- The foreign 900 row does not leak into bs-app.
- Each request makes one query.

**Conditional expectations, which apply only if the producer contract confirms additive daily event aggregates:**

| Service | Metric | Current | Expected |
|---|---|---|---|
| bs-app | incidents_7d / incidents_30d | 1 / 2 | 3 / 10 |
| bs-app | changes_7d / changes_30d | 1 / 2 | 4 / 10 |
| bs-app | success_rate_30d | 50 | 90 |
| bs-db | success_rate_30d | 10 | `null` |

MTTR 60 and SLA 3 would stay the same. This synthetic run proves how the consumer does its arithmetic. It does not establish the production grain.

## 3. What was not done

- `getServiceHealth` was not changed.
- `business-service-child-reads.test.ts` was not changed.
- No regression test was added: without the producer contract, the new expectations would be invented semantics.
- No listener smoke test was run after a fix, because there is no fix.
- HAP-188 is **not complete**.
