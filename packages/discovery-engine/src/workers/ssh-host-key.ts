// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-444 K2: pure SSH host-key pin verification (proposal §2.1, §2.4). No storage, no I/O.
import { createHash, timingSafeEqual } from 'crypto';
import type { ServerHostKeyAlgorithm } from 'ssh2';

export const ERR_HOSTKEY_UNPINNED = 'ERR_HOSTKEY_UNPINNED';
export const ERR_HOSTKEY_MISMATCH = 'ERR_HOSTKEY_MISMATCH';

/** Pinnable host-key types, as named inside the SSH public-key blob. */
export const HostKeyType = {
  Ed25519: 'ssh-ed25519', EcdsaP256: 'ecdsa-sha2-nistp256', EcdsaP384: 'ecdsa-sha2-nistp384',
  EcdsaP521: 'ecdsa-sha2-nistp521', Rsa: 'ssh-rsa',
} as const;
export type HostKeyType = (typeof HostKeyType)[keyof typeof HostKeyType];

/** The ruled allow-list (HAP-444 D5): an RSA pin never offers SHA-1 `ssh-rsa`; ssh-dss is not pinnable. */
const ALGORITHMS: Readonly<Record<HostKeyType, readonly ServerHostKeyAlgorithm[]>> = {
  [HostKeyType.Ed25519]: ['ssh-ed25519'],
  [HostKeyType.EcdsaP256]: ['ecdsa-sha2-nistp256'],
  [HostKeyType.EcdsaP384]: ['ecdsa-sha2-nistp384'],
  [HostKeyType.EcdsaP521]: ['ecdsa-sha2-nistp521'],
  [HostKeyType.Rsa]: ['rsa-sha2-512', 'rsa-sha2-256'],
};

/** `fingerprint` as `ssh-keygen -lf` prints it: `SHA256:` plus unpadded base64 of the blob's SHA-256. */
export interface HostKeyPin { keyType: HostKeyType; fingerprint: string }
/** Set only by the verifier: callers map errors from this flag, never from a library message. */
export interface HostKeyOutcome { code?: typeof ERR_HOSTKEY_MISMATCH }

export function hostKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

export function isHostKeyPin(pin: unknown): pin is HostKeyPin {
  const { keyType, fingerprint } = (typeof pin === 'object' && pin !== null ? pin : {}) as Record<string, unknown>;
  return typeof keyType === 'string' && Object.prototype.hasOwnProperty.call(ALGORITHMS, keyType)
    && typeof fingerprint === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint);
}

/** The only server host-key algorithms to offer, so a host holding several keys presents the pinned one. */
export function hostKeyAlgorithms(pin: HostKeyPin): ServerHostKeyAlgorithm[] {
  if (!isHostKeyPin(pin)) throw new Error(ERR_HOSTKEY_UNPINNED);
  return [...ALGORITHMS[pin.keyType]];
}

/**
 * ssh2 `hostVerifier` without `hostHash`, so it receives the raw blob. It runs in key exchange,
 * before user authentication: returning false means no credential is ever sent.
 */
export function pinnedVerifier(pin: HostKeyPin, outcome: HostKeyOutcome): (blob: Buffer) => boolean {
  if (!isHostKeyPin(pin)) throw new Error(ERR_HOSTKEY_UNPINNED);
  const expected = Buffer.from(pin.fingerprint, 'latin1');
  return (blob: Buffer) => {
    // The blob embeds its key type, so a fingerprint match also pins the type. Both sides are 50 ASCII bytes.
    const observed = Buffer.from(hostKeyFingerprint(blob), 'latin1');
    const matched = observed.length === expected.length && timingSafeEqual(observed, expected);
    if (!matched) outcome.code = ERR_HOSTKEY_MISMATCH;
    return matched;
  };
}
