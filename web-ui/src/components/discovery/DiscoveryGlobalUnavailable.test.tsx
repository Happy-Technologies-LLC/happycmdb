// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { request, toast } = vi.hoisted(() => ({ request: { get: vi.fn(), post: vi.fn(), put: vi.fn() }, toast: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => ({
  ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import { DiscoveryDashboard } from './DiscoveryDashboard';
import { DiscoveryScheduleManager } from './DiscoveryScheduleManager';

const refusal = { response: { status: 403, data: { success: false, error: 'Global queue operations unavailable' } } };
beforeEach(() => {
  vi.clearAllMocks();
  request.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/jobs/discovery?')) {
      return { data: { data: [{ id: 'owned-job', provider: 'nmap', status: 'completed', createdAt: '2026-01-01T00:00:00Z' }],
        pagination: { total: 1, page: 1, limit: 5, totalPages: 1 } } };
    }
    return Promise.reject(refusal);
  });
});

describe('discovery global controls are unavailable', () => {
  it('keeps the owned recent-job list while showing accurate unavailable aggregates without refused requests', async () => {
    render(<DiscoveryDashboard />);
    expect(screen.getByText(/discovery statistics unavailable/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('owned-job')).toBeInTheDocument());
    expect(request.get).toHaveBeenCalledTimes(1);
    expect(request.get.mock.calls[0]![0]).toMatch(/^\/jobs\/discovery\?/);
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows schedules unavailable without loading the refused global schedule or offering edits', () => {
    render(<DiscoveryScheduleManager />);
    expect(screen.getByText(/discovery schedules unavailable/i)).toBeInTheDocument();
    expect(request.get).not.toHaveBeenCalled();
    expect(request.put).not.toHaveBeenCalled();
    expect(screen.queryByText('No schedules found')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });
});
