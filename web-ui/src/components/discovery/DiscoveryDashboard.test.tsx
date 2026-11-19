// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// The dashboard drill-down puts a server-issued job id in a query string, so it must be encoded.
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DiscoveryDashboard } from './DiscoveryDashboard';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
const JOB_ID = 'a&b=c d';
vi.mock('../../hooks/useDiscoveryJobs', () => ({
  useDiscoveryJobs: () => ({
    jobs: [{ id: JOB_ID, provider: 'ssh', status: 'completed', progress: 100, discoveredCIs: 2, createdAt: new Date().toISOString(), config: {} }],
    loading: false,
    error: null,
    loadJobs: vi.fn(),
  }),
}));
// The view renders real design-system components; only the icon glyphs are stubbed.
vi.mock('@happy-technologies/design-system', async (importOriginal) => ({ ...(await importOriginal<typeof import('@happy-technologies/design-system')>()), Icon: () => null }));

it('a clicked recent-job row navigates with the job id encoded, and it round-trips through URLSearchParams', () => {
  render(<DiscoveryDashboard />);
  fireEvent.click(screen.getByText(JOB_ID));
  expect(navigate).toHaveBeenCalledWith('/discovery?tab=jobs&jobId=a%26b%3Dc%20d');
  const target = navigate.mock.calls[0][0] as string;
  expect(new URLSearchParams(target.split('?')[1]).get('jobId')).toBe(JOB_ID);
});
