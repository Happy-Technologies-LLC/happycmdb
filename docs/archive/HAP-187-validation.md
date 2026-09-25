# HAP-187 validation evidence

STATUS: VALIDATION EXECUTED 2026-09-25T17:41Z by dispatch job `f4da386d-8a34-4943-baae-bcb3c2b38b87`; comment-only correction re-run 2026-09-25T17:52Z (§5)

Commands in §0–§3 ran 2026-09-25 between 17:39:40Z (`date -u` at orientation) and 17:41:24Z (iat of the last JWT). They were
run by dispatch job `f4da386d-8a34-4943-baae-bcb3c2b38b87`, a resume of job `bf709f12-abc1-4d31-a48b-e7b6a023be1a` that reused
the bf709f12 worktree path (`/home/coder/jobs/bf709f12-abc1-4d31-a48b-e7b6a023be1a/repo`), which is why the scratch and sibling
paths below contain `bf709f12`. The original bf709f12 implementation session ran nothing (its file said "NO COMMAND HAS BEEN RUN").
§5 was produced by a later correction dispatch that again resumed in the same bf709f12 worktree path; its own dispatch job id is
not exposed in its environment (`HOME`, `TMPDIR`, `PWD` all point at the bf709f12 path), so it is identified here only as the
HAP-187 PR21 evidence-accuracy correction dispatch run at head `51576bc33680673ad2b0d48a317f76d273578cdf`.

- Linear: HAP-187 (parent HAP-94, "Now — Minimum service-context contract"). Draft PR21, branch `agent/hap-187-service-metric-not-found`.
- Base: `ade7f70bee55d496f0e02b4d33188b8ff7d62329` (main).
  - Base blob of `business-service.controller.ts` = `1d19f63c0eeb77edae4dbbbac6171083b1f1ff24`; base blob of `business-service.routes.ts` = `c5d1d0e3251cd6dc82f81f8db1e8e19372c43d45`.
- Head before validation: `195cb232062f053a467bb077d0ae94af008a9289`. Head after validation: `195cb232062f053a467bb077d0ae94af008a9289`
  (the validation session made no commit; the only tracked change it made is this file). The §5 correction started from head
  `51576bc33680673ad2b0d48a317f76d273578cdf` and changed only the test comment above `EMPTY_METRICS` and this file.
- Toolchain: node `v22.23.2`, npm `10.9.8`.
- Final blob SHAs (`git hash-object <path>`, after the §5 correction):
  - `packages/api-server/src/rest/controllers/business-service.controller.ts` = `9ec3acd23eef5117c806c38e3c9ce31e6e760d7f` (unchanged)
  - `packages/api-server/src/rest/routes/business-service.routes.ts` = `9998baf66e03b39ced0f6e1e4a940bb1cefe2559` (unchanged)
  - `packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts` = `7a53fe13fa148c8784a3d92de8e3944913b40dcf`
    (was `41839ebf16f1fafcaf9d0f91d3e3b67f534e2482` during §0–§3; only the 4-line driver-serialisation comment changed, see §5)
  - `docs/archive/HAP-187-validation.md`: a file cannot contain its own blob SHA; it is recorded in
    `/home/coder/jobs/bf709f12-abc1-4d31-a48b-e7b6a023be1a/validation.md` and in the job's final report.

No controller or route source was changed by validation: no contract defect surfaced and no driver-serialization expectation was
wrong. The test file changed afterwards only in the comment above `EMPTY_METRICS` (§5).

## Result summary

| Check | Result |
|---|---|
| Dependency prerequisites (HAP-174 §9 procedure; node_modules was missing) | DS 0.7.1 pack exit 0, SHA1 `60d6c25c…` and SHA512 equal the HAP-174 §9.4 registry values; 21 regular files under `package/`, 0 unsafe, 0 non-regular; extract exit 0; root `npm ci` exit 0, `git status --short` empty |
| Step 1: committed suite, fixed controller | 24/24 pass, exit 0 (cis/dependencies × 6, health/costs × 6 cases a–f) |
| Step 2: controller swapped to ade7f70 | exit 1; 4 failed, 20 passed: health (a),(f) and costs (a),(f) fail `Expected: 404 / Received: 200`; all others pass. Restore verified: `git diff --stat` and `git status --short` empty |
| Step 3: real listener + curl over loopback + PGlite | bs-app 200 populated; bs-empty 200 zero/null; bs-missing 404 exact envelope; no token 401 with 0 adapter queries; tables offline 500 `relation ... does not exist`; restored 200; baseline controller bs-missing 200 (health and costs). Harness deleted; `git diff --stat` and `git status --short` empty |
| §5: comment-only re-run of the focused suite (at 51576bc + working-tree change) | 24/24 pass, exit 0; controller/routes blobs unchanged |

Note on case counts: the task brief said "cis/dependencies × 5"; the suite actually has six cases per endpoint (including the
injection case), so the observed total is 24 = 4 endpoints × 6.

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
  should not affect it [INFERENCE from reading lines 148-173; that file was not run in this validation].
- `packages/cli/src/commands/datamart.command.ts:118` calls `/datamart/health`, which is a different endpoint and is unaffected.

No consumer would observe the new 404.

## 0. Dependency prerequisites (node_modules was missing)

`ls node_modules | wc -l` at orientation printed `ls: cannot access 'node_modules': No such file or directory` and `0`.
Procedure of `docs/archive/HAP-174-validation.md` §9. Scratch dir `/home/coder/jobs/bf709f12-abc1-4d31-a48b-e7b6a023be1a/scratch`
(outside git). Resolved sibling: `realpath /home/coder/jobs/bf709f12-abc1-4d31-a48b-e7b6a023be1a/repo/../happy-technologies-design-system`
printed `/home/coder/jobs/bf709f12-abc1-4d31-a48b-e7b6a023be1a/happy-technologies-design-system`. Manifest and lockfile not edited.

Exact command line (cwd scratch, one bash invocation; `J=/home/coder/jobs/bf709f12-abc1-4d31-a48b-e7b6a023be1a`):

~~~~~~
npm pack @happy-technologies/design-system@0.7.1 --ignore-scripts --registry=https://registry.npmjs.org/ --json > pack.stdout 2> pack.stderr; echo $? > pack.exit
sha1sum *.tgz > sha1.txt
openssl dgst -sha512 -binary *.tgz | base64 -w0 > sha512.txt
tar tvzf *.tgz > list.stdout 2>list.stderr; echo $? > list.exit
tar tzf *.tgz | awk '!/^package\// || /(^|\/)\.\.(\/|$)/ || /^\//' | wc -l > unsafe.txt
tar tvzf *.tgz | awk '$1 !~ /^-/' | wc -l > nonreg.txt
realpath $J/repo/../happy-technologies-design-system
mkdir -p $J/happy-technologies-design-system && tar xzf happy-technologies-design-system-0.7.1.tgz -C $J/happy-technologies-design-system --strip-components=1 > extract.log 2>&1; echo "EXIT=$?" >> extract.log
~~~~~~

### 0.1 npm pack

~~~~~~
--- pack.exit ---
0
--- pack.stdout (2597 bytes) ---
[
  {
    "id": "@happy-technologies/design-system@0.7.1",
    "name": "@happy-technologies/design-system",
    "version": "0.7.1",
    "size": 224803,
    "unpackedSize": 543140,
    "shasum": "60d6c25cd69620c1301622bb64a81d01ce34e78b",
    "integrity": "sha512-sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew==",
    "filename": "happy-technologies-design-system-0.7.1.tgz",
    "files": [
      {
        "path": "MIGRATION.md",
        "size": 16522,
        "mode": 420
      },
      {
        "path": "adherence.oxlintrc.json",
        "size": 4541,
        "mode": 420
      },
      {
        "path": "package.json",
        "size": 2360,
        "mode": 420
      },
      {
        "path": "src/assets/phosphor-duotone.css",
        "size": 231626,
        "mode": 420
      },
      {
        "path": "src/assets/Phosphor-Duotone.woff2",
        "size": 164420,
        "mode": 420
      },
      {
        "path": "src/connectors/ConnectorCard.tsx",
        "size": 2538,
        "mode": 420
      },
      {
        "path": "src/connectors/ConnectorCatalog.tsx",
        "size": 1895,
        "mode": 420
      },
      {
        "path": "src/connectors/ConnectorConfigForm.tsx",
        "size": 4854,
        "mode": 420
      },
      {
        "path": "src/connectors/ConnectorInstallWizard.tsx",
        "size": 5272,
        "mode": 420
      },
      {
        "path": "src/connectors/index.ts",
        "size": 473,
        "mode": 420
      },
      {
        "path": "src/connectors/types.ts",
        "size": 1493,
        "mode": 420
      },
      {
        "path": "src/controls.tsx",
        "size": 7772,
        "mode": 420
      },
      {
        "path": "src/feedback.tsx",
        "size": 7483,
        "mode": 420
      },
      {
        "path": "src/globals.d.ts",
        "size": 174,
        "mode": 420
      },
      {
        "path": "src/HappyTheme.tsx",
        "size": 852,
        "mode": 420
      },
      {
        "path": "src/index.ts",
        "size": 556,
        "mode": 420
      },
      {
        "path": "src/overlays.tsx",
        "size": 6712,
        "mode": 420
      },
      {
        "path": "src/shell.tsx",
        "size": 12499,
        "mode": 420
      },
      {
        "path": "src/theme.css",
        "size": 6229,
        "mode": 420
      },
      {
        "path": "src/ui.tsx",
        "size": 61897,
        "mode": 420
      },
      {
        "path": "tailwind.preset.cjs",
        "size": 2972,
        "mode": 420
      }
    ],
    "entryCount": 21,
    "bundled": []
  }
]
--- pack.stderr (0 bytes) ---
~~~~~~

### 0.2 Integrity

~~~~~~
--- sha1.txt ---
60d6c25cd69620c1301622bb64a81d01ce34e78b  happy-technologies-design-system-0.7.1.tgz
--- sha512.txt (base64, no trailing newline) ---
sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew==
~~~~~~

Expected (HAP-174 §9.4 registry `dist.shasum` / `dist.integrity`): `60d6c25cd69620c1301622bb64a81d01ce34e78b` /
`sha512-sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew==`. Both match. The registry
was not re-queried with `npm view` in this session; the `npm pack --json` output above reports the same shasum/integrity.

### 0.3 Archive listing and path safety

~~~~~~
--- list.exit ---
0
--- list.stdout ---
-rw-r--r-- 0/0            2972 1985-10-26 08:15 package/tailwind.preset.cjs
-rw-r--r-- 0/0          231626 1985-10-26 08:15 package/src/assets/phosphor-duotone.css
-rw-r--r-- 0/0            6229 1985-10-26 08:15 package/src/theme.css
-rw-r--r-- 0/0            4541 1985-10-26 08:15 package/adherence.oxlintrc.json
-rw-r--r-- 0/0            2360 1985-10-26 08:15 package/package.json
-rw-r--r-- 0/0           16522 1985-10-26 08:15 package/MIGRATION.md
-rw-r--r-- 0/0             174 1985-10-26 08:15 package/src/globals.d.ts
-rw-r--r-- 0/0             473 1985-10-26 08:15 package/src/connectors/index.ts
-rw-r--r-- 0/0             556 1985-10-26 08:15 package/src/index.ts
-rw-r--r-- 0/0            1493 1985-10-26 08:15 package/src/connectors/types.ts
-rw-r--r-- 0/0            2538 1985-10-26 08:15 package/src/connectors/ConnectorCard.tsx
-rw-r--r-- 0/0            1895 1985-10-26 08:15 package/src/connectors/ConnectorCatalog.tsx
-rw-r--r-- 0/0            4854 1985-10-26 08:15 package/src/connectors/ConnectorConfigForm.tsx
-rw-r--r-- 0/0            5272 1985-10-26 08:15 package/src/connectors/ConnectorInstallWizard.tsx
-rw-r--r-- 0/0            7772 1985-10-26 08:15 package/src/controls.tsx
-rw-r--r-- 0/0            7483 1985-10-26 08:15 package/src/feedback.tsx
-rw-r--r-- 0/0             852 1985-10-26 08:15 package/src/HappyTheme.tsx
-rw-r--r-- 0/0            6712 1985-10-26 08:15 package/src/overlays.tsx
-rw-r--r-- 0/0           12499 1985-10-26 08:15 package/src/shell.tsx
-rw-r--r-- 0/0           61897 1985-10-26 08:15 package/src/ui.tsx
-rw-r--r-- 0/0          164420 1985-10-26 08:15 package/src/assets/Phosphor-Duotone.woff2
--- list.stderr (0 bytes) ---
--- unsafe.txt (count of entries outside package/, with a `..` segment, or absolute) ---
0
--- nonreg.txt (count of non-regular entries) ---
0
~~~~~~

### 0.4 Extraction

~~~~~~
--- extract.log ---
EXIT=0
~~~~~~

### 0.5 Root npm ci (cwd repo)

~~~~~~
$ npm ci --ignore-scripts --no-audit --no-fund > ../scratch/ci.stdout 2> ../scratch/ci.stderr; echo $? > ../scratch/ci.exit; cat ../scratch/ci.exit ../scratch/ci.stdout; wc -c ../scratch/ci.stderr; git status --short
--- ci.exit ---
0
--- ci.stdout (28 bytes) ---

added 1591 packages in 18s
--- ci.stderr (4557 bytes) ---
npm warn deprecated supertest@6.3.4: Please upgrade to supertest v7.1.3+, see release notes at https://github.com/forwardemail/supertest/releases/tag/v7.1.3 - maintenance is supported by Forward Email @ https://forwardemail.net
npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported
npm warn deprecated superagent@8.1.2: Please upgrade to superagent v10.2.2+, see release notes at https://github.com/forwardemail/superagent/releases/tag/v10.2.2 - maintenance is supported by Forward Email @ https://forwardemail.net
npm warn deprecated npmlog@5.0.1: This package is no longer supported.
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you want a good and tested way to coalesce async requests by a key value, which is much more comprehensive and powerful.
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported
npm warn deprecated gauge@3.0.2: This package is no longer supported.
npm warn deprecated ldapjs@3.0.7: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated are-we-there-yet@2.0.0: This package is no longer supported.
npm warn deprecated @ldapjs/protocol@1.2.1: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/attribute@1.0.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/change@1.0.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/asn1@2.0.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/controls@2.1.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/dn@1.1.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @humanwhocodes/object-schema@2.0.3: Use @eslint/object-schema instead
npm warn deprecated @humanwhocodes/config-array@0.13.0: Use @eslint/config-array instead
npm warn deprecated @ldapjs/filter@2.1.1: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/messages@1.3.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @babel/plugin-proposal-export-namespace-from@7.18.9: This proposal has been merged to the ECMAScript standard and thus this plugin is no longer maintained. Please use @babel/plugin-transform-export-namespace-from instead.
npm warn deprecated eslint@8.57.1: This version is no longer supported. Please see https://eslint.org/version-support for other options.
npm warn deprecated glob@8.1.0: Glob versions prior to v9 are no longer supported
npm warn deprecated @apollo/server-gateway-interface@1.1.1: @apollo/server-gateway-interface v1 is part of Apollo Server v4, which is deprecated and will transition to end-of-life on January 26, 2026. As long as you are already using a non-EOL version of Node.js, upgrading to v2 should take only a few minutes. See https://www.apollographql.com/docs/apollo-server/previous-versions for details.
npm warn deprecated @ldapjs/asn1@1.2.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me
npm warn deprecated @apollo/server@4.13.0: Apollo Server v4 is end-of-life since January 26, 2026. As long as you are already using a non-EOL version of Node.js, upgrading to v5 should take only a few minutes. See https://www.apollographql.com/docs/apollo-server/previous-versions for details.
--- git status --short (printed nothing: no tracked or untracked change) ---
~~~~~~

## 1. Focused regression, fixed controller (Step 1)

Jest config: root `jest.config.unit.js` (`testMatch` includes `**/packages/**/src/**/__tests__/**/*.test.ts`).
The same bash invocation first ran `cd ../scratch; npx --prefix ../repo true; cd ../repo` (a no-op I issued by mistake; it printed nothing).

~~~~~~
$ npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts > ../scratch/s1.out 2> ../scratch/s1.err; echo $? > ../scratch/s1.exit
--- s1.exit ---
0
--- s1.out (stdout) ---
2026-09-25 17:40:20 [undefined] [31merror[39m: Error getting mapped CIs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:40:20.603Z"}}
2026-09-25 17:40:20 [undefined] [31merror[39m: Error getting service dependencies {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:40:20.693Z"}}
2026-09-25 17:40:20 [undefined] [31merror[39m: Error getting service health {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:40:20.778Z"}}
2026-09-25 17:40:20 [undefined] [31merror[39m: Error getting service costs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:40:20.868Z"}}
--- s1.err (stderr) ---
PASS UNIT packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
  business-service child reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/cis
      ✓ returns 404 with the parent envelope for an unknown service (35 ms)
      ✓ returns 200 with data [] for an existing service without children (15 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (18 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (20 ms)
    GET /api/v1/business-services/:service_id/dependencies
      ✓ returns 404 with the parent envelope for an unknown service (15 ms)
      ✓ returns 200 with data [] for an existing service without children (15 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (10 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (13 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (17 ms)
  business-service metric reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/health
      ✓ returns 404 with the parent envelope for an unknown service (14 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (14 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (13 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (16 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (22 ms)
    GET /api/v1/business-services/:service_id/costs
      ✓ returns 404 with the parent envelope for an unknown service (15 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (13 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (14 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (18 ms)

Test Suites: 1 passed, 1 total
Tests:       24 passed, 24 total
Snapshots:   0 total
Time:        2.718 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/business-service-child-reads.test.ts/i.
~~~~~~

The four `error:` log lines on stdout come from case (e) of each endpoint (engine failure → 500), which logs through the
controller's catch before responding.

### Driver serialization (observed; replaces the earlier [INFERENCE] note)

Observed through the real routes in Step 1 (populated case passes with `toEqual`) and in the Step 3 HTTP bodies:
- `COUNT(*)` (int8) arrives as a JS number: `"incidents_7d":1`, `"ci_count":2`.
- `AVG`/`SUM`/ratio columns in `/health` arrive as numbers: `"avg_mttr_30d":60`, `"sla_breaches_30d":3`, `"success_rate_30d":50`.
- `total_monthly_cost` (NUMERIC) arrives as a string: `"total_monthly_cost":"150.5"`.
- `cost_by_tower` (json) arrives parsed as an object: `{"compute":100,"storage":50.5}`.
- Empty service: counts `0`, averages/sums/ratios `null`, `cost_by_tower` `null`.

No expectation had to change.

## 2. Baseline-failing proof (Step 2)

~~~~~~
$ C=packages/api-server/src/rest/controllers/business-service.controller.ts; S=../scratch
$ cp $C $S/fixed-controller.ts && git show ade7f70bee55d496f0e02b4d33188b8ff7d62329:$C > $C && npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts > $S/s2.out 2> $S/s2.err; echo $? > $S/s2.exit
$ cp $S/fixed-controller.ts $C
$ git diff --stat > $S/s2.diffstat 2>&1; echo "diffstat_exit=$?" >> $S/s2.diffstat
$ git status --short > $S/s2.status 2>&1; echo "status_exit=$?" >> $S/s2.status
--- s2.exit ---
1
--- s2.out (stdout) ---
2026-09-25 17:40:31 [undefined] [31merror[39m: Error getting mapped CIs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:40:31.017Z"}}
2026-09-25 17:40:31 [undefined] [31merror[39m: Error getting service dependencies {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:40:31.102Z"}}
2026-09-25 17:40:31 [undefined] [31merror[39m: Error getting service health {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:40:31.189Z"}}
2026-09-25 17:40:31 [undefined] [31merror[39m: Error getting service costs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:40:31.268Z"}}
--- s2.err (stderr) ---
FAIL UNIT packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
  business-service child reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/cis
      ✓ returns 404 with the parent envelope for an unknown service (36 ms)
      ✓ returns 200 with data [] for an existing service without children (15 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (15 ms)
      ✓ rejects anonymous requests with 401 before any data access (13 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (22 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (19 ms)
    GET /api/v1/business-services/:service_id/dependencies
      ✓ returns 404 with the parent envelope for an unknown service (14 ms)
      ✓ returns 200 with data [] for an existing service without children (13 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (12 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (14 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (18 ms)
  business-service metric reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/health
      ✕ returns 404 with the parent envelope for an unknown service (17 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (13 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (13 ms)
      ✕ treats injection-shaped ids as unknown services and leaves data intact (13 ms)
    GET /api/v1/business-services/:service_id/costs
      ✕ returns 404 with the parent envelope for an unknown service (14 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (13 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (12 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (13 ms)
      ✕ treats injection-shaped ids as unknown services and leaves data intact (12 ms)

  ● business-service metric reads: missing-parent semantics (PGlite) › GET /api/v1/business-services/:service_id/health › returns 404 with the parent envelope for an unknown service

    expect(received).toBe(expected) // Object.is equality

    Expected: 404
    Received: 200

      263 |   health: {
      264 |     incidents: { incidents_7d: 1, incidents_30d: 2, avg_mttr_30d: 60, sla_breaches_30d: 3 },
    > 265 |     changes: { changes_7d: 1, changes_30d: 2, success_rate_30d: 50 },
          |                                ^
      266 |   },
      267 |   // The non-current ci-new row (999) and bs-other's ci-foreign are excluded.
      268 |   costs: { ci_count: 2, total_monthly_cost: '150.5', cost_by_tower: { compute: 100, storage: 50.5 } },

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts:265:32)

  ● business-service metric reads: missing-parent semantics (PGlite) › GET /api/v1/business-services/:service_id/health › treats injection-shaped ids as unknown services and leaves data intact

    expect(received).toBe(expected) // Object.is equality

    Expected: 404
    Received: 200

      298 |     it('returns only the service\'s own metrics with the pre-change expressions', async () => {
      299 |       const res = await request(app).get(`/api/v1/business-services/bs-app/${metric}`).set(auth);
    > 300 |       expect(res.status).toBe(200);
          |                                    ^
      301 |       expect(res.body).toEqual({ success: true, data: APP_METRICS[metric] });
      302 |     });
      303 |

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts:300:36)

  ● business-service metric reads: missing-parent semantics (PGlite) › GET /api/v1/business-services/:service_id/costs › returns 404 with the parent envelope for an unknown service

    expect(received).toBe(expected) // Object.is equality

    Expected: 404
    Received: 200

      263 |   health: {
      264 |     incidents: { incidents_7d: 1, incidents_30d: 2, avg_mttr_30d: 60, sla_breaches_30d: 3 },
    > 265 |     changes: { changes_7d: 1, changes_30d: 2, success_rate_30d: 50 },
          |                                ^
      266 |   },
      267 |   // The non-current ci-new row (999) and bs-other's ci-foreign are excluded.
      268 |   costs: { ci_count: 2, total_monthly_cost: '150.5', cost_by_tower: { compute: 100, storage: 50.5 } },

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts:265:32)

  ● business-service metric reads: missing-parent semantics (PGlite) › GET /api/v1/business-services/:service_id/costs › treats injection-shaped ids as unknown services and leaves data intact

    expect(received).toBe(expected) // Object.is equality

    Expected: 404
    Received: 200

      298 |     it('returns only the service\'s own metrics with the pre-change expressions', async () => {
      299 |       const res = await request(app).get(`/api/v1/business-services/bs-app/${metric}`).set(auth);
    > 300 |       expect(res.status).toBe(200);
          |                                    ^
      301 |       expect(res.body).toEqual({ success: true, data: APP_METRICS[metric] });
      302 |     });
      303 |

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts:300:36)

Test Suites: 1 failed, 1 total
Tests:       4 failed, 20 passed, 24 total
Snapshots:   0 total
Time:        2.626 s, estimated 3 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/business-service-child-reads.test.ts/i.
--- s2.diffstat (git diff --stat after restore) ---
diffstat_exit=0
--- s2.status (git status --short after restore) ---
status_exit=0
~~~~~~

Observed split, exactly as expected: health (a) + (f) and costs (a) + (f) FAIL with `Expected: 404 / Received: 200`;
health/costs (b), (c), (d), (e) and all 12 cis/dependencies cases PASS (4 failed, 20 passed). The failing assertion is the
status check, so Jest does not print the 200 body; the baseline 200 body for a missing service is shown over real HTTP in §3.2.
The Jest code frames above point at unrelated source lines (265, 300) while the failing test titles are correct; this is a
source-map line mismatch in Jest's frame rendering, not a different failing assertion [INFERENCE: every failure is `toBe(404)`
and the (a)/(f) tests are the only ones in the metric block that assert 404].
Payload preservation: the baseline controller still passes (b) empty and (c) populated, so bodies for existing services are
identical between baseline and fix. Restore proof: after the copy-back both `git diff --stat` and `git status --short` printed
nothing (the fix is committed at `195cb23`, so an unchanged tree prints nothing).

## 3. Real mounted-route + PGlite smoke over loopback TCP (Step 3)

### 3.0 Launch method

A throwaway Jest runner that calls `app.listen(0, '127.0.0.1')` and shells out to `/usr/bin/curl` (async `execFile`, so the
in-process server keeps serving). Jest was used because the mocking of `@cmdb/database`, `bcrypt` and `Neo4jAuthRepository`
is identical to the committed suite and PGlite must run in the forked `fixtures/pglite-host.cjs` (its WASM `import()` is
rejected inside Jest's VM). No ts-node/tsx attempt was made; the first launch worked, so there are no failed attempts to report.
Scratch path: `packages/api-server/src/rest/routes/__tests__/hap187-smoke/` (a `src/**/__tests__/` path so the unit
config's `testMatch` picks it up; `packages/api-server/hap187-smoke/` would not match). It was deleted after the runs.

Mount order is server.ts's: `express.json()` → `app.use('/api/v1', getAuthMiddleware().authenticate())` →
`app.use('/api/v1/business-services', businessServiceRoutes)`. Real controller, real routes (including `auditMiddleware`, which
runs unmodified and passes GET requests straight through), real `AuthMiddleware`, real `JWTService` token.

Substitutions (all disclosed): `getPostgresClient` → IPC adapter to forked PGlite (counts queries); `@cmdb/database`'s
`getNeo4jClient`/`getAuditService` → `{}` stubs (module mock; never called on GET because `auditMiddleware` returns early);
`Neo4jAuthRepository` → in-memory store with one enabled viewer; `bcrypt` → `{}`; test JWT secret and placeholder env for
`loadConfig()`. Schema: `CREATE SCHEMA IF NOT EXISTS cmdb;` plus the verbatim `CREATE TABLE IF NOT EXISTS` blocks of
`dim_business_services`, `business_service_dependencies`, `ci_business_service_mappings`, `fact_business_service_incidents`,
`fact_business_service_changes`, `cmdb.dim_ci` extracted at runtime from `001_complete_schema.sql`. Seed: the `SEED` literal read
at runtime from `business-service-child-reads.test.ts` (identical data to the suite).

### 3.1 Harness source (verbatim; deleted after proof)

`packages/api-server/src/rest/routes/__tests__/hap187-smoke/smoke.harness.test.ts` (the only file):

~~~~~~typescript
// THROWAWAY HAP-187 smoke harness (deleted after proof). Real HTTP listener on
// 127.0.0.1:0 driven by curl over loopback TCP; SQL executed by forked PGlite.
import { fork, execFile } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AddressInfo } from 'net';
import express from 'express';

Object.assign(process.env, {
  JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters-long',
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, '../fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}

let queryCount = 0;
const pgClient = {
  query: async (sql: string, params: unknown[] = []) => {
    queryCount++;
    return { rows: await send('query', sql, params) };
  },
};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => ({}),
  getAuditService: () => ({}),
}));
jest.mock('bcrypt', () => ({}));
const VIEWER_ID = 'viewer-user-1';
jest.mock('../../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) =>
      userId === VIEWER_ID ? { _id: VIEWER_ID, _username: 'viewer', _role: 'viewer', _enabled: true } : null,
  })),
}));

import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../../auth/auth-bootstrap';
import { businessServiceRoutes } from '../../business-service.routes';

const MIGRATION = join(__dirname, '../../../../../../database/src/postgres/migrations/001_complete_schema.sql');
const DDL_TABLES = ['dim_business_services', 'business_service_dependencies', 'ci_business_service_mappings',
  'fact_business_service_incidents', 'fact_business_service_changes', 'cmdb.dim_ci'];
function productionDdl(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  return 'CREATE SCHEMA IF NOT EXISTS cmdb;\n' + DDL_TABLES.map(table => {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!m) throw new Error(`DDL for ${table} not found`);
    return m[0];
  }).join('\n');
}
// Identical to business-service-child-reads.test.ts SEED.
const SEED = readFileSync(join(__dirname, '../business-service-child-reads.test.ts'), 'utf8')
  .match(/const SEED = `([\s\S]*?)`;/)![1];

const out = (s: string) => process.stdout.write(s + '\n');
function curl(url: string, token?: string): Promise<void> {
  const args = ['-sS', '-w', '\nHTTP_STATUS:%{http_code}\n'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push(url);
  return new Promise(resolve => {
    execFile('curl', args, (err, stdout, stderr) => {
      out(`$ curl ${args.map(a => (a.includes(' ') || a.includes('\n') ? JSON.stringify(a) : a)).join(' ')}`);
      out(stdout + (stderr ? `[stderr] ${stderr}` : '') + `[curl exit] ${err ? err.code : 0}`);
      resolve();
    });
  });
}

jest.setTimeout(60000);
it('hap187 smoke', async () => {
  await send('exec', productionDdl() + SEED);
  const app = express();
  app.use(express.json());
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/business-services', businessServiceRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/api/v1/business-services`;
  const token = new JWTService(loadConfig().auth.jwt).generateAccessToken(VIEWER_ID, 'viewer', 'viewer');
  out(`MODE=${process.env.HAP187_MODE} listening on 127.0.0.1:${port}`);

  if (process.env.HAP187_MODE === 'baseline') {
    out('--- 7. baseline controller: missing service ---');
    for (const m of ['health', 'costs']) await curl(`${base}/bs-missing/${m}`, token);
  } else {
    out('--- 1/2. bs-app populated ---');
    for (const m of ['health', 'costs']) await curl(`${base}/bs-app/${m}`, token);
    out('--- 3. bs-empty ---');
    for (const m of ['health', 'costs']) await curl(`${base}/bs-empty/${m}`, token);
    out('--- 4. bs-missing ---');
    for (const m of ['health', 'costs']) await curl(`${base}/bs-missing/${m}`, token);
    out('--- 5. no token ---');
    queryCount = 0;
    for (const m of ['health', 'costs']) await curl(`${base}/bs-app/${m}`);
    out(`adapter queryCount during unauthenticated requests: ${queryCount}`);
    out('--- 6. tables offline ---');
    await send('exec', 'ALTER TABLE fact_business_service_incidents RENAME TO fact_business_service_incidents_offline;');
    await send('exec', 'ALTER TABLE ci_business_service_mappings RENAME TO ci_business_service_mappings_offline;');
    out('renamed fact_business_service_incidents, ci_business_service_mappings -> *_offline');
    for (const m of ['health', 'costs']) await curl(`${base}/bs-app/${m}`, token);
    await send('exec', 'ALTER TABLE fact_business_service_incidents_offline RENAME TO fact_business_service_incidents;');
    await send('exec', 'ALTER TABLE ci_business_service_mappings_offline RENAME TO ci_business_service_mappings;');
    out('restored tables; re-check:');
    for (const m of ['health', 'costs']) await curl(`${base}/bs-app/${m}`, token);
  }
  await new Promise(r => server.close(r));
  host.kill();
});
~~~~~~

### 3.2 Fixed controller (requests 1–6)

~~~~~~
$ HAP187_MODE=fixed npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/hap187-smoke/smoke.harness.test.ts > ../scratch/s3fixed.out 2> ../scratch/s3fixed.err; echo $? > ../scratch/s3fixed.exit
--- s3fixed.exit ---
0
--- s3fixed.out (stdout) ---
MODE=fixed listening on 127.0.0.1:46631
--- 1/2. bs-app populated ---
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-app/health
{"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":2,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":2,"success_rate_30d":50}}}
HTTP_STATUS:200
[curl exit] 0
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-app/costs
{"success":true,"data":{"ci_count":2,"total_monthly_cost":"150.5","cost_by_tower":{"compute":100,"storage":50.5}}}
HTTP_STATUS:200
[curl exit] 0
--- 3. bs-empty ---
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-empty/health
{"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":null,"sla_breaches_30d":null},"changes":{"changes_7d":0,"changes_30d":0,"success_rate_30d":null}}}
HTTP_STATUS:200
[curl exit] 0
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-empty/costs
{"success":true,"data":{"ci_count":0,"total_monthly_cost":null,"cost_by_tower":null}}
HTTP_STATUS:200
[curl exit] 0
--- 4. bs-missing ---
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-missing/health
{"success":false,"error":"Business service not found"}
HTTP_STATUS:404
[curl exit] 0
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-missing/costs
{"success":false,"error":"Business service not found"}
HTTP_STATUS:404
[curl exit] 0
--- 5. no token ---
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" http://127.0.0.1:46631/api/v1/business-services/bs-app/health
{"_error":"Unauthorized","_message":"No authentication credentials provided"}
HTTP_STATUS:401
[curl exit] 0
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" http://127.0.0.1:46631/api/v1/business-services/bs-app/costs
{"_error":"Unauthorized","_message":"No authentication credentials provided"}
HTTP_STATUS:401
[curl exit] 0
adapter queryCount during unauthenticated requests: 0
--- 6. tables offline ---
renamed fact_business_service_incidents, ci_business_service_mappings -> *_offline
2026-09-25 17:41:16 [undefined] [31merror[39m: Error getting service health {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:41:16.408Z"}}
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-app/health
{"success":false,"error":"Failed to get service health metrics","message":"relation \"fact_business_service_incidents\" does not exist"}
HTTP_STATUS:500
[curl exit] 0
2026-09-25 17:41:16 [undefined] [31merror[39m: Error getting service costs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:41:16.421Z"}}
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-app/costs
{"success":false,"error":"Failed to get service costs","message":"relation \"ci_business_service_mappings\" does not exist"}
HTTP_STATUS:500
[curl exit] 0
restored tables; re-check:
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-app/health
{"success":true,"data":{"incidents":{"incidents_7d":1,"incidents_30d":2,"avg_mttr_30d":60,"sla_breaches_30d":3},"changes":{"changes_7d":1,"changes_30d":2,"success_rate_30d":50}}}
HTTP_STATUS:200
[curl exit] 0
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwNzYsImV4cCI6MTc5MDM1ODk3NiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.DQv1GledaV3JqtbgVn3hkWl-XkL9tf1KBMpX-Ihisx8" http://127.0.0.1:46631/api/v1/business-services/bs-app/costs
{"success":true,"data":{"ci_count":2,"total_monthly_cost":"150.5","cost_by_tower":{"compute":100,"storage":50.5}}}
HTTP_STATUS:200
[curl exit] 0
--- s3fixed.err (stderr) ---
PASS UNIT packages/api-server/src/rest/routes/__tests__/hap187-smoke/smoke.harness.test.ts
  ✓ hap187 smoke (1451 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        2.429 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/hap187-smoke\/smoke.harness.test.ts/i.
~~~~~~

### 3.3 Baseline controller from ade7f70 (request 7), restore, harness deletion

~~~~~~
$ C=packages/api-server/src/rest/controllers/business-service.controller.ts; S=../scratch; H=packages/api-server/src/rest/routes/__tests__/hap187-smoke
$ cp $C $S/fixed-controller2.ts && git show ade7f70bee55d496f0e02b4d33188b8ff7d62329:$C > $C && HAP187_MODE=baseline npx jest -c jest.config.unit.js $H/smoke.harness.test.ts > $S/s3base.out 2> $S/s3base.err; echo $? > $S/s3base.exit
$ cp $S/fixed-controller2.ts $C
$ git diff --stat > $S/s3.diffstat 2>&1; echo "diffstat_exit=$?" >> $S/s3.diffstat
$ cp $H/smoke.harness.test.ts $S/smoke.harness.test.ts; rm -r $H
$ git status --short > $S/s3.status 2>&1; echo "status_exit=$?" >> $S/s3.status
--- s3base.exit ---
0
--- s3base.out (stdout) ---
MODE=baseline listening on 127.0.0.1:35859
--- 7. baseline controller: missing service ---
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwODQsImV4cCI6MTc5MDM1ODk4NCwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.xHdi1pAKmN8upVQ2LYTFlOwJT_3jY72rtGp6oktUxms" http://127.0.0.1:35859/api/v1/business-services/bs-missing/health
{"success":true,"data":{"incidents":{"incidents_7d":0,"incidents_30d":0,"avg_mttr_30d":null,"sla_breaches_30d":null},"changes":{"changes_7d":0,"changes_30d":0,"success_rate_30d":null}}}
HTTP_STATUS:200
[curl exit] 0
$ curl -sS -w "\nHTTP_STATUS:%{http_code}\n" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoidmlld2VyLXVzZXItMSIsIl91c2VybmFtZSI6InZpZXdlciIsIl9yb2xlIjoidmlld2VyIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAzNTgwODQsImV4cCI6MTc5MDM1ODk4NCwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.xHdi1pAKmN8upVQ2LYTFlOwJT_3jY72rtGp6oktUxms" http://127.0.0.1:35859/api/v1/business-services/bs-missing/costs
{"success":true,"data":{"ci_count":0,"total_monthly_cost":null,"cost_by_tower":null}}
HTTP_STATUS:200
[curl exit] 0
--- s3base.err (stderr) ---
PASS UNIT packages/api-server/src/rest/routes/__tests__/hap187-smoke/smoke.harness.test.ts
  ✓ hap187 smoke (1335 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        2.216 s, estimated 3 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/hap187-smoke\/smoke.harness.test.ts/i.
--- s3.diffstat (git diff --stat after restoring the fixed controller) ---
diffstat_exit=0
--- s3.status (git status --short after deleting the harness) ---
status_exit=0
~~~~~~

Baseline returns 200 with a zero/null body for `bs-missing` on both endpoints; the fix returns 404
`{"success":false,"error":"Business service not found"}`. Nothing throwaway remains in the worktree (empty status).
The JWTs printed above are test-only tokens signed with the public test secret and expire 15 minutes after issue.

## 4. Substitutions and limitations

- PostgreSQL: PGlite (WASM) in a forked child process (`fixtures/pglite-host.cjs`). It has no TimescaleDB, so
  `fact_business_service_incidents` and `fact_business_service_changes` are plain tables: only their `CREATE TABLE` blocks are
  extracted from `001_complete_schema.sql`, without `create_hypertable` or indexes.
- User store: `Neo4jAuthRepository` is replaced by an in-memory store with one enabled viewer user. `bcrypt` is stubbed.
- JWT: a test-only secret (`JWT_SECRET` set in the test/harness). Tokens are real `JWTService` tokens verified by the real `authenticate()`.
- HTTP: Step 1/2 use supertest against an ephemeral loopback server; Step 3 uses a real `app.listen(0, '127.0.0.1')` listener driven by curl.
- No production PostgreSQL/TimescaleDB, no Neo4j/Redis, and no deployment was exercised. `business-service.routes.test.ts` and the rest of the suite were not run.

## 5. Re-run after comment-only test change

Run 2026-09-25 ~17:52Z by the correction dispatch (see header) at head `51576bc33680673ad2b0d48a317f76d273578cdf` plus the
working-tree change below. The only change to the test file is the comment above `EMPTY_METRICS`, replacing the stale
"[INFERENCE, UNRUN]" note with the serialization observed in §1 ("Driver serialization (observed …)").

### 5.0 Prerequisites (node_modules was missing again)

At orientation, `ls node_modules 2>&1 | wc -l` printed `1` (the error line), and `ls -d node_modules ../happy-technologies-design-system ../scratch`
printed `ls: cannot access '<path>': No such file or directory` for all three. The exact §0 command block (HAP-174 §9 procedure,
`J=/home/coder/jobs/bf709f12-abc1-4d31-a48b-e7b6a023be1a`)
was re-run, followed by root `npm ci`. Observed:

~~~~~~
--- realpath $J/repo/../happy-technologies-design-system ---
/home/coder/jobs/bf709f12-abc1-4d31-a48b-e7b6a023be1a/happy-technologies-design-system
--- pack.exit ---
0
--- sha1.txt ---
60d6c25cd69620c1301622bb64a81d01ce34e78b  happy-technologies-design-system-0.7.1.tgz
--- sha512.txt ---
sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew==
--- list.exit ---
0
--- unsafe.txt ---
0
--- nonreg.txt ---
0
--- extract.log ---
EXIT=0
--- wc -c pack.stdout pack.stderr list.stderr; wc -l < list.stdout ---
2597 pack.stdout
   0 pack.stderr
   0 list.stderr
2597 total
21
$ npm ci --ignore-scripts --no-audit --no-fund > ../scratch/ci.stdout 2> ../scratch/ci.stderr; echo "ci_exit=$?"; cat ../scratch/ci.stdout; wc -c < ../scratch/ci.stderr; git status --short
ci_exit=0

added 1591 packages in 18s
4557
 M packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
~~~~~~

SHA1 and SHA512 equal the HAP-174 §9.4 registry values (same as §0.2). The ci.stderr byte count (4557) equals §0.5; its
content was not re-printed. `git status --short` shows only the comment change (made before `npm ci`).

### 5.1 Focused suite

Exact command (cwd repo; the redirect/echo wrapper only captures output and exit code):

~~~~~~
$ npx jest -c jest.config.unit.js packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts > ../scratch/r5.out 2> ../scratch/r5.err; echo $? > ../scratch/r5.exit
--- exit ---
0
--- stdout (729 bytes) ---
2026-09-25 17:52:08 [undefined] error: Error getting mapped CIs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:52:08.093Z"}}
2026-09-25 17:52:08 [undefined] error: Error getting service dependencies {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:52:08.186Z"}}
2026-09-25 17:52:08 [undefined] error: Error getting service health {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:52:08.278Z"}}
2026-09-25 17:52:08 [undefined] error: Error getting service costs {"metadata":{"service":"cmdb","error":{},"service_id":"bs-app","timestamp":"2026-09-25T17:52:08.367Z"}}
--- stderr (2657 bytes) ---
PASS UNIT packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
  business-service child reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/cis
      ✓ returns 404 with the parent envelope for an unknown service (36 ms)
      ✓ returns 200 with data [] for an existing service without children (15 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (17 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (20 ms)
    GET /api/v1/business-services/:service_id/dependencies
      ✓ returns 404 with the parent envelope for an unknown service (17 ms)
      ✓ returns 200 with data [] for an existing service without children (15 ms)
      ✓ returns only the service's own children with the pre-change projection, newest first (13 ms)
      ✓ rejects anonymous requests with 401 before any data access (11 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (14 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (18 ms)
  business-service metric reads: missing-parent semantics (PGlite)
    GET /api/v1/business-services/:service_id/health
      ✓ returns 404 with the parent envelope for an unknown service (16 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (15 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (13 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (16 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (19 ms)
    GET /api/v1/business-services/:service_id/costs
      ✓ returns 404 with the parent envelope for an unknown service (14 ms)
      ✓ returns 200 with zero/null metrics for an existing service without data (14 ms)
      ✓ returns only the service's own metrics with the pre-change expressions (14 ms)
      ✓ rejects anonymous requests with 401 before any data access (13 ms)
      ✓ surfaces an engine failure as 500, not an empty 200 (14 ms)
      ✓ treats injection-shaped ids as unknown services and leaves data intact (19 ms)

Test Suites: 1 passed, 1 total
Tests:       24 passed, 24 total
Snapshots:   0 total
Time:        2.763 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/business-service-child-reads.test.ts/i.
~~~~~~

Exit code 0; 24/24 pass. The four stdout `error:` lines are the expected logs of the four "engine failure → 500" cases.

### 5.2 Blobs

~~~~~~
$ git hash-object packages/api-server/src/rest/controllers/business-service.controller.ts packages/api-server/src/rest/routes/business-service.routes.ts packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
9ec3acd23eef5117c806c38e3c9ce31e6e760d7f
9998baf66e03b39ced0f6e1e4a940bb1cefe2559
7a53fe13fa148c8784a3d92de8e3944913b40dcf
~~~~~~

Controller `9ec3acd…` and routes `9998baf…` equal the required values (unchanged). New test blob: `7a53fe13fa148c8784a3d92de8e3944913b40dcf`.

### 5.3 Diff against 51576bc

Test file (raw `git --no-pager diff --no-color 51576bc -- <test>`, exit 0):

~~~~~~
diff --git a/packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts b/packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
index 41839eb..7a53fe1 100644
--- a/packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
+++ b/packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
@@ -246,10 +246,10 @@ describe('business-service child reads: missing-parent semantics (PGlite)', () =
   });
 });
 
-// Driver serialisation [INFERENCE, UNRUN]: PGlite parses int8 (COUNT/SUM of
-// INT) to a JS number when it is a safe integer, returns NUMERIC as a string
-// ('150.5'), and parses json into an object. If the validation run shows the
-// driver differs, adjust these expectations only, never the controller.
+// Driver serialisation, observed in HAP-187 validation (docs/archive/HAP-187-validation.md):
+// through PGlite, int8 COUNT/SUM arrive as JS numbers, AVG/ratio values as
+// numbers, NUMERIC total_monthly_cost as the string '150.5', and json
+// cost_by_tower as a parsed object.
 const EMPTY_METRICS: Record<string, unknown> = {
   health: {
     incidents: { incidents_7d: 0, incidents_30d: 0, avg_mttr_30d: null, sla_breaches_30d: null },
~~~~~~

`git diff --stat 51576bc` (captured after everything in this section above this block was written; this block and the
sentence introducing it add further lines to the doc, so the doc's final count is in the external validation.md):

~~~~~~
$ git --no-pager diff --no-color --stat 51576bc; echo "diffstat_exit=$?"; git status --short
 docs/archive/HAP-187-validation.md                 | 171 +++++++++++++++++++--
 .../__tests__/business-service-child-reads.test.ts |   8 +-
 2 files changed, 165 insertions(+), 14 deletions(-)
diffstat_exit=0
 M docs/archive/HAP-187-validation.md
 M packages/api-server/src/rest/routes/__tests__/business-service-child-reads.test.ts
~~~~~~

Only two paths differ from 51576bc: this doc and the test file, whose 4 insertions / 4 deletions are exactly the comment lines
shown in the raw diff above. Controller and routes are absent from the stat. Nothing was committed or merged.
