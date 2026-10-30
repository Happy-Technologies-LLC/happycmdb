// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

function redactConfig(config: unknown): void {
  if (!config || typeof config !== 'object') return;
  const target = config as { headers?: unknown; data?: unknown; auth?: unknown };
  // AxiosHeaders keeps each header as an own property, so one loop covers it and plain objects.
  const headers = (target.headers ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(headers)) if (name.toLowerCase() === 'authorization') delete headers[name];
  target.data = undefined;
  if ('auth' in target) target.auth = undefined;
}

/**
 * HAP-1210 S3: strip the Authorization header and the request body from a rejected axios error (config and
 * response.config) so logging, JSON.stringify, inspect or toJSON cannot print them. Keeps url, method,
 * code and the response; error.request (the browser XHR) exposes neither. Returns the same error; never throws.
 */
export function redactAxiosError<T>(error: T): T {
  try {
    const target = error as { config?: unknown; response?: { config?: unknown } } | null | undefined;
    redactConfig(target?.config);
    redactConfig(target?.response?.config);
  } catch {
    // Redaction must never replace the original rejection.
  }
  return error;
}
