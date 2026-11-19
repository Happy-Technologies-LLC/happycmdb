// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Connector manifests are third-party data: only http(s) URLs may become a link or a window.open target.

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The trimmed value when it parses as an absolute http: or https: URL, otherwise null. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // URL parsing drops tabs and newlines inside the string, so reject them up front.
  if (trimmed === '' || CONTROL_CHARS.test(trimmed)) return null;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'http:' || protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}
