# web-ui after S2 (HAP-1252 UX-4b, S2: estate hub)

Screenshots of the new Dashboard (`/`), the estate hub, light and dark. Same method, fixtures style and viewport as `docs/ux/after-s1/`: Vite dev server on the branch head, headless Chromium, 1440 px wide, theme by `prefers-color-scheme` alone, the route loaded at 1440x900 then the viewport grown to the document height (900 to 5000 px) for a normal screenshot, wait for the page heading and for the Inter, Jost and Phosphor fonts (the capture fails otherwise). The API is stubbed at `/api/v1/**` (session from stubbed `/auth/refresh` + `/auth/me`, user "Admin User", role `admin` unless a state says otherwise). Data is invented: 33 CIs of eight types and 37 relationships answer `GET /cis` (stubbed `total` 12,840) and `GET /relationships` (stubbed `total` 3,120); one open P1 incident answers `GET /itil/incidents?status=NEW`. Nothing here is measured from a real estate.

## Before

`before-01-dashboard-{light,dark}.png` is the Dashboard at the S1b head (`docs/ux/after-s1/01-dashboard-*`, copied; `main` has not touched the Dashboard since). It shows the KPI row this slice removes: a "Health score" computed from `health_score * 100` (a hardcoded `0` on the server today, BW4), a "Critical relationships" card that is the total relationship count, and the lede "Your service graph is healthy".

## After

| File | State |
|---|---|
| `30-hub-orbit-*` | default: incident ribbon, Stage in Orbit view, KPI stack, Live changes and Top services (not available yet), then the existing distribution cards |
| `31-hub-graph-*` | `/?view=graph`: Cytoscape graph of the same sample |
| `32-hub-list-*` | `/?view=list`: CI table (CI, Class, Environment, Status) with the category filter; the note names the columns that need BW1 and BW2 |
| `33-hub-orbit-filter-data-*` | the Data chip chosen: dots outside the category dim |
| `34-state-no-open-incident-*` | no open incident: success ribbon "No open incidents." |
| `35-state-incidents-forbidden-*` | `GET /itil/incidents` answers 403: the ribbon shows the reason, the page-level banner stays down (side read) |
| `36-state-cis-error-*` | `GET /cis` answers 500: error with Try again on the topology surface |
| `37-state-cis-forbidden-*` | `GET /cis` answers 403: the topology surface shows the server reason, and the shell shows "Access denied." (a primary read) |
| `38-state-empty-admin-*` | no CIs, role `admin`: empty state with Run discovery |
| `39-state-empty-viewer-*` | no CIs, role `viewer`: the same empty state without Run discovery (`RequirePermission write`) |
| `40-state-loading-*` | `GET /cis` never answers: loading state |
| `41-topology-redirect-*` | `/topology` (the retired TopologyMap address) lands on `/?view=graph` |

## Notes

- Orbit is static SVG, Graph is Cytoscape (already a dependency), List is a DS `DataTable`. three.js is not used (decision N1, see the PR).
- The Stage draws a capped sample (150 CIs and the endpoints of up to 400 relationships) because the tenant-wide topology summary (BW3) is not on `main`. The subtitle says how many CIs and relationships the estate has and how many are drawn.
- Health, Config drift and Coverage show "Not available yet" and name the missing backend (BW1/BW4, BW5, BW6). No deltas or sparklines: there is no KPI history (BW7). Live changes (BW9) and Top services (BW10) are the same kind of state.
- The Critical chip is a static chip that says it is not available yet (it needs BW1).
- The Environment pie label in dark is the existing S1 chart colour, not part of this slice.
- Capture note: the Graph shots wait 2.5 s for the Cytoscape layout; the Cytoscape canvas is real in these shots (jsdom has none, so the unit test covers the no-canvas fallback only).
