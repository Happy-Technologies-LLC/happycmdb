// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { utils } from 'ssh2';

/** At ~1 malformed key in 256, 16 consecutive misses (~1 in 2^128) means the generator is broken, not unlucky. */
export const MAX_KEYGEN_ATTEMPTS = 16;

/**
 * ssh2 1.17.0 keygen strips leading 0x00 bytes from a raw ed25519 public key, so ~1 key in 256 is malformed:
 * parseKey rejects it and a Server cannot load it (main CI flake at 20f3dab). Regenerates until ssh2 can parse
 * the public key it generated (the private key embeds the same public bytes, so it parses too), at most
 * MAX_KEYGEN_ATTEMPTS times; then throws instead of looping forever.
 */
export function wellFormedKeyPair(generate: () => utils.KeyPairReturn): utils.KeyPairReturn {
  for (let attempt = 0; attempt < MAX_KEYGEN_ATTEMPTS; attempt++) {
    const pair = generate();
    if (!(utils.parseKey(pair.public) instanceof Error)) return pair;
  }
  throw new Error(`ssh2 keygen produced no parseable key pair in ${MAX_KEYGEN_ATTEMPTS} attempts`);
}
