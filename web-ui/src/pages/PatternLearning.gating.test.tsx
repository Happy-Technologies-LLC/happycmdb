// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import PatternLearning from './PatternLearning';

const auth = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const compileAndSubmitPatterns = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useDiscoverySessions', () => ({
  useDiscoverySessions: () => ({ compileAndSubmitPatterns, sessions: [], loading: false, error: null }),
}));
vi.mock('@/components/ai/PatternLearningOverview', () => ({ PatternLearningOverview: () => <div>Overview view</div> }));
vi.mock('@/components/ai/PatternLibrary', () => ({ PatternLibrary: () => <div>Library view</div> }));
vi.mock('@/components/ai/DiscoverySessionsView', () => ({ DiscoverySessionsView: () => <div>Sessions view</div> }));
vi.mock('@/components/ai/CostAnalyticsDashboard', () => ({ CostAnalyticsDashboard: () => <div>Cost view</div> }));

beforeEach(() => compileAndSubmitPatterns.mockReset().mockResolvedValue({ compiled: 0, submitted: 0, errors: [] }));
afterEach(cleanup);

const mount = () =>
  render(
    <MemoryRouter>
      <PatternLearning />
    </MemoryRouter>,
  );

// POST /ai/patterns/compile needs write on the server; a viewer gets no control to send it.
describe('PatternLearning page by role', () => {
  it('a viewer reads the page but gets no Compile Patterns control; an operator gets it, disabled while a compile is pending', async () => {
    auth.role = 'viewer';
    mount();
    expect(screen.getByRole('heading', { name: 'AI Pattern Learning' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Pattern learning sections' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /compile patterns/i })).toBeNull();
    cleanup();

    auth.role = 'operator';
    let finish: (value: unknown) => void = () => {};
    compileAndSubmitPatterns.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    mount();
    const button = screen.getByRole('button', { name: /compile patterns/i });
    await user.click(button);
    expect(compileAndSubmitPatterns).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    await act(async () => finish({ compiled: 0, submitted: 0, errors: [] }));
    expect(button).toBeEnabled();
  });
});
