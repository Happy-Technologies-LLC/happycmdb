// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { projectCIFields, withNormalizedCIFields } from '../ci-normalized-fields';

const NONE = { owner: null, provider: null, ip_address: null, tier: null };

describe('projectCIFields', () => {
  it('is all null for a CI with no usable key', () => {
    expect(projectCIFields({ id: 'ci-1', name: 'x', metadata: '{}' })).toEqual(NONE);
    expect(projectCIFields({})).toEqual(NONE);
  });

  // The documented key order, written out here on purpose: the test must not read it from the module under test.
  const ORDER: Array<[keyof typeof NONE, string[]]> = [
    ['owner', ['owner', 'owned_by', 'managed_by', 'owner_name']],
    ['provider', ['cloud_provider', 'provider', 'vendor']],
    ['ip_address', ['ip_address', 'ip', 'primary_ip', 'private_ip', 'public_ip']],
    ['tier', ['tier', 'service_tier', 'criticality_tier']],
  ];

  it.each(ORDER)('%s: the earliest key in the documented order wins', (field, keys) => {
    for (let i = 0; i < keys.length; i++) {
      const present = Object.fromEntries(keys.slice(i).map(key => [key, `from-${key}`]));
      expect(projectCIFields({ metadata: present })[field]).toBe(`from-${keys[i]}`);
    }
  });

  it('reads the stored metadata JSON string (the list shape) and a parsed object (the detail shape) alike', () => {
    const bag = { owned_by: 'platform-team', cloud_provider: 'aws', private_ip: '10.0.0.4', service_tier: 'gold' };
    const expected = { owner: 'platform-team', provider: 'aws', ip_address: '10.0.0.4', tier: 'gold' };
    expect(projectCIFields({ metadata: JSON.stringify(bag) })).toEqual(expected);
    expect(projectCIFields({ metadata: bag })).toEqual(expected);
  });

  it('prefers attributes over metadata for the same key', () => {
    expect(projectCIFields({ attributes: { owner: 'attrs' }, metadata: { owner: 'meta' } }).owner).toBe('attrs');
    expect(projectCIFields({ metadata: { owner: 'meta' } }).owner).toBe('meta');
  });

  it('does not read top-level node properties', () => {
    expect(projectCIFields({ owner: 'top', ip_address: '10.0.0.1', bsm_business_criticality: 'tier_1' })).toEqual(NONE);
  });

  it('a key earlier in the order beats the same field from an earlier source', () => {
    expect(projectCIFields({ attributes: { owner_name: 'late' }, metadata: { owner: 'early' } }).owner).toBe('early');
  });

  it('returns trimmed strings', () => {
    expect(projectCIFields({ metadata: { owner: '  ops-team \n', ip: '\t10.1.1.1 ' } }))
      .toEqual({ ...NONE, owner: 'ops-team', ip_address: '10.1.1.1' });
  });

  it('yields null for non-string values, and skips them in favour of a later usable key', () => {
    const metadata = { owner: { name: 'ops' }, owned_by: ['ops'], managed_by: 42, ip_address: 10, ip: true, provider: null };
    expect(projectCIFields({ metadata })).toEqual(NONE);
    expect(projectCIFields({ metadata: { ...metadata, owner_name: 'ops-team', primary_ip: '10.0.0.9' } }))
      .toEqual({ ...NONE, owner: 'ops-team', ip_address: '10.0.0.9' });
  });

  it('yields null for an empty or blank string', () => {
    expect(projectCIFields({ metadata: { owner: '', provider: '   ', ip: '\n' } })).toEqual(NONE);
  });

  it('accepts exactly 256 characters and rejects 257, measured after trimming', () => {
    const ok = 'a'.repeat(256);
    expect(projectCIFields({ metadata: { owner: ok } }).owner).toBe(ok);
    expect(projectCIFields({ metadata: { owner: ` ${ok} ` } }).owner).toBe(ok);
    expect(projectCIFields({ metadata: { owner: ok + 'a' } }).owner).toBeNull();
    expect(projectCIFields({ metadata: { owner: 'a'.repeat(5000), owned_by: 'short' } }).owner).toBe('short');
  });

  it('ignores a metadata string that is malformed, not an object, or too large to parse', () => {
    expect(projectCIFields({ metadata: '{not json' })).toEqual(NONE);
    expect(projectCIFields({ metadata: '"owner"' })).toEqual(NONE);
    expect(projectCIFields({ metadata: '["owner"]' })).toEqual(NONE);
    const padding = 'x'.repeat(65_536);
    expect(projectCIFields({ metadata: JSON.stringify({ owner: 'ops', padding }) }).owner).toBeNull();
  });

  it('never reads inherited properties', () => {
    const inherited = Object.create({ owner: 'from-prototype' }) as Record<string, unknown>;
    expect(projectCIFields({ metadata: inherited }).owner).toBeNull();
    expect(projectCIFields({ attributes: inherited }).owner).toBeNull();
  });
});

describe('withNormalizedCIFields', () => {
  it('adds the four keys and leaves every raw key, including metadata, exactly as it was', () => {
    const raw = {
      id: 'ci-1', name: 'web', type: 'server', status: 'active', environment: 'production',
      metadata: JSON.stringify({ owner: 'ops', hostname: 'web01', nested: { owner: 'x' } }),
    };
    const snapshot = structuredClone(raw);
    const out = withNormalizedCIFields(raw);
    expect(raw).toEqual(snapshot);
    expect(out).toEqual({ ...snapshot, owner: 'ops', provider: null, ip_address: null, tier: null });
  });

  it('emits null (not undefined) for an absent field so the JSON key is always present', () => {
    expect(JSON.parse(JSON.stringify(withNormalizedCIFields({ id: 'ci-1' }))))
      .toEqual({ id: 'ci-1', owner: null, provider: null, ip_address: null, tier: null });
  });
});
