// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateRangeSelector } from './DateRangeSelector';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('DateRangeSelector', () => {
  it('reports the preset range and marks the chosen preset as pressed', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DateRangeSelector onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Last 7 Days' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Last 90 Days' }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      startDate: '2026-08-21T12:00:00.000Z',
      endDate: '2026-11-19T12:00:00.000Z',
    });
    expect(screen.getByRole('button', { name: 'Last 90 Days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Last 7 Days' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports Today from local midnight', async () => {
    const onChange = vi.fn();
    render(<DateRangeSelector onChange={onChange} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Today' }));
    const midnight = new Date('2026-11-19T12:00:00.000Z');
    midnight.setHours(0, 0, 0, 0);
    expect(onChange).toHaveBeenCalledWith({
      startDate: midnight.toISOString(),
      endDate: '2026-11-19T12:00:00.000Z',
    });
  });

  it('applies a custom range only when both dates are set', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DateRangeSelector onChange={onChange} />);
    expect(screen.queryByLabelText('Start Date')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    await user.type(screen.getByLabelText('Start Date'), '2026-11-01');
    expect(apply).toBeDisabled();
    await user.type(screen.getByLabelText('End Date'), '2026-11-15');
    expect(apply).toBeEnabled();

    await user.click(apply);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      startDate: new Date('2026-11-01').toISOString(),
      endDate: new Date('2026-11-15').toISOString(),
    });
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
  });
});
