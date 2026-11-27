// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AIPattern } from '@/services/ai-pattern.service';
import { EMPTY_VALUE } from '@/lib/dashboardValue';
import { PatternDetailModal } from './PatternDetailModal';

afterEach(cleanup);

const pattern = (overrides: Partial<AIPattern> = {}): AIPattern => ({
  patternId: 'pat-42',
  name: 'Redis Cluster',
  category: 'database',
  description: 'Finds Redis cluster nodes',
  detectionCode: 'function detect() { return "redis-marker"; }',
  discoveryCode: 'async function discover() { return "discover-marker"; }',
  author: 'pattern-compiler',
  confidenceScore: 0.93,
  status: 'active',
  isActive: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  usageCount: 10,
  successCount: 8,
  failureCount: 2,
  avgExecutionTimeMs: 120,
  learnedFromSessions: ['s1', 's2'],
  testCases: [{ name: 'matches a cluster', input: { host: 'redis-1' }, expectedMatch: true, expectedConfidence: 0.9 }],
  ...overrides,
});

function Harness({ value }: { value: AIPattern }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open pattern</button>
      <PatternDetailModal pattern={value} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe('PatternDetailModal', () => {
  it('opens as a dialog with one Close control, shows the pattern on its tabs, closes on Escape or Close and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<Harness value={pattern()} />);
    const trigger = screen.getByRole('button', { name: 'Open pattern' });
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Redis Cluster')).toBeInTheDocument();
    expect(within(dialog).getByText('Finds Redis cluster nodes')).toBeInTheDocument();
    expect(within(dialog).getByText('2 discovery sessions')).toBeInTheDocument();
    expect(within(dialog).getByText('80%')).toBeInTheDocument();
    expect(within(dialog).getByText('120ms')).toBeInTheDocument();
    // One way out, not an icon and a footer button that both read "Close".
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(1);

    await user.click(within(dialog).getByRole('tab', { name: 'Detection' }));
    expect(within(dialog).getByText(/redis-marker/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('tab', { name: 'Discovery' }));
    expect(within(dialog).getByText(/discover-marker/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('tab', { name: 'Tests' }));
    expect(within(dialog).getByText('matches a cluster')).toBeInTheDocument();
    expect(within(dialog).getByText('Should Match')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('reads a never-used pattern with no timing as unavailable, not 0% and 0ms, and a real 0ms as 0ms', async () => {
    const user = userEvent.setup();
    render(
      <Harness value={pattern({ usageCount: 0, successCount: 0, failureCount: 0, avgExecutionTimeMs: undefined })} />,
    );
    await user.click(screen.getByRole('button', { name: 'Open pattern' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('0%')).toBeNull();
    expect(within(dialog).queryByText('0ms')).toBeNull();
    expect(within(dialog).getByText('Success Rate').parentElement).toHaveTextContent(EMPTY_VALUE);
    expect(within(dialog).getByText('Avg Execution Time').parentElement).toHaveTextContent(EMPTY_VALUE);

    cleanup();
    render(<Harness value={pattern({ avgExecutionTimeMs: 0 })} />);
    await user.click(screen.getByRole('button', { name: 'Open pattern' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('0ms')).toBeInTheDocument();
  });
});
