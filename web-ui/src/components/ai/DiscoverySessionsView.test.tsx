// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AIDiscoverySession } from '@/services/ai-pattern.service';
import { DiscoverySessionsView } from './DiscoverySessionsView';

const hook = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useDiscoverySessions', () => ({ useDiscoverySessions: () => hook.value }));

const session = (overrides: Partial<AIDiscoverySession> = {}): AIDiscoverySession => ({
  sessionId: 'sess-1',
  targetHost: 'web.internal',
  targetPort: 443,
  status: 'completed',
  toolCalls: [],
  discoveredCIs: [],
  confidenceScore: 0.92,
  estimatedCost: 0.0123,
  startedAt: '2026-10-01T10:00:00Z',
  durationMs: 4200,
  aiModel: 'claude-sonnet-4',
  retryCount: 0,
  ...overrides,
});

const loadSessions = vi.fn();
const state = (overrides: Record<string, unknown> = {}) => {
  hook.value = { sessions: [session()], loading: false, error: null, loadSessions, ...overrides };
};

beforeEach(() => {
  loadSessions.mockReset();
  state();
});
afterEach(cleanup);

describe('DiscoverySessionsView states', () => {
  it('says what is loading while the sessions load, and shows no table', () => {
    state({ loading: true, sessions: [] });
    render(<DiscoverySessionsView />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading discovery sessions');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the empty message with its filters named for a screen reader when there are no sessions', () => {
    state({ sessions: [] });
    render(<DiscoverySessionsView />);
    expect(screen.getByRole('textbox', { name: 'Search sessions' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter by model' })).toBeInTheDocument();
    expect(screen.getByText('No discovery sessions found')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('shows a failed load with its reason and a retry that reloads, not an empty table', async () => {
    state({ sessions: [], error: 'Failed to load sessions: upstream down' });
    const user = userEvent.setup();
    render(<DiscoverySessionsView />);
    expect(screen.getByText('Could not load discovery sessions')).toBeInTheDocument();
    expect(screen.getByText('Failed to load sessions: upstream down')).toBeInTheDocument();
    expect(screen.queryByText('No discovery sessions found')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });
});

describe('DiscoverySessionsView figures', () => {
  const rowOf = (host: string) => screen.getByText(host).closest('tr') as HTMLElement;

  it('reads a session with no confidence or cost as unavailable, never 0% or $0.0000, and a real 0 as 0', () => {
    state({ sessions: [session({ confidenceScore: undefined, estimatedCost: undefined })] });
    render(<DiscoverySessionsView />);
    const row = rowOf('web.internal');
    expect(within(row).getAllByText('Not available yet')).toHaveLength(2);
    expect(within(row).queryByText('0%')).toBeNull();
    expect(within(row).queryByText('$0.0000')).toBeNull();

    cleanup();
    state({ sessions: [session({ confidenceScore: 0, estimatedCost: 0 })] });
    render(<DiscoverySessionsView />);
    expect(within(rowOf('web.internal')).getByText('0%')).toBeInTheDocument();
    expect(within(rowOf('web.internal')).getByText('$0.0000')).toBeInTheDocument();
    expect(within(rowOf('web.internal')).queryByText('Not available yet')).toBeNull();
  });

  it('reads a session that reports no discovered CIs as a dash, never 0, and an empty list as 0', () => {
    state({ sessions: [session({ discoveredCIs: undefined })] });
    render(<DiscoverySessionsView />);
    const cell = (host: string) => within(rowOf(host)).getAllByRole('cell')[headerIndex('CIs Found')];
    const headerIndex = (name: string) => screen.getAllByRole('columnheader').findIndex((h) => h.textContent === name);
    expect(cell('web.internal')).toHaveTextContent(/^—$/);

    cleanup();
    state({ sessions: [session({ discoveredCIs: [] })] });
    render(<DiscoverySessionsView />);
    expect(cell('web.internal')).toHaveTextContent(/^0$/);
  });
});
