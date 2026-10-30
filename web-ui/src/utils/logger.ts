// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Frontend Logger Utility
 */

export const logger = {
  info: (message: string, meta?: any) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[INFO] ${message}`, meta || '');
    }
  },

  debug: (message: string, meta?: any) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[DEBUG] ${message}`, meta || '');
    }
  },

  warn: (message: string, meta?: any) => {
    console.warn(`[WARN] ${message}`, meta || '');
  },

  error: (message: string, meta?: any) => {
    console.error(`[ERROR] ${message}`, meta || '');
  },
};

// A Set, not an object map: membership must not be inherited from Object.prototype.
const LOGGED_CODES = new Set(['ERR_NETWORK', 'ECONNABORTED', 'ERR_CANCELED']);

/**
 * Logs a failed client call without the error itself (HAP-1210): an AxiosError carries the bearer token and the
 * request body in `config`. Emits only the fixed label, the error class and the HTTP status, or, when there is no
 * status, an allow-listed axios code. Nothing else is read from the error, and each field is read once so a getter
 * cannot pass the checks and then return a different value.
 */
export function logClientError(label: string, error: unknown): void {
  const name = error instanceof Error ? error.name : undefined;
  const fields: { errorClass: string; status?: number; code?: string } = {
    errorClass: typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'NonError',
  };
  const shape = typeof error === 'object' && error !== null ? (error as { response?: { status?: unknown }; code?: unknown }) : {};
  const status = shape.response?.status;
  const code = shape.code;
  if (typeof status === 'number' && Number.isInteger(status)) {
    fields.status = status;
  } else if (typeof code === 'string' && LOGGED_CODES.has(code)) {
    fields.code = code;
  }
  console.error(`[ERROR] ${label}`, fields);
}
