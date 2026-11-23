// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { request, apiClient } = vi.hoisted(() => {
  const request = { get: vi.fn() };
  const apiClient = { ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } };
  return { request, apiClient };
});

vi.mock('axios', () => ({ default: { create: vi.fn(() => apiClient) } }));
vi.mock('../drift/DriftTrackingPanel', () => ({ default: () => null }));
vi.mock('./AuditHistory', () => ({ default: () => null }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => true }));

import CIDetail from './CIDetail';
import type { CIRelationship, RelationshipType } from '../../services/ci.service';
import {
  ciFixture,
  edgeFixture,
  envelopeFixture,
  evidencePage,
  receiptFixture,
} from '../../tests/fixtures/impactEvidence';

const FOCAL = 'ci-focal';
const focal = ciFixture(FOCAL, 'focal-ci');
const a = ciFixture('ci-a', 'svc-a');
const b = ciFixture('ci-b', 'svc-b');
const c = ciFixture('ci-c', 'svc-c');
const d = ciFixture('ci-d', 'svc-d');
const e = ciFixture('ci-e', 'svc-e');

const rel = (id: string, source: typeof a, target: typeof a, type: RelationshipType = 'DEPENDS_ON'): CIRelationship => ({
  id,
  type,
  source_ci_id: source.id,
  target_ci_id: target.id,
  source_ci: source,
  target_ci: target,
  created_at: '2026-01-01T00:00:00Z',
});

// Upstream: a -> focal, b -> focal. Downstream: focal -> c, d, e (USES), and focal -> a (ids swapped against a -> focal).
const relationships = [
  rel('r1', a, focal),
  rel('r2', b, focal),
  rel('r3', focal, c),
  rel('r4', focal, d),
  rel('r5', focal, e, 'USES'),
  rel('r6', focal, a),
];

const edges = [
  edgeFixture('ci-a', FOCAL, 'current'),
  edgeFixture('ci-b', FOCAL, 'stale'),
  edgeFixture(FOCAL, 'ci-c', 'contradicted'),
  edgeFixture(FOCAL, 'ci-d', 'unsupported'),
];

function serve(
  envelope: ReturnType<typeof envelopeFixture> | null,
  evidence?: (params: Record<string, unknown>) => unknown,
  relationshipRows: CIRelationship[] = relationships
) {
  request.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === `/cis/${FOCAL}`) return { data: { success: true, data: focal } };
    if (url === `/cis/${FOCAL}/relationships`) return { data: { success: true, data: relationshipRows } };
    if (url === `/cis/${FOCAL}/impact`) {
      return {
        data: {
          success: true,
          data: { ci: focal, upstream: [a, b], downstream: [c, d], impact_score: 0.4, affected_environments: [] },
          ...(envelope ?? {}),
        },
      };
    }
    if (url === '/relationships/evidence' && evidence) return evidence(config?.params ?? {});
    throw new Error(`unexpected GET ${url}`);
  });
}

async function renderRelationshipsTab(waitForTopology = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <CIDetail ciId={FOCAL} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  await user.click(await screen.findByRole('tab', { name: 'Relationships' }));
  if (waitForTopology) await screen.findByText('Dependency topology');
  return user;
}

/** The text block of one neighbour row: name, relationship type and its evidence controls. */
const rowOf = (name: string, index = 0) => screen.getAllByText(name)[index].parentElement as HTMLElement;
const evidenceButtons = () => screen.queryAllByRole('button', { name: /^View evidence/ });

describe('CIDetail relationships evidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the basis banner above the topology, and a not-established runtime blast radius', async () => {
    serve(envelopeFixture(edges, []));
    await renderRelationshipsTab();

    expect(await screen.findByText('Declared graph reachability. Not a complete runtime blast radius.')).toBeInTheDocument();
    expect(screen.getByText('Runtime blast radius: not established.')).toBeInTheDocument();
    expect(screen.getByText('5 CIs in scope, 0 unreported.')).toBeInTheDocument();
    const banner = screen.getByRole('note', { name: 'Impact basis' });
    const topology = screen.getByText('Dependency topology');
    expect(banner.compareDocumentPosition(topology) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('isolated CI the server lists as unreported: shows the banner and the focal marker, not an absence claim', async () => {
    serve(envelopeFixture([], [FOCAL], 1), undefined, []);
    await renderRelationshipsTab(false);

    const marker = await screen.findByRole('note', { name: /^Unreported\./ });
    expect(marker).toHaveTextContent('Unreported');
    expect(screen.getByRole('note', { name: 'Impact basis' })).toBeInTheDocument();
    expect(screen.getByText('1 CI in scope, 1 unreported.')).toBeInTheDocument();
    expect(screen.getByText(/No relationships reported for this CI; coverage is incomplete\./)).toBeInTheDocument();
    expect(screen.queryByText('No relationships found for this CI.')).not.toBeInTheDocument();
    expect(screen.queryByText('Dependency topology')).not.toBeInTheDocument();
  });

  it('isolated CI the server reports: plain empty text, no unreported marker, basis banner kept', async () => {
    serve(envelopeFixture([], [], 1), undefined, []);
    await renderRelationshipsTab(false);

    expect(await screen.findByText('No relationships found for this CI.')).toBeInTheDocument();
    expect(screen.getByRole('note', { name: 'Impact basis' })).toBeInTheDocument();
    expect(screen.getByText('1 CI in scope, 0 unreported.')).toBeInTheDocument();
    expect(screen.queryByText('Unreported')).not.toBeInTheDocument();
    expect(screen.queryByText(/coverage is incomplete/)).not.toBeInTheDocument();
  });

  it('isolated CI against a server that sends no envelope: plain empty text, no banner, no marker', async () => {
    serve(null, undefined, []);
    await renderRelationshipsTab(false);

    expect(await screen.findByText('No relationships found for this CI.')).toBeInTheDocument();
    await waitFor(() => expect(request.get).toHaveBeenCalledWith(`/cis/${FOCAL}/impact`));
    expect(screen.queryByRole('note', { name: 'Impact basis' })).not.toBeInTheDocument();
    expect(screen.queryByText('Unreported')).not.toBeInTheDocument();
  });

  it('renders nothing new and no error against a server that sends no envelope', async () => {
    serve(null);
    await renderRelationshipsTab();

    await waitFor(() => expect(request.get).toHaveBeenCalledWith(`/cis/${FOCAL}/impact`));
    expect(screen.queryByText(/Declared graph reachability/)).not.toBeInTheDocument();
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
    expect(screen.queryByText('Unreported')).not.toBeInTheDocument();
    expect(evidenceButtons()).toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('labels each matching row with its own server currentness, one distinct text per value', async () => {
    serve(envelopeFixture(edges, []));
    await renderRelationshipsTab();

    await screen.findByText('Current');
    expect(within(rowOf('svc-a')).getByText('Current')).toBeInTheDocument();
    expect(within(rowOf('svc-b')).getByText('Stale')).toBeInTheDocument();
    expect(within(rowOf('svc-c')).getByText('Contradicted')).toBeInTheDocument();
    expect(within(rowOf('svc-d')).getByText('No evidence')).toBeInTheDocument();
  });

  it('gives a relationship the server does not qualify (USES) no badge and no drawer trigger', async () => {
    serve(envelopeFixture(edges, []));
    await renderRelationshipsTab();

    await screen.findByText('Current');
    const uses = rowOf('svc-e');
    expect(uses).toHaveTextContent('USES');
    expect(within(uses).queryByRole('button')).not.toBeInTheDocument();
    for (const label of ['Current', 'Stale', 'Contradicted', 'No evidence']) {
      expect(within(uses).queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('matches by stored orientation: a -> focal badges the row a feeds, not the swapped focal -> a row', async () => {
    serve(envelopeFixture([edgeFixture('ci-a', FOCAL, 'current')], []));
    await renderRelationshipsTab();

    await screen.findByText('Current');
    // svc-a appears twice: upstream (source a, target focal) first, downstream (source focal, target a) second.
    expect(within(rowOf('svc-a', 0)).getByText('Current')).toBeInTheDocument();
    expect(within(rowOf('svc-a', 1)).queryByText('Current')).not.toBeInTheDocument();
    expect(within(rowOf('svc-a', 1)).queryByRole('button')).not.toBeInTheDocument();
    expect(evidenceButtons()).toHaveLength(1);
  });

  it('marks unreported CIs, the focal CI included, and no listed-absent CI', async () => {
    serve(envelopeFixture(edges, [FOCAL, 'ci-b']));
    await renderRelationshipsTab();

    await screen.findAllByRole('note', { name: /^Unreported\./ });
    expect(within(rowOf('svc-b')).getByText('Unreported')).toBeInTheDocument();
    expect(within(rowOf('svc-a')).queryByText('Unreported')).not.toBeInTheDocument();
    expect(within(rowOf('svc-c')).queryByText('Unreported')).not.toBeInTheDocument();
    const focalNode = screen.getAllByText('focal-ci').find((el) => el.tagName === 'DIV')!.parentElement!;
    expect(within(focalNode).getByText('Unreported')).toBeInTheDocument();
    expect(screen.getAllByText('Unreported')).toHaveLength(2);
    expect(screen.getByText('5 CIs in scope, 2 unreported.')).toBeInTheDocument();
  });

  it('marks an unreported CI whose relationship has no qualified edge, with no badge or trigger', async () => {
    serve(envelopeFixture(edges, ['ci-e']));
    await renderRelationshipsTab();

    await screen.findByText('Unreported');
    const uses = rowOf('svc-e');
    expect(within(uses).getByText('Unreported')).toBeInTheDocument();
    expect(within(uses).queryByRole('button')).not.toBeInTheDocument();
  });

  it('fetches no receipts until the drawer opens, then requests the exact edge and type', async () => {
    serve(envelopeFixture(edges, []), () => evidencePage([receiptFixture(1)], { total: 1, offset: 0 }));
    const user = await renderRelationshipsTab();

    await screen.findByText('Current');
    expect(request.get.mock.calls.some(([url]) => url === '/relationships/evidence')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'View evidence: svc-b DEPENDS_ON focal-ci' }));

    expect(await screen.findByText('source-1 1.2.0')).toBeInTheDocument();
    expect(request.get).toHaveBeenCalledWith('/relationships/evidence', {
      params: { from_id: 'ci-b', to_id: FOCAL, type: 'DEPENDS_ON', limit: 20, offset: 0 },
      sideRead: true,
    });
  });

  it('opens by keyboard, shows each edge its own rows, closes on Escape and returns focus to the trigger', async () => {
    let releaseB: (value: unknown) => void = () => {};
    serve(envelopeFixture(edges, []), (params) =>
      params.from_id === 'ci-a'
        ? evidencePage([receiptFixture(1, { source_name: 'source-for-a' })], { total: 1, offset: 0 })
        : new Promise((resolve) => {
            releaseB = resolve;
          })
    );
    const user = await renderRelationshipsTab();
    await screen.findByText('Current');

    const triggerA = screen.getByRole('button', { name: 'View evidence: svc-a DEPENDS_ON focal-ci' });
    triggerA.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('source-for-a 1.2.0')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(triggerA).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'View evidence: svc-b DEPENDS_ON focal-ci' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Loading receipts...')).toBeInTheDocument();
    expect(screen.queryByText('source-for-a 1.2.0')).not.toBeInTheDocument();

    releaseB(evidencePage([receiptFixture(2, { source_name: 'source-for-b' })], { total: 1, offset: 0 }));
    expect(await screen.findByText('source-for-b 1.2.0')).toBeInTheDocument();
    expect(screen.queryByText('source-for-a 1.2.0')).not.toBeInTheDocument();
  });
});
