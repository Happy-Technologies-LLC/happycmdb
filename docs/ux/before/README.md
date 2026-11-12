# web-ui "before" state (HAP-1252 UX-4b, slice S0)

Baseline for the UX-4b design-system adoption. Light mode only; dark-mode "before" shots wait for S1 (design-freeze phase order).
Code base: `origin/main` @ `25c1dabc` plus the S0 change (DS switched to `@happy-technologies/design-system` 1.1.0 from npm; no UI change).

## Design-system share (decision N10)

```
$ npm run --silent ds-share --workspace=web-ui
ds-share: 16 of 2289 primitive use sites on the design system = 0.7% (16 ds, 1993 local components/ui, 280 raw h1-h3/button/select/table/input/textarea; 18.4% counting 496 DS Icon sites); screens on the design system: 1 of 23 (pages/**/*.tsx)
```

Method (`web-ui/scripts/ds-share.mjs`, TypeScript AST over `web-ui/src`, test files excluded):

- Counts JSX use sites of the primitives the design system replaces.
- `ds`: tag imported from `@happy-technologies/design-system` (named, aliased or namespace member), `Icon` excluded.
- `localUi`: tag imported from `src/components/ui/**` (the app's own shadcn-style copies).
- `raw`: `h1 h2 h3 button select table input textarea`.
- Share = `ds / (ds + localUi + raw)`. Layout tags (`div`, `span`, router components) are not part of the denominator, otherwise 80% would be unreachable.
- DS `Icon` is reported separately (N10): it is 496 sites and would inflate the number to 18.4%.

Reproducibility note: the freeze document quotes "16 of 1,891, 0.8%; 21.2% incl. Icon". The numerator (16) reproduces. The 1,891 denominator and the 21.2% do not: the definition behind them is not in the repo. The denominator above is a stated, re-runnable one, so the S0 baseline is **0.7%**, and later slices compare against this script, not against the freeze figure.

Target per N10: 80% by end of S8. CI prints the number on every run (job summary) but does not gate on it yet (`--min <pct>` exists for that).

## Gates added in S0

- `lint:ds` (warn-first): runs oxlint with the DS `adherence.oxlintrc.json` (banned imports such as `lucide-react`) plus `happy-ds-adherence`. Today: 0 banned imports, 229 adherence problems (~90 raw hex colours; `Badge` variants `outline`/`secondary`/`destructive`; `Button` variant `destructive`, size `icon`) and 1 deprecation notice (`Dashboard.tsx` `MetricCard` tone `amber`). Some Badge/Button findings are the app's own `components/ui` components that happen to share a name; they go away as those are replaced. Exits 0 with a `::warning`; `--deny-warnings` exits 1 and is for S2 onward.
- `check:ds-tokens` (hard gate): every `--hh-*` token web-ui reads must be declared by the DS CSS or by web-ui itself. Today: 22 distinct tokens, all declared.
- `test:scripts`: `node --test` for the three scripts.

## Screenshots

`*.png` here, 1440 px wide, light (`prefers-color-scheme: light`), Vite dev server, headless Chromium.
**Re-captured in S1 (review finding L5).** The first S0 set used full-page capture, which mishandles fixed-position elements (the old sidebar background stopped at 900 px). Every shot is now taken by loading the route at 1440x900, measuring the document height, resizing the viewport to that height (900 to 5000 px) and taking a normal screenshot, so fixed and sticky parts span the whole page. `docs/ux/after-s1/` uses the identical method, so before and after compare one to one. Code: `origin/main` @ `7ccc5a52` (S0 merged), a worktree of it, not the S1 branch. Observed, cause not investigated: body text in these shots renders in a different sans face than in `after-s1`; layout is unaffected.
**No backend was available**, so the API is stubbed at the network layer (`/api/v1/**` fulfilled with fixtures; session restored from a stubbed `/auth/refresh` + `/auth/me`, user "Admin User"; `00-login` answers `/auth/refresh` with 401). Screens with a fixture show data (dashboard, CIs, CI detail, inventory, executive); the others render their real empty state. Numbers and names are invented and are the same fixtures as in `after-s1`. The point of the set is layout, typography and component look, not data.

| File | Route |
|---|---|
| `00-login.png` | `/login` (signed out) |
| `01-dashboard.png` | `/` |
| `02-cis.png` | `/cis` |
| `03-ci-detail.png` | `/cis/:ciId` |
| `04-discovery.png` | `/discovery` |
| `05-agents.png` | `/agents` |
| `06-credentials.png` | `/credentials` |
| `07-credential-sets.png` | `/credential-sets` |
| `08-inventory.png` | `/inventory` |
| `09-jobs.png` | `/jobs` |
| `10-analytics.png` | `/analytics` |
| `11-connectors.png` | `/connectors` |
| `12-connector-catalog.png` | `/connectors/catalog` |
| `13-cmdb-health.png` | `/cmdb-health` |
| `14-anomalies.png` | `/anomalies` |
| `15-ai-patterns.png` | `/ai/patterns` |
| `16-dash-executive.png` | `/dashboards/executive` |
| `17-dash-cio.png` | `/dashboards/cio` |
| `18-dash-itsm.png` | `/dashboards/itsm` |
| `19-dash-finops.png` | `/dashboards/finops` |
| `20-dash-business-service.png` | `/dashboards/business-service` |
| `21-business-services.png` | `/business-services` |
| `22-financial-management.png` | `/financial-management` |
| `23-settings.png` | `/settings` |

The 24 routes are every route in `web-ui/src/App.tsx` except the `*` redirect. The dev server served the DS fonts and CSS with no 403/404 after the sibling-checkout `server.fs.allow` entry was removed.
