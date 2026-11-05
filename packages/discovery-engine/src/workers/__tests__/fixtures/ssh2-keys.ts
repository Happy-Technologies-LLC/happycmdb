// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { utils } from 'ssh2';

/**
 * ssh2 1.17.0 keygen strips leading 0x00 bytes from a raw ed25519 public key, so ~1 key in 256 is malformed:
 * parseKey rejects it and a Server cannot load it (main CI flake at 20f3dab). Regenerates until ssh2 can parse
 * the public key it generated; the private key embeds the same public bytes, so it parses too.
 */
export function wellFormedKeyPair(generate: () => utils.KeyPairReturn): utils.KeyPairReturn {
  for (;;) {
    const pair = generate();
    if (!(utils.parseKey(pair.public) instanceof Error)) return pair;
  }
}
