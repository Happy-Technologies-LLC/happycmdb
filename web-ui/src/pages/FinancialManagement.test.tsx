// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/tests/utils/test-utils';

const { exportData, auth } = vi.hoisted(() => ({
  exportData: vi.fn(),
  auth: { role: 'operator' },
}));

vi.mock('../hooks/useDashboardData', () => ({ useExportDashboard: () => ({ exportData }) }));
vi.mock('@contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@contexts/AuthContext')>()),
  useAuth: () => ({ user: { role: auth.role } }),
}));

import FinancialManagement from './FinancialManagement';

const WRITE_VERBS = /\b(create|add|edit|delete|remove|save|update|approve|submit)\b/i;

describe('FinancialManagement page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.role = 'operator';
  });

  it('shows the headline TBM figures', () => {
    render(<FinancialManagement />);

    expect(screen.getByRole('heading', { level: 1, name: 'Financial Management' })).toBeInTheDocument();
    // Tower costs total $125,500 against the $100,000 budget; the savings opportunities total $29,100.
    expect(screen.getByText('$125,500')).toBeInTheDocument();
    expect(screen.getByText('125.5%')).toBeInTheDocument();
    expect(screen.getByText('$29,100')).toBeInTheDocument();
    expect(screen.getByText('$45.20')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /budget utilization/i })).toBeInTheDocument();
  });

  it('switches between the four views as tabs and shows each one\'s content', async () => {
    const user = userEvent.setup();
    render(<FinancialManagement />);

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Overview', 'Cost by Tower', 'Service Costs', 'Optimization']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Cost Trends' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Cost by Tower' }));
    expect(screen.getByRole('heading', { name: 'TBM Resource Tower Breakdown' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cost Trends' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Service Costs' }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Business Service', 'Monthly Cost', 'Supporting CIs', 'Users', 'Cost/User', 'Trend',
    ]);
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);

    await user.click(screen.getByRole('tab', { name: 'Optimization' }));
    expect(screen.getByRole('heading', { name: /cost optimization opportunities/i })).toBeInTheDocument();
    expect(screen.getByText('Total Potential Savings: $29,100')).toBeInTheDocument();
  });

  it('exports the report for the default six-month range with the page totals', async () => {
    const user = userEvent.setup();
    render(<FinancialManagement />);

    await user.click(screen.getByRole('button', { name: /export report/i }));

    expect(exportData).toHaveBeenCalledTimes(1);
    const [report, payload] = exportData.mock.calls[0];
    expect(report).toBe('financial-management');
    expect(payload.timeRange).toBe('6m');
    expect(payload.summary.totalMonthlyCost).toBe(125500);
    expect(payload.summary.budgetUtilization).toBeCloseTo(125.5, 6);
    expect(payload.summary.totalPotentialSavings).toBe(29100);
  });

  it('exports for the time range that was chosen', async () => {
    const user = userEvent.setup();
    render(<FinancialManagement />);

    const range = screen.getByRole('combobox', { name: /time range/i });
    expect(range).toHaveTextContent('Last 6 Months');
    await user.click(range);
    await user.click(await screen.findByRole('option', { name: 'Last 12 Months' }));
    expect(range).toHaveTextContent('Last 12 Months');
    await user.click(screen.getByRole('button', { name: /export report/i }));

    expect(exportData).toHaveBeenCalledWith('financial-management', expect.objectContaining({ timeRange: '12m' }));
  });

  it.each(['viewer', 'operator', 'admin'])('offers a %s no write control on any view', async (role) => {
    auth.role = role;
    const user = userEvent.setup();
    render(<FinancialManagement />);

    for (const name of ['Overview', 'Cost by Tower', 'Service Costs', 'Optimization']) {
      await user.click(screen.getByRole('tab', { name }));
      const writes = screen.queryAllByRole('button').filter((button) => WRITE_VERBS.test(button.textContent ?? ''));
      expect(writes, `write control on ${name}`).toEqual([]);
    }
  });
});
