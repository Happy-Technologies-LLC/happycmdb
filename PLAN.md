# HAP-174 remaining checklist (PR #20)

Done (job 2dd434d5, evidence in /home/coder/jobs/2dd434d5-db07-499e-b2b0-f3c6c47c89d2/validation.md):
- [x] design-system@0.7.1 packed from registry.npmjs.org, sha512/sha1 verified, extracted to ../happy-technologies-design-system; root `npm ci` exit 0, lock unchanged.
- [x] Focused `npm --prefix web-ui run test:run -- src/pages/BusinessServices.test.tsx`: 6/6 pass on final source; 6/6 fail with page swapped to c5a4e6f (restored identical).
- [x] Fixed rejected-write test: mount sonner `<Toaster />` (test-utils lacks it).

Remaining (a fresh job must re-provision the sibling + `npm ci` first; job dirs are scrubbed):
- [ ] Throwaway harness: mount real `business-service.routes.ts` (Joi + controller) on express with PGlite via `packages/api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs` pattern (see `business-service-child-reads.test.ts`: in-memory auth user, JWT from `JWTService`). Drive the BusinessServices page against it (apiClient pointed at the harness, not mocked): distinct canonical reads + filter, explicit create and edit persisted + reload, unknown not silently valid, name<3 rejected write keeps dialog/row and shows error toast. Record every substitution (auth store, getPostgresClient). Remove harness after proof; keep exact commands/source in validation.md.
- [ ] Browser visual check if a browser is available; otherwise disclose absence.
- [ ] Copy full validation.md into a single evidence doc on this PR (e.g. docs/archive/HAP-174-validation.md), then delete this PLAN.md.
