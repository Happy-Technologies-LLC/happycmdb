// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { jobsServiceMock } = vi.hoisted(() => ({
  jobsServiceMock: {
    getSchedules: vi.fn(),
    updateSchedule: vi.fn(),
  },
}));

vi.mock('../services/jobs.service', () => ({
  jobsService: jobsServiceMock,
}));

import { useSchedules } from './useQueueStats';

const initialSchedule = {
  id: 'discovery:nmap',
  name: 'Discovery: nmap',
  queueName: 'discovery-nmap',
  cron: '0 * * * *',
  data: {},
  enabled: true,
};

describe('useSchedules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the refreshed schedule after toggling its enabled state', async () => {
    const refreshedSchedule = { ...initialSchedule, enabled: false };
    jobsServiceMock.getSchedules
      .mockResolvedValueOnce([initialSchedule])
      .mockResolvedValueOnce([refreshedSchedule]);
    jobsServiceMock.updateSchedule.mockResolvedValue(refreshedSchedule);

    const { result } = renderHook(() => useSchedules({ autoRefresh: false }));
    await waitFor(() => expect(result.current.schedules).toEqual([initialSchedule]));

    let toggledSchedule: typeof refreshedSchedule | undefined;
    await act(async () => {
      toggledSchedule = await result.current.toggleSchedule('discovery:nmap', false);
    });

    expect(jobsServiceMock.updateSchedule).toHaveBeenCalledWith('discovery:nmap', { enabled: false });
    expect(jobsServiceMock.getSchedules).toHaveBeenCalledTimes(2);
    expect(toggledSchedule).toEqual(refreshedSchedule);
    expect(result.current.schedules).toEqual([refreshedSchedule]);
  });
});
