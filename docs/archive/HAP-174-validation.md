# HAP-174 validation evidence (PR #20)

Evidence index (this file is the durable record; PR body copies may truncate):
- Section 9 (appended 2026-09-23T20:12Z, head `3578bb56d841c8e213185682e8a3fc4aaa4f777b`): FRESH COMPLETE, unfiltered capture of the
  dependency prerequisites (raw `npm pack --json` stdout/stderr/exit, hashes, full archive listing, extraction, registry metadata,
  raw root `npm ci` stdout/stderr/exit, post-install `git status`). This is the authoritative prerequisite proof.
- Sections 1 and 2 are PARTIAL historical excerpts, not full captures: section 1's original `npm pack` output was piped through `jq`
  and the listing through `grep`; section 2 shows only the tail of the `npm ci` log. The unfiltered bytes of those original runs are lost
  (scratch dir scrubbed) and were NOT recovered or reconstructed; section 9 replaces them as evidence.
- Harness history: the very first mounted attempt failed on `target.hasPointerCapture is not a function` (driver lacked the jsdom Radix
  polyfills that `BusinessServices.test.tsx` already carries); its log was overwritten by the re-run and is LOST, not reproduced or recovered.
  Sections 5, 6, 7.1, 7.2 and 8 are complete raw captures of their runs (including failure output).
- Scope caveat: omitting a blank `owned_by` fixes acceptance of a blank optional owner on create/edit. It does NOT implement owner
  clearing: an edit that blanks the owner omits `owned_by` from the PATCH, so the stored owner is retained. Owner clearing is a separate
  feature outside HAP-174.
- Committed path: `docs/archive/HAP-174-validation.md` on branch `agent/hap-174-canonical-service-criticality`.
- Base of this session: `9e0ceefbe622b036c8c529baff5aa3d28eaab647`. Pre-fix page: `c5a4e6fa521774043697d999672bb74ea01c6598`.

## 0. Prior-run evidence status

The previous run's `/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/validation.md` did NOT survive
(job directory scrubbed; `ls ..` showed only `agent/ home/ repo/ session/ tmp/`). Its output is not reproduced here.
All evidence below was re-exercised in this session (2026-09-23).

## 1. Dependency provisioning (genuine public artifact) — PARTIAL historical excerpt (filtered via jq/grep; see section 9)

```
$ cd ../scratch && npm pack @happy-technologies/design-system@0.7.1 --ignore-scripts --registry=https://registry.npmjs.org/ --json | jq -c '.[0]|{filename,shasum,integrity}'
{"filename":"happy-technologies-design-system-0.7.1.tgz","shasum":"60d6c25cd69620c1301622bb64a81d01ce34e78b","integrity":"sha512-sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew=="}
EXIT=0
$ sha1sum happy-technologies-design-system-0.7.1.tgz
60d6c25cd69620c1301622bb64a81d01ce34e78b  happy-technologies-design-system-0.7.1.tgz
$ openssl dgst -sha512 -binary happy-technologies-design-system-0.7.1.tgz | base64 -w0
sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew==
$ tar tzf happy-technologies-design-system-0.7.1.tgz | grep -v '^package/' | wc -l     # prefix check only; does NOT by itself exclude `..` segments (see section 9)
0
$ tar tzf ... | grep -E 'package/(package.json|src/index.ts|src/theme.css)$'
package/src/theme.css
package/package.json
package/src/index.ts
$ mkdir -p ../happy-technologies-design-system && tar xzf happy-technologies-design-system-0.7.1.tgz -C ../happy-technologies-design-system --strip-components=1
$ jq -c '{name,version,gitHead,exports}' ../happy-technologies-design-system/package.json
{"name":"@happy-technologies/design-system","version":"0.7.1","gitHead":null,"exports":{".":"./src/index.ts","./theme.css":"./src/theme.css","./assets/*":"./src/assets/*","./adherence":"./adherence.oxlintrc.json","./tailwind.preset.cjs":"./tailwind.preset.cjs"}}
$ npm view @happy-technologies/design-system@0.7.1 gitHead dist.integrity --registry=https://registry.npmjs.org/
gitHead = 'acb0c9481837131360e822f58ced7196a27f7ab2'
dist.integrity = 'sha512-sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew=='
$ grep -n -A3 '^    "../happy-technologies-design-system": {' package-lock.json
61:    "../happy-technologies-design-system": {
62-      "name": "@happy-technologies/design-system",
63-      "version": "0.7.1",
```

Note: the tarball's own `package.json` carries `gitHead: null`; the registry manifest records gitHead
`acb0c9481837131360e822f58ced7196a27f7ab2` for the identical integrity. No sibling source modified, no DS build/test.

## 2. Root install — PARTIAL historical excerpt (log tail only; see section 9)

```
$ npm ci --ignore-scripts --no-audit --no-fund      # tail of ../scratch/npm-ci.log
added 1591 packages in 18s
EXIT=0
```
`git status --short` afterwards showed only the new `docs/` dir: tracked manifests/lock unchanged.

## 3. Summary of results (full raw output in sections 5-9; sections 1-2 are partial excerpts)

| Check | Result |
|---|---|
| Dependency prerequisites (fresh, complete capture) | DS 0.7.1 pack exit 0, SHA1/SHA512 match, 21 regular files all under `package/`, no `..`/absolute paths; root `npm ci` exit 0, tracked files unchanged (section 9) |
| Focused `BusinessServices.test.tsx`, final page | 6/6 pass, exit 0 (section 5) |
| Same, page swapped to pre-fix `c5a4e6f` | 6/6 fail, exit 1; page restored via `git checkout` (section 6) |
| Mounted UI → real route/Joi/controller → PGlite, first run | canonical labels/filter PASS; create + edit FAILED with real Joi 400 `"owned_by" is not allowed to be empty` (section 7.1) |
| Page fix: `mapUIToAPI` sends `owned_by: uiService.owner \|\| undefined` | pre-existing defect (c5a4e6f also sent `owned_by: uiService.owner`, i.e. `''` for a blank owner) that blocked every UI create/edit without an owner against the real schema (`owned_by: Joi.string().optional()`) |
| Mounted run after fix | 5/5 driver tests pass, harness exit 0; DB shows `Harness New`=high, `bs-c`=low (section 7.2) |
| Focused test re-run after page fix | 6/6 pass, exit 0 (section 5 is the post-fix run) |
| Browser | none available: `which chromium chromium-browser google-chrome firefox` found nothing; no Playwright cache. Substitute: jsdom component runtime (vitest) rendering the real `BusinessServices` page, real `apiClient`/axios XHR over real TCP to the harness server. No visual check performed. |

Scope gaps (disclosed, not exercised in the mounted run): "unknown criticality cannot silently submit" is proven only by the focused mocked test
(`requires an explicit selection before saving a row with unknown criticality`); the mounted run did not seed a non-canonical row
(the DB table stores what Joi allows). No regression assertion was added to the focused test for the `owned_by` omission; the mounted run is its proof.

## 4. Substitutions and teardown (mounted harness)

- DB: in-memory PGlite (forked `fixtures/pglite-host.cjs`), DDL extracted verbatim from `packages/database/src/postgres/migrations/001_complete_schema.sql`
  for `dim_business_services`, `business_service_dependencies`, `ci_business_service_mappings`; 4 seeded rows (critical/high/medium/low).
- `@cmdb/database` jest-mocked: `getPostgresClient` → PGlite IPC client; Neo4j/audit → `{}`. `bcrypt` mocked `{}` (login path unused).
- Auth: real `getAuthMiddleware().authenticate()` + real `requirePermission('write')`; user store substituted by an in-memory
  `Neo4jAuthRepository.findUserById` returning one enabled `admin`; JWT minted by real `JWTService` with a test-only secret; placeholder env (no real services contacted).
- Harness-only CORS middleware (jsdom XHR enforces CORS; page origin ≠ harness port) and a request logger (`[api] ...` lines).
- Server: `express.listen(0, '127.0.0.1')` ephemeral port; UI: `npx vitest run` in `web-ui` with `VITE_API_BASE_URL=http://127.0.0.1:<port>/api/v1`, token via `localStorage.auth_token`.
- "Reload" = `cleanup()` unmount then fresh mount, which issues a new real GET.
- Teardown: `finally { server.close(); host.kill(); }`. No production entrypoint, workers, Neo4j/Redis/Postgres started.
- Both harness files were deleted after the proof (not committed); their exact source is in section 8.

Command (run from `packages/api-server`):
```
npx jest --config ../../jest.config.unit.js --rootDir ../.. packages/api-server/src/rest/routes/__tests__/hap174-mounted.harness.test.ts > ../../../scratch/mounted.log 2>&1; echo "EXIT=$?" >> ../../../scratch/mounted.log
```

## 5. Focused test, final page (post owned_by fix)

$ npm --prefix web-ui run test:run -- src/pages/BusinessServices.test.tsx

~~~~~~

> @cmdb/web-ui@1.0.0 test:run
> vitest run src/pages/BusinessServices.test.tsx

▲ [WARNING] Duplicate key "allowSyntheticDefaultImports" in object literal [duplicate-object-key]

    ../tsconfig.base.json:25:4:
      25 │     "allowSyntheticDefaultImports": true,
         ╵     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

  The original key "allowSyntheticDefaultImports" is here:

    ../tsconfig.base.json:11:4:
      11 │     "allowSyntheticDefaultImports": true,
         ╵     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~


 RUN  v3.2.4 /home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui

stderr | src/pages/BusinessServices.test.tsx > BusinessServices page > renders each canonical criticality distinctly and non-canonical values as Unknown
⚠️ React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition` in v7. You can use the `v7_startTransition` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_starttransition.
⚠️ React Router Future Flag Warning: Relative route resolution within Splat routes is changing in v7. You can use the `v7_relativeSplatPath` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_relativesplatpath.

stderr | src/pages/BusinessServices.test.tsx > BusinessServices page > keeps the form and current row when the server rejects the write
Failed to save business service: {
  response: {
    status: 400,
    data: {
      _success: false,
      _error: 'Validation Error',
      _message: '"name" length must be at least 3 characters long',
      _details: [Array]
    }
  }
}

 ✓ src/pages/BusinessServices.test.tsx (6 tests) 2583ms
   ✓ BusinessServices page > filters rows by canonical criticality  382ms
   ✓ BusinessServices page > requires an explicit criticality on create and sends the canonical value  701ms
   ✓ BusinessServices page > starts editing at the stored criticality and sends the changed canonical value  745ms
   ✓ BusinessServices page > requires an explicit selection before saving a row with unknown criticality  306ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  20:06:28
   Duration  4.19s (transform 306ms, setup 132ms, collect 538ms, tests 2.58s, environment 466ms, prepare 143ms)

EXIT=0
~~~~~~

## 6. Baseline: page swapped to c5a4e6f (then `git checkout -- web-ui/src/pages/BusinessServices.tsx`)

$ git show c5a4e6fa521774043697d999672bb74ea01c6598:web-ui/src/pages/BusinessServices.tsx > web-ui/src/pages/BusinessServices.tsx && npm --prefix web-ui run test:run -- src/pages/BusinessServices.test.tsx

~~~~~~

> @cmdb/web-ui@1.0.0 test:run
> vitest run src/pages/BusinessServices.test.tsx

▲ [WARNING] Duplicate key "allowSyntheticDefaultImports" in object literal [duplicate-object-key]

    ../tsconfig.base.json:25:4:
      25 │     "allowSyntheticDefaultImports": true,
         ╵     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

  The original key "allowSyntheticDefaultImports" is here:

    ../tsconfig.base.json:11:4:
      11 │     "allowSyntheticDefaultImports": true,
         ╵     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~


 RUN  v3.2.4 /home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui

stderr | src/pages/BusinessServices.test.tsx > BusinessServices page > renders each canonical criticality distinctly and non-canonical values as Unknown
⚠️ React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition` in v7. You can use the `v7_startTransition` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_starttransition.
⚠️ React Router Future Flag Warning: Relative route resolution within Splat routes is changing in v7. You can use the `v7_relativeSplatPath` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_relativesplatpath.

stderr | src/pages/BusinessServices.test.tsx > BusinessServices page > keeps the form and current row when the server rejects the write
Failed to save business service: {
  response: {
    status: 400,
    data: {
      _success: false,
      _error: 'Validation Error',
      _message: '"name" length must be at least 3 characters long',
      _details: [Array]
    }
  }
}

 ❯ src/pages/BusinessServices.test.tsx (6 tests | 6 failed) 2517ms
   × BusinessServices page > renders each canonical criticality distinctly and non-canonical values as Unknown 136ms
     → Unable to find an element with the text: Critical. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

Ignored nodes: comments, script, style
[36m<tr[39m
  [33mclass[39m=[32m"border-b border-border hover:bg-accent transition-colors"[39m
[36m>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"font-medium"[39m
      [36m>[39m
        [0mSvc Critical[0m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"text-xs text-muted-foreground"[39m
      [36m>[39m
        [0mPublic customer portal[0m
      [36m</div>[39m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors bg-sky-soft text-sky-text"[39m
    [36m>[39m
      [0mTier [0m
      [0m3[0m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors border-line bg-success-soft text-success"[39m
    [36m>[39m
      [0mactive[0m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m$500,000[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m12,000[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m$8,200[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [36m<span[39m
      [33mclass[39m=[32m"text-muted-foreground"[39m
    [36m>[39m
      [0m4[0m
    [36m</span>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"flex gap-2 justify-end"[39m
    [36m>[39m
      [36m<button[39m
        [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
      [36m>[39m
        [36m<i[39m
          [33maria-hidden[39m=[32m"true"[39m
          [33mclass[39m=[32m"ph-duotone ph-pencil-simple"[39m
          [33mstyle[39m=[32m"font-size: 16px;"[39m
        [36m/>[39m
      [36m</button>[39m
      [36m<button[39m
        [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
      [36m>[39m
        [36m<i[39m
          [33maria-hidden[39m=[32m"true"[39m
          [33mclass[39m=[32m"ph-duotone ph-trash"[39m
          [33mstyle[39m=[32m"font-size: 16px;"[39m
        [36m/>[39m
      [36m</button>[39m
    [36m</div>[39m
  [36m</td>[39m
[36m</tr>[39m
   × BusinessServices page > filters rows by canonical criticality 1115ms
     → Unable to find an accessible element with the role "combobox" and name `/filter by criticality/i`

Here are the accessible roles:

  heading:

  Name "Business Services":
  [36m<h1[39m
    [33mclass[39m=[32m"mt-3 text-[1.9rem]"[39m
  [36m/>[39m

  --------------------------------------------------
  paragraph:

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"mt-1.5 text-ink-soft"[39m
  [36m/>[39m

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
  [36m/>[39m

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
  [36m/>[39m

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
  [36m/>[39m

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
  [36m/>[39m

  --------------------------------------------------
  button:

  Name "Create Service":
  [36m<button[39m
    [33maria-controls[39m=[32m"radix-:ra:"[39m
    [33maria-expanded[39m=[32m"false"[39m
    [33maria-haspopup[39m=[32m"dialog"[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"[39m
    [33mdata-state[39m=[32m"closed"[39m
    [33mtype[39m=[32m"button"[39m
  [36m/>[39m

  Name "":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
  [36m/>[39m

  Name "":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
  [36m/>[39m

  Name "":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
  [36m/>[39m

  Name "":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
  [36m/>[39m

  --------------------------------------------------
  textbox:

  Name "":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 pl-10"[39m
    [33mplaceholder[39m=[32m"Search services..."[39m
    [33mvalue[39m=[32m""[39m
  [36m/>[39m

  --------------------------------------------------
  combobox:

  Name "":
  [36m<button[39m
    [33maria-autocomplete[39m=[32m"none"[39m
    [33maria-controls[39m=[32m"radix-:re:"[39m
    [33maria-expanded[39m=[32m"false"[39m
    [33mclass[39m=[32m"flex h-11 items-center justify-between whitespace-nowrap rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 w-[200px]"[39m
    [33mdata-state[39m=[32m"closed"[39m
    [33mdir[39m=[32m"ltr"[39m
    [33mrole[39m=[32m"combobox"[39m
    [33mtype[39m=[32m"button"[39m
  [36m/>[39m

  --------------------------------------------------
  table:

  Name "":
  [36m<table[39m
    [33mclass[39m=[32m"w-full"[39m
  [36m/>[39m

  --------------------------------------------------
  rowgroup:

  Name "":
  [36m<thead />[39m

  Name "":
  [36m<tbody />[39m

  --------------------------------------------------
  row:

  Name "Service Name Tier Status Revenue Impact Users Monthly Cost Supporting CIs Actions":
  [36m<tr[39m
    [33mclass[39m=[32m"border-b border-border"[39m
  [36m/>[39m

  Name "Svc Critical Public customer portal Tier 3 active $500,000 12,000 $8,200 4":
  [36m<tr[39m
    [33mclass[39m=[32m"border-b border-border hover:bg-accent transition-colors"[39m
  [36m/>[39m

  Name "Svc Low Public customer portal Tier 3 active $500,000 12,000 $8,200 4":
  [36m<tr[39m
    [33mclass[39m=[32m"border-b border-border hover:bg-accent transition-colors"[39m
  [36m/>[39m

  --------------------------------------------------
  columnheader:

  Name "Service Name":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Tier":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Status":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Revenue Impact":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Users":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Monthly Cost":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Supporting CIs":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Actions":
  [36m<th[39m
    [33mclass[39m=[32m"text-right py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  --------------------------------------------------
  cell:

  Name "Svc Critical Public customer portal":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "Tier 3":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "active":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "$500,000":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "12,000":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "$8,200":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "4":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "Svc Low Public customer portal":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "Tier 3":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "active":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "$500,000":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "12,000":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "$8,200":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "4":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  --------------------------------------------------

Ignored nodes: comments, script, style
[36m<body>[39m
  [36m<div>[39m
    [36m<div[39m
      [33mclass[39m=[32m"container mx-auto p-6 space-y-6"[39m
    [36m>[39m
      [36m<div[39m
        [33mclass[39m=[32m"flex justify-between items-center"[39m
      [36m>[39m
        [36m<div>[39m
          [36m<span[39m
            [33mclass[39m=[32m"hh-heading inline-flex items-center rounded-[var(--hh-radius-sm)] px-3 py-1.5 text-[0.7rem] bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]"[39m
          [36m>[39m
            [0mService Catalog[0m
          [36m</span>[39m
          [36m<h1[39m
            [33mclass[39m=[32m"mt-3 text-[1.9rem]"[39m
          [36m>[39m
            [0mBusiness Services[0m
          [36m</h1>[39m
          [36m<p[39m
            [33mclass[39m=[32m"mt-1.5 text-ink-soft"[39m
          [36m>[39m
            [0mManage and monitor your business-critical services[0m
          [36m</p>[39m
        [36m</div>[39m
        [36m<button[39m
          [33maria-controls[39m=[32m"radix-:ra:"[39m
          [33maria-expanded[39m=[32m"false"[39m
          [33maria-haspopup[39m=[32m"dialog"[39m
          [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"[39m
          [33mdata-state[39m=[32m"closed"[39m
          [33mtype[39m=[32m"button"[39m
        [36m>[39m
          [36m<i[39m
            [33maria-hidden[39m=[32m"true"[39m
            [33mclass[39m=[32m"ph-duotone ph-plus mr-2"[39m
            [33mstyle[39m=[32m"font-size: 16px;"[39m
          [36m/>[39m
          [0mCreate Service[0m
        [36m</button>[39m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"grid grid-cols-1 md:grid-cols-4 gap-4"[39m
      [36m>[39m
        [36m<div[39m
          [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"p-6"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
            [36m>[39m
              [36m<span[39m
                [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
              [36m>[39m
                [0mTotal Services[0m
              [36m</span>[39m
              [36m<i[39m
                [33maria-hidden[39m=[32m"true"[39m
                [33mclass[39m=[32m"ph-duotone ph-graph text-muted-foreground"[39m
                [33mstyle[39m=[32m"font-size: 16px;"[39m
              [36m/>[39m
            [36m</div>[39m
            [36m<div[39m
              [33mclass[39m=[32m"text-3xl font-bold"[39m
            [36m>[39m
              [0m2[0m
            [36m</div>[39m
            [36m<p[39m
              [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
            [36m>[39m
              [0m2[0m
              [0m active[0m
            [36m</p>[39m
          [36m</div>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"p-6"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
            [36m>[39m
              [36m<span[39m
                [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
              [36m>[39m
                [0mTotal Revenue Impact[0m
              [36m</span>[39m
              [36m<i[39m
                [33maria-hidden[39m=[32m"true"[39m
                [33mclass[39m=[32m"ph-duotone ph-currency-dollar text-muted-foreground"[39m
                [33mstyle[39m=[32m"font-size: 16px;"[39m
              [36m/>[39m
            [36m</div>[39m
            [36m<div[39m
              [33mclass[39m=[32m"text-3xl font-bold"[39m
            [36m>[39m
              [0m$1,000,000[0m
            [36m</div>[39m
            [36m<p[39m
              [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
            [36m>[39m
              [0mAnnual[0m
            [36m</p>[39m
          [36m</div>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"p-6"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
            [36m>[39m
              [36m<span[39m
                [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
              [36m>[39m
                [0mTotal Users[0m
              [36m</span>[39m
              [36m<i[39m
                [33maria-hidden[39m=[32m"true"[39m
                [33mclass[39m=[32m"ph-duotone ph-users text-muted-foreground"[39m
                [33mstyle[39m=[32m"font-size: 16px;"[39m
              [36m/>[39m
            [36m</div>[39m
            [36m<div[39m
              [33mclass[39m=[32m"text-3xl font-bold"[39m
            [36m>[39m
              [0m24,000[0m
            [36m</div>[39m
            [36m<p[39m
              [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
            [36m>[39m
              [0mAcross all services[0m
            [36m</p>[39m
          [36m</div>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"p-6"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
            [36m>[39m
              [36m<span[39m
                [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
              [36m>[39m
                [0mMonthly IT Cost[0m
              [36m</span>[39m
              [36m<i[39m
                [33maria-hidden[39m=[32m"true"[39m
                [33mclass[39m=[32m"ph-duotone ph-trend-up text-muted-foreground"[39m
                [33mstyle[39m=[32m"font-size: 16px;"[39m
              [36m/>[39m
            [36m</div>[39m
            [36m<div[39m
              [33mclass...
   × BusinessServices page > requires an explicit criticality on create and sends the canonical value 440ms
     → expect(element).toBeDisabled()

Received element is not disabled:
  <button
  class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"
/>
   × BusinessServices page > starts editing at the stored criticality and sends the changed canonical value 391ms
     → Unable to find an accessible element with the role "combobox" and name `/^criticality$/i`

Here are the accessible roles:

  heading:

  Name "Edit Business Service":
  [36m<h2[39m
    [33mclass[39m=[32m"text-lg font-semibold leading-none tracking-tight"[39m
    [33mid[39m=[32m"radix-:r14:"[39m
  [36m/>[39m

  --------------------------------------------------
  paragraph:

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
    [33mid[39m=[32m"radix-:r15:"[39m
  [36m/>[39m

  --------------------------------------------------
  textbox:

  Name "Service Name":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"name"[39m
    [33mplaceholder[39m=[32m"e.g., Customer Portal"[39m
    [33mvalue[39m=[32m"Customer Portal"[39m
  [36m/>[39m

  Name "Description":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"description"[39m
    [33mplaceholder[39m=[32m"Brief description of the service"[39m
    [33mvalue[39m=[32m"Public customer portal"[39m
  [36m/>[39m

  Name "Service Owner":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"owner"[39m
    [33mplaceholder[39m=[32m"Team or person"[39m
    [33mvalue[39m=[32m"Platform Team"[39m
  [36m/>[39m

  --------------------------------------------------
  combobox:

  Name "":
  [36m<button[39m
    [33maria-autocomplete[39m=[32m"none"[39m
    [33maria-controls[39m=[32m"radix-:r1d:"[39m
    [33maria-expanded[39m=[32m"false"[39m
    [33mclass[39m=[32m"flex h-11 w-full items-center justify-between whitespace-nowrap rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1"[39m
    [33mdata-state[39m=[32m"closed"[39m
    [33mdir[39m=[32m"ltr"[39m
    [33mrole[39m=[32m"combobox"[39m
    [33mtype[39m=[32m"button"[39m
  [36m/>[39m

  --------------------------------------------------
  spinbutton:

  Name "Annual Revenue Impact ($)":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"revenueImpact"[39m
    [33mplaceholder[39m=[32m"0"[39m
    [33mtype[39m=[32m"number"[39m
    [33mvalue[39m=[32m"500000"[39m
  [36m/>[39m

  Name "User Count":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"userCount"[39m
    [33mplaceholder[39m=[32m"0"[39m
    [33mtype[39m=[32m"number"[39m
    [33mvalue[39m=[32m"12000"[39m
  [36m/>[39m

  --------------------------------------------------
  button:

  Name "Cancel":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border-2 border-navy bg-transparent text-navy hover:bg-navy hover:text-white h-10 px-5 py-2"[39m
  [36m/>[39m

  Name "Update Service":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"[39m
  [36m/>[39m

  Name "Close":
  [36m<button[39m
    [33mclass[39m=[32m"absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"[39m
    [33mtype[39m=[32m"button"[39m
  [36m/>[39m

  --------------------------------------------------

Ignored nodes: comments, script, style
[36m<div[39m
  [33maria-describedby[39m=[32m"radix-:r15:"[39m
  [33maria-labelledby[39m=[32m"radix-:r14:"[39m
  [33mclass[39m=[32m"left-[50%] top-[40%] z-50 grid w-full translate-x-[-50%] translate-y-[-40%] gap-4 border p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[38%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[38%] rounded-2xl relative overflow-hidden max-w-2xl"[39m
  [33mdata-state[39m=[32m"open"[39m
  [33mid[39m=[32m"radix-:r13:"[39m
  [33mrole[39m=[32m"dialog"[39m
  [33mstyle[39m=[32m"box-shadow: 0 4px 6px rgba(59, 130, 246, 0.15), 0 2px 4px rgba(239, 68, 68, 0.1), 0 8px 16px rgba(59, 130, 246, 0.1), 0 8px 16px rgba(239, 68, 68, 0.08); pointer-events: auto;"[39m
  [33mtabindex[39m=[32m"-1"[39m
[36m>[39m
  [36m<div[39m
    [33mclass[39m=[32m"absolute inset-0 rounded-2xl dialog-glass--bend--r16-"[39m
    [33mstyle[39m=[32m"filter: url(#dialog-glass-blur-:r16:);"[39m
  [36m/>[39m
  [36m<div[39m
    [33mclass[39m=[32m"absolute inset-0 rounded-2xl"[39m
    [33mstyle[39m=[32m"box-shadow: 0 4px 4px rgba(0, 0, 0, 0.15), 0 0 12px rgba(0, 0, 0, 0.08);"[39m
  [36m/>[39m
  [36m<div[39m
    [33mclass[39m=[32m"absolute inset-0 pointer-events-none rounded-2xl"[39m
    [33mstyle[39m=[32m"box-shadow: inset 3px 3px 3px 0 rgba(255, 255, 255, 0.45), inset -3px -3px 3px 0 rgba(255, 255, 255, 0.45);"[39m
  [36m/>[39m
  [36m<div[39m
    [33mclass[39m=[32m"relative z-10"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"flex flex-col space-y-1.5 text-center sm:text-left"[39m
    [36m>[39m
      [36m<h2[39m
        [33mclass[39m=[32m"text-lg font-semibold leading-none tracking-tight"[39m
        [33mid[39m=[32m"radix-:r14:"[39m
      [36m>[39m
        [0mEdit Business Service[0m
      [36m</h2>[39m
      [36m<p[39m
        [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
        [33mid[39m=[32m"radix-:r15:"[39m
      [36m>[39m
        [0mDefine a new business service and its key attributes[0m
      [36m</p>[39m
    [36m</div>[39m
    [36m<div[39m
      [33mclass[39m=[32m"grid gap-4 py-4"[39m
    [36m>[39m
      [36m<div[39m
        [33mclass[39m=[32m"grid gap-2"[39m
      [36m>[39m
        [36m<label[39m
          [33mclass[39m=[32m"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"[39m
          [33mfor[39m=[32m"name"[39m
        [36m>[39m
          [0mService Name[0m
        [36m</label>[39m
        [36m<input[39m
          [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
          [33mid[39m=[32m"name"[39m
          [33mplaceholder[39m=[32m"e.g., Customer Portal"[39m
          [33mvalue[39m=[32m"Customer Portal"[39m
        [36m/>[39m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"grid gap-2"[39m
      [36m>[39m
        [36m<label[39m
          [33mclass[39m=[32m"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"[39m
          [33mfor[39m=[32m"description"[39m
        [36m>[39m
          [0mDescription[0m
        [36m</label>[39m
        [36m<input[39m
          [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
          [33mid[39m=[32m"description"[39m
          [33mplaceholder[39m=[32m"Brief description of the service"[39m
          [33mvalue[39m=[32m"Public customer portal"[39m
        [36m/>[39m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"grid grid-cols-2 gap-4"[39m
      [36m>[39m
        [36m<div[39m
          [33mclass[39m=[32m"grid gap-2"[39m
        [36m>[39m
          [36m<label[39m
            [33mclass[39m=[32m"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"[39m
            [33mfor[39m=[32m"tier"[39m
          [36m>[39m
            [0mCriticality Tier[0m
          [36m</label>[39m
          [36m<button[39m
            [33maria-autocomplete[39m=[32m"none"[39m
            [33maria-controls[39m=[32m"radix-:r1d:"[39m
            [33maria-expanded[39m=[32m"false"[39m
            [33mclass[39m=[32m"flex h-11 w-full items-center justify-between whitespace-nowrap rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1"[39m
            [33mdata-state[39m=[32m"closed"[39m
            [33mdir[39m=[32m"ltr"[39m
            [33mrole[39m=[32m"combobox"[39m
            [33mtype[39m=[32m"button"[39m
          [36m>[39m
            [36m<span[39m
              [33mstyle[39m=[32m"pointer-events: none;"[39m
            [36m>[39m
              [0mTier 3 - Standard[0m
            [36m</span>[39m
            [36m<i[39m
              [33maria-hidden[39m=[32m"true"[39m
              [33mclass[39m=[32m"ph-duotone ph-caret-down opacity-50"[39m
              [33mstyle[39m=[32m"font-size: 16px;"[39m
            [36m/>[39m
          [36m</button>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"grid gap-2"[39m
        [36m>[39m
          [36m<label[39m
            [33mclass[39m=[32m"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"[39m
            [33mfor[39m=[32m"owner"[39m
          [36m>[39m
            [0mService Owner[0m
          [36m</label>[39m
          [36m<input[39m
            [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
            [33mi...
   × BusinessServices page > requires an explicit selection before saving a row with unknown criticality 141ms
     → expect(element).toBeDisabled()

Received element is not disabled:
  <button
  class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"
/>
   × BusinessServices page > keeps the form and current row when the server rejects the write 294ms
     → Unable to find an element with the text: Critical. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

Ignored nodes: comments, script, style
[36m<tr[39m
  [33mclass[39m=[32m"border-b border-border hover:bg-accent transition-colors"[39m
[36m>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"font-medium"[39m
      [36m>[39m
        [0mCustomer Portal[0m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"text-xs text-muted-foreground"[39m
      [36m>[39m
        [0mPublic customer portal[0m
      [36m</div>[39m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors bg-sky-soft text-sky-text"[39m
    [36m>[39m
      [0mTier [0m
      [0m3[0m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors border-line bg-success-soft text-success"[39m
    [36m>[39m
      [0mactive[0m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m$500,000[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m12,000[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m$8,200[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [36m<span[39m
      [33mclass[39m=[32m"text-muted-foreground"[39m
    [36m>[39m
      [0m4[0m
    [36m</span>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"flex gap-2 justify-end"[39m
    [36m>[39m
      [36m<button[39m
        [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
      [36m>[39m
        [36m<i[39m
          [33maria-hidden[39m=[32m"true"[39m
          [33mclass[39m=[32m"ph-duotone ph-pencil-simple"[39m
          [33mstyle[39m=[32m"font-size: 16px;"[39m
        [36m/>[39m
      [36m</button>[39m
      [36m<button[39m
        [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
      [36m>[39m
        [36m<i[39m
          [33maria-hidden[39m=[32m"true"[39m
          [33mclass[39m=[32m"ph-duotone ph-trash"[39m
          [33mstyle[39m=[32m"font-size: 16px;"[39m
        [36m/>[39m
      [36m</button>[39m
    [36m</div>[39m
  [36m</td>[39m
[36m</tr>[39m

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 6 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/pages/BusinessServices.test.tsx > BusinessServices page > renders each canonical criticality distinctly and non-canonical values as Unknown
TestingLibraryElementError: Unable to find an element with the text: Critical. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

Ignored nodes: comments, script, style
[36m<tr[39m
  [33mclass[39m=[32m"border-b border-border hover:bg-accent transition-colors"[39m
[36m>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"font-medium"[39m
      [36m>[39m
        [0mSvc Critical[0m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"text-xs text-muted-foreground"[39m
      [36m>[39m
        [0mPublic customer portal[0m
      [36m</div>[39m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors bg-sky-soft text-sky-text"[39m
    [36m>[39m
      [0mTier [0m
      [0m3[0m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors border-line bg-success-soft text-success"[39m
    [36m>[39m
      [0mactive[0m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m$500,000[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m12,000[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m$8,200[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [36m<span[39m
      [33mclass[39m=[32m"text-muted-foreground"[39m
    [36m>[39m
      [0m4[0m
    [36m</span>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"flex gap-2 justify-end"[39m
    [36m>[39m
      [36m<button[39m
        [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
      [36m>[39m
        [36m<i[39m
          [33maria-hidden[39m=[32m"true"[39m
          [33mclass[39m=[32m"ph-duotone ph-pencil-simple"[39m
          [33mstyle[39m=[32m"font-size: 16px;"[39m
        [36m/>[39m
      [36m</button>[39m
      [36m<button[39m
        [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
      [36m>[39m
        [36m<i[39m
          [33maria-hidden[39m=[32m"true"[39m
          [33mclass[39m=[32m"ph-duotone ph-trash"[39m
          [33mstyle[39m=[32m"font-size: 16px;"[39m
        [36m/>[39m
      [36m</button>[39m
    [36m</div>[39m
  [36m</td>[39m
[36m</tr>[39m
 ❯ Object.getElementError ../node_modules/@testing-library/dom/dist/config.js:37:19
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:76:38
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:52:17
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:95:19
 ❯ src/pages/BusinessServices.test.tsx:94:49
     92|     render(<BusinessServices />);
     93| 
     94|     expect(within(await rowFor('Svc Critical')).getByText('Critical'))…
       |                                                 ^
     95|     expect(within(await rowFor('Svc High')).getByText('High')).toBeInT…
     96|     expect(within(await rowFor('Svc Medium')).getByText('Medium')).toB…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/6]⎯

 FAIL  src/pages/BusinessServices.test.tsx > BusinessServices page > filters rows by canonical criticality
TestingLibraryElementError: Unable to find an accessible element with the role "combobox" and name `/filter by criticality/i`

Here are the accessible roles:

  heading:

  Name "Business Services":
  [36m<h1[39m
    [33mclass[39m=[32m"mt-3 text-[1.9rem]"[39m
  [36m/>[39m

  --------------------------------------------------
  paragraph:

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"mt-1.5 text-ink-soft"[39m
  [36m/>[39m

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
  [36m/>[39m

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
  [36m/>[39m

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
  [36m/>[39m

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
  [36m/>[39m

  --------------------------------------------------
  button:

  Name "Create Service":
  [36m<button[39m
    [33maria-controls[39m=[32m"radix-:ra:"[39m
    [33maria-expanded[39m=[32m"false"[39m
    [33maria-haspopup[39m=[32m"dialog"[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"[39m
    [33mdata-state[39m=[32m"closed"[39m
    [33mtype[39m=[32m"button"[39m
  [36m/>[39m

  Name "":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
  [36m/>[39m

  Name "":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
  [36m/>[39m

  Name "":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
  [36m/>[39m

  Name "":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
  [36m/>[39m

  --------------------------------------------------
  textbox:

  Name "":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 pl-10"[39m
    [33mplaceholder[39m=[32m"Search services..."[39m
    [33mvalue[39m=[32m""[39m
  [36m/>[39m

  --------------------------------------------------
  combobox:

  Name "":
  [36m<button[39m
    [33maria-autocomplete[39m=[32m"none"[39m
    [33maria-controls[39m=[32m"radix-:re:"[39m
    [33maria-expanded[39m=[32m"false"[39m
    [33mclass[39m=[32m"flex h-11 items-center justify-between whitespace-nowrap rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 w-[200px]"[39m
    [33mdata-state[39m=[32m"closed"[39m
    [33mdir[39m=[32m"ltr"[39m
    [33mrole[39m=[32m"combobox"[39m
    [33mtype[39m=[32m"button"[39m
  [36m/>[39m

  --------------------------------------------------
  table:

  Name "":
  [36m<table[39m
    [33mclass[39m=[32m"w-full"[39m
  [36m/>[39m

  --------------------------------------------------
  rowgroup:

  Name "":
  [36m<thead />[39m

  Name "":
  [36m<tbody />[39m

  --------------------------------------------------
  row:

  Name "Service Name Tier Status Revenue Impact Users Monthly Cost Supporting CIs Actions":
  [36m<tr[39m
    [33mclass[39m=[32m"border-b border-border"[39m
  [36m/>[39m

  Name "Svc Critical Public customer portal Tier 3 active $500,000 12,000 $8,200 4":
  [36m<tr[39m
    [33mclass[39m=[32m"border-b border-border hover:bg-accent transition-colors"[39m
  [36m/>[39m

  Name "Svc Low Public customer portal Tier 3 active $500,000 12,000 $8,200 4":
  [36m<tr[39m
    [33mclass[39m=[32m"border-b border-border hover:bg-accent transition-colors"[39m
  [36m/>[39m

  --------------------------------------------------
  columnheader:

  Name "Service Name":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Tier":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Status":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Revenue Impact":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Users":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Monthly Cost":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Supporting CIs":
  [36m<th[39m
    [33mclass[39m=[32m"text-left py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  Name "Actions":
  [36m<th[39m
    [33mclass[39m=[32m"text-right py-3 px-4 text-sm font-semibold"[39m
  [36m/>[39m

  --------------------------------------------------
  cell:

  Name "Svc Critical Public customer portal":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "Tier 3":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "active":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "$500,000":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "12,000":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "$8,200":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "4":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "Svc Low Public customer portal":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "Tier 3":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "active":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  Name "$500,000":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "12,000":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "$8,200":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "4":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m/>[39m

  Name "":
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m/>[39m

  --------------------------------------------------

Ignored nodes: comments, script, style
[36m<body>[39m
  [36m<div>[39m
    [36m<div[39m
      [33mclass[39m=[32m"container mx-auto p-6 space-y-6"[39m
    [36m>[39m
      [36m<div[39m
        [33mclass[39m=[32m"flex justify-between items-center"[39m
      [36m>[39m
        [36m<div>[39m
          [36m<span[39m
            [33mclass[39m=[32m"hh-heading inline-flex items-center rounded-[var(--hh-radius-sm)] px-3 py-1.5 text-[0.7rem] bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]"[39m
          [36m>[39m
            [0mService Catalog[0m
          [36m</span>[39m
          [36m<h1[39m
            [33mclass[39m=[32m"mt-3 text-[1.9rem]"[39m
          [36m>[39m
            [0mBusiness Services[0m
          [36m</h1>[39m
          [36m<p[39m
            [33mclass[39m=[32m"mt-1.5 text-ink-soft"[39m
          [36m>[39m
            [0mManage and monitor your business-critical services[0m
          [36m</p>[39m
        [36m</div>[39m
        [36m<button[39m
          [33maria-controls[39m=[32m"radix-:ra:"[39m
          [33maria-expanded[39m=[32m"false"[39m
          [33maria-haspopup[39m=[32m"dialog"[39m
          [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"[39m
          [33mdata-state[39m=[32m"closed"[39m
          [33mtype[39m=[32m"button"[39m
        [36m>[39m
          [36m<i[39m
            [33maria-hidden[39m=[32m"true"[39m
            [33mclass[39m=[32m"ph-duotone ph-plus mr-2"[39m
            [33mstyle[39m=[32m"font-size: 16px;"[39m
          [36m/>[39m
          [0mCreate Service[0m
        [36m</button>[39m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"grid grid-cols-1 md:grid-cols-4 gap-4"[39m
      [36m>[39m
        [36m<div[39m
          [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"p-6"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
            [36m>[39m
              [36m<span[39m
                [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
              [36m>[39m
                [0mTotal Services[0m
              [36m</span>[39m
              [36m<i[39m
                [33maria-hidden[39m=[32m"true"[39m
                [33mclass[39m=[32m"ph-duotone ph-graph text-muted-foreground"[39m
                [33mstyle[39m=[32m"font-size: 16px;"[39m
              [36m/>[39m
            [36m</div>[39m
            [36m<div[39m
              [33mclass[39m=[32m"text-3xl font-bold"[39m
            [36m>[39m
              [0m2[0m
            [36m</div>[39m
            [36m<p[39m
              [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
            [36m>[39m
              [0m2[0m
              [0m active[0m
            [36m</p>[39m
          [36m</div>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"p-6"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
            [36m>[39m
              [36m<span[39m
                [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
              [36m>[39m
                [0mTotal Revenue Impact[0m
              [36m</span>[39m
              [36m<i[39m
                [33maria-hidden[39m=[32m"true"[39m
                [33mclass[39m=[32m"ph-duotone ph-currency-dollar text-muted-foreground"[39m
                [33mstyle[39m=[32m"font-size: 16px;"[39m
              [36m/>[39m
            [36m</div>[39m
            [36m<div[39m
              [33mclass[39m=[32m"text-3xl font-bold"[39m
            [36m>[39m
              [0m$1,000,000[0m
            [36m</div>[39m
            [36m<p[39m
              [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
            [36m>[39m
              [0mAnnual[0m
            [36m</p>[39m
          [36m</div>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"p-6"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
            [36m>[39m
              [36m<span[39m
                [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
              [36m>[39m
                [0mTotal Users[0m
              [36m</span>[39m
              [36m<i[39m
                [33maria-hidden[39m=[32m"true"[39m
                [33mclass[39m=[32m"ph-duotone ph-users text-muted-foreground"[39m
                [33mstyle[39m=[32m"font-size: 16px;"[39m
              [36m/>[39m
            [36m</div>[39m
            [36m<div[39m
              [33mclass[39m=[32m"text-3xl font-bold"[39m
            [36m>[39m
              [0m24,000[0m
            [36m</div>[39m
            [36m<p[39m
              [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
            [36m>[39m
              [0mAcross all services[0m
            [36m</p>[39m
          [36m</div>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"p-6"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
            [36m>[39m
              [36m<span[39m
                [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
              [36m>[39m
                [0mMonthly IT Cost[0m
              [36m</span>[39m
              [36m<i[39m
                [33maria-hidden[39m=[32m"true"[39m
                [33mclass[39m=[32m"ph-duotone ph-trend-up text-muted-foreground"[39m
                [33mstyle[39m=[32m"font-size: 16px;"[39m
              [36m/>[39m
            [36m</div>[39m
            [36m<div[39m
              [33mclass...
 ❯ Object.getElementError ../node_modules/@testing-library/dom/dist/config.js:37:19
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:76:38
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:52:17
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:95:19
 ❯ src/pages/BusinessServices.test.tsx:114:31
    112|     await rowFor('Svc Low');
    113| 
    114|     await choose(user, screen.getByRole('combobox', { name: /filter by…
       |                               ^
    115| 
    116|     expect(screen.getByText('Svc Critical')).toBeInTheDocument();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/6]⎯

 FAIL  src/pages/BusinessServices.test.tsx > BusinessServices page > requires an explicit criticality on create and sends the canonical value
Error: expect(element).toBeDisabled()

Received element is not disabled:
  <button
  class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"
/>
 ❯ src/pages/BusinessServices.test.tsx:136:20
    134| 
    135|     const submit = within(dialog).getByRole('button', { name: /create …
    136|     expect(submit).toBeDisabled();
       |                    ^
    137| 
    138|     await choose(user, within(dialog).getByRole('combobox', { name: /^…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/6]⎯

 FAIL  src/pages/BusinessServices.test.tsx > BusinessServices page > starts editing at the stored criticality and sends the changed canonical value
TestingLibraryElementError: Unable to find an accessible element with the role "combobox" and name `/^criticality$/i`

Here are the accessible roles:

  heading:

  Name "Edit Business Service":
  [36m<h2[39m
    [33mclass[39m=[32m"text-lg font-semibold leading-none tracking-tight"[39m
    [33mid[39m=[32m"radix-:r14:"[39m
  [36m/>[39m

  --------------------------------------------------
  paragraph:

  Name "":
  [36m<p[39m
    [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
    [33mid[39m=[32m"radix-:r15:"[39m
  [36m/>[39m

  --------------------------------------------------
  textbox:

  Name "Service Name":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"name"[39m
    [33mplaceholder[39m=[32m"e.g., Customer Portal"[39m
    [33mvalue[39m=[32m"Customer Portal"[39m
  [36m/>[39m

  Name "Description":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"description"[39m
    [33mplaceholder[39m=[32m"Brief description of the service"[39m
    [33mvalue[39m=[32m"Public customer portal"[39m
  [36m/>[39m

  Name "Service Owner":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"owner"[39m
    [33mplaceholder[39m=[32m"Team or person"[39m
    [33mvalue[39m=[32m"Platform Team"[39m
  [36m/>[39m

  --------------------------------------------------
  combobox:

  Name "":
  [36m<button[39m
    [33maria-autocomplete[39m=[32m"none"[39m
    [33maria-controls[39m=[32m"radix-:r1d:"[39m
    [33maria-expanded[39m=[32m"false"[39m
    [33mclass[39m=[32m"flex h-11 w-full items-center justify-between whitespace-nowrap rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1"[39m
    [33mdata-state[39m=[32m"closed"[39m
    [33mdir[39m=[32m"ltr"[39m
    [33mrole[39m=[32m"combobox"[39m
    [33mtype[39m=[32m"button"[39m
  [36m/>[39m

  --------------------------------------------------
  spinbutton:

  Name "Annual Revenue Impact ($)":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"revenueImpact"[39m
    [33mplaceholder[39m=[32m"0"[39m
    [33mtype[39m=[32m"number"[39m
    [33mvalue[39m=[32m"500000"[39m
  [36m/>[39m

  Name "User Count":
  [36m<input[39m
    [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
    [33mid[39m=[32m"userCount"[39m
    [33mplaceholder[39m=[32m"0"[39m
    [33mtype[39m=[32m"number"[39m
    [33mvalue[39m=[32m"12000"[39m
  [36m/>[39m

  --------------------------------------------------
  button:

  Name "Cancel":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border-2 border-navy bg-transparent text-navy hover:bg-navy hover:text-white h-10 px-5 py-2"[39m
  [36m/>[39m

  Name "Update Service":
  [36m<button[39m
    [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"[39m
  [36m/>[39m

  Name "Close":
  [36m<button[39m
    [33mclass[39m=[32m"absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"[39m
    [33mtype[39m=[32m"button"[39m
  [36m/>[39m

  --------------------------------------------------

Ignored nodes: comments, script, style
[36m<div[39m
  [33maria-describedby[39m=[32m"radix-:r15:"[39m
  [33maria-labelledby[39m=[32m"radix-:r14:"[39m
  [33mclass[39m=[32m"left-[50%] top-[40%] z-50 grid w-full translate-x-[-50%] translate-y-[-40%] gap-4 border p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[38%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[38%] rounded-2xl relative overflow-hidden max-w-2xl"[39m
  [33mdata-state[39m=[32m"open"[39m
  [33mid[39m=[32m"radix-:r13:"[39m
  [33mrole[39m=[32m"dialog"[39m
  [33mstyle[39m=[32m"box-shadow: 0 4px 6px rgba(59, 130, 246, 0.15), 0 2px 4px rgba(239, 68, 68, 0.1), 0 8px 16px rgba(59, 130, 246, 0.1), 0 8px 16px rgba(239, 68, 68, 0.08); pointer-events: auto;"[39m
  [33mtabindex[39m=[32m"-1"[39m
[36m>[39m
  [36m<div[39m
    [33mclass[39m=[32m"absolute inset-0 rounded-2xl dialog-glass--bend--r16-"[39m
    [33mstyle[39m=[32m"filter: url(#dialog-glass-blur-:r16:);"[39m
  [36m/>[39m
  [36m<div[39m
    [33mclass[39m=[32m"absolute inset-0 rounded-2xl"[39m
    [33mstyle[39m=[32m"box-shadow: 0 4px 4px rgba(0, 0, 0, 0.15), 0 0 12px rgba(0, 0, 0, 0.08);"[39m
  [36m/>[39m
  [36m<div[39m
    [33mclass[39m=[32m"absolute inset-0 pointer-events-none rounded-2xl"[39m
    [33mstyle[39m=[32m"box-shadow: inset 3px 3px 3px 0 rgba(255, 255, 255, 0.45), inset -3px -3px 3px 0 rgba(255, 255, 255, 0.45);"[39m
  [36m/>[39m
  [36m<div[39m
    [33mclass[39m=[32m"relative z-10"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"flex flex-col space-y-1.5 text-center sm:text-left"[39m
    [36m>[39m
      [36m<h2[39m
        [33mclass[39m=[32m"text-lg font-semibold leading-none tracking-tight"[39m
        [33mid[39m=[32m"radix-:r14:"[39m
      [36m>[39m
        [0mEdit Business Service[0m
      [36m</h2>[39m
      [36m<p[39m
        [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
        [33mid[39m=[32m"radix-:r15:"[39m
      [36m>[39m
        [0mDefine a new business service and its key attributes[0m
      [36m</p>[39m
    [36m</div>[39m
    [36m<div[39m
      [33mclass[39m=[32m"grid gap-4 py-4"[39m
    [36m>[39m
      [36m<div[39m
        [33mclass[39m=[32m"grid gap-2"[39m
      [36m>[39m
        [36m<label[39m
          [33mclass[39m=[32m"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"[39m
          [33mfor[39m=[32m"name"[39m
        [36m>[39m
          [0mService Name[0m
        [36m</label>[39m
        [36m<input[39m
          [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
          [33mid[39m=[32m"name"[39m
          [33mplaceholder[39m=[32m"e.g., Customer Portal"[39m
          [33mvalue[39m=[32m"Customer Portal"[39m
        [36m/>[39m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"grid gap-2"[39m
      [36m>[39m
        [36m<label[39m
          [33mclass[39m=[32m"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"[39m
          [33mfor[39m=[32m"description"[39m
        [36m>[39m
          [0mDescription[0m
        [36m</label>[39m
        [36m<input[39m
          [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
          [33mid[39m=[32m"description"[39m
          [33mplaceholder[39m=[32m"Brief description of the service"[39m
          [33mvalue[39m=[32m"Public customer portal"[39m
        [36m/>[39m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"grid grid-cols-2 gap-4"[39m
      [36m>[39m
        [36m<div[39m
          [33mclass[39m=[32m"grid gap-2"[39m
        [36m>[39m
          [36m<label[39m
            [33mclass[39m=[32m"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"[39m
            [33mfor[39m=[32m"tier"[39m
          [36m>[39m
            [0mCriticality Tier[0m
          [36m</label>[39m
          [36m<button[39m
            [33maria-autocomplete[39m=[32m"none"[39m
            [33maria-controls[39m=[32m"radix-:r1d:"[39m
            [33maria-expanded[39m=[32m"false"[39m
            [33mclass[39m=[32m"flex h-11 w-full items-center justify-between whitespace-nowrap rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1"[39m
            [33mdata-state[39m=[32m"closed"[39m
            [33mdir[39m=[32m"ltr"[39m
            [33mrole[39m=[32m"combobox"[39m
            [33mtype[39m=[32m"button"[39m
          [36m>[39m
            [36m<span[39m
              [33mstyle[39m=[32m"pointer-events: none;"[39m
            [36m>[39m
              [0mTier 3 - Standard[0m
            [36m</span>[39m
            [36m<i[39m
              [33maria-hidden[39m=[32m"true"[39m
              [33mclass[39m=[32m"ph-duotone ph-caret-down opacity-50"[39m
              [33mstyle[39m=[32m"font-size: 16px;"[39m
            [36m/>[39m
          [36m</button>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"grid gap-2"[39m
        [36m>[39m
          [36m<label[39m
            [33mclass[39m=[32m"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"[39m
            [33mfor[39m=[32m"owner"[39m
          [36m>[39m
            [0mService Owner[0m
          [36m</label>[39m
          [36m<input[39m
            [33mclass[39m=[32m"flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"[39m
            [33mi...
 ❯ Object.getElementError ../node_modules/@testing-library/dom/dist/config.js:37:19
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:76:38
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:52:17
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:95:19
 ❯ src/pages/BusinessServices.test.tsx:164:36
    162| 
    163|     const dialog = await screen.findByRole('dialog');
    164|     const trigger = within(dialog).getByRole('combobox', { name: /^cri…
       |                                    ^
    165|     expect(trigger).toHaveTextContent('Critical');
    166| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/6]⎯

 FAIL  src/pages/BusinessServices.test.tsx > BusinessServices page > requires an explicit selection before saving a row with unknown criticality
Error: expect(element).toBeDisabled()

Received element is not disabled:
  <button
  class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"
/>
 ❯ src/pages/BusinessServices.test.tsx:194:20
    192|     const dialog = await screen.findByRole('dialog');
    193|     const submit = within(dialog).getByRole('button', { name: /update …
    194|     expect(submit).toBeDisabled();
       |                    ^
    195| 
    196|     await choose(user, within(dialog).getByRole('combobox', { name: /^…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/6]⎯

 FAIL  src/pages/BusinessServices.test.tsx > BusinessServices page > keeps the form and current row when the server rejects the write
TestingLibraryElementError: Unable to find an element with the text: Critical. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

Ignored nodes: comments, script, style
[36m<tr[39m
  [33mclass[39m=[32m"border-b border-border hover:bg-accent transition-colors"[39m
[36m>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"font-medium"[39m
      [36m>[39m
        [0mCustomer Portal[0m
      [36m</div>[39m
      [36m<div[39m
        [33mclass[39m=[32m"text-xs text-muted-foreground"[39m
      [36m>[39m
        [0mPublic customer portal[0m
      [36m</div>[39m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors bg-sky-soft text-sky-text"[39m
    [36m>[39m
      [0mTier [0m
      [0m3[0m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors border-line bg-success-soft text-success"[39m
    [36m>[39m
      [0mactive[0m
    [36m</div>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m$500,000[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m12,000[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [0m$8,200[0m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4 text-sm"[39m
  [36m>[39m
    [36m<span[39m
      [33mclass[39m=[32m"text-muted-foreground"[39m
    [36m>[39m
      [0m4[0m
    [36m</span>[39m
  [36m</td>[39m
  [36m<td[39m
    [33mclass[39m=[32m"py-3 px-4"[39m
  [36m>[39m
    [36m<div[39m
      [33mclass[39m=[32m"flex gap-2 justify-end"[39m
    [36m>[39m
      [36m<button[39m
        [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
      [36m>[39m
        [36m<i[39m
          [33maria-hidden[39m=[32m"true"[39m
          [33mclass[39m=[32m"ph-duotone ph-pencil-simple"[39m
          [33mstyle[39m=[32m"font-size: 16px;"[39m
        [36m/>[39m
      [36m</button>[39m
      [36m<button[39m
        [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-transparent text-sky-text hover:bg-sky-soft h-10 w-10"[39m
      [36m>[39m
        [36m<i[39m
          [33maria-hidden[39m=[32m"true"[39m
          [33mclass[39m=[32m"ph-duotone ph-trash"[39m
          [33mstyle[39m=[32m"font-size: 16px;"[39m
        [36m/>[39m
      [36m</button>[39m
    [36m</div>[39m
  [36m</td>[39m
[36m</tr>[39m
 ❯ Object.getElementError ../node_modules/@testing-library/dom/dist/config.js:37:19
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:76:38
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:52:17
 ❯ ../node_modules/@testing-library/dom/dist/query-helpers.js:95:19
 ❯ src/pages/BusinessServices.test.tsx:245:52
    243|     expect(within(screen.getByRole('dialog')).getByLabelText(/service …
    244|     expect(screen.queryByText('Business service updated successfully')…
    245|     expect(within(await rowFor('Customer Portal')).getByText('Critical…
       |                                                    ^
    246|   });
    247| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/6]⎯


 Test Files  1 failed (1)
      Tests  6 failed (6)
   Start at  20:04:22
   Duration  4.13s (transform 314ms, setup 133ms, collect 543ms, tests 2.52s, environment 471ms, prepare 137ms)

EXIT=1
~~~~~~

## 7.1 Mounted run BEFORE owned_by fix (full output)

~~~~~~
▲ [WARNING] Duplicate key "allowSyntheticDefaultImports" in object literal [duplicate-object-key]

    ../tsconfig.base.json:25:4:
      25 │     "allowSyntheticDefaultImports": true,
         ╵     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

  The original key "allowSyntheticDefaultImports" is here:

    ../tsconfig.base.json:11:4:
      11 │     "allowSyntheticDefaultImports": true,
         ╵     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~


 RUN  v3.2.4 /home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui

stdout | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > env
[driver] base http://127.0.0.1:39767/api/v1

stderr | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > canonical labels + filter from real GET
⚠️ React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition` in v7. You can use the `v7_startTransition` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_starttransition.
⚠️ React Router Future Flag Warning: Relative route resolution within Splat routes is changing in v7. You can use the `v7_relativeSplatPath` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_relativesplatpath.

[api] GET /api/v1/business-services {}
[api] GET /api/v1/business-services {}
[api] POST /api/v1/business-services {"service_id":"bs-harness-new-1790193946938","name":"Harness New","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}
stderr | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > explicit create persists across reload
Failed to save business service: AxiosError: Request failed with status code 400
    at settle (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/core/settle.js:20:7)
    at XMLHttpRequest.onloadend (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/adapters/xhr.js:62:9)
    at XMLHttpRequest.invokeTheCallbackFunction (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/generated/EventHandlerNonNull.js:14:28)
    at XMLHttpRequest.<anonymous> (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/helpers/create-event-accessor.js:36:32)
    at innerInvokeEventListeners (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:360:16)
    at invokeEventListeners (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:296:3)
    at XMLHttpRequestImpl._dispatch (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:243:9)
    at fireAnEvent (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/helpers/events.js:18:36)
    at EventEmitter.<anonymous> (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js:891:5)
    at EventEmitter.emit (node:events:531:35)
    at Axios.request (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/core/Axios.js:46:41)
    at processTicksAndRejections (node:internal/process/task_queues:103:5)
    at APIClient.post (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui/src/lib/api-client.ts:55:22)
    at handleCreateService (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui/src/pages/BusinessServices.tsx:230:32) {
  isAxiosError: true,
  code: 'ERR_BAD_REQUEST',
  config: {
    transitional: {
      silentJSONParsing: true,
      forcedJSONParsing: true,
      clarifyTimeoutError: false,
      legacyInterceptorReqResOrdering: true
    },
    adapter: [ 'xhr', 'http', 'fetch' ],
    transformRequest: [ [Function: transformRequest] ],
    transformResponse: [ [Function: transformResponse] ],
    timeout: 30000,
    xsrfCookieName: 'XSRF-TOKEN',
    xsrfHeaderName: 'X-XSRF-TOKEN',
    maxContentLength: -1,
    maxBodyLength: -1,
    env: { FormData: [Function], Blob: [class Blob] },
    validateStatus: [Function: validateStatus],
    headers: Object [AxiosHeaders] {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoiaGFwMTc0LWFkbWluIiwiX3VzZXJuYW1lIjoiYWRtaW4iLCJfcm9sZSI6ImFkbWluIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAxOTM5NDMsImV4cCI6MTc5MDE5NDg0MywiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.YB1ekNIB__FyF4Rd5Tl-ZvBY3eKghVNEkFuM2SglSKo'
    },
    baseURL: 'http://127.0.0.1:39767/api/v1',
    method: 'post',
    url: '/business-services',
    data: '{"service_id":"bs-harness-new-1790193946938","name":"Harness New","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}',
    allowAbsoluteUrls: true
  },
  request: XMLHttpRequest {},
  response: {
    data: {
      _success: false,
      _error: 'Validation Error',
      _message: '"owned_by" is not allowed to be empty',
      _details: [Array]
    },
    status: 400,
    statusText: 'Bad Request',
    headers: Object [AxiosHeaders] {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '210'
    },
    config: {
      transitional: [Object],
      adapter: [Array],
      transformRequest: [Array],
      transformResponse: [Array],
      timeout: 30000,
      xsrfCookieName: 'XSRF-TOKEN',
      xsrfHeaderName: 'X-XSRF-TOKEN',
      maxContentLength: -1,
      maxBodyLength: -1,
      env: [Object],
      validateStatus: [Function: validateStatus],
      headers: [Object [AxiosHeaders]],
      baseURL: 'http://127.0.0.1:39767/api/v1',
      method: 'post',
      url: '/business-services',
      data: '{"service_id":"bs-harness-new-1790193946938","name":"Harness New","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}',
      allowAbsoluteUrls: true
    },
    request: XMLHttpRequest {}
  },
  status: 400
}

[api] GET /api/v1/business-services {}
[api] PATCH /api/v1/business-services/bs-c {"service_id":"bs-c","name":"Svc Critical","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"low","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}
stderr | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > edit criticality persists across reload
Failed to save business service: AxiosError: Request failed with status code 400
    at settle (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/core/settle.js:20:7)
    at XMLHttpRequest.onloadend (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/adapters/xhr.js:62:9)
    at XMLHttpRequest.invokeTheCallbackFunction (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/generated/EventHandlerNonNull.js:14:28)
    at XMLHttpRequest.<anonymous> (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/helpers/create-event-accessor.js:36:32)
    at innerInvokeEventListeners (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:360:16)
    at invokeEventListeners (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:296:3)
    at XMLHttpRequestImpl._dispatch (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:243:9)
    at fireAnEvent (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/helpers/events.js:18:36)
    at EventEmitter.<anonymous> (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js:891:5)
    at EventEmitter.emit (node:events:531:35)
    at Axios.request (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/core/Axios.js:46:41)
    at processTicksAndRejections (node:internal/process/task_queues:103:5)
    at APIClient.patch (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui/src/lib/api-client.ts:65:22)
    at handleCreateService (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui/src/pages/BusinessServices.tsx:220:32) {
  isAxiosError: true,
  code: 'ERR_BAD_REQUEST',
  config: {
    transitional: {
      silentJSONParsing: true,
      forcedJSONParsing: true,
      clarifyTimeoutError: false,
      legacyInterceptorReqResOrdering: true
    },
    adapter: [ 'xhr', 'http', 'fetch' ],
    transformRequest: [ [Function: transformRequest] ],
    transformResponse: [ [Function: transformResponse] ],
    timeout: 30000,
    xsrfCookieName: 'XSRF-TOKEN',
    xsrfHeaderName: 'X-XSRF-TOKEN',
    maxContentLength: -1,
    maxBodyLength: -1,
    env: { FormData: [Function], Blob: [class Blob] },
    validateStatus: [Function: validateStatus],
    headers: Object [AxiosHeaders] {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoiaGFwMTc0LWFkbWluIiwiX3VzZXJuYW1lIjoiYWRtaW4iLCJfcm9sZSI6ImFkbWluIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAxOTM5NDMsImV4cCI6MTc5MDE5NDg0MywiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.YB1ekNIB__FyF4Rd5Tl-ZvBY3eKghVNEkFuM2SglSKo'
    },
    baseURL: 'http://127.0.0.1:39767/api/v1',
    method: 'patch',
    url: '/business-services/bs-c',
    data: '{"service_id":"bs-c","name":"Svc Critical","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"low","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}',
    allowAbsoluteUrls: true
  },
  request: XMLHttpRequest {},
  response: {
    data: {
      _success: false,
      _error: 'Validation Error',
      _message: '"owned_by" is not allowed to be empty',
      _details: [Array]
    },
    status: 400,
    statusText: 'Bad Request',
    headers: Object [AxiosHeaders] {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '210'
    },
    config: {
      transitional: [Object],
      adapter: [Array],
      transformRequest: [Array],
      transformResponse: [Array],
      timeout: 30000,
      xsrfCookieName: 'XSRF-TOKEN',
      xsrfHeaderName: 'X-XSRF-TOKEN',
      maxContentLength: -1,
      maxBodyLength: -1,
      env: [Object],
      validateStatus: [Function: validateStatus],
      headers: [Object [AxiosHeaders]],
      baseURL: 'http://127.0.0.1:39767/api/v1',
      method: 'patch',
      url: '/business-services/bs-c',
      data: '{"service_id":"bs-c","name":"Svc Critical","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"low","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}',
      allowAbsoluteUrls: true
    },
    request: XMLHttpRequest {}
  },
  status: 400
}

[api] GET /api/v1/business-services {}
[api] PATCH /api/v1/business-services/bs-h {"service_id":"bs-h","name":"ab","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}
stderr | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > real Joi 400 keeps dialog/input, existing row, shows error toast
Failed to save business service: AxiosError: Request failed with status code 400
    at settle (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/core/settle.js:20:7)
    at XMLHttpRequest.onloadend (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/adapters/xhr.js:62:9)
    at XMLHttpRequest.invokeTheCallbackFunction (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/generated/EventHandlerNonNull.js:14:28)
    at XMLHttpRequest.<anonymous> (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/helpers/create-event-accessor.js:36:32)
    at innerInvokeEventListeners (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:360:16)
    at invokeEventListeners (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:296:3)
    at XMLHttpRequestImpl._dispatch (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:243:9)
    at fireAnEvent (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/helpers/events.js:18:36)
    at EventEmitter.<anonymous> (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js:891:5)
    at EventEmitter.emit (node:events:531:35)
    at Axios.request (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/core/Axios.js:46:41)
    at processTicksAndRejections (node:internal/process/task_queues:103:5)
    at APIClient.patch (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui/src/lib/api-client.ts:65:22)
    at handleCreateService (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui/src/pages/BusinessServices.tsx:220:32) {
  isAxiosError: true,
  code: 'ERR_BAD_REQUEST',
  config: {
    transitional: {
      silentJSONParsing: true,
      forcedJSONParsing: true,
      clarifyTimeoutError: false,
      legacyInterceptorReqResOrdering: true
    },
    adapter: [ 'xhr', 'http', 'fetch' ],
    transformRequest: [ [Function: transformRequest] ],
    transformResponse: [ [Function: transformResponse] ],
    timeout: 30000,
    xsrfCookieName: 'XSRF-TOKEN',
    xsrfHeaderName: 'X-XSRF-TOKEN',
    maxContentLength: -1,
    maxBodyLength: -1,
    env: { FormData: [Function], Blob: [class Blob] },
    validateStatus: [Function: validateStatus],
    headers: Object [AxiosHeaders] {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoiaGFwMTc0LWFkbWluIiwiX3VzZXJuYW1lIjoiYWRtaW4iLCJfcm9sZSI6ImFkbWluIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAxOTM5NDMsImV4cCI6MTc5MDE5NDg0MywiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.YB1ekNIB__FyF4Rd5Tl-ZvBY3eKghVNEkFuM2SglSKo'
    },
    baseURL: 'http://127.0.0.1:39767/api/v1',
    method: 'patch',
    url: '/business-services/bs-h',
    data: '{"service_id":"bs-h","name":"ab","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}',
    allowAbsoluteUrls: true
  },
  request: XMLHttpRequest {},
  response: {
    data: {
      _success: false,
      _error: 'Validation Error',
      _message: '"name" length must be at least 3 characters long. "owned_by" is not allowed to be empty',
      _details: [Array]
    },
    status: 400,
    statusText: 'Bad Request',
    headers: Object [AxiosHeaders] {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '365'
    },
    config: {
      transitional: [Object],
      adapter: [Array],
      transformRequest: [Array],
      transformResponse: [Array],
      timeout: 30000,
      xsrfCookieName: 'XSRF-TOKEN',
      xsrfHeaderName: 'X-XSRF-TOKEN',
      maxContentLength: -1,
      maxBodyLength: -1,
      env: [Object],
      validateStatus: [Function: validateStatus],
      headers: [Object [AxiosHeaders]],
      baseURL: 'http://127.0.0.1:39767/api/v1',
      method: 'patch',
      url: '/business-services/bs-h',
      data: '{"service_id":"bs-h","name":"ab","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","owned_by":"","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}',
      allowAbsoluteUrls: true
    },
    request: XMLHttpRequest {}
  },
  status: 400
}

stdout | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > real Joi 400 keeps dialog/input, existing row, shows error toast
[driver] toast text: Failed to save business service

 ❯ src/pages/hap174-mounted.driver.test.tsx (5 tests | 2 failed) 7346ms
   ✓ HAP-174 mounted > env 2ms
   ✓ HAP-174 mounted > canonical labels + filter from real GET  535ms
   × HAP-174 mounted > explicit create persists across reload 5005ms
     → Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
   × HAP-174 mounted > edit criticality persists across reload 1483ms
     → expect(element).not.toBeInTheDocument()

expected document not to contain element, found <div
  aria-describedby="radix-:r1d:"
  aria-labelledby="radix-:r1c:"
  class="left-[50%] top-[40%] z-50 grid w-full translate-x-[-50%] translate-y-[-40%] gap-4 border p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[38%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[38%] rounded-2xl relative overflow-hidden max-w-2xl"
  data-state="open"
  id="radix-:r1b:"
  role="dialog"
  style="box-shadow: 0 4px 6px rgba(59, 130, 246, 0.15), 0 2px 4px rgba(239, 68, 68, 0.1), 0 8px 16px rgba(59, 130, 246, 0.1), 0 8px 16px rgba(239, 68, 68, 0.08); pointer-events: auto;"
  tabindex="-1"
>
  <div
    class="absolute inset-0 rounded-2xl dialog-glass--bend--r1e-"
    style="filter: url(#dialog-glass-blur-:r1e:);"
  />
  <div
    class="absolute inset-0 rounded-2xl"
    style="box-shadow: 0 4px 4px rgba(0, 0, 0, 0.15), 0 0 12px rgba(0, 0, 0, 0.08);"
  />
  <div
    class="absolute inset-0 pointer-events-none rounded-2xl"
    style="box-shadow: inset 3px 3px 3px 0 rgba(255, 255, 255, 0.45), inset -3px -3px 3px 0 rgba(255, 255, 255, 0.45);"
  />
  <div
    class="relative z-10"
  >
    <div
      class="flex flex-col space-y-1.5 text-center sm:text-left"
    >
      <h2
        class="text-lg font-semibold leading-none tracking-tight"
        id="radix-:r1c:"
      >
        Edit Business Service
      </h2>
      <p
        class="text-sm text-muted-foreground"
        id="radix-:r1d:"
      >
        Define a new business service and its key attributes
      </p>
    </div>
    <div
      class="grid gap-4 py-4"
    >
      <div
        class="grid gap-2"
      >
        <label
          class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          for="name"
        >
          Service Name
        </label>
        <input
          class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
          id="name"
          placeholder="e.g., Customer Portal"
          value="Svc Critical"
        />
      </div>
      <div
        class="grid gap-2"
      >
        <label
          class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          for="description"
        >
          Description
        </label>
        <input
          class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
          id="description"
          placeholder="Brief description of the service"
          value=""
        />
      </div>
      <div
        class="grid grid-cols-2 gap-4"
      >
        <div
          class="grid gap-2"
        >
          <label
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            for="criticality"
          >
            Criticality
          </label>
          <button
            aria-autocomplete="none"
            aria-controls="radix-:r1l:"
            aria-expanded="false"
            aria-label="Criticality"
            class="flex h-11 w-full items-center justify-between whitespace-nowrap rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1"
            data-state="closed"
            dir="ltr"
            id="criticality"
            role="combobox"
            type="button"
          >
            <span
              style="pointer-events: none;"
            >
              Low
            </span>
            <i
              aria-hidden="true"
              class="ph-duotone ph-caret-down opacity-50"
              style="font-size: 16px;"
            />
          </button>
        </div>
        <div
          class="grid gap-2"
        >
          <label
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            for="owner"
          >
            Service Owner
          </label>
          <input
            class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
            id="owner"
            placeholder="Team or person"
            value=""
          />
        </div>
      </div>
      <div
        class="grid grid-cols-2 gap-4"
      >
        <div
          class="grid gap-2"
        >
          <label
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            for="revenueImpact"
          >
            Annual Revenue Impact ($)
          </label>
          <input
            class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
            id="revenueImpact"
            placeholder="0"
            type="number"
            value="0"
          />
        </div>
        <div
          class="grid gap-2"
        >
          <label
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            for="userCount"
          >
            User Count
          </label>
          <input
            class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
            id="userCount"
            placeholder="0"
            type="number"
            value="0"
          />
        </div>
      </div>
    </div>
    <div
      class="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2"
    >
      <button
        class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border-2 border-navy bg-transparent text-navy hover:bg-navy hover:text-white h-10 px-5 py-2"
      >
        Cancel
      </button>
      <button
        class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"
      >
        Update Service
      </button>
    </div>
    <button
      class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
      type="button"
    >
      <i
        aria-hidden="true"
        class="ph-duotone ph-x"
        style="font-size: 16px;"
      />
      <span
        class="sr-only"
      >
        Close
      </span>
    </button>
  </div>
</div> instead

Ignored nodes: comments, script, style
[36m<html>[39m
  [36m<head />[39m
  [36m<body[39m
    [33mdata-scroll-locked[39m=[32m"1"[39m
    [33mstyle[39m=[32m"pointer-events: none;"[39m
  [36m>[39m
    [36m<span[39m
      [33maria-hidden[39m=[32m"true"[39m
      [33mdata-aria-hidden[39m=[32m"true"[39m
      [33mdata-radix-focus-guard[39m=[32m""[39m
      [33mstyle[39m=[32m"outline: none; opacity: 0; position: fixed; pointer-events: none;"[39m
      [33mtabindex[39m=[32m"0"[39m
    [36m/>[39m
    [36m<div>[39m
      [36m<div[39m
        [33maria-hidden[39m=[32m"true"[39m
        [33mclass[39m=[32m"container mx-auto p-6 space-y-6"[39m
        [33mdata-aria-hidden[39m=[32m"true"[39m
      [36m>[39m
        [36m<div[39m
          [33mclass[39m=[32m"flex justify-between items-center"[39m
        [36m>[39m
          [36m<div>[39m
            [36m<span[39m
              [33mclass[39m=[32m"hh-heading inline-flex items-center rounded-[var(--hh-radius-sm)] px-3 py-1.5 text-[0.7rem] bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]"[39m
            [36m>[39m
              [0mService Catalog[0m
            [36m</span>[39m
            [36m<h1[39m
              [33mclass[39m=[32m"mt-3 text-[1.9rem]"[39m
            [36m>[39m
              [0mBusiness Services[0m
            [36m</h1>[39m
            [36m<p[39m
              [33mclass[39m=[32m"mt-1.5 text-ink-soft"[39m
            [36m>[39m
              [0mManage and monitor your business-critical services[0m
            [36m</p>[39m
          [36m</div>[39m
          [36m<button[39m
            [33maria-controls[39m=[32m"radix-:r1b:"[39m
            [33maria-expanded[39m=[32m"true"[39m
            [33maria-haspopup[39m=[32m"dialog"[39m
            [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"[39m
            [33mdata-state[39m=[32m"open"[39m
            [33mtype[39m=[32m"button"[39m
          [36m>[39m
            [36m<i[39m
              [33maria-hidden[39m=[32m"true"[39m
              [33mclass[39m=[32m"ph-duotone ph-plus mr-2"[39m
              [33mstyle[39m=[32m"font-size: 16px;"[39m
            [36m/>[39m
            [0mCreate Service[0m
          [36m</button>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"grid grid-cols-1 md:grid-cols-4 gap-4"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"p-6"[39m
            [36m>[39m
              [36m<div[39m
                [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
              [36m>[39m
                [36m<span[39m
                  [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
                [36m>[39m
                  [0mTotal Services[0m
                [36m</span>[39m
                [36m<i[39m
                  [33maria-hidden[39m=[32m"true"[39m
                  [33mclass[39m=[32m"ph-duotone ph-graph text-muted-foreground"[39m
                  [33mstyle[39m=[32m"font-size: 16px;"[39m
                [36m/>[39m
              [36m</div>[39m
              [36m<div[39m
                [33mclass[39m=[32m"text-3xl font-bold"[39m
              [36m>[39m
                [0m4[0m
              [36m</div>[39m
              [36m<p[39m
                [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
              [36m>[39m
                [0m4[0m
                [0m active[0m
              [36m</p>[39m
            [36m</div>[39m
          [36m</div>[39m
          [36m<div[39m
            [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"p-6"[39m
            [36m>[39m
              [36m<div[39m
                [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
              [36m>[39m
                [36m<span[39m
                  [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
                [36m>[39m
                  [0mTotal Revenue Impact[0m
                [36m</span>[39m
                [36m<i[39m
                  [33maria-hidden[39m=[32m"true"[39m
                  [33mclass[39m=[32m"ph-duotone ph-currency-dollar text-muted-foreground"[39m
                  [33mstyle[39m=[32m"font-size: 16px;"[39m
                [36m/>[39m
              [36m</div>[39m
              [36m<div[39m
                [33mclass[39m=[32m"text-3xl font-bold"[39m
              [36m>[39m
                [0m$0[0m
              [36m</div>[39m
              [36m<p[39m
                [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
              [36m>[39m
                [0mAnnual[0m
              [36m</p>[39m
            [36m</div>[39m
          [36m</div>[39m
          [36m<div[39m
            [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"p-6"[39m
            [36m>[39m
              [36m<div[39m
                [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
              [36m>[39m
                [36m<span[39m
                  [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
                [36m>[39m
                  [0mTotal Users[0m
                [36m</span>[39m
                [36m<i[39m
                  [33maria-hidden[39m=[32m"true"[39m
                  [33mclass[39m=[32m"ph-duotone ph-users text-muted-foreground"[39m
                  [33mstyle[39m=[32m"font-size: 16px;"[39m
                [36m/>[39m
              [36m</div>[39m
              [36m<div[39m
                [33mclass[39m=[32m"text-3xl font-bold"[39m
              [36m>[39m
                [0m0[0m
              [36m</div>[39m
              [36m<p[39m
                [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
              [36m>[39m
                [0mAcross all services[0m
              [36m</p>[39m
            [36m</div>[39m
          [36m</div>[39m
          [36m<div[39m
            [33mclass[39m=[32m"relative border shadow-sm transition-all du...
   ✓ HAP-174 mounted > real Joi 400 keeps dialog/input, existing row, shows error toast  318ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > explicit create persists across reload
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/pages/hap174-mounted.driver.test.tsx:39:3
     37|   });
     38| 
     39|   it('explicit create persists across reload', async () => {
       |   ^
     40|     const user = userEvent.setup();
     41|     mount();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > edit criticality persists across reload
Error: expect(element).not.toBeInTheDocument()

expected document not to contain element, found <div
  aria-describedby="radix-:r1d:"
  aria-labelledby="radix-:r1c:"
  class="left-[50%] top-[40%] z-50 grid w-full translate-x-[-50%] translate-y-[-40%] gap-4 border p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[38%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[38%] rounded-2xl relative overflow-hidden max-w-2xl"
  data-state="open"
  id="radix-:r1b:"
  role="dialog"
  style="box-shadow: 0 4px 6px rgba(59, 130, 246, 0.15), 0 2px 4px rgba(239, 68, 68, 0.1), 0 8px 16px rgba(59, 130, 246, 0.1), 0 8px 16px rgba(239, 68, 68, 0.08); pointer-events: auto;"
  tabindex="-1"
>
  <div
    class="absolute inset-0 rounded-2xl dialog-glass--bend--r1e-"
    style="filter: url(#dialog-glass-blur-:r1e:);"
  />
  <div
    class="absolute inset-0 rounded-2xl"
    style="box-shadow: 0 4px 4px rgba(0, 0, 0, 0.15), 0 0 12px rgba(0, 0, 0, 0.08);"
  />
  <div
    class="absolute inset-0 pointer-events-none rounded-2xl"
    style="box-shadow: inset 3px 3px 3px 0 rgba(255, 255, 255, 0.45), inset -3px -3px 3px 0 rgba(255, 255, 255, 0.45);"
  />
  <div
    class="relative z-10"
  >
    <div
      class="flex flex-col space-y-1.5 text-center sm:text-left"
    >
      <h2
        class="text-lg font-semibold leading-none tracking-tight"
        id="radix-:r1c:"
      >
        Edit Business Service
      </h2>
      <p
        class="text-sm text-muted-foreground"
        id="radix-:r1d:"
      >
        Define a new business service and its key attributes
      </p>
    </div>
    <div
      class="grid gap-4 py-4"
    >
      <div
        class="grid gap-2"
      >
        <label
          class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          for="name"
        >
          Service Name
        </label>
        <input
          class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
          id="name"
          placeholder="e.g., Customer Portal"
          value="Svc Critical"
        />
      </div>
      <div
        class="grid gap-2"
      >
        <label
          class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          for="description"
        >
          Description
        </label>
        <input
          class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
          id="description"
          placeholder="Brief description of the service"
          value=""
        />
      </div>
      <div
        class="grid grid-cols-2 gap-4"
      >
        <div
          class="grid gap-2"
        >
          <label
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            for="criticality"
          >
            Criticality
          </label>
          <button
            aria-autocomplete="none"
            aria-controls="radix-:r1l:"
            aria-expanded="false"
            aria-label="Criticality"
            class="flex h-11 w-full items-center justify-between whitespace-nowrap rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1"
            data-state="closed"
            dir="ltr"
            id="criticality"
            role="combobox"
            type="button"
          >
            <span
              style="pointer-events: none;"
            >
              Low
            </span>
            <i
              aria-hidden="true"
              class="ph-duotone ph-caret-down opacity-50"
              style="font-size: 16px;"
            />
          </button>
        </div>
        <div
          class="grid gap-2"
        >
          <label
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            for="owner"
          >
            Service Owner
          </label>
          <input
            class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
            id="owner"
            placeholder="Team or person"
            value=""
          />
        </div>
      </div>
      <div
        class="grid grid-cols-2 gap-4"
      >
        <div
          class="grid gap-2"
        >
          <label
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            for="revenueImpact"
          >
            Annual Revenue Impact ($)
          </label>
          <input
            class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
            id="revenueImpact"
            placeholder="0"
            type="number"
            value="0"
          />
        </div>
        <div
          class="grid gap-2"
        >
          <label
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            for="userCount"
          >
            User Count
          </label>
          <input
            class="flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50"
            id="userCount"
            placeholder="0"
            type="number"
            value="0"
          />
        </div>
      </div>
    </div>
    <div
      class="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2"
    >
      <button
        class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border-2 border-navy bg-transparent text-navy hover:bg-navy hover:text-white h-10 px-5 py-2"
      >
        Cancel
      </button>
      <button
        class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"
      >
        Update Service
      </button>
    </div>
    <button
      class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
      type="button"
    >
      <i
        aria-hidden="true"
        class="ph-duotone ph-x"
        style="font-size: 16px;"
      />
      <span
        class="sr-only"
      >
        Close
      </span>
    </button>
  </div>
</div> instead

Ignored nodes: comments, script, style
[36m<html>[39m
  [36m<head />[39m
  [36m<body[39m
    [33mdata-scroll-locked[39m=[32m"1"[39m
    [33mstyle[39m=[32m"pointer-events: none;"[39m
  [36m>[39m
    [36m<span[39m
      [33maria-hidden[39m=[32m"true"[39m
      [33mdata-aria-hidden[39m=[32m"true"[39m
      [33mdata-radix-focus-guard[39m=[32m""[39m
      [33mstyle[39m=[32m"outline: none; opacity: 0; position: fixed; pointer-events: none;"[39m
      [33mtabindex[39m=[32m"0"[39m
    [36m/>[39m
    [36m<div>[39m
      [36m<div[39m
        [33maria-hidden[39m=[32m"true"[39m
        [33mclass[39m=[32m"container mx-auto p-6 space-y-6"[39m
        [33mdata-aria-hidden[39m=[32m"true"[39m
      [36m>[39m
        [36m<div[39m
          [33mclass[39m=[32m"flex justify-between items-center"[39m
        [36m>[39m
          [36m<div>[39m
            [36m<span[39m
              [33mclass[39m=[32m"hh-heading inline-flex items-center rounded-[var(--hh-radius-sm)] px-3 py-1.5 text-[0.7rem] bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]"[39m
            [36m>[39m
              [0mService Catalog[0m
            [36m</span>[39m
            [36m<h1[39m
              [33mclass[39m=[32m"mt-3 text-[1.9rem]"[39m
            [36m>[39m
              [0mBusiness Services[0m
            [36m</h1>[39m
            [36m<p[39m
              [33mclass[39m=[32m"mt-1.5 text-ink-soft"[39m
            [36m>[39m
              [0mManage and monitor your business-critical services[0m
            [36m</p>[39m
          [36m</div>[39m
          [36m<button[39m
            [33maria-controls[39m=[32m"radix-:r1b:"[39m
            [33maria-expanded[39m=[32m"true"[39m
            [33maria-haspopup[39m=[32m"dialog"[39m
            [33mclass[39m=[32m"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-sky text-white shadow-sm hover:bg-sky-light h-10 px-5 py-2"[39m
            [33mdata-state[39m=[32m"open"[39m
            [33mtype[39m=[32m"button"[39m
          [36m>[39m
            [36m<i[39m
              [33maria-hidden[39m=[32m"true"[39m
              [33mclass[39m=[32m"ph-duotone ph-plus mr-2"[39m
              [33mstyle[39m=[32m"font-size: 16px;"[39m
            [36m/>[39m
            [0mCreate Service[0m
          [36m</button>[39m
        [36m</div>[39m
        [36m<div[39m
          [33mclass[39m=[32m"grid grid-cols-1 md:grid-cols-4 gap-4"[39m
        [36m>[39m
          [36m<div[39m
            [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"p-6"[39m
            [36m>[39m
              [36m<div[39m
                [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
              [36m>[39m
                [36m<span[39m
                  [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
                [36m>[39m
                  [0mTotal Services[0m
                [36m</span>[39m
                [36m<i[39m
                  [33maria-hidden[39m=[32m"true"[39m
                  [33mclass[39m=[32m"ph-duotone ph-graph text-muted-foreground"[39m
                  [33mstyle[39m=[32m"font-size: 16px;"[39m
                [36m/>[39m
              [36m</div>[39m
              [36m<div[39m
                [33mclass[39m=[32m"text-3xl font-bold"[39m
              [36m>[39m
                [0m4[0m
              [36m</div>[39m
              [36m<p[39m
                [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
              [36m>[39m
                [0m4[0m
                [0m active[0m
              [36m</p>[39m
            [36m</div>[39m
          [36m</div>[39m
          [36m<div[39m
            [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"p-6"[39m
            [36m>[39m
              [36m<div[39m
                [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
              [36m>[39m
                [36m<span[39m
                  [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
                [36m>[39m
                  [0mTotal Revenue Impact[0m
                [36m</span>[39m
                [36m<i[39m
                  [33maria-hidden[39m=[32m"true"[39m
                  [33mclass[39m=[32m"ph-duotone ph-currency-dollar text-muted-foreground"[39m
                  [33mstyle[39m=[32m"font-size: 16px;"[39m
                [36m/>[39m
              [36m</div>[39m
              [36m<div[39m
                [33mclass[39m=[32m"text-3xl font-bold"[39m
              [36m>[39m
                [0m$0[0m
              [36m</div>[39m
              [36m<p[39m
                [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
              [36m>[39m
                [0mAnnual[0m
              [36m</p>[39m
            [36m</div>[39m
          [36m</div>[39m
          [36m<div[39m
            [33mclass[39m=[32m"relative border shadow-sm transition-all duration-300 ease-out p-4 rounded-xl bg-card border-line"[39m
          [36m>[39m
            [36m<div[39m
              [33mclass[39m=[32m"p-6"[39m
            [36m>[39m
              [36m<div[39m
                [33mclass[39m=[32m"flex items-center justify-between mb-2"[39m
              [36m>[39m
                [36m<span[39m
                  [33mclass[39m=[32m"text-sm text-muted-foreground"[39m
                [36m>[39m
                  [0mTotal Users[0m
                [36m</span>[39m
                [36m<i[39m
                  [33maria-hidden[39m=[32m"true"[39m
                  [33mclass[39m=[32m"ph-duotone ph-users text-muted-foreground"[39m
                  [33mstyle[39m=[32m"font-size: 16px;"[39m
                [36m/>[39m
              [36m</div>[39m
              [36m<div[39m
                [33mclass[39m=[32m"text-3xl font-bold"[39m
              [36m>[39m
                [0m0[0m
              [36m</div>[39m
              [36m<p[39m
                [33mclass[39m=[32m"text-xs text-muted-foreground mt-1"[39m
              [36m>[39m
                [0mAcross all services[0m
              [36m</p>[39m
            [36m</div>[39m
          [36m</div>[39m
          [36m<div[39m
            [33mclass[39m=[32m"relative border shadow-sm transition-all du...
 ❯ src/pages/hap174-mounted.driver.test.tsx:67:66
     65|     await choose(user, trigger, 'Low');
     66|     await user.click(within(dialog).getByRole('button', { name: /updat…
     67|     await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeI…
       |                                                                  ^
     68|     cleanup();
     69|     mount();
 ❯ runWithExpensiveErrorDiagnosticsDisabled ../node_modules/@testing-library/dom/dist/config.js:47:12
 ❯ checkCallback ../node_modules/@testing-library/dom/dist/wait-for.js:124:77
 ❯ Timeout.checkRealTimersCallback ../node_modules/@testing-library/dom/dist/wait-for.js:118:16

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)
   Start at  20:05:44
   Duration  8.97s (transform 298ms, setup 139ms, collect 523ms, tests 7.35s, environment 479ms, prepare 144ms)

[harness] ui driver exit=1
[harness] DB after UI: [{"service_id":"bs-c","name":"Svc Critical","business_criticality":"critical"},{"service_id":"bs-h","name":"Svc High","business_criticality":"high"},{"service_id":"bs-l","name":"Svc Low","business_criticality":"low"},{"service_id":"bs-m","name":"Svc Medium","business_criticality":"medium"}]
FAIL UNIT src/rest/routes/__tests__/hap174-mounted.harness.test.ts (11.656 s)
  ✕ drives the real BusinessServices page against the mounted route + PGlite (10987 ms)

  ● drives the real BusinessServices page against the mounted route + PGlite

    expect(received).toBe(expected) // Object.is equality

    Expected: 0
    Received: 1

      92 |       });
      93 |       child.on('exit', (status: number | null) => resolve({ status }));
    > 94 |     });
         |        ^
      95 |     process.stdout.write(`[harness] ui driver exit=${ui.status}\n`);
      96 |     const rows = await send('query', 'SELECT service_id, name, business_criticality FROM dim_business_services ORDER BY service_id');
      97 |     process.stdout.write(`[harness] DB after UI: ${JSON.stringify(rows)}\n`);

      at Object.<anonymous> (packages/api-server/src/rest/routes/__tests__/hap174-mounted.harness.test.ts:94:27)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
Snapshots:   0 total
Time:        11.888 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/hap174-mounted.harness.test.ts/i.
EXIT=1
~~~~~~

## 7.2 Mounted run AFTER owned_by fix (full output)

~~~~~~
▲ [WARNING] Duplicate key "allowSyntheticDefaultImports" in object literal [duplicate-object-key]

    ../tsconfig.base.json:25:4:
      25 │     "allowSyntheticDefaultImports": true,
         ╵     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

  The original key "allowSyntheticDefaultImports" is here:

    ../tsconfig.base.json:11:4:
      11 │     "allowSyntheticDefaultImports": true,
         ╵     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~


 RUN  v3.2.4 /home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui

stdout | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > env
[driver] base http://127.0.0.1:34473/api/v1

stderr | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > canonical labels + filter from real GET
⚠️ React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition` in v7. You can use the `v7_startTransition` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_starttransition.
⚠️ React Router Future Flag Warning: Relative route resolution within Splat routes is changing in v7. You can use the `v7_relativeSplatPath` future flag to opt-in early. For more information, see https://reactrouter.com/v6/upgrading/future#v7_relativesplatpath.

[api] GET /api/v1/business-services {}
[api] GET /api/v1/business-services {}
[api] POST /api/v1/business-services {"service_id":"bs-harness-new-1790193986310","name":"Harness New","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}
[api] GET /api/v1/business-services {}
[api] GET /api/v1/business-services {}
[api] PATCH /api/v1/business-services/bs-c {"service_id":"bs-c","name":"Svc Critical","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"low","operational_status":"active","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}
[api] GET /api/v1/business-services {}
[api] GET /api/v1/business-services {}
[api] PATCH /api/v1/business-services/bs-h {"service_id":"bs-h","name":"ab","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}
stderr | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > real Joi 400 keeps dialog/input, existing row, shows error toast
Failed to save business service: AxiosError: Request failed with status code 400
    at settle (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/core/settle.js:20:7)
    at XMLHttpRequest.onloadend (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/adapters/xhr.js:62:9)
    at XMLHttpRequest.invokeTheCallbackFunction (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/generated/EventHandlerNonNull.js:14:28)
    at XMLHttpRequest.<anonymous> (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/helpers/create-event-accessor.js:36:32)
    at innerInvokeEventListeners (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:360:16)
    at invokeEventListeners (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:296:3)
    at XMLHttpRequestImpl._dispatch (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:243:9)
    at fireAnEvent (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/helpers/events.js:18:36)
    at EventEmitter.<anonymous> (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js:891:5)
    at EventEmitter.emit (node:events:531:35)
    at Axios.request (file:///home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/node_modules/axios/lib/core/Axios.js:46:41)
    at processTicksAndRejections (node:internal/process/task_queues:103:5)
    at APIClient.patch (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui/src/lib/api-client.ts:65:22)
    at handleCreateService (/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo/web-ui/src/pages/BusinessServices.tsx:221:32) {
  isAxiosError: true,
  code: 'ERR_BAD_REQUEST',
  config: {
    transitional: {
      silentJSONParsing: true,
      forcedJSONParsing: true,
      clarifyTimeoutError: false,
      legacyInterceptorReqResOrdering: true
    },
    adapter: [ 'xhr', 'http', 'fetch' ],
    transformRequest: [ [Function: transformRequest] ],
    transformResponse: [ [Function: transformResponse] ],
    timeout: 30000,
    xsrfCookieName: 'XSRF-TOKEN',
    xsrfHeaderName: 'X-XSRF-TOKEN',
    maxContentLength: -1,
    maxBodyLength: -1,
    env: { FormData: [Function], Blob: [class Blob] },
    validateStatus: [Function: validateStatus],
    headers: Object [AxiosHeaders] {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfdXNlcklkIjoiaGFwMTc0LWFkbWluIiwiX3VzZXJuYW1lIjoiYWRtaW4iLCJfcm9sZSI6ImFkbWluIiwiX3R5cGUiOiJhY2Nlc3MiLCJpYXQiOjE3OTAxOTM5ODIsImV4cCI6MTc5MDE5NDg4MiwiYXVkIjoiY21kYi1hcGkiLCJpc3MiOiJoYXBweWNtZGIifQ.9mDtl-Bh9Zwo0hM4PJx82WDINUoBz6bW-f7tMiQ9t5I'
    },
    baseURL: 'http://127.0.0.1:34473/api/v1',
    method: 'patch',
    url: '/business-services/bs-h',
    data: '{"service_id":"bs-h","name":"ab","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}',
    allowAbsoluteUrls: true
  },
  request: XMLHttpRequest {},
  response: {
    data: {
      _success: false,
      _error: 'Validation Error',
      _message: '"name" length must be at least 3 characters long',
      _details: [Array]
    },
    status: 400,
    statusText: 'Bad Request',
    headers: Object [AxiosHeaders] {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '226'
    },
    config: {
      transitional: [Object],
      adapter: [Array],
      transformRequest: [Array],
      transformResponse: [Array],
      timeout: 30000,
      xsrfCookieName: 'XSRF-TOKEN',
      xsrfHeaderName: 'X-XSRF-TOKEN',
      maxContentLength: -1,
      maxBodyLength: -1,
      env: [Object],
      validateStatus: [Function: validateStatus],
      headers: [Object [AxiosHeaders]],
      baseURL: 'http://127.0.0.1:34473/api/v1',
      method: 'patch',
      url: '/business-services/bs-h',
      data: '{"service_id":"bs-h","name":"ab","description":"","service_classification":"application","tbm_tower":"application","business_criticality":"high","operational_status":"active","metadata":{"revenue_impact":0,"user_count":0,"supporting_cis":0,"monthly_cost":0}}',
      allowAbsoluteUrls: true
    },
    request: XMLHttpRequest {}
  },
  status: 400
}

stdout | src/pages/hap174-mounted.driver.test.tsx > HAP-174 mounted > real Joi 400 keeps dialog/input, existing row, shows error toast
[driver] toast text: Failed to save business service

 ✓ src/pages/hap174-mounted.driver.test.tsx (5 tests) 2217ms
   ✓ HAP-174 mounted > canonical labels + filter from real GET  519ms
   ✓ HAP-174 mounted > explicit create persists across reload  876ms
   ✓ HAP-174 mounted > edit criticality persists across reload  469ms
   ✓ HAP-174 mounted > real Joi 400 keeps dialog/input, existing row, shows error toast  349ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  20:06:23
   Duration  3.89s (transform 312ms, setup 141ms, collect 534ms, tests 2.22s, environment 468ms, prepare 63ms)

[harness] ui driver exit=0
[harness] DB after UI: [{"service_id":"bs-c","name":"Svc Critical","business_criticality":"low"},{"service_id":"bs-h","name":"Svc High","business_criticality":"high"},{"service_id":"bs-harness-new-1790193986310","name":"Harness New","business_criticality":"high"},{"service_id":"bs-l","name":"Svc Low","business_criticality":"low"},{"service_id":"bs-m","name":"Svc Medium","business_criticality":"medium"}]
PASS UNIT src/rest/routes/__tests__/hap174-mounted.harness.test.ts (6.57 s)
  ✓ drives the real BusinessServices page against the mounted route + PGlite (5915 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        6.801 s, estimated 12 s
Ran all test suites matching /packages\/api-server\/src\/rest\/routes\/__tests__\/hap174-mounted.harness.test.ts/i.
EXIT=0
~~~~~~

## 8. Harness source (deleted after proof)

### packages/api-server/src/rest/routes/__tests__/hap174-mounted.harness.test.ts

~~~~~~
// THROWAWAY HAP-174 harness: real business-service.routes.ts (auth + Joi + controller) on PGlite,
// listening on 127.0.0.1; spawns the web-ui vitest page driver against it, then checks the DB.
import { fork, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';

Object.assign(process.env, {
  JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters-long',
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<any[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const pgClient = { query: async (sql: string, params: unknown[] = []) => ({ rows: await send('query', sql, params) }) };

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => ({}),
  getAuditService: () => ({}),
}));
jest.mock('bcrypt', () => ({}));
const ADMIN_ID = 'hap174-admin';
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) =>
      userId === 'hap174-admin' ? { _id: 'hap174-admin', _username: 'admin', _role: 'admin', _enabled: true } : null,
  })),
}));

import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { businessServiceRoutes } from '../business-service.routes';

const MIGRATION = join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql');
const DDL_TABLES = ['dim_business_services', 'business_service_dependencies', 'ci_business_service_mappings'];
const ddl = () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  return DDL_TABLES.map(t => sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`))![0]).join('\n');
};

jest.setTimeout(180000);

it('drives the real BusinessServices page against the mounted route + PGlite', async () => {
  await send('exec', ddl());
  await send('exec', `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status) VALUES
    ('bs-c','Svc Critical','application','application','critical','active'),
    ('bs-h','Svc High','application','application','high','active'),
    ('bs-m','Svc Medium','application','application','medium','active'),
    ('bs-l','Svc Low','application','application','low','active');`);

  const app = express();
  // Harness substitution: jsdom XHR enforces CORS; the page origin differs from the harness port.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.use((req, _res, next) => { process.stdout.write(`[api] ${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}\n`); next(); });
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/business-services', businessServiceRoutes);
  const server = await new Promise<import('http').Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = (server.address() as import('net').AddressInfo).port;
  const token = new JWTService(loadConfig().auth.jwt).generateAccessToken(ADMIN_ID, 'admin', 'admin');

  try {
    const ui = await new Promise<{ status: number | null }>(resolve => {
      const child = require('child_process').spawn('npx', ['vitest', 'run', 'src/pages/hap174-mounted.driver.test.tsx'], {
        cwd: join(__dirname, '../../../../../../web-ui'),
        env: { ...process.env, VITE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`, HAP174_TOKEN: token },
        stdio: 'inherit',
      });
      child.on('exit', (status: number | null) => resolve({ status }));
    });
    process.stdout.write(`[harness] ui driver exit=${ui.status}\n`);
    const rows = await send('query', 'SELECT service_id, name, business_criticality FROM dim_business_services ORDER BY service_id');
    process.stdout.write(`[harness] DB after UI: ${JSON.stringify(rows)}\n`);
    expect(ui.status).toBe(0);
    expect(rows.find(r => r.name === 'Harness New')?.business_criticality).toBe('high');
    expect(rows.find(r => r.service_id === 'bs-c')).toMatchObject({ name: 'Svc Critical', business_criticality: 'low' });
  } finally {
    server.close();
    host.kill();
  }
});
void spawnSync;
~~~~~~

### web-ui/src/pages/hap174-mounted.driver.test.tsx

~~~~~~
// THROWAWAY HAP-174 driver: real BusinessServices + real apiClient (no vi.mock) against the harness server.
import { describe, expect, it } from 'vitest';
// Same jsdom polyfills as BusinessServices.test.tsx (Radix Select).
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
import { screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { render } from '@/tests/utils/test-utils';
import BusinessServices from './BusinessServices';

const mount = () => {
  localStorage.setItem('auth_token', process.env.HAP174_TOKEN!);
  return render(<><BusinessServices /><Toaster /></>);
};
const rowFor = async (name: string) => (await screen.findByText(name, {}, { timeout: 5000 })).closest('tr') as HTMLElement;
const choose = async (user: UserEvent, trigger: HTMLElement, label: string) => {
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: label }));
};

describe.sequential('HAP-174 mounted', () => {
  it('env', () => { console.log('[driver] base', import.meta.env.VITE_API_BASE_URL); expect(import.meta.env.VITE_API_BASE_URL).toMatch(/^http:\/\/127/); });

  it('canonical labels + filter from real GET', async () => {
    const user = userEvent.setup();
    mount();
    for (const [n, l] of [['Svc Critical', 'Critical'], ['Svc High', 'High'], ['Svc Medium', 'Medium'], ['Svc Low', 'Low']]) {
      expect(within(await rowFor(n)).getByText(l)).toBeInTheDocument();
    }
    await choose(user, screen.getByRole('combobox', { name: /filter by criticality/i }), 'Critical');
    expect(screen.getByText('Svc Critical')).toBeInTheDocument();
    expect(screen.queryByText('Svc Low')).not.toBeInTheDocument();
    cleanup();
  });

  it('explicit create persists across reload', async () => {
    const user = userEvent.setup();
    mount();
    await rowFor('Svc Low');
    await user.click(screen.getByRole('button', { name: /create service/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/service name/i), 'Harness New');
    const submit = within(dialog).getByRole('button', { name: /create service/i });
    expect(submit).toBeDisabled();
    await choose(user, within(dialog).getByRole('combobox', { name: /^criticality$/i }), 'High');
    await user.click(submit);
    await rowFor('Harness New');
    cleanup();
    mount(); // reload: fresh GET from mounted route/DB
    expect(within(await rowFor('Harness New')).getByText('High')).toBeInTheDocument();
    cleanup();
  });

  it('edit criticality persists across reload', async () => {
    const user = userEvent.setup();
    mount();
    const [edit] = within(await rowFor('Svc Critical')).getAllByRole('button');
    await user.click(edit);
    const dialog = await screen.findByRole('dialog');
    const trigger = within(dialog).getByRole('combobox', { name: /^criticality$/i });
    expect(trigger).toHaveTextContent('Critical');
    await choose(user, trigger, 'Low');
    await user.click(within(dialog).getByRole('button', { name: /update service/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    cleanup();
    mount();
    expect(within(await rowFor('Svc Critical')).getByText('Low')).toBeInTheDocument();
    cleanup();
  });

  it('real Joi 400 keeps dialog/input, existing row, shows error toast', async () => {
    const user = userEvent.setup();
    mount();
    const [edit] = within(await rowFor('Svc High')).getAllByRole('button');
    await user.click(edit);
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(/service name/i);
    await user.clear(name);
    await user.type(name, 'ab');
    await user.click(within(dialog).getByRole('button', { name: /update service/i }));
    const toast = await screen.findByText(/failed/i, {}, { timeout: 5000 });
    console.log('[driver] toast text:', toast.textContent);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByLabelText(/service name/i)).toHaveValue('ab');
    expect(screen.getByText('Svc High')).toBeInTheDocument();
    cleanup();
  });
});
~~~~~~

## 9. FRESH COMPLETE prerequisite capture (2026-09-23, supersedes partial sections 1-2)

Earlier sections 1-2 are partial (jq/grep-filtered pack output; npm ci tail only) and the first pointer-capture harness log is lost;
none of those bytes were recovered or reconstructed. Everything below is a new run, every byte of each captured stream included verbatim
(files in `/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/scratch2/`, outside git). Streams captured separately; exit = real `$?` of the command.

### 9.0 Run identity

~~~~~~
2026-09-23T20:12:37Z
cwd=/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/scratch2
repo=/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo HEAD=3578bb56d841c8e213185682e8a3fc4aaa4f777b
job=2dd434d5-db07-499e-b2b0-f3c6c47c89d2
node=v22.23.2 npm=10.9.8
~~~~~~

### 9.1 npm pack (cwd `/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/scratch2`)

~~~~~~
$ npm pack @happy-technologies/design-system@0.7.1 --ignore-scripts --registry=https://registry.npmjs.org/ --json > pack.stdout 2> pack.stderr; echo $? > pack.exit
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
--- pack.exit ---
0
~~~~~~

### 9.2 Archive hashes (expected SHA1 60d6c25cd69620c1301622bb64a81d01ce34e78b, SHA512 sHn6pU9V...BXZAew==)

~~~~~~
$ sha1sum happy-technologies-design-system-0.7.1.tgz
60d6c25cd69620c1301622bb64a81d01ce34e78b  happy-technologies-design-system-0.7.1.tgz
EXIT=0
$ openssl dgst -sha512 -binary happy-technologies-design-system-0.7.1.tgz | base64 -w0
sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew==
EXIT=0
~~~~~~
Capture defect, disclosed: the second `EXIT=0` above is the status of an intervening bare `echo` (newline), NOT of the openssl|base64
pipeline. Re-run with the real per-stage pipeline status (`hash2.log`, verbatim):
~~~~~~
$ openssl dgst -sha512 -binary happy-technologies-design-system-0.7.1.tgz | base64 -w0
sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew== PIPESTATUS=0 0
~~~~~~
Both digests equal the expected values and the registry `dist.shasum`/`dist.integrity` in 9.4.

### 9.3 Full archive listing and path safety

~~~~~~
$ tar tvzf happy-technologies-design-system-0.7.1.tgz > list.stdout 2> list.stderr; echo $? > list.exit
--- list.stdout (21 entries) ---
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
--- list.exit ---
0
$ tar tzf happy-technologies-design-system-0.7.1.tgz | awk '!/^package\// || /(^|\/)\.\.(\/|$)/ || /^\//' > unsafe.txt   # entries outside package/, containing a `..` segment, or absolute
unsafe_exit=0 unsafe_count=0
$ tar tvzf happy-technologies-design-system-0.7.1.tgz | awk '$1 !~ /^-/' > nonregular.txt   # symlinks/hardlinks/devices/dirs
nonregular_count=0
~~~~~~
Path safety rests on the full listing above plus both checks: every entry is a regular file (`-rw-r--r--`), under `package/`, with no `..` segment and no absolute path.

### 9.4 Extraction (sibling outside git) and registry metadata

~~~~~~
$ mkdir -p /home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/happy-technologies-design-system && tar xzf happy-technologies-design-system-0.7.1.tgz -C /home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/happy-technologies-design-system --strip-components=1 > extract.log 2>&1; echo "EXIT=$?" >> extract.log
--- extract.log ---
EXIT=0
$ npm view @happy-technologies/design-system@0.7.1 name version gitHead dist.shasum dist.integrity --registry=https://registry.npmjs.org/ > view.log 2>&1; echo "EXIT=$?" >> view.log
--- view.log ---
name = '@happy-technologies/design-system'
version = '0.7.1'
gitHead = 'acb0c9481837131360e822f58ced7196a27f7ab2'
dist.shasum = '60d6c25cd69620c1301622bb64a81d01ce34e78b'
dist.integrity = 'sha512-sHn6pU9VHbV/Xc0HvhXb1p2WO1pZecPXvY/iUWHs0lhPE6k3oIjLEUwKKPpeiJWaKIn6uxSPYWG5oCqlBXZAew=='
EXIT=0
$ git -C /home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/happy-technologies-design-system rev-parse
fatal: not a git repository (or any parent up to mount point /home/coder)
~~~~~~
Registry gitHead `acb0c9481837131360e822f58ced7196a27f7ab2` and integrity match the requested artifact; the extracted sibling is not a git checkout and was not modified, built or tested.

### 9.5 Root npm ci (cwd `/home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/repo`)

~~~~~~
$ npm ci --ignore-scripts --no-audit --no-fund > ../scratch2/ci.stdout 2> ../scratch2/ci.stderr; echo $? > ../scratch2/ci.exit
--- ci.stdout (28 bytes) ---

added 1591 packages in 18s
--- ci.stderr (4557 bytes) ---
npm warn deprecated supertest@6.3.4: Please upgrade to supertest v7.1.3+, see release notes at https://github.com/forwardemail/supertest/releases/tag/v7.1.3 - maintenance is supported by Forward Email @ https://forwardemail.net
npm warn deprecated superagent@8.1.2: Please upgrade to superagent v10.2.2+, see release notes at https://github.com/forwardemail/superagent/releases/tag/v10.2.2 - maintenance is supported by Forward Email @ https://forwardemail.net
npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported
npm warn deprecated npmlog@5.0.1: This package is no longer supported.
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you want a good and tested way to coalesce async requests by a key value, which is much more comprehensive and powerful.
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported
npm warn deprecated ldapjs@3.0.7: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated gauge@3.0.2: This package is no longer supported.
npm warn deprecated are-we-there-yet@2.0.0: This package is no longer supported.
npm warn deprecated @ldapjs/attribute@1.0.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/protocol@1.2.1: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/asn1@2.0.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/controls@2.1.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/dn@1.1.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/change@1.0.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/filter@2.1.1: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @ldapjs/messages@1.3.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated @humanwhocodes/object-schema@2.0.3: Use @eslint/object-schema instead
npm warn deprecated @humanwhocodes/config-array@0.13.0: Use @eslint/config-array instead
npm warn deprecated @babel/plugin-proposal-export-namespace-from@7.18.9: This proposal has been merged to the ECMAScript standard and thus this plugin is no longer maintained. Please use @babel/plugin-transform-export-namespace-from instead.
npm warn deprecated glob@8.1.0: Glob versions prior to v9 are no longer supported
npm warn deprecated @apollo/server-gateway-interface@1.1.1: @apollo/server-gateway-interface v1 is part of Apollo Server v4, which is deprecated and will transition to end-of-life on January 26, 2026. As long as you are already using a non-EOL version of Node.js, upgrading to v2 should take only a few minutes. See https://www.apollographql.com/docs/apollo-server/previous-versions for details.
npm warn deprecated eslint@8.57.1: This version is no longer supported. Please see https://eslint.org/version-support for other options.
npm warn deprecated @ldapjs/asn1@1.2.0: This package has been decomissioned. See https://github.com/ldapjs/node-ldapjs/blob/8ffd0bc9c149088a10ec4c1ec6a18450f76ad05d/README.md
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me
npm warn deprecated @apollo/server@4.13.0: Apollo Server v4 is end-of-life since January 26, 2026. As long as you are already using a non-EOL version of Node.js, upgrading to v5 should take only a few minutes. See https://www.apollographql.com/docs/apollo-server/previous-versions for details.
--- ci.exit ---
0
$ git status --short > ../scratch2/status.after 2>&1; echo "EXIT=$?" >> ../scratch2/status.after
--- status.after ---
EXIT=0
~~~~~~
Empty `git status --short` (before this doc edit): no tracked manifest/lock change from the install. No source, test, manifest or lock file changed in this correction; only this document.
