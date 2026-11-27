// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsPanel, MetricCard } from './MetricCard';

afterEach(cleanup);

describe('MetricCard value', () => {
  it('renders a real zero as 0 and a missing or non-finite figure as unavailable', () => {
    render(
      <>
        <MetricCard title="Zero" value={0} />
        <MetricCard title="Null" value={null} />
        <MetricCard title="Undefined" value={undefined} />
        <MetricCard title="NaN" value={Number.NaN} />
      </>,
    );
    const cardOf = (title: string) => screen.getByText(title).closest('[data-metric-value], .h-full') as HTMLElement;
    expect(cardOf('Zero')).toHaveTextContent('0');
    expect(cardOf('Zero')).not.toHaveTextContent('Not available yet');
    for (const title of ['Null', 'Undefined', 'NaN']) {
      expect(cardOf(title)).toHaveTextContent('Not available yet');
      expect(cardOf(title).textContent).not.toMatch(/(^|\D)0(\D|$)/);
    }
  });

  it('groups thousands and keeps a text value as given', () => {
    render(
      <>
        <MetricCard title="Big" value={12345} />
        <MetricCard title="When" value="11/19/2026" />
      </>,
    );
    expect(screen.getByText((12345).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText('11/19/2026')).toBeInTheDocument();
  });

  it('hides the value while loading', () => {
    render(<MetricCard title="Total" value={42} loading />);
    expect(screen.getByText('42')).not.toBeVisible();
  });

  it('shows a trend as a percentage next to the value', () => {
    render(<MetricCard title="Active" value={9} trend={{ value: -12.34, direction: 'down', isPositive: false }} />);
    expect(screen.getByText('12.3%')).toBeInTheDocument();
  });
});

describe('MetricCard press', () => {
  it('is a button that Enter and Space activate when it has a handler, and plain text otherwise', async () => {
    const onPress = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<MetricCard title="Open" value={1} onPress={onPress} />);
    const button = screen.getByRole('button');
    await user.click(button);
    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onPress).toHaveBeenCalledTimes(3);

    rerender(<MetricCard title="Open" value={1} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('AnalyticsPanel', () => {
  const body = vi.fn(() => <p>the chart</p>);
  const panel = (props: Partial<React.ComponentProps<typeof AnalyticsPanel>> = {}) =>
    render(
      <AnalyticsPanel title="Things" actions={<button type="button">Export now</button>} {...props}>
        {body}
      </AnalyticsPanel>,
    );

  it('renders the body and the actions only once the read has data', () => {
    panel();
    expect(screen.getByRole('heading', { name: 'Things' })).toBeInTheDocument();
    expect(screen.getByText('the chart')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export now' })).toBeInTheDocument();
  });

  it('while loading says so, and builds neither the body nor the actions', () => {
    body.mockClear();
    panel({ loading: true });
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(body).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Export now' })).toBeNull();
  });

  it('on a failure shows the error and retries on request, with no body and no actions', async () => {
    body.mockClear();
    const onRetry = vi.fn();
    panel({ error: new Error('database is down'), onRetry });
    expect(screen.getByText('Failed to load data')).toBeInTheDocument();
    expect(screen.getByText('database is down')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Export now' })).toBeNull();
  });

  it('on a refused read (403) says it is not permitted and offers no retry', () => {
    const refused = Object.assign(new Error('Request failed'), {
      response: { status: 403, data: { _message: "Permission 'read' required" } },
    });
    panel({ error: refused, onRetry: vi.fn() });
    expect(screen.getByText('Failed to load data')).toBeInTheDocument();
    expect(screen.getByText(/Not permitted\./)).toHaveTextContent("Permission 'read' required");
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the empty label instead of a chart for an empty read', () => {
    body.mockClear();
    panel({ empty: true, emptyLabel: 'No changes in selected period' });
    expect(screen.getByText('No changes in selected period')).toBeInTheDocument();
    expect(body).not.toHaveBeenCalled();
  });
});
