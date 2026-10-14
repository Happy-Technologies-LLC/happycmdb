// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// ============================================
// 003: :User._id lookup index (HP1-S6, v16 §15 N-21 SEC12-02)
// ============================================
// Every authenticated request (JWT, API key, refresh, WebSocket re-check)
// loads the user with `MATCH (u:User) WHERE u._id = $id OR u.id = $id`.
// `User.id` is index-backed by its unique constraint (init-neo4j.cypher),
// but `User._id` (the spelling seed-data.ts and the API write) was not
// indexed. Neo4j therefore scanned every :User node on each request, and
// auth p99 grew with the number of users. Measured in hosted CI: median p99
// ratio 1.60 for 5 000 vs 10 users, with 15 008 db hits per lookup.
// With this index both spellings are index lookups (CI PROFILE gate in
// tests/integration/database/user-identity-resolution.integration.test.ts).
// No separate User.id index: user_id_unique already backs `id`.
//
// Authorized by approvals/cmdb-pr50-sec12-02-user-id-index-scope-a-AMENDMENT.go.
// New databases get the index from infrastructure/scripts/init-neo4j.cypher.
// Existing databases must NOT re-run init-neo4j.cypher: it also writes the
// seeded admin and sample data. Apply this file once instead. It is a MANUAL
// operator step, like 001 and 002. `rotate-user-password --prepare` does NOT
// create it, and no environment is authorized to apply it by this change.
// Without it every lookup returns the same result (the code accepts exactly
// one node either way), only more slowly.
//
// Idempotent and schema-only: no node is read or written. Operator action
// against a chosen database, for example:
//   cypher-shell -a bolt://<host>:7687 -u <user> -f packages/database/src/neo4j/migrations/003_user_id_lookup_index.cypher
// (cypher-shell prompts for the password when -p is omitted)
//
// Index population runs in the background: confirm with
//   SHOW INDEXES YIELD name, state WHERE name = 'user_id_lookup'
// (state ONLINE) before relying on it.

CREATE INDEX user_id_lookup IF NOT EXISTS
FOR (u:User) ON (u._id);
