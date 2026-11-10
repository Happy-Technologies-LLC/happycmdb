// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Type-only loggable fields of a caught value: its class name and, when it has one, its string `code` (a SQLSTATE,
 * Neo4j status or errno). Never the message, stack or cause: a store or driver message can quote a connection URL
 * with credentials, a Cypher or SQL fragment, or row values (HAP-1382), and a decrypt failure's message can quote
 * decrypted plaintext (a JSON.parse snippet). Logging the raw `{ error }` instead hands the logger the whole object
 * and serializes as `"error":{}` (HAP-1733).
 */
export function errorClassFields(error: unknown): { errorClass: string; code?: string } {
  if (!(error instanceof Error)) return { errorClass: typeof error };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined ? { errorClass: error.constructor.name } : { errorClass: error.constructor.name, code };
}
