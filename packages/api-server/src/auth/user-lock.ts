// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cypher clause that takes a matched `:User` node's write lock before any
 * guard on it is evaluated (Neo4j's documented dummy-property idiom).
 *
 * A guard written in MATCH ... WHERE reads the last committed row and is not
 * re-evaluated after the statement waits for a competing writer's lock, so a
 * guarded SET can land on a row whose guard no longer holds. After this
 * clause the transaction holds the node lock until it ends, and the guards in
 * the following `WITH u WHERE ...` read the latest committed values.
 *
 * Use as: MATCH (u:User) WHERE elementId(u) = $eid ${LOCK_USER} WITH u WHERE <guards> SET ...
 * No dependencies, so operator scripts can share it with the API.
 */
export const LOCK_USER = 'SET u._hp1WriteLock = true REMOVE u._hp1WriteLock';
