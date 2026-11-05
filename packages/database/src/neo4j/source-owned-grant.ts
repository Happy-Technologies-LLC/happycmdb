// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1442: the capability that lets a Neo4jClient write create or change a source-owned (AI) CI. Only AISyncWriter
 * imports it; the package index does not export it, so the REST, GraphQL, reconciliation and import paths cannot pass it.
 */
export const SOURCE_OWNED_WRITE: unique symbol = Symbol('SOURCE_OWNED_WRITE');
export type SourceOwnedGrant = typeof SOURCE_OWNED_WRITE;
