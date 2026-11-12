# web-ui after S1 (HAP-1252 UX-4b, S1a + S1b: shell, theme, login, 403 and error states)

Screenshots of every main screen in the new shell, light and dark. Same fixtures, same viewport and same capture method as `docs/ux/before/` (re-captured in S1, see its README), so `before/NN-name.png` compares one to one with `NN-name-light.png` here.

Method: Vite dev server on the S1b head (S1a plus S1b), headless Chromium, 1440 px wide, theme chosen by `prefers-color-scheme` alone (no stored choice: this also exercises the first-load rule of N6). The route is loaded at 1440x900, the document height is measured, the viewport is resized to that height (900 to 5000 px) and a normal screenshot is taken. That is the fix for review finding L5: the rail and topbar span the whole shot instead of stopping at 900 px. The API is stubbed at `/api/v1/**` (session restored from a stubbed `/auth/refresh` + `/auth/me`, user "Admin User", role `admin` unless a state below says otherwise; `00-login` answers `/auth/refresh` with 401). Screens with no fixture render their real empty state. Data is invented; the point is layout and theme.

Files: `NN-name-light.png`, `NN-name-dark.png`, `NN-name` as in the table of `docs/ux/before/README.md` (`00-login` to `23-settings`), plus the S1b states:

| File | State |
|---|---|
| `00-login-*` | restyled login on DS components |
| `24-state-forbidden-read-*` | `/cis` while the server answers `GET /cis` with 403 `{_error, _message: "Permission 'read' required"}`: the reason shows as a banner above the page |
| `25-state-not-found-*` | `/no/such/screen`: designed not-found state inside the shell (was a silent redirect to `/`) |
| `26-state-render-error-*` | `/` with a malformed dashboard response, so the screen throws: DS crash state with Try again and Reload page, shell still up |
| `27-state-viewer-credentials-*` | `/credentials` as role `viewer`: no Create or edit controls |
| `28-state-viewer-business-services-*` | `/business-services` as role `viewer`: no write controls (UX6) |
| `29-state-operator-credentials-*` | `/credentials` as role `operator`: write controls present |

## Where the screens moved

The collapsed DS rail has no sub-menus, so each rail item opens its section's first screen and the section's other screens are a DS `Tabs` strip under the topbar (`SectionNav`, `components/layout/navigation.ts`). Rail order is the freeze order.

| Rail item | Screens |
|---|---|
| Dashboard | `/`, `/dashboards/executive`, `/dashboards/cio`, `/dashboards/itsm`, `/dashboards/finops`, `/dashboards/business-service` |
| Configuration items | `/cis`, `/inventory`, `/cmdb-health`, `/anomalies` |
| Business services | `/business-services`, `/financial-management` |
| Discovery | `/discovery`, `/agents`, `/jobs`, `/credentials`, `/credential-sets` |
| Connectors | `/connectors`, `/connectors/catalog` |
| Analytics | `/analytics`, `/ai/patterns` |
| Settings | `/settings` |

The old Business Insights, Service Management, Integration, AI & Analytics and Administration groups are dissolved. Every route still resolves; no route path changed.

## Dispositions (freeze MF1-MF8, findings F1-F14)

| Item | Disposition |
|---|---|
| MF1 rail | Done: DS rail, existing screens, freeze order; active item follows the route; CI count as a DS count dot with the number as screen-reader text. |
| MF2 lockup, "Workspace" label | Done (`AppRail`): DS cube icon lockup. The old `/assets/logo.svg` did not exist and is gone. |
| MF3 greeting and date | Done (`AppTopbar`, `greeting.ts`): from the user of `/auth/me`, no new call. |
| MF4 search | Done: Enter goes to `/cis?search=<encoded>`; the existing CI search, no backend change. F6. |
| MF5 bell | Hidden by decision N11 (it opened nothing). F9. |
| MF6 account menu | Done (`AccountMenu`): theme switch, profile (Settings), sign out. F5, F13. |
| MF7 Copilot aside | Not in S1: belongs to S5 (BW13). Recorded only. |
| MF8 light and dark | Done (N6): `ThemeContext`, stored in `localStorage` key `hh-theme`, follows `prefers-color-scheme` until the user chooses. |
| F4 sidebar | Replaced by the rail; the static "Part of HappyHive" card is dropped (static copy). |
| F7 tenant dropdown | Hidden: static text, no tenant-list API (N8). |
| F8 health dots | Kept (`ServiceHealthDots`): the DS `HealthDot` has no unknown or degraded state, so these are small custom dots. |
| F1 login | Restyled on DS components (`Login`, `LoginForm`); sign-in behaviour unchanged. Dead controls removed: Forgot password and Contact administrator (no target), Remember me (the value was never passed to `login()`). The footer is plain text. Password still uses the unmirrored-value input (`useUnmirroredValue`). |
| F2/F3 session and guard | No change to the guard or session logic (out of scope). The only addition is that `attachSession` reports a 403 (see F10). |
| F10 error boundary and toasts | `ErrorBoundary` is the DS boundary with Try again and Reload page, logged through `logClientError`; it resets on navigation. A 403 is reported by `lib/session.ts` to `ForbiddenHost`: a refused read is a danger banner "Access denied. {server reason}" cleared on route change, a refused write is a toast "Not permitted" with the server reason; "Forbidden" when the body has none. |
| UX3 role type | `User.role` is the server's `ServerRole` (`admin`, `operator`, `viewer`, `agent`); it was `admin`, `user`, `viewer`. |
| UX4, UX6 role gating | `lib/permissions.ts` copies the server's `ROLE_PERMISSIONS`; `RequirePermission` and `usePermission` hide write controls the server would refuse (about 20 files, `permission="write"`; `admin` only for pattern approve/activate). No user or an unknown role sees none. |
| UX5 unknown routes | `*` renders `NotFound` inside the shell instead of redirecting to `/`. |
| UX7 tenant dropdown, UX8 bell | See F7 and MF5. |
| F11 theme | Done (MF8, above). |
| F12 WebSocket, F14 responsive | Not part of S1: recorded, no change. |

## Dark theme

`HappyTheme` renders the DS dark tokens. Legacy utility classes that the not-yet-migrated screens still use (`text-gray-*`, `bg-white`, `divide-*`, navy text) are remapped in one block of `web-ui/src/index.css` under the dark selector, using tokens only (no raw hex). Each rule is to be deleted as the S2-S8 screens move to DS components. Check: the share of near-white pixels (all channels above 200) in each dark shot is 0.1-0.6% on every route and state, i.e. text and icons only, no light surface left. Charts on the dashboards use their own series colours and are unchanged.

`--white` is re-pointed at the dark surface, and `text-primary-foreground` / `text-destructive-foreground` read it at the element (`@theme inline` in `index.css`), so they would turn dark on the sky and red fills. The dark block therefore restates both as the DS `--hh-on-solid` (white in every theme). `fix-dark-primary-destructive.png` is the dark theme with the exact class strings of `ConnectorDashboard.tsx` (primary) and `DiscoveryDefinitionCard.tsx` (destructive) on the live Vite build: computed text colour `rgb(255, 255, 255)` on both fills. Without the rule it is `rgb(15, 23, 48)`.
