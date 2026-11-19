// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AIDiscoverySession } from '@/services/ai-pattern.service';
import { EMPTY_VALUE } from '@/lib/dashboardValue';
import { SessionDetailModal } from './SessionDetailModal';

afterEach(cleanup);

const session = (overrides: Partial<AIDiscoverySession> = {}): AIDiscoverySession => ({
  sessionId: 'sess-77',
  targetHost: 'db.internal',
  targetPort: 5432,
  status: 'completed',
  toolCalls: [
    { toolName: 'nmap_scan', input: { host: 'db.internal' }, output: { open: [5432] }, executionTime: 250, timestamp: '2026-10-01T10:00:00Z', success: true },
  ],
  discoveredCIs: [{ name: 'orders-db', _type: 'database' }],
  confidenceScore: 0.87,
  estimatedCost: 0.0123,
  totalTokens: 1500,
  promptTokens: 1000,
  completionTokens: 500,
  aiReasoning: 'Port 5432 answered like Postgres',
  startedAt: '2026-10-01T10:00:00Z',
  completedAt: '2026-10-01T10:00:04Z',
  durationMs: 4200,
  aiModel: 'claude-sonnet-4',
  retryCount: 0,
  ...overrides,
});

function Harness({ value }: { value: AIDiscoverySession }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open session</button>
      <SessionDetailModal session={value} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

const openDialog = async (value: AIDiscoverySession) => {
  const user = userEvent.setup();
  render(<Harness value={value} />);
  await user.click(screen.getByRole('button', { name: 'Open session' }));
  return { user, dialog: await screen.findByRole('dialog') };
};

describe('SessionDetailModal', () => {
  it('opens as a dialog with one Close control, shows the session on its tabs, closes on Escape and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<Harness value={session()} />);
    const trigger = screen.getByRole('button', { name: 'Open session' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('sess-77')).toBeInTheDocument();
    expect(within(dialog).getByText('db.internal:5432')).toBeInTheDocument();
    expect(within(dialog).getByText('claude-sonnet-4')).toBeInTheDocument();
    expect(within(dialog).getByText('87%')).toBeInTheDocument();
    expect(within(dialog).getByText('$0.0123')).toBeInTheDocument();
    expect(within(dialog).getByText('1,500')).toBeInTheDocument();
    expect(within(dialog).getByText('4.2s')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(1);

    await user.click(within(dialog).getByRole('tab', { name: 'Tool Calls' }));
    expect(within(dialog).getByText('nmap_scan')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('tab', { name: 'Results' }));
    expect(within(dialog).getByText('orders-db')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('tab', { name: 'AI Reasoning' }));
    expect(within(dialog).getByText('Port 5432 answered like Postgres')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('reads a session with no cost, confidence or tokens as unavailable, never as 0, and a real $0.0000 and 0 tokens as they are', async () => {
    const { dialog } = await openDialog(
      session({ confidenceScore: undefined, estimatedCost: undefined, totalTokens: undefined, promptTokens: undefined, completionTokens: undefined }),
    );
    expect(within(dialog).getByText('Cost (not available yet)')).toBeInTheDocument();
    expect(within(dialog).getByText('Confidence (not available yet)')).toBeInTheDocument();
    expect(within(dialog).queryByText('$0.0000')).toBeNull();
    expect(within(dialog).queryByText('0%')).toBeNull();
    expect(within(dialog).getByText('Total').nextElementSibling).toHaveTextContent(EMPTY_VALUE);

    cleanup();
    const zero = await openDialog(session({ estimatedCost: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 }));
    expect(within(zero.dialog).getByText('$0.0000')).toBeInTheDocument();
    expect(within(zero.dialog).getByText('Total').nextElementSibling).toHaveTextContent('0');
    expect(within(zero.dialog).queryByText(/not available yet/)).toBeNull();
  });
});
