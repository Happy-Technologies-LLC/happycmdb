// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// ============================================
// 002: credential rotation decision fence (HP1-S6)
// ============================================
// rotate-user-password records each rotation's outcome as one
// :CredentialRotationDecision {eventId} node. Its safety depends on this
// uniqueness constraint: with it, an `applied` and a `cancelled` decision for
// the same event can never both commit. Without it the tool refuses every
// rotation (decision_constraint_missing).
//
// New databases get the constraint from infrastructure/scripts/init-neo4j.cypher.
// Existing databases must NOT re-run init-neo4j.cypher; apply this file once
// instead (or run `rotate-user-password --prepare`, which issues the same
// statement and then confirms the constraint exists).
//
// Idempotent and schema-only: no nodes are read or written. Operator action
// against a chosen database, for example:
//   cypher-shell -a bolt://<host>:7687 -u <user> -f packages/database/src/neo4j/migrations/002_credential_rotation_decision.cypher
// (cypher-shell prompts for the password when -p is omitted)
//
// Creation fails if duplicate eventId values already exist; on a database
// where rotation has never run there are no :CredentialRotationDecision nodes.

CREATE CONSTRAINT credential_rotation_decision_event IF NOT EXISTS
FOR (d:CredentialRotationDecision) REQUIRE d.eventId IS UNIQUE;
