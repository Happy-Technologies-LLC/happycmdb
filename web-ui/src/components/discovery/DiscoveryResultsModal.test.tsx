// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, within } from '@testing-library/react';
import { DiscoveryResultsModal } from './DiscoveryResultsModal';
import type { DiscoveredCIResult } from '../../services/discovery.service';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const ci = (n: number, over: Partial<DiscoveredCIResult> = {}): DiscoveredCIResult => ({
  id: `ci-${n}`,
  name: `host-${String(n).padStart(2, '0')}`,
  type: n % 2 ? 'server' : 'database',
  source: 'ssh',
  status: 'active',
  attributes: {},
  confidenceScore: 0.85,
  ...over,
});

const renderModal = (results: DiscoveredCIResult[], onClose = vi.fn()) => {
  render(<DiscoveryResultsModal open onClose={onClose} results={results} jobId="job-9" />);
  return onClose;
};

beforeEach(() => navigate.mockReset());

describe('DiscoveryResultsModal', () => {
  it('is a named dialog with the same six columns and one row per CI', () => {
    renderModal([ci(1), ci(2)]);
    const dialog = screen.getByRole('dialog', { name: 'Discovery Results - Job job-9' });
    const table = within(dialog).getByRole('table', { name: 'Discovered CIs' });

    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Name', 'Type', 'Source', 'Status', 'Confidence', 'Actions',
    ]);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getAllByText('85%')).toHaveLength(2);
    expect(within(dialog).getByText('2 of 2 CIs')).toBeVisible();
  });

  it('renders nothing while closed', () => {
    render(<DiscoveryResultsModal open={false} onClose={vi.fn()} results={[ci(1)]} jobId="job-9" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says so when the job found nothing, and when a filter matches nothing; never a blank table', () => {
    renderModal([ci(1)]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search by name or type' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No CIs match the current filters')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('an empty result set is stated as such', () => {
    renderModal([]);
    expect(screen.getByText('This job discovered no CIs')).toBeVisible();
  });

  it('shows a score the server did not send as a dash, not 0%', () => {
    renderModal([ci(1, { confidenceScore: undefined as unknown as number })]);
    const table = screen.getByRole('table', { name: 'Discovered CIs' });
    expect(within(table).queryByText('0%')).not.toBeInTheDocument();
    expect(within(table).getByText('\u2013')).toBeVisible();
  });

  it('searches by name, filters by type and pages at 25 rows', () => {
    const many = Array.from({ length: 30 }, (_, i) => ci(i + 1));
    renderModal(many);
    const table = () => screen.getByRole('table', { name: 'Discovered CIs' });

    expect(within(table()).getAllByRole('row')).toHaveLength(26);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(within(table()).getAllByRole('row')).toHaveLength(6);
    expect(within(table()).getByText('host-30')).toBeVisible();

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by type' }), { target: { value: 'database' } });
    expect(screen.getByText('15 of 30 CIs')).toBeVisible();
    expect(within(table()).getAllByRole('row')).toHaveLength(16);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search by name or type' }), { target: { value: 'host-04' } });
    expect(within(table()).getByText('host-04')).toBeVisible();
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
  });

  it('View opens that CI in the inventory and closes the dialog', () => {
    const onClose = renderModal([ci(1)]);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(navigate).toHaveBeenCalledWith('/inventory/ci-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not print attribute values that may hold a credential, with the dialog portal open', () => {
    const marker = secretMarker('ci-attr');
    renderModal([ci(1, { attributes: { password: marker, apiToken: marker } })]);

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(domLeaks(marker)).toEqual([]);
  });
});
