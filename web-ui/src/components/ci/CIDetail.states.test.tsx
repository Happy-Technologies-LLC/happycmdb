// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1918 (UX-4b S4b): the CI detail page on the design system, against a played server. The real service, its
// session interceptors and the real hooks talk to an axios adapter; only who is signed in and the drift panel
// (not under test here) are replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'operator' as string }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock('../drift/DriftTrackingPanel', () => ({ default: () => <p>drift panel</p> }));

type Reply = { status: number; body: unknown } | 'pending' | (() => { status: number; body: unknown });
const world: { routes: Record<string, Reply>; depths: unknown[] } = { routes: {}, depths: [] };

const { default: axios } = await import('axios');
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = String(config.url);
  if (url === `/cis/${ID}/relationships`) world.depths.push(config.params?.depth);
  const played = world.routes[url] ?? { status: 404, body: { message: `unplayed ${url}` } };
  if (played === 'pending') return new Promise(() => undefined);
  const reply = typeof played === 'function' ? played() : played;
  const response = { data: reply.body, status: reply.status, statusText: '', headers: {}, config, request: {} };
  if (reply.status < 400) return response;
  throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_REQUEST', config, {}, response);
};

const { default: CIDetail } = await import('./CIDetail');
const { ForbiddenHost } = await import('../layout/ForbiddenHost');
const { ciFixture, edgeFixture, envelopeFixture } = await import('../../tests/fixtures/impactEvidence');

const ID = 'ci-1';
const ci = { ...ciFixture(ID, 'orders-db'), confidence_score: 0.8 };
const neighbour = ciFixture('ci-2', 'payments-api');
const relationship = {
  id: 'r1',
  type: 'DEPENDS_ON',
  source_ci_id: 'ci-2',
  target_ci_id: ID,
  source_ci: neighbour,
  target_ci: ci,
  created_at: '2026-01-01T00:00:00Z',
};

const ok = (body: unknown): Reply => ({ status: 200, body });
const refused = (message: string): Reply => ({ status: 403, body: { _error: 'Forbidden', _message: message } });
const failed: Reply = { status: 500, body: { message: 'boom' } };

function play(over: Record<string, Reply> = {}) {
  world.routes = {
    [`/cis/${ID}`]: ok({ success: true, data: ci }),
    [`/cis/${ID}/relationships`]: ok({ success: true, data: [relationship] }),
    [`/cis/${ID}/impact`]: ok({
      success: true,
      data: { ci, upstream: [neighbour], downstream: [], impact_score: 0.1, affected_environments: [] },
      ...envelopeFixture([edgeFixture('ci-2', ID, 'current')], []),
    }),
    [`/cis/${ID}/audit`]: ok({ success: true, data: [] }),
    ...over,
  };
}

const callbacks = () => ({ onBack: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() });

function mount(handlers = callbacks()) {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter>
        <ForbiddenHost />
        <CIDetail ciId={ID} {...handlers} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { user, ...handlers };
}

/** The Stat whose caption is `label` (a div, so the tab with the same text is not matched). */
const stat = (label: string) => screen.getByText(label, { selector: 'div' }).parentElement as HTMLElement;

beforeEach(() => {
  auth.role = 'operator';
  world.depths = [];
  play();
});
afterEach(cleanup);

describe('CIDetail states', () => {
  it('says it is loading while the CI read is pending, not a bare spinner', async () => {
    play({ [`/cis/${ID}`]: 'pending' });
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading this configuration item');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('shows a visible, retryable error when the CI read fails, and recovers on retry', async () => {
    let calls = 0;
    play({
      [`/cis/${ID}`]: () => (++calls === 1 ? { status: 500, body: { message: 'boom' } } : { status: 200, body: { success: true, data: ci } }),
    });
    const { user } = mount();

    expect(await screen.findByText('Could not load this configuration item')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'orders-db' })).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('shows a plain not-found state with a back action for a 404', async () => {
    play({ [`/cis/${ID}`]: { status: 404, body: { message: 'CI not found' } } });
    const { user, onBack } = mount();

    expect(await screen.findByText('Configuration item not found')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this configuration item')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to list' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('a server 403 on the CI read reaches the global banner and the page shows its own not-permitted state', async () => {
    play({ [`/cis/${ID}`]: refused("Permission 'read' required") });
    mount();

    expect(await screen.findByText('No access to this configuration item')).toBeInTheDocument();
    expect(screen.getByText('Access denied.')).toBeInTheDocument();
    expect(screen.getAllByText("Permission 'read' required").length).toBeGreaterThan(0);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to list' })).toBeInTheDocument();
  });
});

describe('CIDetail write controls', () => {
  it('a viewer reads the CI and sees neither Edit nor Delete', async () => {
    auth.role = 'viewer';
    mount();

    expect(await screen.findByRole('heading', { level: 1, name: 'orders-db' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to list' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('an operator gets both, and each calls its own callback once', async () => {
    const { user, onEdit, onDelete, onBack } = mount();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Back to list' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('CIDetail figures', () => {
  it('shows N/A, never 0, for a count whose read failed', async () => {
    play({ [`/cis/${ID}/relationships`]: failed });
    mount();

    await screen.findByRole('heading', { level: 1, name: 'orders-db' });
    await waitFor(() => expect(within(stat('Relationships')).getByText('N/A')).toBeInTheDocument());
    expect(within(stat('Relationships')).queryByText('0')).not.toBeInTheDocument();
    // The impact read answered: its figure is real.
    await waitFor(() => expect(within(stat('Potential Impact')).getByText('1')).toBeInTheDocument());
  });

  it('shows a confidence score of zero as 0%, and an absent score as N/A', async () => {
    play({ [`/cis/${ID}`]: ok({ success: true, data: { ...ci, confidence_score: 0 } }) });
    mount();
    await screen.findByRole('heading', { level: 1, name: 'orders-db' });
    expect(within(stat('Confidence Score')).getByText('0%')).toBeInTheDocument();

    cleanup();
    play({ [`/cis/${ID}`]: ok({ success: true, data: { ...ci, confidence_score: undefined } }) });
    mount();
    await screen.findByRole('heading', { level: 1, name: 'orders-db' });
    expect(within(stat('Confidence Score')).getByText('N/A')).toBeInTheDocument();
  });
});

describe('CIDetail tabs', () => {
  it('has the four tabs in order, Overview selected by default, and shows the matching panel on selection', async () => {
    const { user } = mount();
    const tabs = await screen.findAllByRole('tab');

    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Relationships', 'Configuration Drift', 'History']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tabpanel', { name: 'Overview' })).getByText('Quick Stats')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false');
    expect(
      await within(screen.getByRole('tabpanel', { name: 'History' })).findByText('No audit history available')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Configuration Drift' }));
    expect(within(screen.getByRole('tabpanel', { name: 'Configuration Drift' })).getByText('drift panel')).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys, wrapping at both ends', async () => {
    const { user } = mount();
    const overview = await screen.findByRole('tab', { name: 'Overview' });
    overview.focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Relationships' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Relationships' })).toHaveFocus();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('CIDetail relationships tab', () => {
  const openRelationships = async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('tab', { name: 'Relationships' }));
    return user;
  };

  it('shows the retired graph widget and its depth control nowhere: only the direct topology', async () => {
    await openRelationships();

    expect(await screen.findByText('Dependency topology')).toBeInTheDocument();
    const panel = screen.getByRole('tabpanel', { name: 'Relationships' });
    expect(within(panel).queryByLabelText(/depth/i)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /zoom|download|center/i })).not.toBeInTheDocument();
    expect(panel.querySelector('canvas, svg')).toBeNull();
    expect(within(panel).queryByText(/Status \(Border Color\)/)).not.toBeInTheDocument();
  });

  it('asks for the relationships at depth 1 only', async () => {
    await openRelationships();
    await screen.findByText('Dependency topology');

    expect(new Set(world.depths)).toEqual(new Set([1]));
  });

  it('shows a retryable error, not "no relationships", when the relationships read fails', async () => {
    let calls = 0;
    play({
      [`/cis/${ID}/relationships`]: () =>
        ++calls === 1 ? { status: 500, body: { message: 'boom' } } : { status: 200, body: { success: true, data: [relationship] } },
    });
    const user = await openRelationships();

    expect(await screen.findByText('Could not load relationships')).toBeInTheDocument();
    expect(screen.queryByText('No relationships found for this CI.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Dependency topology')).toBeInTheDocument();
  });

  it('says the impact basis is unavailable, with a retry, when the impact read fails; the topology still shows', async () => {
    play({ [`/cis/${ID}/impact`]: failed });
    await openRelationships();

    expect(await screen.findByText('Dependency topology')).toBeInTheDocument();
    expect(await screen.findByText(/impact basis could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('note', { name: 'Impact basis' })).not.toBeInTheDocument();
  });

  it('shows the not-permitted state when the relationships read is a 403', async () => {
    play({ [`/cis/${ID}/relationships`]: refused("Permission 'read' required") });
    await openRelationships();

    expect(await screen.findByText('No access to relationships')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the loading state while the relationships read is pending', async () => {
    play({ [`/cis/${ID}/relationships`]: 'pending' });
    await openRelationships();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading relationships');
  });
});
