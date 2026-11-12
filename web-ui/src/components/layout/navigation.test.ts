// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, matchNav } from './navigation';

describe('matchNav', () => {
  it('lists the seven rail sections in the design-freeze order', () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      'Dashboard',
      'Configuration items',
      'Business services',
      'Discovery',
      'Connectors',
      'Analytics',
      'Settings',
    ]);
  });

  it('keeps / on Overview only, not on every path', () => {
    expect(matchNav('/')?.item.label).toBe('Overview');
    expect(matchNav('/dashboards/cio')?.section.id).toBe('dashboard');
    expect(matchNav('/dashboards/cio')?.item.label).toBe('CIO');
  });

  it('puts a detail route in its parent section', () => {
    expect(matchNav('/cis/ci-42')?.section.id).toBe('cis');
    expect(matchNav('/cis/ci-42')?.item.path).toBe('/cis');
  });

  it('prefers the longest matching item: the catalog is not the connector list', () => {
    expect(matchNav('/connectors')?.item.label).toBe('Connectors');
    expect(matchNav('/connectors/catalog')?.item.label).toBe('Catalog');
  });

  it('does not match a path that only shares a prefix with an item', () => {
    expect(matchNav('/credentials-archive')).toBeNull();
    expect(matchNav('/credential-sets')?.section.id).toBe('discovery');
  });

  it('returns null for an unknown route', () => {
    expect(matchNav('/no/such/screen')).toBeNull();
  });
});
