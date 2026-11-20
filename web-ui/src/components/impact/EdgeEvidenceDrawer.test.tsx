// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { request, apiClient } = vi.hoisted(() => {
  const request = { get: vi.fn() };
  const apiClient = { ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } };
  return { request, apiClient };
});

vi.mock('axios', () => ({ default: { create: vi.fn(() => apiClient) } }));

import EdgeEvidenceDrawer from './EdgeEvidenceDrawer';
import { edgeFixture, evidencePage, receiptFixture } from '../../tests/fixtures/impactEvidence';

const names = { 'ci-a': 'billing-api', 'ci-b': 'orders-db' };

function renderDrawer(edge = edgeFixture('ci-a', 'ci-b', 'current'), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui = (e: typeof edge | null) => (
    <QueryClientProvider client={client}>
      <EdgeEvidenceDrawer edge={e} onClose={onClose} ciNames={names} />
    </QueryClientProvider>
  );
  const view = render(ui(edge));
  return { ...view, onClose, rerenderEdge: (e: typeof edge | null) => view.rerender(ui(e)) };
}

describe('EdgeEvidenceDrawer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the edge by CI name, shows the server summary, and requests the exact edge at limit 20 offset 0', async () => {
    request.get.mockResolvedValue(
      evidencePage(
        [
          receiptFixture(1, { evidence_class: 'static_observed', polarity: 'contradicts', source_name: 'scanner', source_version: '3.1', observer: 'svc-scan' }),
        ],
        { total: 1, offset: 0 }
      )
    );
    renderDrawer(
      edgeFixture('ci-a', 'ci-b', 'stale', {
        classes: ['declared', 'static_observed'],
        support: { supports: 4, contradicts: 2 },
        last_supported_at: '2026-04-02T08:00:00Z',
        receipts_truncated: true,
      })
    );

    const dialog = await screen.findByRole('dialog');
    expect(request.get).toHaveBeenCalledWith('/relationships/evidence', {
      params: { from_id: 'ci-a', to_id: 'ci-b', type: 'DEPENDS_ON', limit: 20, offset: 0 },
      sideRead: true,
    });
    expect(within(dialog).getByRole('heading', { name: 'billing-api \u2192 orders-db' })).toBeInTheDocument();
    expect(within(dialog).getByText('Stale')).toBeInTheDocument();
    expect(within(dialog).getByText('Declared, Static observed')).toBeInTheDocument();
    expect(within(dialog).getByText(/newest 200 receipts only/)).toBeInTheDocument();

    const row = (await within(dialog).findByText('scanner 3.1')).closest('tr')!;
    expect(within(row).getByText('Static observed')).toBeInTheDocument();
    expect(within(row).getByText('Contradicts')).toBeInTheDocument();
    expect(within(row).getByText('svc-scan')).toBeInTheDocument();
    expect(row.querySelector('time')).toHaveAttribute('datetime', '2026-05-01T10:00:00Z');
  });

  it('falls back to the CI id when no name is known', async () => {
    request.get.mockResolvedValue(evidencePage([], { total: 0, offset: 0 }));
    renderDrawer(edgeFixture('ci-unknown', 'ci-b', 'unsupported'));

    expect(await screen.findByRole('heading', { name: 'ci-unknown \u2192 orders-db' })).toBeInTheDocument();
  });

  it('shows an inherited-member name as plain text in the Class column and never a function source', async () => {
    request.get.mockResolvedValue(
      evidencePage([receiptFixture(1, { evidence_class: 'toString' as unknown as 'declared' })], { total: 1, offset: 0 })
    );
    renderDrawer();

    const dialog = await screen.findByRole('dialog');
    const row = (await within(dialog).findByText('source-1 1.2.0')).closest('tr')!;
    expect(within(row).getByText('toString')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/function|\[native code\]/);
  });

  it('lists an inherited-member name in the summary classes as the raw string', async () => {
    request.get.mockResolvedValue(evidencePage([], { total: 0, offset: 0 }));
    renderDrawer(
      edgeFixture('ci-a', 'ci-b', 'current', { classes: ['declared', 'constructor' as unknown as 'declared'] })
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Declared, constructor')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/function|\[native code\]/);
  });

  it('still shows an unknown plain class string as itself', async () => {
    request.get.mockResolvedValue(
      evidencePage([receiptFixture(1, { evidence_class: 'future_class' as unknown as 'declared' })], { total: 1, offset: 0 })
    );
    renderDrawer();

    const dialog = await screen.findByRole('dialog');
    const row = (await within(dialog).findByText('source-1 1.2.0')).closest('tr')!;
    expect(within(row).getByText('future_class')).toBeInTheDocument();
  });

  it('says so when an edge has no receipts', async () => {
    request.get.mockResolvedValue(evidencePage([], { total: 0, offset: 0 }));
    renderDrawer(edgeFixture('ci-a', 'ci-b', 'unsupported', { classes: [], receipt_count: 0, last_supported_at: null }));

    expect(await screen.findByText('No receipts for this relationship')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it.each([
    [403, 'You do not have permission to view the evidence for this relationship.'],
    [404, 'This relationship or one of its CIs was not found.'],
    [500, 'The receipts could not be loaded. Try again.'],
  ])('shows fixed copy for a %i and never the server text', async (status, message) => {
    request.get.mockRejectedValue({ response: { status, data: { message: 'RAW internal detail: relation "x" missing' } } });
    renderDrawer();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/RAW internal detail/)).not.toBeInTheDocument();
  });

  it('loads the next page at offset 20, appends it, and stops offering more at the end', async () => {
    const first = Array.from({ length: 20 }, (_, i) => receiptFixture(i + 1));
    request.get
      .mockResolvedValueOnce(evidencePage(first, { total: 22, offset: 0 }))
      .mockResolvedValueOnce(evidencePage([receiptFixture(21), receiptFixture(22)], { total: 22, offset: 20 }));
    const user = userEvent.setup();
    renderDrawer();

    await screen.findByText('source-1 1.2.0');
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('source-22 1.2.0');
    expect(request.get).toHaveBeenLastCalledWith('/relationships/evidence', {
      params: { from_id: 'ci-a', to_id: 'ci-b', type: 'DEPENDS_ON', limit: 20, offset: 20 },
      sideRead: true,
    });
    expect(screen.getByText('source-1 1.2.0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows a receipt once when page 2 repeats the last receipt of page 1 after a new write shifted the offset', async () => {
    const first = Array.from({ length: 20 }, (_, i) => receiptFixture(i + 1));
    request.get
      .mockResolvedValueOnce(evidencePage(first, { total: 22, offset: 0 }))
      .mockResolvedValueOnce(evidencePage([receiptFixture(20), receiptFixture(21)], { total: 22, offset: 20 }));
    const user = userEvent.setup();
    renderDrawer();

    await screen.findByText('source-1 1.2.0');
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('source-21 1.2.0');
    expect(screen.getAllByText('source-20 1.2.0')).toHaveLength(1);
    expect(screen.getAllByRole('row')).toHaveLength(1 + 21);
  });

  it('keeps the loaded rows and shows the error when a later page fails', async () => {
    const first = Array.from({ length: 20 }, (_, i) => receiptFixture(i + 1));
    request.get
      .mockResolvedValueOnce(evidencePage(first, { total: 40, offset: 0 }))
      .mockRejectedValueOnce({ response: { status: 500 } });
    const user = userEvent.setup();
    renderDrawer();

    await screen.findByText('source-1 1.2.0');
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('The receipts could not be loaded. Try again.')).toBeInTheDocument();
    expect(screen.getByText('source-1 1.2.0')).toBeInTheDocument();
  });

  it.each([
    ['from', 'ci-x', 'ci-b', 'DEPENDS_ON'],
    ['to', 'ci-a', 'ci-x', 'DEPENDS_ON'],
    ['type', 'ci-a', 'ci-b', 'HOSTS'],
  ])('switching the open drawer to an edge that differs only in %s never shows the first edge\'s rows', async (_what, from, to, type) => {
    let releaseSecond: (value: unknown) => void = () => {};
    request.get
      .mockResolvedValueOnce(evidencePage([receiptFixture(1, { source_name: 'first-edge-source' })], { total: 1, offset: 0 }))
      .mockReturnValueOnce(new Promise((resolve) => (releaseSecond = resolve)));
    const { rerenderEdge } = renderDrawer(edgeFixture('ci-a', 'ci-b', 'current'));
    await screen.findByText('first-edge-source 1.2.0');

    rerenderEdge(edgeFixture(from, to, 'current', {}, type));

    expect(await screen.findByText('Loading receipts...')).toBeInTheDocument();
    expect(screen.queryByText('first-edge-source 1.2.0')).not.toBeInTheDocument();
    expect(request.get).toHaveBeenLastCalledWith('/relationships/evidence', {
      params: { from_id: from, to_id: to, type, limit: 20, offset: 0 },
      sideRead: true,
    });
    releaseSecond(evidencePage([receiptFixture(2, { source_name: 'second-edge-source' })], { total: 1, offset: 0 }));
    expect(await screen.findByText('second-edge-source 1.2.0')).toBeInTheDocument();
  });

  it('fetches nothing while no edge is open', () => {
    renderDrawer(null as never);

    expect(request.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    request.get.mockResolvedValue(evidencePage([], { total: 0, offset: 0 }));
    const user = userEvent.setup();
    const { onClose } = renderDrawer();

    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
