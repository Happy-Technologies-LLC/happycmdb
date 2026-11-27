// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Connector manifests are third-party data: only http(s) URLs may become a link or a window.open target.

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The normalised absolute URL when the trimmed value parses as an http: or https: URL without userinfo,
 * otherwise null.
 *
 * The returned string is the validated URL's `href`, not the raw input: a value such as `https:/api/v1/x`
 * parses without a base as host `api`, but a browser resolving the raw string against an https page would
 * navigate same-origin. The `href` is absolute, so resolving it against any base yields the same string.
 *
 * A URL carrying a username or password is rejected, not stripped: `https://cmdb.example@evil.test/` reads
 * like the CMDB host in the status bar but navigates to `evil.test`, and a manifest with credentials in a
 * URL is wrong data that rewriting would hide. The server-side `sanitizeManifestUrl` in
 * `packages/api-server/src/utils/safe-manifest-url.ts` applies the same rules and must stay in step.
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // URL parsing drops tabs and newlines inside the string, so reject them up front.
  if (trimmed === '' || CONTROL_CHARS.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}
