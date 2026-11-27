// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
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

import CIDrawer from './CIDrawer';

const ci = (over: Record<string, unknown> = {}) => ({
  id: 'ci-1',
  name: 'billing-api',
  type: 'application',
  status: 'active',
  environment: 'production',
  health: 'degraded',
  tier: 'tier-1',
  description: 'Handles invoicing',
  provider: 'aws',
  owner: 'platform-team',
  ip_address: '10.0.0.4',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...over,
});

const audit = (id: string, timestamp: string, action = 'UPDATE', fields: string[] = ['status']) => ({
  id,
  entity_type: 'CI',
  entity_id: 'ci-1',
  action,
  actor: 'alice',
  actor_type: 'user',
  changes: fields.map((field) => ({ field, old_value: 'a', new_value: 'b' })),
  timestamp,
});

const rel = (id: string, otherName: string, outgoing = true) => ({
  id,
  type: 'DEPENDS_ON',
  source_ci_id: outgoing ? 'ci-1' : 'ci-9',
  target_ci_id: outgoing ? 'ci-9' : 'ci-1',
  ...(outgoing ? { target_ci: { id: 'ci-9', name: otherName } } : { source_ci: { id: 'ci-9', name: otherName } }),
});

type Answers = Partial<Record<'ci' | 'audit' | 'relationships' | 'impact', () => unknown>>;
const ok = (data: unknown) => () => Promise.resolve({ data: { success: true, data } });
const fail = (error: unknown) => () => Promise.reject(error);
const forbidden = () =>
  Object.assign(new Error('Request failed with status code 403'), {
    response: { status: 403, data: { _error: 'Forbidden', _message: "Permission 'read' required" } },
  });

function serve(answers: Answers = {}) {
  const defaults: Required<Answers> = {
    ci: ok(ci()),
    audit: ok([]),
    relationships: ok([]),
    impact: ok({ upstream: [], downstream: [] }),
  };
  const all = { ...defaults, ...answers };
  request.get.mockImplementation((url: string) => {
    if (url === '/cis/ci-1') return all.ci();
    if (url === '/cis/ci-1/audit') return all.audit();
    if (url === '/cis/ci-1/relationships') return all.relationships();
    if (url === '/cis/ci-1/impact') return all.impact();
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

const urls = () => request.get.mock.calls.map(([url]) => url as string);

function renderDrawer(props: Partial<React.ComponentProps<typeof CIDrawer>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onClose = vi.fn();
  const onOpenFull = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <CIDrawer ciId="ci-1" open onClose={onClose} onOpenFull={onOpenFull} {...props} />
    </QueryClientProvider>
  );
  return { ...view, onClose, onOpenFull };
}

const openDrawer = async () => within(await screen.findByRole('dialog'));

describe('CIDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve();
  });

  it('requests nothing while closed, and the four reads for that id once open', async () => {
    const view = renderDrawer({ open: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(request.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <CIDrawer ciId="ci-1" open onClose={view.onClose} onOpenFull={view.onOpenFull} />
      </QueryClientProvider>
    );
    await screen.findByRole('dialog');
    await waitFor(() => expect(urls().sort()).toEqual(
      ['/cis/ci-1', '/cis/ci-1/audit', '/cis/ci-1/impact', '/cis/ci-1/relationships'].sort()
    ));
  });

  it('shows the name, health, tier and description, the dependents banner and the field list', async () => {
    serve({ impact: ok({ upstream: [], downstream: [ci({ id: 'a' }), ci({ id: 'b' }), ci({ id: 'c' })] }) });
    renderDrawer();
    const drawer = await openDrawer();

    expect(await drawer.findByRole('heading', { name: 'billing-api' })).toBeInTheDocument();
    expect(drawer.getByText('Degraded')).toBeInTheDocument();
    expect(drawer.getByText('tier-1')).toBeInTheDocument();
    expect(drawer.getByText('Handles invoicing')).toBeInTheDocument();
    expect(await drawer.findByText('3 dependents')).toBeInTheDocument();
    expect(drawer.getByText('ci-1')).toBeInTheDocument();
    expect(drawer.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(drawer.getByText('Application')).toBeInTheDocument();
    expect(drawer.getByText('Production')).toBeInTheDocument();
    expect(drawer.getByText('aws')).toBeInTheDocument();
    expect(drawer.getByText('platform-team')).toBeInTheDocument();
    expect(drawer.getByText('10.0.0.4')).toBeInTheDocument();
  });

  it('a CI with no health reads Unknown, never Healthy, and one without a tier shows no tier badge', async () => {
    serve({ ci: ok(ci({ health: null, tier: undefined })) });
    renderDrawer();
    const drawer = await openDrawer();

    expect(await drawer.findByText('Unknown')).toBeInTheDocument();
    expect(drawer.queryByText('Healthy')).toBeNull();
    expect(drawer.queryByText(/^tier:/i)).toBeNull();
  });

  it('lists every address of an array ip_address and shows an em-dash for a missing owner and provider', async () => {
    serve({ ci: ok(ci({ ip_address: ['10.0.0.4', '10.0.0.5'], owner: null, provider: null })) });
    renderDrawer();
    const drawer = await openDrawer();

    const first = await drawer.findByText('10.0.0.4');
    expect(first.closest('ul')).toContainElement(drawer.getByText('10.0.0.5'));
    expect(drawer.getAllByText('\u2014')).toHaveLength(2);
  });

  it('shows an empty state for a CI with no changes and no relationships, with a real zero dependents', async () => {
    renderDrawer();
    const drawer = await openDrawer();

    expect(await drawer.findByText('No recorded changes.')).toBeInTheDocument();
    expect(await drawer.findByText('No relationships.')).toBeInTheDocument();
    expect(await drawer.findByText('0 dependents')).toBeInTheDocument();
  });

  it('lists the five most recent changes, newest first, and counts the relationships', async () => {
    serve({
      audit: ok([
        audit('old', '2026-01-01T00:00:00Z', 'CREATE', []),
        audit('new', '2026-03-01T00:00:00Z', 'UPDATE', ['owner', 'tier']),
        audit('a', '2026-02-01T00:00:00Z'),
        audit('b', '2026-02-02T00:00:00Z'),
        audit('c', '2026-02-03T00:00:00Z'),
        audit('d', '2026-02-04T00:00:00Z'),
      ]),
      relationships: ok([rel('r1', 'orders-db'), rel('r2', 'edge-lb', false)]),
    });
    renderDrawer();
    const drawer = await openDrawer();

    expect(await drawer.findByText('owner, tier')).toBeInTheDocument();
    expect(drawer.queryByText('Created')).toBeNull(); // the sixth, oldest entry is cut
    const changes = drawer.getByRole('heading', { name: 'Recent changes' }).closest('section')!;
    expect(within(changes).getAllByRole('listitem')).toHaveLength(5);
    expect(within(changes).getAllByRole('listitem')[0]).toHaveTextContent('owner, tier');

    const relationships = drawer.getByRole('heading', { name: /relationships/i }).closest('section')!;
    expect(await within(relationships).findByText('orders-db')).toBeInTheDocument();
    expect(within(relationships).getByText('edge-lb')).toBeInTheDocument();
    expect(within(relationships).getByText('2')).toBeInTheDocument();
  });

  it('a failing audit read breaks only that section and offers a retry that re-requests it', async () => {
    let attempts = 0;
    serve({
      audit: () => (++attempts === 1 ? Promise.reject(new Error('audit down')) : ok([audit('x', '2026-02-01T00:00:00Z')])()),
      relationships: ok([rel('r1', 'orders-db')]),
      impact: ok({ upstream: [], downstream: [ci({ id: 'a' })] }),
    });
    renderDrawer();
    const drawer = await openDrawer();

    expect(await drawer.findByText('Could not load recent changes')).toBeInTheDocument();
    expect(drawer.getByText('audit down')).toBeInTheDocument();
    expect(await drawer.findByText('orders-db')).toBeInTheDocument();
    expect(await drawer.findByText('1 dependent')).toBeInTheDocument();
    expect(drawer.queryByText('No recorded changes.')).toBeNull();

    await userEvent.click(drawer.getByRole('button', { name: 'Try again' }));
    expect(await drawer.findByText('alice', { exact: false })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('a failing impact or relationships read shows no figure, not a zero', async () => {
    serve({ impact: fail(new Error('impact down')), relationships: fail(new Error('rels down')) });
    renderDrawer();
    const drawer = await openDrawer();

    expect(await drawer.findByText('Could not load dependents')).toBeInTheDocument();
    expect(await drawer.findByText('Could not load relationships')).toBeInTheDocument();
    expect(drawer.queryByText(/^\d+ dependents?$/)).toBeNull();
    expect(drawer.queryByText('0')).toBeNull();
    expect(await drawer.findByText('billing-api', { selector: 'h2' })).toBeInTheDocument();
  });

  it('a refused read says so with the server reason instead of an error or a spinner', async () => {
    serve({ ci: fail(forbidden()) });
    renderDrawer();
    const drawer = await openDrawer();

    expect(await drawer.findByText('No access to this configuration item')).toBeInTheDocument();
    expect(drawer.getByText("Permission 'read' required")).toBeInTheDocument();
    expect(drawer.queryByText(/loading/i)).toBeNull();
  });

  it('shows a loading state while the CI is in flight', async () => {
    serve({ ci: () => new Promise(() => undefined) });
    renderDrawer();
    const drawer = await openDrawer();
    expect(await drawer.findByText('Loading this configuration item\u2026')).toBeInTheDocument();
  });

  it('Open full record hands the id to the caller', async () => {
    const view = renderDrawer();
    const drawer = await openDrawer();
    await userEvent.click(drawer.getByRole('button', { name: /open full record/i }));
    expect(view.onOpenFull).toHaveBeenCalledWith('ci-1');
  });

  it('Escape closes the drawer and focus returns to the control that opened it', async () => {
    function Host() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Peek billing-api
          </button>
          <CIDrawer ciId="ci-1" open={open} onClose={() => setOpen(false)} onOpenFull={() => undefined} />
        </>
      );
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Peek billing-api' });
    await userEvent.click(trigger);
    await screen.findByRole('dialog');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});
