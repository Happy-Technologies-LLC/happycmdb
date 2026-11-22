// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const service = vi.hoisted(() => ({ exportToCSV: vi.fn(), exportToJSON: vi.fn() }));
vi.mock('../../services/analytics.service', () => ({ analyticsService: service }));
vi.mock('../../utils/logger', () => ({ logClientError: vi.fn() }));

import { ExportButton } from './ExportButton';

const rows = [
  { ci_type: 'server', count: 3 },
  { ci_type: 'database', count: 0 },
];

beforeEach(() => {
  service.exportToCSV.mockReset().mockResolvedValue(undefined);
  service.exportToJSON.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

const choose = async (format: RegExp) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /export/i }));
  await user.click(screen.getByRole('menuitem', { name: format }));
};

describe('ExportButton', () => {
  it('exports the same rows as CSV under <filename>_<date>.csv', async () => {
    render(<ExportButton data={rows} filename="ci_status_breakdown" />);
    await choose(/csv/i);
    expect(service.exportToCSV).toHaveBeenCalledOnce();
    expect(service.exportToCSV).toHaveBeenCalledWith(rows, 'ci_status_breakdown_2026-11-19.csv');
    expect(service.exportToJSON).not.toHaveBeenCalled();
  });

  it('exports the same rows as JSON under <filename>_<date>.json', async () => {
    render(<ExportButton data={rows} filename="top_connected_cis" />);
    await choose(/json/i);
    expect(service.exportToJSON).toHaveBeenCalledOnce();
    expect(service.exportToJSON).toHaveBeenCalledWith(rows, 'top_connected_cis_2026-11-19.json');
    expect(service.exportToCSV).not.toHaveBeenCalled();
  });

  it('shows Exporting... and cannot be reopened while the export runs, then comes back', async () => {
    let finish: () => void = () => undefined;
    service.exportToCSV.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    render(<ExportButton data={rows} filename="x" />);
    await choose(/csv/i);

    const busy = await screen.findByRole('button', { name: /exporting/i });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    finish();
    expect(await screen.findByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('tells the user when the export fails, and recovers', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    service.exportToJSON.mockRejectedValue(new Error('disk full'));
    render(<ExportButton data={rows} filename="x" />);
    await choose(/json/i);
    expect(alert).toHaveBeenCalledWith('Export failed. Please try again.');
    expect(await screen.findByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('is disabled, with no menu, when told so', () => {
    render(<ExportButton data={rows} filename="x" disabled />);
    expect(screen.getByRole('button', { name: /export/i })).toBeDisabled();
  });
});
