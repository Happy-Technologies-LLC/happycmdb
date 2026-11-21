// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import CIStatusBadge from './CIStatusBadge';
import CITypeBadge, { typeIcons } from './CITypeBadge';
import type { CIStatus, CIType } from '../../services/ci.service';

const STATUSES: Array<[CIStatus, string]> = [
  ['active', 'Active'],
  ['inactive', 'Inactive'],
  ['maintenance', 'Maintenance'],
  ['decommissioned', 'Decommissioned'],
];

const TYPES: Array<[CIType, string]> = [
  ['server', 'Server'],
  ['virtual-machine', 'Virtual Machine'],
  ['container', 'Container'],
  ['application', 'Application'],
  ['service', 'Service'],
  ['database', 'Database'],
  ['network-device', 'Network Device'],
  ['storage', 'Storage'],
  ['load-balancer', 'Load Balancer'],
  ['cloud-resource', 'Cloud Resource'],
];

describe('CIStatusBadge', () => {
  it.each(STATUSES)('renders %s as the design-system pill labelled %s', (status, label) => {
    render(<CIStatusBadge status={status} />);
    const pill = screen.getByText(label);
    expect(pill).toHaveClass('hh-body');
    // colour comes from design tokens, never a raw palette class
    expect(pill.className).toContain('var(--hh-');
    expect(pill.className).not.toMatch(/\b(?:bg|text|border)-(?:green|red|yellow|amber|gray|slate|sky|blue)-\d/);
  });

  it('gives a healthy lifecycle and a decommissioned one different tones', () => {
    render(
      <>
        <CIStatusBadge status="active" />
        <CIStatusBadge status="decommissioned" />
      </>
    );
    expect(screen.getByText('Active').className).not.toBe(screen.getByText('Decommissioned').className);
  });

  it('falls back to Inactive for a status it does not know', () => {
    render(<CIStatusBadge status={'archived' as CIStatus} />);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });
});

describe('CITypeBadge', () => {
  it.each(TYPES)('renders %s as the design-system pill labelled %s', (type, label) => {
    render(<CITypeBadge type={type} />);
    const pill = screen.getByText(label);
    expect(pill).toHaveClass('hh-body');
    expect(pill.className).toContain('var(--hh-');
  });

  it('falls back to Server for a type it does not know', () => {
    render(<CITypeBadge type={'mainframe' as CIType} />);
    expect(screen.getByText('Server')).toBeInTheDocument();
  });

  it('still exports an icon for every CI type', () => {
    expect(Object.keys(typeIcons).sort()).toEqual(TYPES.map(([type]) => type).sort());
  });
});
