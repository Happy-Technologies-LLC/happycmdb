// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Connector card (HAP-1922 S8j): content, the keyboard-reachable detail trigger, and tone-plus-text install state.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectorRegistry } from '@/services/connector.service';
import { ConnectorCard } from './ConnectorCard';

const CONNECTOR: ConnectorRegistry = {
  connectorType: 'servicenow',
  category: 'CONNECTOR',
  name: 'ServiceNow',
  description: 'Bi-directional ServiceNow CMDB sync',
  verified: true,
  latestVersion: '2.0.0',
  versions: [],
  author: 'Happy Technologies',
  homepage: 'https://example.test/servicenow',
  repository: '',
  license: 'Apache-2.0',
  downloads: 12345,
  rating: 4.56,
  tags: ['itsm', 'cmdb', 'sync', 'tickets', 'extra-one', 'extra-two'],
  metadata: {},
} as ConnectorRegistry;

afterEach(() => vi.restoreAllMocks());

describe('connector card', () => {
  it('shows the connector facts: name, category, version, license, description, tags, popularity, author', () => {
    render(<ConnectorCard connector={CONNECTOR} />);

    expect(screen.getByText('ServiceNow')).toBeVisible();
    expect(screen.getByText('Verified')).toBeVisible();
    expect(screen.getByText('v2.0.0')).toBeVisible();
    expect(screen.getByText('Apache-2.0')).toBeVisible();
    expect(screen.getByText('Bi-directional ServiceNow CMDB sync')).toBeVisible();
    expect(screen.getByText('itsm')).toBeVisible();
    expect(screen.queryByText('extra-one')).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeVisible();
    expect(screen.getByText((12345).toLocaleString())).toBeVisible();
    expect(screen.getByText('4.6')).toBeVisible();
    expect(screen.getByText('by Happy Technologies')).toBeVisible();
  });

  it('says the connector is available for deployment, or installed at its version, as text with its own tone', () => {
    const { rerender } = render(<ConnectorCard connector={CONNECTOR} />);
    const availableTone = screen.getByText('Available for deployment').className;
    expect(screen.queryByText(/^Installed/)).not.toBeInTheDocument();

    rerender(<ConnectorCard connector={CONNECTOR} isInstalled installedVersion="1.4.0" />);
    const installed = screen.getByText('Installed (v1.4.0)');
    expect(screen.queryByText('Available for deployment')).not.toBeInTheDocument();
    expect(installed.className).not.toBe(availableTone);
  });

  it('is plain content without onSelect: no detail trigger', () => {
    render(<ConnectorCard connector={CONNECTOR} />);

    expect(screen.queryByRole('button', { name: 'ServiceNow' })).not.toBeInTheDocument();
  });

  it('opens its detail from a click anywhere on the card and from the keyboard on the name', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ConnectorCard connector={CONNECTOR} onSelect={onSelect} />);

    await user.click(screen.getByText('Bi-directional ServiceNow CMDB sync'));
    expect(onSelect).toHaveBeenCalledTimes(1);

    await user.tab();
    expect(screen.getByRole('button', { name: 'ServiceNow' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('opens the homepage in a new tab without opening the detail', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onSelect = vi.fn();
    render(<ConnectorCard connector={CONNECTOR} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'ServiceNow homepage' }));

    expect(open).toHaveBeenCalledWith('https://example.test/servicenow', '_blank', 'noopener,noreferrer');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the normalised homepage href, not the raw manifest value, without opening the detail', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onSelect = vi.fn();
    render(<ConnectorCard connector={{ ...CONNECTOR, homepage: 'https:/api/v1/x' }} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'ServiceNow homepage' }));

    expect(open).toHaveBeenCalledWith('https://api/v1/x', '_blank', 'noopener,noreferrer');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    ' JaVaScRiPt:alert(1)',
    'https://user:pw@host/',
    'https://cmdb.example@evil.test/',
    'https://user@host/',
    'https://:pw@host/',
    'https://%75ser@host/',
    'https:\\\\user:pw@host',
    'HTTP://u:p@host',
  ])(
    'has no homepage control and never opens a window for the unsafe homepage %j',
    async (homepage) => {
      const user = userEvent.setup();
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const onSelect = vi.fn();
      render(<ConnectorCard connector={{ ...CONNECTOR, homepage }} onSelect={onSelect} />);

      expect(screen.queryByRole('button', { name: /homepage/ })).not.toBeInTheDocument();

      await user.click(screen.getByText('Bi-directional ServiceNow CMDB sync'));

      expect(open).not.toHaveBeenCalled();
      expect(onSelect).toHaveBeenCalledTimes(1);
    },
  );

  it('has no homepage control when the connector has no homepage', () => {
    render(<ConnectorCard connector={{ ...CONNECTOR, homepage: '' }} />);

    expect(screen.queryByRole('button', { name: /homepage/ })).not.toBeInTheDocument();
  });
});
