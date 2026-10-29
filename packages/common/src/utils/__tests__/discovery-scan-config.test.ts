// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import {
  strictDiscoveryDefinitionConfig, safeDiscoveryScanConfig,
  publicDiscoveryDefinitionConfig, hasUnsafeDiscoveryDefinitionConfig,
} from '../discovery-scan-config';

function expectAccepted(config: Record<string, unknown>): void {
  expect(strictDiscoveryDefinitionConfig(config)).toEqual(config);
  expect(safeDiscoveryScanConfig(config)).toEqual(config);
  expect(publicDiscoveryDefinitionConfig(config)).toEqual(config);
  expect(hasUnsafeDiscoveryDefinitionConfig(config)).toBe(false);
}

function expectRejected(config: Record<string, unknown>): void {
  expect(() => strictDiscoveryDefinitionConfig(config)).toThrow(/^Invalid discovery scan configuration$/);
  expect(() => safeDiscoveryScanConfig(config)).toThrow(/^Invalid discovery (targets|range)$/);
  expect(publicDiscoveryDefinitionConfig(config)).toEqual({});
  expect(hasUnsafeDiscoveryDefinitionConfig(config)).toBe(true);
}

const rejectEverywhere = (value: string): void => {
  expectRejected({ targets: [value] });
  expectRejected({ targets: ['10.0.0.5', value] });
  expectRejected({ range: value });
};

it('targets accept hostnames, IP literals and CIDRs up to 256 entries, never 257', () => {
  expectAccepted({ targets: ['example.com', '10.0.0.5', '2001:db8::1', '192.0.2.0/24'] });
  expectAccepted({ targets: Array.from({ length: 256 }, () => 'example.com') });
  expectRejected({ targets: Array.from({ length: 257 }, () => 'example.com') });
});

it('range accepts an IP or an in-family CIDR and bounds the prefix', () => {
  for (const range of ['10.0.0.5', '10.0.0.0/24', '10.0.0.0/32', '2001:db8::/116', '2001:db8::/128']) {
    expectAccepted({ range });
  }
  for (const range of ['10.0.0.0/33', '2001:db8::/129', 'example.com']) expectRejected({ range });
});

it('credential, URL and host:port shapes are refused and never projected', () => {
  for (const value of ['root:pw@10.0.0.5', 'u@h', 'ssh://u:p@h', 'h:22']) rejectEverywhere(value);
});

it('malformed targets are refused and never projected', () => {
  for (const value of ['10.0.0.0/33', 'a b', '\u0000', '', 'a'.repeat(254), 'fe80::1%root:pw', '10.0.0.0/24/8']) {
    rejectEverywhere(value);
  }
});

it('HAP-768 follow-up: newline-joined and space-padded hostnames are refused and never projected', () => {
  for (const value of ['example.com\nroot:pw@10.0.0.5', ' example.com']) rejectEverywhere(value);
});

it('the legacy _targets alias is never read into the queue projection', () => {
  expect(safeDiscoveryScanConfig({ _targets: ['192.0.2.1'] })).toEqual({});
});

it('HAP-1079: a target or range above 4,096 addresses, or a definition above 65,536, is refused and never projected', () => {
  const twenties = Array.from({ length: 16 }, () => '8.8.0.0/20');
  expectAccepted({ range: '8.8.0.0/20' });
  expectAccepted({ targets: twenties });
  expectAccepted({ targets: Array.from({ length: 256 }, () => '8.8.8.0/24') });
  for (const value of ['8.8.0.0/19', '8.0.0.0/8', '32.0.0.0/3', '0.0.0.0/0', '2001:db8::/115', '2001:db8::/64']) {
    rejectEverywhere(value);
  }
  expectRejected({ targets: [...twenties, 'example.com'] });
});
