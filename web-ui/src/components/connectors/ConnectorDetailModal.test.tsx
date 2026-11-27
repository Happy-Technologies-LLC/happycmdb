// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Connector detail modal (HAP-1922 S8j): open and close, Escape, focus return, and the four tabs' content.

import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectorRegistry } from '@/services/connector.service';
import { ConnectorDetailModal } from './ConnectorDetailModal';

const CONNECTOR = {
  connectorType: 'servicenow',
  category: 'CONNECTOR',
  name: 'ServiceNow',
  description: 'Bi-directional ServiceNow CMDB sync',
  verified: true,
  latestVersion: '2.0.0',
  versions: [
    { version: '2.0.0', releasedAt: '2026-08-01T00:00:00Z', downloadUrl: 'x', checksum: 'x', sizeBytes: 2097152, breakingChanges: true, changelog: 'Rewrote the sync engine' },
    { version: '1.0.0', releasedAt: '2026-01-15T00:00:00Z', downloadUrl: 'x', checksum: 'x', sizeBytes: 1048576, breakingChanges: false, changelog: 'First release' },
  ],
  author: 'Happy Technologies',
  homepage: 'https://example.test/servicenow',
  repository: 'https://example.test/servicenow.git',
  license: 'Apache-2.0',
  downloads: 12345,
  rating: 4.5,
  tags: ['itsm', 'cmdb'],
  metadata: { requirements: 'ServiceNow Tokyo or later', supported_platforms: ['linux', 'windows'] },
} as unknown as ConnectorRegistry;

// Userinfo is rejected, not stripped: the status bar would show a host the link does not go to.
const USERINFO_URLS = [
  'https://user:pw@host/',
  'https://cmdb.example@evil.test/',
  'https://user@host/',
  'https://:pw@host/',
  'https://%75ser@host/',
  'https:\\\\user:pw@host',
  'HTTP://u:p@host',
];
const UNSAFE_HOMEPAGES = ['javascript:alert(1)', ...USERINFO_URLS];
const UNSAFE_REPOSITORIES = ['data:text/html,x', ...USERINFO_URLS];

function Harness({ installedVersion, connector = CONNECTOR }: { installedVersion?: string; connector?: ConnectorRegistry }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open details</button>
      {open && <ConnectorDetailModal connector={connector} installedVersion={installedVersion} onClose={() => setOpen(false)} />}
    </>
  );
}

async function openModal(installedVersion?: string, connector?: ConnectorRegistry) {
  const user = userEvent.setup();
  render(<Harness installedVersion={installedVersion} connector={connector} />);
  await user.click(screen.getByRole('button', { name: 'Open details' }));
  return { user, dialog: await screen.findByRole('dialog', { name: 'ServiceNow' }) };
}

describe('connector detail modal', () => {
  it('opens as a dialog named for the connector, with its summary, overview and footer', async () => {
    const { dialog } = await openModal();
    const view = within(dialog);

    expect(view.getByText('Bi-directional ServiceNow CMDB sync')).toBeVisible();
    expect(view.getByText('v2.0.0')).toBeVisible();
    expect(view.getByText('Apache-2.0', { selector: 'span' })).toBeVisible();
    expect(view.getByText((12345).toLocaleString())).toBeVisible();
    expect(view.getByText('4.5 / 5.0')).toBeVisible();
    expect(view.getByText('Versions', { selector: 'div' })).toBeVisible();
    expect(view.getByText('itsm')).toBeVisible();
    expect(view.getByText('Happy Technologies')).toBeVisible();
    expect(view.getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', 'https://example.test/servicenow');
    expect(view.getByRole('link', { name: 'Repository' })).toHaveAttribute('href', 'https://example.test/servicenow.git');
    expect(view.getByText('ServiceNow Tokyo or later')).toBeVisible();
    expect(view.getByText('linux, windows')).toBeVisible();
    expect(view.getByText('Install and update connector code through deployment packaging.')).toBeVisible();
    expect(view.queryByText(/Installed \(v/)).not.toBeInTheDocument();
  });

  it.each([...UNSAFE_HOMEPAGES])(
    'renders no homepage link for the unsafe homepage %j and keeps the safe repository link',
    async (homepage) => {
      const { dialog } = await openModal(undefined, { ...CONNECTOR, homepage } as ConnectorRegistry);
      const view = within(dialog);

      expect(view.queryByRole('link', { name: 'Homepage' })).not.toBeInTheDocument();
      expect(view.getByRole('link', { name: 'Repository' })).toHaveAttribute('href', 'https://example.test/servicenow.git');
    },
  );

  it('renders the validated absolute URL, not a page-relative one, for a homepage without slashes after the scheme', async () => {
    const { dialog } = await openModal(undefined, { ...CONNECTOR, homepage: 'https:/api/v1/x' } as ConnectorRegistry);

    expect(within(dialog).getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', 'https://api/v1/x');
  });

  it.each([...UNSAFE_REPOSITORIES])(
    'renders no repository link for the unsafe repository %j and keeps the safe homepage link',
    async (repository) => {
      const { dialog } = await openModal(undefined, { ...CONNECTOR, repository } as ConnectorRegistry);
      const view = within(dialog);

      expect(view.queryByRole('link', { name: 'Repository' })).not.toBeInTheDocument();
      expect(view.getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', 'https://example.test/servicenow');
    },
  );

  it('marks the installed version, and an available update when it is not the latest', async () => {
    const { dialog } = await openModal('1.0.0');

    expect(within(dialog).getByText('Installed (v1.0.0)')).toBeVisible();
    expect(within(dialog).getByText('Update Available')).toBeVisible();
  });

  it('shows the version history on the Versions tab and hides the overview', async () => {
    const { user, dialog } = await openModal('1.0.0');
    await user.click(within(dialog).getByRole('tab', { name: 'Versions' }));

    expect(within(dialog).getByRole('tab', { name: 'Versions' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByText('v1.0.0')).toBeVisible();
    expect(within(dialog).getByText('Latest')).toBeVisible();
    expect(within(dialog).getByText('Breaking Changes')).toBeVisible();
    expect(within(dialog).getByText('Rewrote the sync engine')).toBeVisible();
    expect(within(dialog).getByText('First release')).toBeVisible();
    expect(within(dialog).getByText('Installed')).toBeVisible();
    expect(within(dialog).getByText('Size: 2.00 MB')).toBeVisible();
    expect(within(dialog).getByText('Size: 1.00 MB')).toBeVisible();
    expect(within(dialog).getByText('Aug 1, 2026')).toBeVisible();
    expect(within(dialog).queryByText('Happy Technologies')).not.toBeInTheDocument();
  });

  it('shows type, category, licence and the verification note on the Details tab', async () => {
    const { user, dialog } = await openModal();
    await user.click(within(dialog).getByRole('tab', { name: 'Details' }));

    expect(within(dialog).getByText('servicenow')).toBeVisible();
    expect(within(dialog).getByText('CONNECTOR')).toBeVisible();
    expect(within(dialog).getByText('Verified Connector')).toBeVisible();
    expect(within(dialog).getByText(/meets all\s+security and quality standards/)).toBeVisible();
  });

  it('shows downloads, rating, version count and latest release on the Stats tab', async () => {
    const { user, dialog } = await openModal();
    await user.click(within(dialog).getByRole('tab', { name: 'Stats' }));

    expect(within(dialog).getByText('Total Downloads')).toBeVisible();
    expect(within(dialog).getByText((12345).toLocaleString())).toBeVisible();
    expect(within(dialog).getByText('Average Rating')).toBeVisible();
    expect(within(dialog).getByText('4.5')).toBeVisible();
    expect(within(dialog).getByText('out of 5.0')).toBeVisible();
    expect(within(dialog).getByText('Available Versions')).toBeVisible();
    expect(within(dialog).getByText('2')).toBeVisible();
    expect(within(dialog).getByText('Aug 1, 2026')).toBeVisible();
  });

  it('closes from the footer Close button', async () => {
    const { user, dialog } = await openModal();

    await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    const { user } = await openModal();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open details' })).toHaveFocus();
  });
});
