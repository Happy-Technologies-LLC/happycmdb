// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector manifest URLs are third-party data and `homepage`/`repository` become links in the web UI and
 * in the output of any API client. This module is deliberately free of database and filesystem imports so
 * the connector loader, the GraphQL resolvers and the REST controller can all share it.
 */

// This mirrors `safeExternalUrl` in `web-ui/src/lib/safe-external-url.ts`; the two must stay in step.
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The normalised `href` when the trimmed value is a string that parses as an absolute http: or https: URL
 * with no userinfo, otherwise `''`. The URL parser already refuses an empty host for these schemes.
 *
 * Userinfo is rejected, not stripped: `https://cmdb.example@evil.test/` reads like the CMDB host on hover but
 * navigates to `evil.test`, and a manifest with credentials in a URL is wrong data that rewriting would hide.
 */
export function sanitizeManifestUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  // URL parsing drops tabs and newlines inside the string, so reject them up front.
  if (trimmed === '' || CONTROL_CHARS.test(trimmed)) {
    return '';
  }
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return '';
    }
    return url.href;
  } catch {
    return '';
  }
}

/**
 * A shallow copy of a `connector_registry_cache` row whose `homepage` and `repository` have passed
 * `sanitizeManifestUrl`, so a value stored by an older loader (or any other writer) never reaches a client
 * unchecked. `null` stays `null`, `''` stays `''` and an absent key stays absent; every other column is
 * copied as is and the input row is never mutated.
 */
export function sanitizeRegistryRowUrls<T extends object>(row: T): T {
  const copy: Record<string, unknown> = { ...row };
  for (const field of ['homepage', 'repository']) {
    const value = copy[field];
    if (value !== undefined && value !== null && value !== '') {
      copy[field] = sanitizeManifestUrl(value);
    }
  }
  return copy as T;
}
