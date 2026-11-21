// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1922: the definition card on the design system keeps its write gates, its callbacks and its honest figures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const perm = vi.hoisted(() => ({ write: true }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => perm.write }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => toast }));

import DiscoveryDefinitionCard from './DiscoveryDefinitionCard';
import type { DiscoveryDefinition } from '../../services/discovery.service';

const def = (over: Partial<DiscoveryDefinition> = {}): DiscoveryDefinition => ({
  id: 'd1',
  name: 'lan sweep',
  provider: 'nmap',
  method: 'agentless',
  config: {},
  schedule: { enabled: false, cronExpression: '0 2 * * *' },
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const handlers = () => ({ onRun: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onToggleSchedule: vi.fn().mockResolvedValue(undefined) });

beforeEach(() => {
  perm.write = true;
  toast.showToast.mockClear();
});
afterEach(cleanup);

describe('DiscoveryDefinitionCard', () => {
  it('a viewer gets no run, edit, delete or schedule control, and still sees the schedule state', () => {
    perm.write = false;
    render(<DiscoveryDefinitionCard definition={def({ schedule: { enabled: true, cronExpression: '0 2 * * *' } })} {...handlers()} />);
    expect(screen.getByText('lan sweep')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('run and edit call the handlers with the id; run announces itself', () => {
    const h = handlers();
    render(<DiscoveryDefinitionCard definition={def()} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run Now' }));
    expect(h.onRun).toHaveBeenCalledWith('d1');
    expect(toast.showToast).toHaveBeenCalledWith('Running discovery for lan sweep...', 'info');
    fireEvent.click(screen.getByRole('button', { name: 'Edit lan sweep' }));
    expect(h.onEdit).toHaveBeenCalledWith('d1');
  });

  it('an inactive definition cannot be run, and the read-only grid shows no zero for a run that never happened', () => {
    const h = handlers();
    render(<DiscoveryDefinitionCard definition={def({ active: false })} {...h} />);
    const run = screen.getByRole('button', { name: 'Run Now' });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(h.onRun).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: 'Schedule for lan sweep' })).toBeDisabled();
    expect(screen.getByText('Never run')).toBeInTheDocument();
    expect(screen.queryByText(/^0m ago$/)).toBeNull();
  });

  it('delete asks first, then calls onDelete; cancel deletes nothing', () => {
    const h = handlers();
    render(<DiscoveryDefinitionCard definition={def()} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete lan sweep' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(h.onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete lan sweep' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(h.onDelete).toHaveBeenCalledWith('d1');
  });

  it('a schedule toggle calls onToggleSchedule and reports success', async () => {
    const h = handlers();
    render(<DiscoveryDefinitionCard definition={def()} {...h} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Schedule for lan sweep' }));
    expect(h.onToggleSchedule).toHaveBeenCalledWith('d1', true);
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Discovery schedule for lan sweep has been enabled.', 'success'));
    expect(screen.getByRole('switch', { name: 'Schedule for lan sweep' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a failed schedule toggle reverts the switch and reports the failure', async () => {
    const h = handlers();
    h.onToggleSchedule.mockRejectedValueOnce(new Error('boom'));
    render(<DiscoveryDefinitionCard definition={def()} {...h} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Schedule for lan sweep' }));
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Failed to toggle schedule', 'error'));
    expect(screen.getByRole('switch', { name: 'Schedule for lan sweep' })).toHaveAttribute('aria-checked', 'false');
  });
});
