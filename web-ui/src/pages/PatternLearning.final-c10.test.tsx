// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Final regression cycle 10 -- frontend AI Pattern Learning surface
 * (F-018, F-051, F-052, F-053).
 *
 * THROWAWAY regression-cycle evidence file (FinalRetestAi). Not part of the
 * permanent suite. Mocks the hook layer (useAIPatterns/useDiscoverySessions)
 * rather than the fetch/service layer, matching this repo's existing
 * convention (see DiscoveryJobTrigger.test.tsx: `vi.mock('@hooks/useX')`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom implements neither the Pointer Events capture API nor
// scrollIntoView, both of which Radix UI's Select uses internally; without
// these stubs, opening a <Select> under jsdom throws
// "target.hasPointerCapture is not a function".
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '@/tests/utils/test-utils';
import PatternLearning from './PatternLearning';
import { DiscoverySessionsView } from '@/components/ai/DiscoverySessionsView';
import { PatternLibrary } from '@/components/ai/PatternLibrary';
import { CostAnalyticsDashboard } from '@/components/ai/CostAnalyticsDashboard';
import type { AIPattern, AIDiscoverySession, CostAnalytics } from '@/services/ai-pattern.service';
import * as useDiscoverySessionsHook from '@/hooks/useDiscoverySessions';
import * as useAIPatternsHook from '@/hooks/useAIPatterns';

vi.mock('@/hooks/useDiscoverySessions');
vi.mock('@/hooks/useAIPatterns');

// PatternLearningOverview independently fetches its own data (learning
// stats, recent activity); stub it so F-018's tab-switching test isn't
// coupled to a third hook/service surface it doesn't describe.
vi.mock('@/components/ai/PatternLearningOverview', () => ({
  PatternLearningOverview: () => <div data-testid="overview-stub">Overview stub</div>,
}));

function makeSession(overrides: Partial<AIDiscoverySession> = {}): AIDiscoverySession {
  return {
    sessionId: 'sess-1',
    targetHost: '10.0.0.1',
    targetPort: 443,
    status: 'completed',
    toolCalls: [],
    discoveredCIs: [],
    confidenceScore: 0.92,
    estimatedCost: 0.0123,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 4200,
    aiModel: 'claude-sonnet-4-20250514',
    retryCount: 0,
    ...overrides,
  };
}

function makePattern(overrides: Partial<AIPattern> = {}): AIPattern {
  return {
    patternId: 'pat-1',
    name: 'Nginx Reverse Proxy',
    category: 'web',
    detectionCode: 'function detect() {}',
    discoveryCode: 'async function discover() {}',
    author: 'pattern-compiler',
    confidenceScore: 0.9,
    status: 'draft',
    isActive: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    usageCount: 10,
    successCount: 8,
    failureCount: 2,
    ...overrides,
  };
}

const baseDiscoverySessionsReturn = {
  sessions: [] as AIDiscoverySession[],
  loading: false,
  error: null,
  loadSessions: vi.fn(),
  getSession: vi.fn(),
  analyzeSession: vi.fn(),
  compileAndSubmitPatterns: vi.fn(),
  costAnalytics: null as CostAnalytics | null,
  loadCostAnalytics: vi.fn(),
  learningStats: null,
  loadLearningStats: vi.fn(),
};

const baseAIPatternsReturn = {
  patterns: [] as AIPattern[],
  loading: false,
  error: null,
  loadPatterns: vi.fn(),
  getPattern: vi.fn(),
  deletePattern: vi.fn().mockResolvedValue(true),
  submitForReview: vi.fn().mockResolvedValue(true),
  approvePattern: vi.fn().mockResolvedValue(true),
  rejectPattern: vi.fn().mockResolvedValue(true),
  activatePattern: vi.fn().mockResolvedValue(true),
  deactivatePattern: vi.fn().mockResolvedValue(true),
  validatePattern: vi.fn(),
};

describe('F-018: /ai/patterns renders PatternLearning, tab-selects content, disables compile while pending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(useDiscoverySessionsHook, 'useDiscoverySessions').mockReturnValue({
      ...baseDiscoverySessionsReturn,
      compileAndSubmitPatterns: vi.fn(),
    });
    vi.spyOn(useAIPatternsHook, 'useAIPatterns').mockReturnValue({ ...baseAIPatternsReturn });
  });

  it('renders overview/patterns/sessions/cost(analytics) tab content on selection', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<PatternLearning />);

    // Overview renders by default.
    expect(await screen.findByTestId('overview-stub')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /pattern library/i }));
    expect(await screen.findByPlaceholderText('Search patterns...')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /discovery sessions/i }));
    expect(await screen.findByPlaceholderText('Search by host or session ID...')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /cost analytics/i }));
    await waitFor(() => {
      // CostAnalyticsDashboard with costAnalytics:null renders its
      // "No cost data available" empty state.
      expect(screen.getByText('No cost data available')).toBeInTheDocument();
    });
  });

  it('disables the Compile Patterns button while compileAndSubmitPatterns() is pending, and re-enables it after resolution', async () => {
    let resolveCompile: (() => void) | undefined;
    const compileAndSubmitPatterns = vi.fn(
      () =>
        new Promise<{ compiled: number; submitted: number; errors: string[] }>(resolve => {
          resolveCompile = () => resolve({ compiled: 0, submitted: 0, errors: [] });
        })
    );
    vi.spyOn(useDiscoverySessionsHook, 'useDiscoverySessions').mockReturnValue({
      ...baseDiscoverySessionsReturn,
      compileAndSubmitPatterns,
    });

    const user = userEvent.setup();
    renderWithQueryClient(<PatternLearning />);

    const compileButton = screen.getByRole('button', { name: /compile patterns/i });
    expect(compileButton).not.toBeDisabled();

    await user.click(compileButton);
    expect(compileAndSubmitPatterns).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(compileButton).toBeDisabled());

    resolveCompile?.();
    await waitFor(() => expect(compileButton).not.toBeDisabled());
  });
});

describe('F-051: DiscoverySessionsView loading -> filter by search/status/provider -> detail modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state before rendering the filterable session table', () => {
    vi.spyOn(useDiscoverySessionsHook, 'useDiscoverySessions').mockReturnValue({
      ...baseDiscoverySessionsReturn,
      loading: true,
    });
    const { container } = renderWithQueryClient(<DiscoverySessionsView />);
    expect(container.querySelector('[role="status"], .animate-spin, svg')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Search by host or session ID...')).not.toBeInTheDocument();
  });

  it('filters sessions by search text, status, and provider(model), and opens the detail modal from a row click or the view-details action', async () => {
    const sessions = [
      makeSession({ sessionId: 'sess-a', targetHost: 'db.internal', status: 'completed', aiModel: 'claude-sonnet-4-20250514' }),
      makeSession({ sessionId: 'sess-b', targetHost: 'web.internal', status: 'failed', aiModel: 'gpt-4o' }),
      makeSession({ sessionId: 'sess-c', targetHost: 'cache.internal', status: 'running', aiModel: 'claude-sonnet-4-20250514' }),
    ];
    vi.spyOn(useDiscoverySessionsHook, 'useDiscoverySessions').mockReturnValue({
      ...baseDiscoverySessionsReturn,
      sessions,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<DiscoverySessionsView />);

    // All three visible initially.
    expect(screen.getByText('db.internal')).toBeInTheDocument();
    expect(screen.getByText('web.internal')).toBeInTheDocument();
    expect(screen.getByText('cache.internal')).toBeInTheDocument();

    // Search filter (matches targetHost).
    await user.type(screen.getByPlaceholderText('Search by host or session ID...'), 'db.internal');
    await waitFor(() => {
      expect(screen.getByText('db.internal')).toBeInTheDocument();
      expect(screen.queryByText('web.internal')).not.toBeInTheDocument();
      expect(screen.queryByText('cache.internal')).not.toBeInTheDocument();
    });
    await user.clear(screen.getByPlaceholderText('Search by host or session ID...'));

    // Status filter.
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByRole('option', { name: 'Failed' }));
    await waitFor(() => {
      expect(screen.getByText('web.internal')).toBeInTheDocument();
      expect(screen.queryByText('db.internal')).not.toBeInTheDocument();
    });
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByRole('option', { name: 'All Statuses' }));

    // Provider (model) filter.
    await user.click(screen.getAllByRole('combobox')[1]);
    await user.click(await screen.findByRole('option', { name: 'gpt-4o' }));
    await waitFor(() => {
      expect(screen.getByText('web.internal')).toBeInTheDocument();
      expect(screen.queryByText('db.internal')).not.toBeInTheDocument();
      expect(screen.queryByText('cache.internal')).not.toBeInTheDocument();
    });
    await user.click(screen.getAllByRole('combobox')[1]);
    await user.click(await screen.findByRole('option', { name: 'All Models' }));

    // Row click opens the detail modal with tab state and a close action.
    await user.click(screen.getByText('db.internal'));
    const modal = await screen.findByRole('dialog');
    expect(within(modal).getByText('sess-a')).toBeInTheDocument();
    expect(within(modal).getByRole('tab', { name: 'Overview' })).toHaveAttribute('data-state', 'active');
    await user.click(within(modal).getByRole('tab', { name: 'Tool Calls' }));
    expect(within(modal).getByRole('tab', { name: 'Tool Calls' })).toHaveAttribute('data-state', 'active');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // View-details action button (not just the row) also opens the modal.
    const detailButtons = screen.getAllByTitle('View Details');
    await user.click(detailButtons[0]);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('F-052: PatternLibrary filter reset, state-gated actions, delete confirmation, detail modal tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // window.confirm is used by handleDelete; stub it so the test controls
    // whether the (real) delete API call is reached.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('resets to page 1 whenever the search/status/category filters change', async () => {
    const patterns = Array.from({ length: 30 }, (_, i) =>
      makePattern({ patternId: `pat-${i}`, name: `Pattern ${i}`, status: 'active', isActive: true })
    );
    vi.spyOn(useAIPatternsHook, 'useAIPatterns').mockReturnValue({ ...baseAIPatternsReturn, patterns });
    const user = userEvent.setup();
    renderWithQueryClient(<PatternLibrary />);

    // 30 patterns at default page size 25 -> page 1 of 2.
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();

    // Changing the search filter resets back to page 1.
    await user.type(screen.getByPlaceholderText('Search patterns...'), 'Pattern 1');
    await waitFor(() => expect(screen.getByText(/Page 1 of/)).toBeInTheDocument());
  });

  it('renders lifecycle actions only at their matching status/isActive state, and calls the corresponding discovery-session API', async () => {
    const approvePattern = vi.fn().mockResolvedValue(true);
    const activatePattern = vi.fn().mockResolvedValue(true);
    const deactivatePattern = vi.fn().mockResolvedValue(true);
    const deletePattern = vi.fn().mockResolvedValue(true);
    const patterns = [
      makePattern({ patternId: 'p-review', name: 'Review Pattern', status: 'review', isActive: false }),
      makePattern({ patternId: 'p-approved', name: 'Approved Pattern', status: 'approved', isActive: false }),
      makePattern({ patternId: 'p-active', name: 'Active Pattern', status: 'active', isActive: true }),
      makePattern({ patternId: 'p-draft', name: 'Draft Pattern', status: 'draft', isActive: false }),
    ];
    vi.spyOn(useAIPatternsHook, 'useAIPatterns').mockReturnValue({
      ...baseAIPatternsReturn,
      patterns,
      approvePattern,
      activatePattern,
      deactivatePattern,
      deletePattern,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<PatternLibrary />);

    const reviewRow = screen.getByText('Review Pattern').closest('tr');
    expect(reviewRow).not.toBeNull();
    await user.click(within(reviewRow as HTMLElement).getByTitle('Approve'));
    expect(approvePattern).toHaveBeenCalledWith('p-review');
    expect(within(reviewRow as HTMLElement).queryByTitle('Activate')).not.toBeInTheDocument();
    expect(within(reviewRow as HTMLElement).queryByTitle('Deactivate')).not.toBeInTheDocument();

    const approvedRow = screen.getByText('Approved Pattern').closest('tr') as HTMLElement;
    expect(within(approvedRow).queryByTitle('Approve')).not.toBeInTheDocument();
    await user.click(within(approvedRow).getByTitle('Activate'));
    expect(activatePattern).toHaveBeenCalledWith('p-approved');

    const activeRow = screen.getByText('Active Pattern').closest('tr') as HTMLElement;
    expect(within(activeRow).queryByTitle('Activate')).not.toBeInTheDocument();
    await user.click(within(activeRow).getByTitle('Deactivate'));
    expect(deactivatePattern).toHaveBeenCalledWith('p-active');

    const draftRow = screen.getByText('Draft Pattern').closest('tr') as HTMLElement;
    expect(within(draftRow).queryByTitle('Approve')).not.toBeInTheDocument();
    expect(within(draftRow).queryByTitle('Activate')).not.toBeInTheDocument();
    expect(within(draftRow).queryByTitle('Deactivate')).not.toBeInTheDocument();
    // Delete only ever renders for 'draft' status.
    expect(within(reviewRow as HTMLElement).queryByTitle('Delete')).not.toBeInTheDocument();
    await user.click(within(draftRow).getByTitle('Delete'));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Draft Pattern'));
    expect(deletePattern).toHaveBeenCalledWith('p-draft');
  });

  it('delete is gated behind window.confirm -- declining leaves the pattern untouched', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deletePattern = vi.fn().mockResolvedValue(true);
    vi.spyOn(useAIPatternsHook, 'useAIPatterns').mockReturnValue({
      ...baseAIPatternsReturn,
      patterns: [makePattern({ patternId: 'p-draft', name: 'Draft Pattern', status: 'draft' })],
      deletePattern,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<PatternLibrary />);
    await user.click(screen.getByTitle('Delete'));
    expect(window.confirm).toHaveBeenCalled();
    expect(deletePattern).not.toHaveBeenCalled();
  });

  it('opens a detail modal with multiple content tabs (info + detection/discovery/tests) from row click or the view-details action', async () => {
    vi.spyOn(useAIPatternsHook, 'useAIPatterns').mockReturnValue({
      ...baseAIPatternsReturn,
      patterns: [makePattern({ patternId: 'p-1', name: 'Detail Modal Pattern' })],
    });
    const user = userEvent.setup();
    renderWithQueryClient(<PatternLibrary />);

    await user.click(screen.getByText('Detail Modal Pattern'));
    const modal = await screen.findByRole('dialog');
    expect(within(modal).getByRole('tab', { name: 'Info' })).toHaveAttribute('data-state', 'active');
    expect(within(modal).getByRole('tab', { name: 'Detection' })).toBeInTheDocument();
    expect(within(modal).getByRole('tab', { name: 'Discovery' })).toBeInTheDocument();
    expect(within(modal).getByRole('tab', { name: 'Tests' })).toBeInTheDocument();
    await user.click(within(modal).getByRole('tab', { name: 'Detection' }));
    expect(within(modal).getByRole('tab', { name: 'Detection' })).toHaveAttribute('data-state', 'active');
  });
});

describe('F-053: CostAnalyticsDashboard converts dateRange to ISO bounds and reloads on change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state before the cost dashboard renders', () => {
    vi.spyOn(useDiscoverySessionsHook, 'useDiscoverySessions').mockReturnValue({
      ...baseDiscoverySessionsReturn,
      loading: true,
    });
    renderWithQueryClient(<CostAnalyticsDashboard />);
    expect(screen.queryByText('No cost data available')).not.toBeInTheDocument();
  });

  it('calls loadCostAnalytics with ISO date bounds on mount, and again whenever the date-range selector changes', async () => {
    const loadCostAnalytics = vi.fn();
    vi.spyOn(useDiscoverySessionsHook, 'useDiscoverySessions').mockReturnValue({
      ...baseDiscoverySessionsReturn,
      loadCostAnalytics,
      costAnalytics: {
        totalCost: 1.23,
        totalSessions: 10,
        avgCostPerSession: 0.123,
        costByModel: [],
        costByDay: [],
        savingsFromPatterns: { totalSaved: 0, percentSaved: 0, patternHits: 0, aiDiscoveries: 10 },
      },
    });
    const user = userEvent.setup();
    renderWithQueryClient(<CostAnalyticsDashboard />);

    await waitFor(() => expect(loadCostAnalytics).toHaveBeenCalledTimes(1));
    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const [firstDateFrom, firstDateTo] = loadCostAnalytics.mock.calls[0] as [string, string];
    expect(firstDateFrom).toMatch(isoPattern);
    expect(firstDateTo).toMatch(isoPattern);
    // Default range is 30 days.
    expect(new Date(firstDateTo).getTime() - new Date(firstDateFrom).getTime()).toBeCloseTo(30 * 86400000, -3);

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /last 7 days/i }));

    await waitFor(() => expect(loadCostAnalytics).toHaveBeenCalledTimes(2));
    const [secondDateFrom, secondDateTo] = loadCostAnalytics.mock.calls[1] as [string, string];
    expect(secondDateFrom).toMatch(isoPattern);
    expect(secondDateTo).toMatch(isoPattern);
    expect(new Date(secondDateTo).getTime() - new Date(secondDateFrom).getTime()).toBeCloseTo(7 * 86400000, -3);
  });
});
