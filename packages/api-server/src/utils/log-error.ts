// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Loggable fields of a caught value.
 *
 * Error's message/stack are non-enumerable, so passing `{ error }` to the
 * Winston JSON formatter logs `"error":{}`. This copies the diagnostic fields
 * explicitly. It never copies pg's `detail`/`where`/`parameters`, which can
 * echo row values, and callers must not log request bodies or credentials.
 */
export function errorLogFields(error: unknown): { name?: string; message: string; code?: string; stack?: string } {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return { name: error.name, message: error.message, code, stack: error.stack };
}

/**
 * Type-only loggable fields of a caught value: its class name and, when it has one, its string `code` (a SQLSTATE,
 * Neo4j status or errno). Never the message, stack or cause: a store or driver message can quote a connection URL
 * with credentials, a Cypher or SQL fragment, or row values (HAP-1382).
 */
export function errorClassFields(error: unknown): { errorClass: string; code?: string } {
  if (!(error instanceof Error)) return { errorClass: typeof error };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined ? { errorClass: error.constructor.name } : { errorClass: error.constructor.name, code };
}
