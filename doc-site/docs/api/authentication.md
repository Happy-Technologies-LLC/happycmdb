# Authentication API

Complete API reference for user authentication, token management, and API key operations in HappyCMDB v3.0.

## Overview

HappyCMDB supports two authentication methods:
1. **JWT Tokens** - For interactive user sessions (recommended for web/mobile apps)
2. **API Keys** - For service-to-service communication and automation

## Base URL

```
http://localhost:3000/api/v1/auth
```

## Default credentials, credential generation and operator rotation

The seeded development admin (`admin` / `Admin123!`, used in the examples below) only works with
`NODE_ENV=development`. In every other environment:

- **Default passwords are refused.** A login with `Admin123!`, or with any string bcrypt treats as the
  same key (for example `'Admin123!\0'` repeated to 72 bytes), gets the same response as a wrong
  password: `401` with `{"success":false,"error":"Authentication failed"}`. A login password containing
  U+0000 is also refused. The server log records the reason `default_credential_refused` (never the
  password).
- **Marked accounts.** If such a login matches the account's stored hash, the account is marked
  (`defaultPasswordSuspect`). A marked account cannot log in, refresh, use API keys or keep a
  WebSocket open, even with a different password. Login never clears the mark. The seeded admin
  is marked when it is created.
- **Recovery is operator-only.** An operator with direct database access runs
  `packages/api-server/src/scripts/rotate-user-password.ts --user-id <id> --operator <name>` and
  supplies the new password on stdin. The new password must be 12–72 UTF-8 bytes, contain no U+0000,
  and not be a default.
  - The rotation sets the new hash, clears the mark and increments the user's **credential
    generation**.
  - Every earlier access token, refresh token, API key and WebSocket of that user stops working.
    Pre-rotation API keys are also revoked.
  - Each run is audited in `auth_credential_events`: an intent row, then exactly one outcome.
  - When the run cannot see its outcome (Neo4j unreachable), it reports `PENDING`. Resolve that with
    `--reconcile` before rotating anyone else.
  - **Existing databases: prepare once before the first rotation.** The rotation's outcome fence
    needs the Neo4j uniqueness constraint `credential_rotation_decision_event`. New databases get it
    from `infrastructure/scripts/init-neo4j.cypher`; never re-run that script on an existing
    database. Instead run `rotate-user-password.ts --prepare` (same `CMDB_ROTATE_*` connection
    variables; creates the constraint idempotently and confirms it) or apply
    `packages/database/src/neo4j/migrations/002_credential_rotation_decision.cypher` with
    `cypher-shell`. Without it every rotation is refused with `decision_constraint_missing`.

**User lookup index (Neo4j migration 003).** Every authenticated request loads the user by `_id` or
`id`. New databases get the `user_id_lookup` index on `User._id` from `init-neo4j.cypher`. On an
existing database an operator applies
`packages/database/src/neo4j/migrations/003_user_id_lookup_index.cypher` once with `cypher-shell`,
then waits until `SHOW INDEXES YIELD name, state WHERE name = 'user_id_lookup'` reports `ONLINE`.
Never re-run `init-neo4j.cypher` on an existing database (it also writes the seeded admin and sample
data), and note that `rotate-user-password.ts --prepare` does not create this index. Without it
authentication is unchanged but slower, because each lookup scans every user.

**One user per identifier.** An identifier must resolve to exactly one user node across both
spellings (`_id`/`id` for tokens and API keys, `_username`/`username` for login). If two different
nodes match, for example one user's `_id` equal to another user's `id`, every login, token, refresh
token and API key for that identifier gets the standard `401`, and profile writes change nothing.
An operator must make the identifiers unique.

**New passwords** (`PUT /api/v1/auth/password`) are refused with `400 Password not allowed` in every
environment when they are a default or a default-equivalent, contain U+0000, or exceed 72 UTF-8
bytes. A password change or account deletion authorized before an operator rotation is refused with
`401 Credentials changed`.

**A self-service password change ends every session AND every API key of the user** (HAP-1285): it
advances the user's credential generation together with the new hash. Every other access token,
refresh cookie and WebSocket of the user is refused on its next use (WebSockets within the 2-minute
re-check), and so is every API key of the user: keys are valid only at the generation they were
created in, so they stop authenticating (`401`) and must be recreated. The changing device stays signed in: the `200` response
(message "Password changed. All other sessions and all your API keys have been revoked; this device
stays signed in.") carries `data` (`_accessToken`, `_expiresIn`, `_user`, as login) and sets a new
`__Secure-cmdb_rt` cookie, whose 7-day cap starts at the change. After the write the change also
revokes the user's key rows below the new generation (`enabled = false`, `revoked_at` set; HAP-1669),
so a rollback that resets the generation cannot revive them. Revoked keys are not returned by
`GET /api/v1/auth/api-keys`: after the change the list holds only keys created since it. This step is
best-effort: a failure is logged by error class only and does not fail the request, since the generation
already refuses the keys. A key of an older generation whose revoke failed stays unrevoked, so the list
still returns it with `_enabled: false` (it never authenticates) until a later change revokes it.

**Password changes are rate-limited and audited** (HAP-1368). `PUT /api/v1/auth/password` shares the
login limit per client address (`RATE_LIMIT_AUTH_MAX` per `RATE_LIMIT_AUTH_WINDOW_MS`, the same
bucket as login) and adds a per-user limit across all client addresses at login's per-account budget
(`RATE_LIMIT_AUTH_ACCOUNT_MAX` per `RATE_LIMIT_AUTH_ACCOUNT_WINDOW_MS`, default 5 per 15 minutes).
Past either limit it answers `429`; while the rate-limit store is unreachable it answers `503` and
changes nothing. Each attempt that reaches a decision appends one row to the
hash-chained `audit_log` (entity `USER`, the user id as entity and actor, client address (null when
unavailable), organization, a fixed `metadata.outcome`; never a password, hash or token): `success`,
`wrong_password` (400), `policy_failure` (400, the new password is not allowed), `rotation_lost` (401,
credentials changed since the session was issued), `user_not_found` (404) and `rate_limited` (429).
Response bodies are the same with or without the audit row. `policy_failure`, `user_not_found` and
`rotation_lost` rows are recorded before (or without) proof of the current password: the request has a
valid session but has not shown the current password, so a row records a refused attempt by that
session, not a verified one (`rotation_lost` is also written when the guarded write loses a race after
the proof; the row does not say which). The `503` for an audit chain that is not
ready (`AUDIT_CHAIN_KEY` unset) is refused before the current password is checked and is not audited:
the chain cannot be written then. Request-validation `400`s (malformed body) are not audited. A change
by a user without an organization never reaches a decision: it is refused with `403` (below), so no
row is written and no change is made. For the same user a `429` writes no row either (an error is logged). `rate_limited` is the first `429`
per user and refusing bucket (the client bucket, the user bucket) per window, and its row's
`metadata.bucket` names the refusing bucket (`client`, `user`; the login-only `account` and
`account-global` buckets do not apply here). Each audit write takes the
global audit-chain lock, so retries past the limit append no further rows until the window passes
(a Redis `SET rate-limit:auth-user-refused:<userId>[:client] <random token> NX PX <window>` decides; if
Redis fails the `429` is unchanged and no row is written). The claim is taken before the write so
concurrent refusals write one row. When the write fails or is skipped (no organization claim) the claim
is not deleted: its TTL is cut to a **30 second backoff** (`REFUSAL_AUDIT_BACKOFF_MS` in
`rest/auth.controller.ts`), so an audit-store fault costs at most one write attempt per user and bucket
per 30 seconds, and the first `429` after the backoff retries and writes the row (it never lengthens the
window: the TTL only shortens). The cut is owner-checked (a Lua compare of the stored token, then
`PEXPIRE`): a slow write whose claim has expired and been retaken by a later request leaves the newer
claim alone. If the backoff itself fails (Redis down) the claim keeps its window TTL and no row is
written for the rest of that window, the same as when the claim fails. Requires PostgreSQL
migration `049_audit_entity_user.sql`.

**Revoke other sessions (step-up)** (HAP-1716). `POST /api/v1/auth/sessions/revoke-others` with
`{"currentPassword": "..."}` ends every other session, refresh token and API key of the user without
changing the password. It advances the credential generation by exactly one (the password hash is
never written) and answers like a password change: `200` with a new `_accessToken`, a new refresh
cookie (its 7-day cap starts now) and no refresh token in the body; this device stays signed in. It
needs a JWT session (an API key gets `403`), the current password (`400` when wrong), a user with an
organization (`403 Organization required to revoke sessions`, nothing changed), and a credential
generation that has not moved since the session was issued (`401 Credentials changed`). API keys are
also revoked best-effort, as for a password change. It is audited like a password change with
`metadata.operation = "revoke_other_sessions"` (outcomes `success`, `wrong_password`,
`rotation_lost`, `user_not_found`, `rate_limited`); without `AUDIT_CHAIN_KEY` it answers `503` before
any check. Rate limit: login's per-client-address bucket, a per-user-**and**-client-address bucket and a
per-user-**and**-session bucket (the last two at `RATE_LIMIT_AUTH_ACCOUNT_*`, default 5 per 15 minutes,
the budget of `PUT /password`). The session is the login: the `_authTime` claim of the access token,
copied from the refresh token on every refresh, so every token refreshed from one login shares the
bucket whatever address it comes from, and only a fresh authentication (login, password change, a
successful step-up, all of which need the password) starts a new one. A session holder therefore gets
at most that budget of password guesses per window from all addresses together, the same bound as
`PUT /password`. A wrong guess never returns a token or a new login time; the new session of a successful
step-up deliberately starts a new login time (its 7-day cap restarts too). The owner's own login is
another session with its own bucket, so a thief draining the stolen session's bucket cannot hold the
owner out; there is no per-user bucket across sessions or the account-wide cap login has. An access
token issued before this claim existed is refused `401 Session must be renewed` before any bucket is
spent or password checked (the web client then renews from its refresh cookie); it never falls back to
per-address limits only. A limiter store error answers `503`. Residual risk: an attacker behind the owner's own client
address shares the address bucket, and one holding the same login's token shares its session bucket, so
either can hold that device out of the step-up for a window (the owner signing in again starts a
fresh session bucket only: the client-address and user-and-client-address buckets stay held until their
window ends); a stolen session can still spend the session budget every window until its 7-day
cap. A first `429` per user and bucket per window is audited with `metadata.bucket` `client`,
`user-client` or `session`, claimed at `rate-limit:auth-session-revoke-refused:<userId>:<bucket>`.

**A user with no organization cannot change their password through this endpoint** (HAP-1714).
`PUT /api/v1/auth/password` answers `403 {"success":false,"error":"Forbidden","message":"Organization
required to change password"}` and changes nothing: no hash, no generation advance, no API-key
revocation, no `audit_log` row, no cookie or token. The refusal comes before the current password is
checked, so a wrong password for such a user is also `403`, not `400`. It applies when the stored
user has no organization (or a value that is not a UUID), and also when the request's organization
claim is absent or is not the stored organization (a race with `assign-organization`; the token
takes its claim from the stored user on every request, so a retry after the assignment works). The
status is `403`, not `409` or `401`: the caller is authenticated and the request is well formed, but
their account state forbids the operation by policy, and only an operator action can change that. A
write that loses the organization between the read and the write lands nothing and answers
`401 Credentials changed`.

Which path applies to such a user:

- An operator gives the user an organization with
  `packages/api-server/src/scripts/identity-window.ts assign-organization --user-id <id> --organization-id <uuid> --operator <name>`
  (see "Assigning a user's organization (FD-5)" in [Authentication](/components/authentication.md)),
  and the user then changes their password themselves.
- Otherwise the operator rotation, `packages/api-server/src/scripts/rotate-user-password.ts`, is the
  supported way to change their password. It does not depend on an organization and records
  `auth_credential_events`, not `audit_log`.

No supported creation path produces such a user today: the init and `seed-data` accounts are in the
internal organization and no API route creates users. They remain possible for accounts that predate
organization scoping, for the `--target` fixture of `scripts/seed-tenant-fixture.ts` (one viewer
without an organization, on purpose) and for direct database writes; the guard stays for them.

**Platform administrators** are a dedicated flag, set only by the operator command
`scripts/identity-window.ts grant-platform-admin`. Role `admin` and organization grant nothing. A
seeded account (the init or seed-data admin, or any account with seed provenance or a default
password) never qualifies. API keys never act as platform administrators. The flag is checked on
every request against the stored user record; tokens and verified request identities carry no
platform-admin claim, so revoking the flag takes effect on the next request. No route accepts platform
administrators yet: global TBM and connector controls still refuse every caller.

**Portfolio import scope** (`portfolio:import`) is the dedicated scope that `POST /api/v1/portfolio/imports`
requires. It is an entry of the user's stored `scopes` list, set only by two reviewed operator commands (the same
identity-window step and `CMDB_ROTATE_*` connections as `grant-platform-admin`; a third only records a change), never through the API:

```bash
scripts/identity-window.ts grant-portfolio-import-scope  --user-id <id> --operator <name>
scripts/identity-window.ts revoke-portfolio-import-scope --user-id <id> --operator <name>
scripts/identity-window.ts record-portfolio-import-scope --grant|--revoke --user-id <id> --operator <name>
```

The third, `record-portfolio-import-scope`, is the recovery for a change whose audit row was not written (below); it
changes no scope.

Grant and revoke both require `--user-id` and `--operator` (1-200 printable characters after trimming; control, format (for example
U+202E, U+200B) and line/paragraph separator characters are refused; anything else invalid exits 1 before
any store opens). Grant adds only `portfolio:import` (no duplicate, other scopes kept); revoke removes only that
entry. A change prints one JSON line
`{"userId": "<id>", "outcome": "granted" | "revoked", "operator": "<name>", "occurredAt": "<UTC, microseconds>", "eventId": "<uuid>"}`;
a repeat is `unchanged`, prints `{"userId": "<id>", "outcome": "unchanged"}` and writes nothing. Each `granted` or
`revoked` change appends one row to the append-only `auth_credential_events` table (event
`portfolio_import_scope_granted` / `portfolio_import_scope_revoked`, actor `window-script:<operator>`). `eventId` is
that row's `id` (its primary key: look the row up by it); `occurredAt` is that row's `occurred_at` at full microsecond
precision (`2026-11-18T09:30:00.123456Z`), so `WHERE occurred_at = '<occurredAt>'` matches it too. Every grant
and revoke leaves a row (a change whose row failed is recovered with the record command below). The node
properties `portfolioImportScopeGrantedBy/At` and `portfolioImportScopeRevokedBy/At` remain only as the latest-state
cache; each new change overwrites them. Read the confirmed history (ambiguous rows excluded, see below) with:

```sql
SELECT id, occurred_at, event, user_id, actor FROM auth_credential_events
WHERE event LIKE 'portfolio_import_scope_%' AND actor NOT LIKE 'window-script-ambiguous:%' ORDER BY occurred_at;
```

The scope change in Neo4j is made first and the audit row second; the two stores cannot share a transaction. If the
row cannot be written, the command exits 3 (`AuditWriteFailed`, fixed message: the change was applied but its audit
row was not written) and the scope change stays applied, with the node properties as the only record. The same exit 3
covers a Neo4j write that errors on the client after the server may have committed it (a lost commit acknowledgement):
the command then re-reads the user's scope under the lock, and if it already holds the requested state the change is
applied and unrecorded, so it exits 3 as above, not 1. If the scope is unchanged after the error, or cannot be re-read
(Neo4j still unreachable), the outcome is unknown, because Neo4j may still apply the write after that re-read. The
command then appends one row for the requested change with actor `window-script-ambiguous:<operator>` (same event
as a real change, inside the same transaction as the lock) and exits 1 with the error text, redacted. An
ambiguous row means "requested, outcome not confirmed", not "applied": it is also written when the write was refused
outright, so it is expected noise, and it never counts as a recovery row. Check the live scope; run the record
command only if it changed. If the ambiguous row itself cannot be written, the original error stands and the exit
is still 1; this path never exits 0. Exit 1 prints the error text with credential-like content replaced by `***`:
URL userinfo (`scheme://user:pw@host`), `Bearer <token>`, and the value after `=` or `:` of any key containing
`password`, `passwd`, `token` or `secret`. A value flag directly followed by another value flag
(`--operator --user-id p`) is a usage error (exit 1, before any store opens), not an operator named `--user-id`.

Ambiguous rows are not confirmed changes: exclude them from a history read with
`AND actor NOT LIKE 'window-script-ambiguous:%'`.

**Recovery after exit 3: `record-portfolio-import-scope`.** The exit-3 message prints the exact command for its own
action, with the same flag as the failed run:

```bash
scripts/identity-window.ts record-portfolio-import-scope --grant  --user-id <id> --operator <name>   # after a failed grant
scripts/identity-window.ts record-portfolio-import-scope --revoke --user-id <id> --operator <name>   # after a failed revoke
```

It writes the missing `portfolio_import_scope_granted` / `portfolio_import_scope_revoked` row and **makes no Neo4j
write**: do not grant or revoke again (that would change the scope a second time and leave the first change
unrecorded). Exactly one of `--grant` or `--revoke` is required (matched only as a flag: the token after
`--operator`, `--user-id`, `--organization-id` or `--except` is that flag's value, never a direction), and
`--operator` has the validation above. The row has the same event as a real change but its actor is
`window-script-record:<operator>`, so a recovery row is told apart from a grant or revoke row; the operator who runs
the record is the actor, and the row's time is the time of the record, not of the original change. Before it
writes, it reads the live scope and refuses, with exit 2
(`GrantRefused`, `scope_state_mismatch`) and no row, unless the state matches the action: `--grant` only while the
user holds `portfolio:import`, `--revoke` only while the user does not. It applies the identity refusals of grant and
revoke below, and prints the same JSON line as a change, with `"recordOnly": true` and `"alreadyRecorded"`.

Every grant and revoke writes a fresh operation id (a UUID) on the user node in the same statement as the scope change
(`portfolioImportScopeGrantedOpId` / `portfolioImportScopeRevokedOpId`). The record reads the id of the change it
records (`--grant` reads the granted id, `--revoke` the revoked id) and stores it as the last 33 characters of the
recovery row's actor: `window-script-record:<operator>#<32 hex digits>`. The record is idempotent on that id alone:
under the lock it appends nothing when a recovery row of the same event already carries the node's current id, and
prints that row with `"alreadyRecorded": true` (its `operator` is the earlier row's), so a retry after an ambiguous
commit adds no duplicate. Every later grant or revoke writes a new id, so a recovery row of an earlier operation never
covers a later change, whether or not that change was recorded in between: a change whose recovery was skipped gets its
own row on the next record. No clock of either store is compared. A node whose marker predates the id (granted or
revoked by an older build) has none: its record always appends a row with no suffix, so a retry of such a record can
append a second row, but a change is never left without a row. The invariant assumes every grant and revoke is made by
a build that writes the id: an older build's change leaves the previous id on the node, and a record after it could be
absorbed by that id's row, so do not run an older build's grant or revoke against a user the newer build has changed. If the record's own insert fails it exits 1
(`the audit row was not written and nothing else was changed`); run the same command again. An error while shaping the
printed result after the row was written exits 1, never 3. To list only the recovery rows:
`WHERE event LIKE 'portfolio_import_scope_%' AND actor LIKE 'window-script-record:%'`.

**Per-user lock.** Grant, revoke and record each take a PostgreSQL transaction-scoped advisory lock keyed on the
target user id, `pg_advisory_xact_lock(2129, hashtext(<user id>))`, as the first statement of the transaction that
also holds the audit insert. It is held across the Neo4j read, the Neo4j change and the audit insert, and released at
commit or rollback, so two runs on one user queue: the second reads the user only after the first has finished, and a
user's real change rows (actor `window-script:`), ordered by `occurred_at` (the time of the insert, not of the
transaction's start), are in the order of the Neo4j changes. Recovery and ambiguous rows are not: a recovery row is
dated when it is recorded, an ambiguous row may stand for a write that was refused or lands later. Different users do not wait for each other. The two-integer form with class 2129 is a different
key space from every other advisory lock in the application (one-bigint keys, and the two-integer class 8271), so no
existing lock is taken or blocked by a user id; a hash collision of two ids only makes their runs wait for each other.
The lock wait is **unbounded**: there is no `lock_timeout`, and the Neo4j reads made while the lock is held have no
timeout (each Neo4j write transaction is bounded at 30 seconds), so a stalled run holds up every other run on the
same user until it ends or its PostgreSQL session is terminated. This is acceptable for an interactive operator command;
stop the stalled process. A holder stalled in a Neo4j read is idle in its transaction, so `pg_cancel_backend` does
nothing to it; if the lock must be freed from the database side, run `pg_terminate_backend` on the `pid` this query returns. A node
that stores both `_id` and `id` answers to either, and a run that came in by one spelling and resolved to the other
holds both locks (the argument's first, the resolved id's second), so the filter must cover both. The operator supplies
two values: the stalled run's `--user-id` as `<user id>`, and the id the run resolved to as `<resolved id>` (the node's
other spelling: read the node's `_id` and `id` in Neo4j; write the same value twice when the node has one id).

```sql
SELECT DISTINCT l.pid
FROM pg_locks l
WHERE l.locktype = 'advisory' AND l.classid = 2129 AND l.objsubid = 2 AND l.granted
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND l.objid IN ((hashtext('<user id>')::bigint & 4294967295)::oid, (hashtext('<resolved id>')::bigint & 4294967295)::oid)
  AND EXISTS (SELECT 1 FROM pg_locks w WHERE w.locktype = 'advisory' AND w.classid = 2129 AND w.objsubid = 2
    AND w.database = l.database AND w.objid = l.objid AND NOT w.granted)
  AND NOT EXISTS (SELECT 1 FROM pg_locks x WHERE x.pid = l.pid AND x.locktype = 'advisory' AND x.classid = 2129
    AND x.objsubid = 2 AND NOT x.granted);
```

The `objid` terms are the key `pg_advisory_xact_lock(2129, hashtext(...))` takes; without them the filter also selects
the lock of every other user's concurrent run, and terminating that `pid` stops the wrong run. The `EXISTS` term keeps
only a lock some other session is waiting for, and the `NOT EXISTS` term drops a session that is itself waiting: a
run that came in by one spelling, holds that spelling's lock and waits on the other can have a third run queued behind
it, and it is a waiter, not the stalled run. The result is the `pid` of the session at the head of the queue, one row
for one stalled run. It is empty when no run waits on either id, or when the ids supplied are not the stalled run's (a
different user's id, or a waiting run's spelling that the holder does not hold): check both values before concluding
that no run is stalled. The lock is then released and a waiting run
proceeds, but the terminated process is still alive and can reach its Neo4j write. That write is guarded by
`coalesce(u.scopes, []) = $observed`, so it changes nothing when the waiting run changed the scopes first: the stalled
run exits 2 (`refused: not_applied`). If the write still applies (the scopes were unchanged), its audit insert fails on
the lost session and the run exits 3: recover it with the record command. A run terminated while it is still waiting
for the lock exits 1 with "PostgreSQL is unavailable" and nothing changed.

**PostgreSQL outage.** The lock is a precondition: when PostgreSQL cannot be connected to, grant, revoke and record
now refuse up front, with exit 1 and a fixed message (`... refused: PostgreSQL is unavailable, so the per-user lock
could not be taken; nothing was changed`), before any Neo4j read or write. Before HAP-2129 a PostgreSQL outage let the
Neo4j change happen and ended in exit 3. Now exit 3 means only that the Neo4j change was made and has no audit row:
PostgreSQL failed after it (the insert or the commit failed) or the Neo4j write errored after committing: recover it
with the record command above. After an exit 1 refusal, re-run the
same grant or revoke once PostgreSQL is back.

Grant and revoke both refuse (exit 2, `GrantRefused`) an unknown or ambiguous identity, an identity held by another node
(`identity_collision`), a seeded account, a default-password account, a `scopes` value that is not a list of
strings, and a write that lost the compare-and-set race (`not_applied`: the user's scopes or eligibility changed
between the read and the write; re-run). Role `admin`, organization and platform administration grant
nothing; the scope is re-read on every request, so a revoke takes effect on the next request.

**Revoking from an account flagged as having a default password: reset first, then revoke.** A flagged account
never holds the scope (the request-time check refuses it), but its stored `scopes` list is untouched, and the
operator password reset clears the flag, so the stored grant is live again from that moment. Revoke is refused
(`seeded_account`) while the flag is set, so the order is:

1. Rotate the account's password with `scripts/rotate-user-password.ts` (the only path that clears the flag). If the
   rotation reports `PENDING` (the run could not see its outcome because Neo4j was unreachable), run
   `rotate-user-password.ts --reconcile` and wait for `APPLIED` before step 2: a `PENDING` rotation may or may not
   have cleared the flag, and the revoke is refused (`seeded_account`) while it is still set.
2. Run `revoke-portfolio-import-scope --user-id <id> --operator <name>` straight after; expect `"outcome": "revoked"`.

Do not leave a flagged account that holds the grant waiting after step 1: until step 2 it holds the scope.

**Running either command on staging or production requires founder approval, named in the change record.**
Until a user holds the scope the portfolio import is unusable: every caller gets `403`.

---

## JWT Authentication

### Login

Authenticate with username and password to obtain JWT tokens. `username` is alphanumeric, 3-30 characters; `password` is at least 8 characters. Email is not accepted as a login identifier.

**Endpoint**: `POST /api/v1/auth/login`

**Request Body**:
```json
{
  "username": "admin",
  "password": "Admin123!"
}
```

A body with `email` instead of `username` fails validation (`username` is required); `email` alongside `username` is ignored (unknown fields are stripped).

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "_accessToken": "<access-token>",
    "_expiresIn": 900,
    "_user": {
      "_id": "user-admin-001",
      "_username": "admin",
      "_role": "admin"
    }
  }
}
```
The refresh token is not in the body: with the header `X-CMDB-Auth: 1` (exactly; the web UI sends it) it is set as `__Secure-cmdb_rt=<refresh JWT>; Max-Age=<refresh TTL>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict` (HAP-1211 H1, renamed from `cmdb_rt` in H2). `Max-Age` is the refresh TTL, but never more than what is left of the 7-day absolute cap from the login (HAP-1382), so the cookie never outlives the session refresh still accepts. A login without that header (scripts, the CLI, or a cross-site form, which cannot add a custom header) gets the same `200` body and **no cookie** (HAP-1211 H2, login CSRF): it cannot refresh and signs in again when the access token expires. Browsers do not store a `Secure` cookie from plain `http://` other than `localhost`, and never store a `__Secure-` cookie from plain `http://`.

**Caching** (HAP-1382): every `/api/v1/auth/*` response, refusals included, carries `Cache-Control: no-store` and `Pragma: no-cache`, so no browser or proxy cache keeps an access token, an API key, the refresh cookie or account data. A failure of the user or API-key store answers the endpoint's fixed body (`"message": "Internal error"`) and logs only the error class, its code and the user id, never the driver's message.

**Web UI session (HAP-1211 H2)**: the web UI holds the access token only in memory, never in `localStorage` or `sessionStorage`. A reload or a new tab restores the session with `POST /api/v1/auth/refresh`, the UI renews the access token about a minute before it expires, and a logout in one tab signs out the other tabs of the same browser. **Cut-over**: the first load after the upgrade signs every web UI user out once, because a session saved by an older release (a `localStorage` token, or a `cmdb_rt` cookie) is not carried over; the server does not clear an old `cmdb_rt` cookie, which expires on its own and is never read. On plain `http://` (local development without TLS) the browser refuses the `__Secure-` cookie, so a reload there always asks you to sign in again.

**Token Lifetimes**:
- **Access Token**: 15 minutes by default (`JWT_ACCESS_TOKEN_EXPIRES_IN`)
- **Refresh Token**: 7 days by default (`JWT_REFRESH_TOKEN_EXPIRES_IN`); each refresh issues a new one with a full TTL (sliding). **Absolute cap** (HAP-1285): refresh is refused once more than 7 days have passed since the login (or self-service password change) the session began with, however often it was renewed; then sign in again. The cap is fixed, not configurable. The last access token issued keeps its own TTL, so a session lasts at most 7 days plus the access TTL.

**Error Responses**:
- `401 Unauthorized` - Invalid credentials
- `403 Forbidden` - Account disabled
- `429 Too Many Requests` - Rate limit exceeded (per client address 20 login attempts per hour by default; per-account limits also apply, see [Rate Limiting](#rate-limiting))

---

### Refresh Token

**Endpoint**: `POST /api/v1/auth/refresh` with the header `X-CMDB-Auth: 1` (exactly). Exchanges the `__Secure-cmdb_rt` cookie (the only token source; no body is read) for a new access token and a new `__Secure-cmdb_rt` cookie (same attributes, full TTL: sliding, within the 7-day absolute cap from login; its `Max-Age` is clamped to the time left of that cap, HAP-1382).

**Error Responses** (fixed bodies): `403 Forbidden` without `X-CMDB-Auth: 1`, checked first. `401 Unauthorized` when the cookie is missing, duplicated or malformed, or the token is invalid, expired, not a refresh token, of an older credential generation (HP1-S6, including after a self-service password change), more than 7 days past its login (HAP-1285; a refresh token issued before HAP-1285 carries no login time and is refused too), or its user is disabled.

---

### Logout

**Endpoint**: `POST /api/v1/auth/logout` → `{ "success": true, "message": "Logged out successfully" }`. Expires the `__Secure-cmdb_rt` cookie (`Max-Age=0`, past `Expires`, same attributes); no header and no access token are required.

**Stateless** (founder decision, HAP-1211 H1b): logout only clears this browser's cookie. A refresh cookie captured before logout can still be renewed until 7 days after the login it came from (HAP-1285 absolute cap), or earlier when the user changes their password, an operator rotation changes the user's credential generation, or the account is disabled or deleted. The access token stays valid until it expires (15 minutes by default).

**Accepted residual** (HAP-1297): logout needs no `X-CMDB-Auth` header, no access token and no cookie to be answered, so a cross-site `POST` can sign a browser out (a forced logout; the user signs in again). `SameSite=Strict` does not limit this: it only keeps the browser from sending the cookie on a cross-site request, and logout does not need the cookie in the request to answer with the expiring `Set-Cookie`. The `X-CMDB-Auth: 1` header rule protects refresh and the login cookie, not logout. What bounds the impact is that logout only expires the cookie: it reads, issues and revokes nothing, and the in-memory access token keeps working until it expires.

---

### Get Current User

Get information about the currently authenticated user.

**Endpoint**: `GET /api/v1/auth/me`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Response** (200 OK), the caller's own record only (also the `data` of `PUT /api/v1/auth/profile`):
```json
{
  "success": true,
  "data": {
    "userId": "user-1",
    "username": "alice",
    "email": "alice@example.com",
    "name": "Alice",
    "avatar": "data:image/png;base64,...",
    "role": "operator",
    "permissions": ["read", "write", "discover"],
    "createdAt": "2025-01-01T00:00:00Z",
    "lastLoginAt": "2025-11-15T10:00:00Z",
    "platformAdmin": false,
    "organizationId": "org-acme"
  }
}
```

`permissions` is the server role table's grant for `role` (empty for a stored role the table does not know); it is for display, the server still checks every request. `platformAdmin` is the effective platform-administrator status the server enforces (the stored flag, never true for a seeded account). `organizationId` is the caller's organization, `null` for a user without one. Both come from the stored user, not from the request or token claims; the UI displays them and never decides access from them.

**Error Responses**:
- `401 Unauthorized` - Missing or invalid access token

---

## API Key Authentication

### Generate API Key

Create a new API key for programmatic access.

**Endpoint**: `POST /api/v1/auth/api-key`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Request Body**:
```json
{
  "name": "Production Automation Script",
  "expiresInDays": 365,
  "role": "operator"
}
```

**Supported Roles**:
- `viewer` - Read-only access
- `operator` - Read + discovery operations
- `admin` - Full access (use sparingly)

**Response** (201 Created):
```json
{
  "success": true,
  "data": {
    "_id": "apikey-123-abc",
    "_name": "Production Automation Script",
    "_key": "cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j",
    "_role": "operator",
    "_enabled": true,
    "_expiresAt": "2026-11-15T10:00:00Z",
    "_createdAt": "2025-11-15T10:00:00Z",
    "warning": "This API key will only be displayed once. Store it securely."
  }
}
```

**IMPORTANT**: The API key (`_key`) is only shown once. Store it securely immediately.

**API Key Format**: `cmdb_{env}_{prefix}_{random_string}`
- `env`: Environment (`test`, `live`)
- `prefix`: Key type (`sk1` = secret key v1)
- `random_string`: Cryptographically secure random string

**Error Responses**:
- `400 Bad Request` - Invalid expiration or role
- `401 Unauthorized` - Missing or invalid access token

---

### List API Keys

Get all API keys for the current user.

**Endpoint**: `GET /api/v1/auth/api-keys`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "apiKeys": [
      {
        "_id": "apikey-123-abc",
        "_name": "Production Automation Script",
        "_role": "operator",
        "_enabled": true,
        "_createdAt": "2025-11-15T10:00:00Z",
        "_expiresAt": "2026-11-15T10:00:00Z",
        "_lastUsedAt": "2025-11-15T14:30:00Z",
        "keyPreview": "cmdb_live_sk1_1a2b...i0j",
        "daysUntilExpiration": 365
      },
      {
        "_id": "apikey-456-def",
        "_name": "CI Import Script",
        "_role": "operator",
        "_enabled": true,
        "_createdAt": "2025-10-01T10:00:00Z",
        "_expiresAt": null,
        "_lastUsedAt": null,
        "keyPreview": "cmdb_live_sk1_9z8y...a1b",
        "status": "never_used"
      }
    ],
    "total": 2
  }
}
```

**Note**: Full API keys are never returned in list operations for security.

---

### Revoke API Key

Revoke (delete) an API key permanently.

**Endpoint**: `DELETE /api/v1/auth/api-key/:keyId`

**Headers**:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

**Example Request**:
```bash
curl -X DELETE "http://localhost:3000/api/v1/auth/api-key/apikey-123-abc" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "API key revoked successfully"
}
```

**Error Responses**:
- `404 Not Found` - API key does not exist
- `403 Forbidden` - Cannot revoke another user's API key (unless admin)

---

## Using Authentication

### JWT Token Authentication

Include the access token in the `Authorization` header for all API requests:

```bash
curl "http://localhost:3000/api/v1/cis" \
  -H "Authorization: Bearer <access-token>"
```

**Example (JavaScript)**:
```javascript
const response = await fetch('http://localhost:3000/api/v1/cis', {
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }
});
```

**Example (Python)**:
```python
import requests

headers = {
    'Authorization': f'Bearer {access_token}',
    'Content-Type': 'application/json'
}

response = requests.get('http://localhost:3000/api/v1/cis', headers=headers)
```

---

### API Key Authentication

Include the API key in the `X-API-Key` header:

```bash
curl "http://localhost:3000/api/v1/cis" \
  -H "X-API-Key: cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j"
```

**Example (JavaScript)**:
```javascript
const response = await fetch('http://localhost:3000/api/v1/cis', {
  headers: {
    'X-API-Key': 'cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j',
    'Content-Type': 'application/json'
  }
});
```

**Example (Python)**:
```python
import requests

headers = {
    'X-API-Key': 'cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j',
    'Content-Type': 'application/json'
}

response = requests.get('http://localhost:3000/api/v1/cis', headers=headers)
```

---

## Role-Based Access Control (RBAC)

The server has four roles and four permissions (`packages/api-server/src/auth/types.ts`). Every route is checked on the server against the user's current stored role; a viewer who is shown a write control is still refused.

### Roles and permissions

| Role | Permissions | Use Case |
|------|-------------|----------|
| **admin** | `read`, `write`, `discover`, `admin` | IT administrators |
| **operator** | `read`, `write`, `discover` | DevOps engineers, operators |
| **viewer** | `read` | Auditors, business stakeholders |
| **agent** | `discover`, `write` | Discovery agents (API key) |

`GET /api/v1/auth/me` returns the caller's `role` and the `permissions` the table above grants it.

### The 403 body

Every refusal by a permission, role, organization, JWT-session, platform-administrator or scope guard has one shape. It keeps both key families the server has always sent (`_error`/`_message` and `success`/`error`/`message`) and adds a stable `code`:

```json
{
  "success": false,
  "error": "Forbidden",
  "message": "Permission 'write' required",
  "_error": "Forbidden",
  "_message": "Permission 'write' required",
  "code": "PERMISSION_REQUIRED",
  "required": { "permission": "write" },
  "role": "viewer"
}
```

| `code` | Refused because | Extra keys |
|--------|-----------------|------------|
| `PERMISSION_REQUIRED` | the role lacks the route's permission | `required.permission`, `role` |
| `ROLE_REQUIRED` | the route is limited to named roles | `required.roles`, `role` |
| `ORGANIZATION_REQUIRED` | the user or token has no organization claim | none |
| `JWT_SESSION_REQUIRED` | an API key called an account operation | none |
| `PLATFORM_ADMIN_REQUIRED` | the user is not the dedicated platform administrator | none |
| `SCOPE_REQUIRED` | the user lacks a dedicated scope | `required.scope` |

`role` is the caller's own role and `required` the route's fixed requirement. Other 403s (an unavailable global operation, a queue the server will not mutate, the refresh-cookie header check) keep their own bodies. A missing or invalid credential is `401`, never this body.

---

## Rate Limiting

Only four authentication endpoints carry a rate limiter: `POST /api/v1/auth/login`, `PUT /api/v1/auth/password`, `POST /api/v1/auth/sessions/revoke-others` and `POST /api/v1/auth/refresh`. The other `/api/v1/auth/*` routes (`logout`, `me`, `profile`, `account`, and the API key routes `POST /api/v1/auth/api-key`, `GET /api/v1/auth/api-keys`, `DELETE /api/v1/auth/api-key/:keyId`) have no dedicated limiter. The API key routes are session-only: they need a JWT session (`authenticate` then `requireJwtSession`), and an API key cannot call them. No generic REST limiter is mounted on the other `/api/v1/*` routes.

### Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/v1/auth/login` | 20 per IP (`RATE_LIMIT_AUTH_*`), 5 per account + IP (`RATE_LIMIT_AUTH_ACCOUNT_*`) and 20 per account across all IPs (`RATE_LIMIT_AUTH_ACCOUNT_GLOBAL_*`); the account is the trimmed, lowercased username | 1 hour per IP; 15 minutes per account + IP and per account |
| `PUT /api/v1/auth/password` | Login's 20 per IP (shared bucket) and 5 per user across all IPs (`RATE_LIMIT_AUTH_ACCOUNT_*`) | 1 hour per IP; 15 minutes per user |
| `POST /api/v1/auth/sessions/revoke-others` | Login's 20 per IP (shared bucket), 5 per user **and IP**, and 5 per user **and session** across all IPs (`RATE_LIMIT_AUTH_ACCOUNT_*`); the session is the login (`_authTime`, kept across refresh), so another login of the same user has its own bucket (HAP-1716) | 1 hour per IP; 15 minutes per user + IP and per user + session |
| `POST /api/v1/auth/refresh` | The REST budget (`RATE_LIMIT_REST_MAX`, default 1000; `0` = unlimited) under its own key, so renewals never use up the login limit (HAP-1211 H2) | `RATE_LIMIT_REST_WINDOW_MS` (default 1 hour) per IP |
| Other `/api/v1/auth/*` endpoints, including `POST /api/v1/auth/api-key` | No dedicated limiter | n/a |

The client address ("IP") is `req.ip`: `X-Forwarded-For` counts only for the hops `TRUST_PROXY` trusts (default:
none). See [Proxy Trust & Login Rate Limiting](/configuration/environment-variables#proxy-trust-login-rate-limiting).
Every per-IP bucket key (login, password change, refresh) uses the address normalized (HAP-1715): an IPv4 address
is itself, an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is its IPv4 address, and any other IPv6 address is its
`/64`, so a client rotating through its own `/64` shares one bucket. A value that is not an IP address shares one
`unknown` bucket.
While the rate-limit store is unreachable, login and password change answer a fixed `503` with
`Cache-Control: no-store` and never check the password (fail closed); refresh is let through (fail open).

### Rate Limit Headers

The three limited endpoints return rate limit info in response headers, on allowed and on `429` responses. They are absent when `rateLimit.enabled` is `false`, when the request carries the bypass header (`rateLimit.bypassHeader`) with the value of `rateLimit.bypassSecret`, when the endpoint's `max` is `0` (`rateLimit.endpoints.auth.max` for login and password; `rateLimit.endpoints.rest.max` for refresh, which is then not mounted), and when the limiter store errors (refresh fails open and sets none; the fail-closed `503` of login and password carries none). Nginx's own `429` carries none:

```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 15
X-RateLimit-Reset: 1699642800000
```

`X-RateLimit-Reset` is a Unix timestamp in **milliseconds** (the request time plus the window), not seconds. Divide by 1000 for epoch seconds, or pass it to `new Date(...)`. The `429` body's `_resetAt` is the same instant as an ISO 8601 string, and `_retryAfter` is in seconds. Requests refused before the limiter runs carry no rate-limit headers: `requireAuthHeader` on refresh (a fixed `403` without `X-CMDB-Auth: 1`), and `authenticate()` / `requireJwtSession()` on password (`401`, or `403` for an API key).

**429 Too Many Requests Response**:
```json
{
  "_error": "Too Many Requests",
  "_message": "Rate limit exceeded. Try again in 3600 seconds",
  "_retryAfter": 3600,
  "_limit": 20,
  "_resetAt": "2023-11-10T19:00:00.000Z"
}
```

On login and password change, the headers and every `429` report only the per-IP bucket (HAP-1795). The
per-account, per-account + IP and per-user buckets still refuse with `429`, but their counts, limits and
windows never appear: a refusal by one of them carries the same headers (`X-RateLimit-Remaining: 0`) and body
as a per-IP refusal, and `_retryAfter` is the per-IP window. The same holds for the per-user-and-client and
per-user-and-session buckets of `POST /auth/sessions/revoke-others`.

---

## Security Best Practices

### For JWT Tokens

1. **Store Securely**: Never store tokens in localStorage or sessionStorage (any script on the page can read them). Keep the access token in memory and the refresh token in the httpOnly cookie.
2. **HTTPS Only**: Always use HTTPS in production to prevent token interception.
3. **Token Expiration**: Implement automatic token refresh before expiration.
4. **Logout**: Implement proper logout to clear tokens from client.
5. **Token Rotation**: Refresh tokens are rotated on each refresh operation.

### For API Keys

1. **Secure Storage**: Store API keys in environment variables or secret managers (never in code).
2. **Least Privilege**: Use the minimum required role (prefer `viewer` or `operator` over `admin`).
3. **Key Rotation**: Rotate API keys regularly (every 90-180 days).
4. **Expiration**: Set expiration dates for API keys (avoid permanent keys).
5. **Monitoring**: Monitor API key usage via `_lastUsedAt` field.
6. **Revocation**: Immediately revoke compromised keys.

### Password Requirements

Passwords must meet these criteria:
- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character (!@#$%^&*)

**Example Strong Passwords**:
- `MySecure#Pass123`
- `HappyCMDB2025!`
- `Admin@CMDB$2025`

---

## Common Authentication Flows

### Web Application Flow

1. User enters credentials on login page
2. Frontend calls `POST /api/v1/auth/login` with `X-CMDB-Auth: 1` (without it no refresh cookie is set)
3. Keep `accessToken` in memory; the server sets the refresh token as the `__Secure-cmdb_rt` HttpOnly cookie
4. Include `accessToken` in Authorization header for all API calls
5. Before token expiry, call `POST /api/v1/auth/refresh` with `X-CMDB-Auth: 1` (the browser sends the cookie)
6. On logout, call `POST /api/v1/auth/logout` (expires the cookie) and discard the access token

### API/Script Flow

1. Administrator creates API key via UI or `POST /api/v1/auth/api-key`
2. Store API key in environment variable or secret manager
3. Include API key in `X-API-Key` header for all requests
4. Monitor usage and rotate key periodically

### Mobile App Flow

1. User authenticates with `POST /api/v1/auth/login`
2. Store `accessToken` in secure storage (Keychain/Keystore)
3. Log in with `X-CMDB-Auth: 1` and keep the `__Secure-cmdb_rt` cookie from the response in encrypted secure storage
4. Implement background token refresh
5. Clear tokens on logout

---

## Troubleshooting

### "Invalid or expired token"

**Cause**: Access token has expired (15-minute lifetime by default)

**Solution**:
1. Use refresh token to get new access token
2. If refresh token is also expired, re-authenticate with username/password

**Example**:
```bash
# Get new access token (cookie jar written by a login call sent with -H "X-CMDB-Auth: 1" -c cookies.txt)
curl -X POST "http://localhost:3000/api/v1/auth/refresh" -H "X-CMDB-Auth: 1" -b cookies.txt -c cookies.txt
```

---

### "Rate limit exceeded"

**Cause**: Too many authentication attempts from same IP

**Solution**: Wait for rate limit window to reset (shown in `_retryAfter` seconds)

**Prevention**: Implement exponential backoff in client code

---

### "Account disabled"

**Cause**: User account has been disabled by administrator

**Solution**: Contact system administrator to re-enable account

---

### "API key not found"

**Cause**: API key has been revoked or never existed

**Solution**: Generate a new API key via `POST /api/v1/auth/api-key`

---

## Testing Authentication

### Test Login with cURL

```bash
# Login
curl -X POST "http://localhost:3000/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "Admin123!"
  }'

# Save access token from response
export ACCESS_TOKEN="<access-token>"

# Test authenticated request
curl "http://localhost:3000/api/v1/cis" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Test API Key with cURL

```bash
# Generate API key (requires logged-in access token first)
curl -X POST "http://localhost:3000/api/v1/auth/api-key" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test API Key",
    "role": "operator"
  }'

# Save API key from response
export API_KEY="cmdb_live_sk1_1a2b3c4d5e6f7g8h9i0j"

# Test API key request
curl "http://localhost:3000/api/v1/cis" \
  -H "X-API-Key: $API_KEY"
```

---

## Environment Variables

Configure authentication behavior via environment variables:

```bash
# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-minimum-32-chars
JWT_ACCESS_TOKEN_EXPIRES_IN=15m   # default; refresh token: JWT_REFRESH_TOKEN_EXPIRES_IN (default 7d)

# API Key Configuration
API_KEY=your-api-key-for-service-to-service-authentication

# Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_AUTH_MAX=20
RATE_LIMIT_AUTH_WINDOW_MS=3600000
```

**See**: `.env.example` for complete configuration

---

## Migration from v2.0

### No Breaking Changes

Authentication in v3.0 is fully backward compatible with v2.0:
- Same JWT token format
- Same login endpoints
- Same API key format

### New Features in v3.0

1. **API Key Management**: Create, list, and revoke API keys via API
2. **Enhanced RBAC**: More granular permission model
3. **Token Rotation**: Refresh tokens are automatically rotated
4. **Rate Limiting**: Built-in rate limiting for authentication endpoints

---

## See Also

- [Unified Credentials API](/api/rest/unified.md) - Manage infrastructure credentials
- [Discovery API](/api/rest/discovery.md) - Discovery operations requiring authentication
- [User Management Guide](/user-guides/administrator-guide.md) - Managing users and roles
