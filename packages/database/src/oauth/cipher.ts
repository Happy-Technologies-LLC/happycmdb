// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CmdbSecretCipher: the connector-core SecretCipher binding for HappyCMDB.
 *
 * The OAuth substrate (connector-core) seals token bundles through an injected
 * SecretCipher (string in, string out). We back it with CMDB's existing
 * envelope crypto (EncryptionService, AES-256-GCM with a PBKDF2-derived key)
 * so OAuth tokens share the same key material and at-rest guarantees as every
 * other credential. No second crypto convention is introduced.
 *
 * The ciphertext is a base64-encoded JSON envelope of the AES-GCM
 * {iv, encryptedData, authTag} triple. Plaintext and tokens are never logged.
 */
import { getEncryptionService } from '@cmdb/common';
import type { SecretCipher } from '@happy-technologies/connector-core';

/** Structural mirror of EncryptionService's EncryptedData (not exported by @cmdb/common). */
type Envelope = { iv: string; encryptedData: string; authTag: string };

export class CmdbSecretCipher implements SecretCipher {
  encrypt(plaintext: string): string {
    const envelope = getEncryptionService().encrypt(plaintext);
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  }

  decrypt(ciphertext: string): string {
    const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
    const envelope = JSON.parse(decoded) as Envelope;
    return getEncryptionService().decrypt(envelope);
  }
}

let cipher: CmdbSecretCipher | null = null;

/** Lazily-built singleton; defers the encryption-key requirement to first use. */
export function getCmdbSecretCipher(): CmdbSecretCipher {
  if (cipher === null) {
    cipher = new CmdbSecretCipher();
  }
  return cipher;
}
