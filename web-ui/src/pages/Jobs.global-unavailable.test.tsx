// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { request, toast } = vi.hoisted(() => ({ request: { get: vi.fn(), put: vi.fn(), post: vi.fn() }, toast: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => ({
  ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null }));

import { Jobs } from './Jobs';

const refusal = { response: { status: 403, data: { success: false, error: 'Global queue operations unavailable' } } };
const message = /Global queue and schedule controls are unavailable \(platform operations only\)/i;

beforeEach(() => {
  vi.clearAllMocks();
  request.get.mockImplementation(async (path: string) => {
    if (path === '/jobs/discovery-aws') {
      return { data: { success: true, data: { jobs: [{ id: 'owned-job', queueName: 'discovery-aws', state: 'completed', timestamp: 1 }] }, pagination: { total: 1, limit: 25, offset: 0 } } };
    }
    if (path.startsWith('/jobs/') && !path.includes('/schedules') && !path.includes('/stats')) {
      return { data: { success: true, data: { jobs: [] }, pagination: { total: 0, limit: 25, offset: 0 } } };
    }
    return Promise.reject(refusal);
  });
});

describe('Jobs global controls on a tenant session', () => {
  it('shows an unavailable state without polling refused globals or losing owned job lists', async () => {
    const user = userEvent.setup();
    render(<Jobs />);
    await waitFor(() => expect(request.get).toHaveBeenCalledWith('/jobs/discovery-aws', expect.anything()));
    await waitFor(() => expect(screen.getByText('owned-job')).toBeInTheDocument());
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('tab', { name: 'Schedules' }));
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /toggle|pause|resume/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Worker Status' }));
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    expect(request.get.mock.calls.every(([path]: [string]) =>
      path.startsWith('/jobs/discovery-aws'))).toBe(true);
    expect(request.put).not.toHaveBeenCalled();
    expect(request.post).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
