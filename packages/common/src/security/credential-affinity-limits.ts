// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Size caps for credential affinity and match-context input. One definition:
 * the REST Joi schemas and the database service entry points both import it,
 * so a caller that bypasses the route (GraphQL, scripts) meets the same bounds.
 */

/** Longest hostname, and longest hostname pattern item (RFC 1035 name length). */
export const MAX_HOSTNAME_LENGTH = 253;
/** Longest network item: an IPv4 CIDR needs 18; 64 leaves room for an IPv6 form. */
export const MAX_NETWORK_LENGTH = 64;
/** Most items in one affinity list (`networks` or `hostname_patterns`). */
export const MAX_AFFINITY_ITEMS = 50;
/** Longest dotted-quad IPv4 address ("255.255.255.255"). */
export const MAX_IPV4_LENGTH = 15;

/** Fixed text only: the message never carries the offending input. */
export class CredentialInputBoundsError extends Error {
  constructor(field: string) {
    super(`Credential input exceeds its size limit: ${field}`);
    this.name = 'CredentialInputBoundsError';
  }
}

function assertList(list: unknown, field: string, maxItemLength: number): void {
  if (!Array.isArray(list)) {
    return;
  }
  if (list.length > MAX_AFFINITY_ITEMS) {
    throw new CredentialInputBoundsError(field);
  }
  for (const item of list) {
    if (typeof item === 'string' && item.length > maxItemLength) {
      throw new CredentialInputBoundsError(field);
    }
  }
}

/** Refuse an oversize `networks` or `hostname_patterns` list before it is stored or scored. */
export function assertAffinityBounds(
  affinity: { networks?: unknown; hostname_patterns?: unknown } | null | undefined
): void {
  if (affinity === null || affinity === undefined) {
    return;
  }
  assertList(affinity.networks, 'networks', MAX_NETWORK_LENGTH);
  assertList(affinity.hostname_patterns, 'hostname_patterns', MAX_HOSTNAME_LENGTH);
}

/** Refuse an oversize match-context `ip` or `hostname` before any network or pattern is scored. */
export function assertMatchContextBounds(
  context: { ip?: unknown; hostname?: unknown } | null | undefined
): void {
  if (context === null || context === undefined) {
    return;
  }
  if (typeof context.ip === 'string' && context.ip.length > MAX_IPV4_LENGTH) {
    throw new CredentialInputBoundsError('ip');
  }
  if (typeof context.hostname === 'string' && context.hostname.length > MAX_HOSTNAME_LENGTH) {
    throw new CredentialInputBoundsError('hostname');
  }
}
