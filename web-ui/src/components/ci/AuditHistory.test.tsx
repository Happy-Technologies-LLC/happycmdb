// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1918 (UX-4b S4b): the CI audit history on the design system, against a played server (real service and hook).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Reply = { status: number; body: unknown } | 'pending' | (() => { status: number; body: unknown });
const world: { audit: Reply } = { audit: { status: 200, body: { success: true, data: [] } } };

const { default: axios } = await import('axios');
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const played = String(config.url) === '/cis/ci-1/audit' ? world.audit : { status: 404, body: {} };
  if (played === 'pending') return new Promise(() => undefined);
  const reply = typeof played === 'function' ? played() : played;
  const response = { data: reply.body, status: reply.status, statusText: '', headers: {}, config, request: {} };
  if (reply.status < 400) return response;
  throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_REQUEST', config, {}, response);
};

const { default: AuditHistory } = await import('./AuditHistory');

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const entry = (id: string, over: Record<string, unknown>) => ({
  id,
  entity_type: 'CI',
  entity_id: 'ci-1',
  action: 'UPDATE',
  actor: 'alice',
  actor_type: 'user',
  changes: [],
  timestamp: hoursAgo(1),
  ...over,
});

const created = entry('a1', { action: 'CREATE', actor: 'alice', timestamp: hoursAgo(24 * 10) });
const updated = entry('a2', {
  action: 'UPDATE',
  actor: 'robo-sync',
  actor_type: 'system',
  timestamp: hoursAgo(2),
  changes: [{ field: 'status', old_value: 'active', new_value: 'maintenance' }],
  metadata: { ticket: 'CHG-4411' },
});
const removed = entry('a3', { action: 'RELATIONSHIP_REMOVE', actor: 'bob', timestamp: hoursAgo(24 * 3) });

const serve = (data: unknown[]) => {
  world.audit = { status: 200, body: { success: true, data } };
};

const mount = () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <AuditHistory ciId="ci-1" />
    </QueryClientProvider>
  );
  return user;
};

const articles = () => screen.queryAllByRole('article');
/** The action badge of each listed entry (the filter's option labels are not entries). */
const actions = () =>
  articles().map((a) => within(a).getByText(/^(Created|Updated|Deleted|Relationship (Added|Removed)|Discovery Update)$/).textContent);

beforeEach(() => serve([]));
afterEach(cleanup);

describe('AuditHistory', () => {
  it('says it is loading while the read is pending', async () => {
    world.audit = 'pending';
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading audit history');
  });

  it('shows an empty state, and no filters, for a CI with no history', async () => {
    mount();
    expect(await screen.findByText('No audit history available')).toBeInTheDocument();
    expect(screen.getByText('Changes to this CI will appear here once they occur.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('shows a visible, retryable error when the read fails, and the rows after a retry', async () => {
    let calls = 0;
    world.audit = () =>
      ++calls === 1 ? { status: 500, body: { message: 'boom' } } : { status: 200, body: { success: true, data: [created] } };
    const user = mount();

    expect(await screen.findByText('Could not load audit history')).toBeInTheDocument();
    expect(screen.queryByText('No audit history available')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Showing 1 of 1 entries')).toBeInTheDocument();
  });

  it('shows a 403 as a not-permitted state with the server reason, not an empty history', async () => {
    world.audit = { status: 403, body: { _error: 'Forbidden', _message: "Permission 'read' required" } };
    mount();

    expect(await screen.findByText('No access to audit history')).toBeInTheDocument();
    expect(screen.getByText("Permission 'read' required")).toBeInTheDocument();
    expect(screen.queryByText('No audit history available')).not.toBeInTheDocument();
  });

  it('lists every entry with its action label and actor, and counts them', async () => {
    serve([created, updated, removed]);
    mount();

    expect(await screen.findByText('Showing 3 of 3 entries')).toBeInTheDocument();
    expect(articles()).toHaveLength(3);
    expect(actions()).toEqual(['Created', 'Updated', 'Relationship Removed']);
    expect(screen.getByText('robo-sync')).toBeInTheDocument();
  });

  it('narrows the rows by action, offering only actions that occur, and restores them on All Actions', async () => {
    serve([created, updated, removed]);
    const user = mount();
    const filter = await screen.findByRole('combobox', { name: 'Filter by action' });

    expect(within(filter).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All Actions',
      'Created',
      'Updated',
      'Relationship Removed',
    ]);
    await user.selectOptions(filter, 'UPDATE');

    expect(screen.getByText('Showing 1 of 3 entries')).toBeInTheDocument();
    expect(articles()).toHaveLength(1);
    expect(screen.getByText('robo-sync')).toBeInTheDocument();
    expect(screen.queryByText('bob')).not.toBeInTheDocument();

    await user.selectOptions(filter, 'all');
    expect(screen.getByText('Showing 3 of 3 entries')).toBeInTheDocument();
  });

  it('narrows the rows by date range and says so when nothing is in range', async () => {
    serve([created, updated, removed]);
    const user = mount();
    const range = await screen.findByRole('combobox', { name: 'Filter by date range' });

    await user.selectOptions(range, '24h');
    expect(screen.getByText('Showing 1 of 3 entries')).toBeInTheDocument();
    expect(screen.getByText('robo-sync')).toBeInTheDocument();

    await user.selectOptions(range, '7d');
    expect(screen.getByText('Showing 2 of 3 entries')).toBeInTheDocument();
    expect(actions()).toEqual(['Updated', 'Relationship Removed']);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by action' }), 'CREATE');
    expect(screen.getByText('Showing 0 of 3 entries')).toBeInTheDocument();
    expect(screen.getByText('No audit entries match the selected filters.')).toBeInTheDocument();
  });

  it('shows the change diff and metadata only when an entry is expanded, and hides them on collapse', async () => {
    serve([created, updated]);
    const user = mount();
    await screen.findByText('Showing 2 of 2 entries');

    // Only the entry that has changes can be expanded.
    expect(screen.getAllByRole('button', { name: 'Expand changes' })).toHaveLength(1);
    expect(screen.queryByText('Changes (1)')).not.toBeInTheDocument();
    expect(screen.queryByText('maintenance')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand changes' }));

    const toggle = screen.getByRole('button', { name: 'Collapse changes' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Changes (1)')).toBeInTheDocument();
    expect(screen.getByText('status')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('maintenance')).toBeInTheDocument();
    expect(screen.getByText(/CHG-4411/)).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByText('maintenance')).not.toBeInTheDocument();
    expect(screen.queryByText(/CHG-4411/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand changes' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('truncates a long value until its own toggle expands it', async () => {
    const long = 'x'.repeat(80);
    serve([entry('a9', { action: 'UPDATE', changes: [{ field: 'notes', old_value: 'short', new_value: long }] })]);
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Expand changes' }));

    const value = screen.getByText(long);
    expect(value).toHaveClass('truncate');
    await user.click(screen.getByRole('button', { name: 'Expand' }));
    expect(value).not.toHaveClass('truncate');
  });
});
