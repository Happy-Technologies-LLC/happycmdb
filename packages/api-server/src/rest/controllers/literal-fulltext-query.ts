// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Escape operators without changing the caller's terms or their whitespace. */
export function literalFulltextQuery(raw: string): string {
  return raw.trim().replace(/(\&\&|\|\||[+\-!(){}\[\]^"~*?:\\/])/g, '\\$1');
}
