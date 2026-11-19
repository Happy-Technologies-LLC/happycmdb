// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1922: the definition list on the design system keeps its write gates, its callbacks and its honest states.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const perm = vi.hoisted(() => ({ write: true }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => perm.write }));
vi.mock('../../hooks/useCredentials', () => ({
  useCredentials: () => ({ credentials: [], loading: false, error: null, loadCredentials: vi.fn() }),
}));

import DiscoveryDefinitionList from './DiscoveryDefinitionList';
import type { DiscoveryDefinition } from '../../services/discovery.service';

const def = (over: Partial<DiscoveryDefinition> = {}): DiscoveryDefinition => ({
  id: 'd1',
  name: 'lan sweep',
  description: 'nightly',
  provider: 'nmap',
  method: 'agentless',
  config: { targets: ['10.0.0.0/24'] },
  schedule: { enabled: false, cronExpression: '0 2 * * *' },
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const handlers = () => ({
  onCreateDefinition: vi.fn().mockResolvedValue(undefined),
  onUpdateDefinition: vi.fn().mockResolvedValue(undefined),
  onDeleteDefinition: vi.fn().mockResolvedValue(undefined),
  onRunDefinition: vi.fn().mockResolvedValue(undefined),
  onToggleSchedule: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  perm.write = true;
});
afterEach(cleanup);

describe('DiscoveryDefinitionList states', () => {
  it('a pending first load shows neither the empty copy nor a "0 of 0" count', () => {
    render(<DiscoveryDefinitionList definitions={[]} loading {...handlers()} />);
    expect(screen.queryByText(/no discovery definitions/i)).toBeNull();
    expect(screen.queryByText(/of 0 definitions/i)).toBeNull();
  });

  it('a settled empty list says so', () => {
    render(<DiscoveryDefinitionList definitions={[]} loading={false} {...handlers()} />);
    expect(screen.getByText('No discovery definitions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create definition/i })).toBeInTheDocument();
  });

  it('a failed read with nothing loaded shows the error and a retry, never "no definitions" or a count', () => {
    const onRetry = vi.fn();
    render(<DiscoveryDefinitionList definitions={[]} loading={false} error="Failed to load discovery definitions" onRetry={onRetry} {...handlers()} />);
    expect(screen.getByText('Could not load discovery definitions')).toBeInTheDocument();
    expect(screen.getByText('Failed to load discovery definitions')).toBeInTheDocument();
    expect(screen.queryByText(/no discovery definitions/i)).toBeNull();
    expect(screen.queryByText(/of 0 definitions/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps the rows already loaded and offers a retry', () => {
    const onRetry = vi.fn();
    render(<DiscoveryDefinitionList definitions={[def()]} loading={false} error="Failed to load discovery definitions" onRetry={onRetry} {...handlers()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load discovery definitions');
    expect(screen.getByText('lan sweep')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a refused read shows the server reason as "not permitted" with no retry', () => {
    render(<DiscoveryDefinitionList definitions={[]} loading={false} error="Failed to load discovery definitions" forbiddenReason="Permission 'read' required" onRetry={vi.fn()} {...handlers()} />);
    expect(screen.getByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText("Permission 'read' required")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('shows the count of filtered rows and narrows by search', () => {
    render(<DiscoveryDefinitionList definitions={[def(), def({ id: 'd2', name: 'dc scan', provider: 'ssh' })]} loading={false} {...handlers()} />);
    expect(screen.getByText('2 of 2 definitions')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search definitions'), { target: { value: 'dc' } });
    expect(screen.queryByText('lan sweep')).toBeNull();
    expect(screen.getByText('1 of 2 definitions')).toBeInTheDocument();
  });
});

describe('DiscoveryDefinitionList write gating', () => {
  it('a viewer gets no create, run, edit, delete or schedule control, and still sees the schedule state', () => {
    perm.write = false;
    render(<DiscoveryDefinitionList definitions={[def({ schedule: { enabled: true, cronExpression: '0 2 * * *' } })]} loading={false} {...handlers()} />);
    expect(screen.getByText('lan sweep')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create definition|run|edit|delete/i })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('a viewer on an empty list is not told to create one', () => {
    perm.write = false;
    render(<DiscoveryDefinitionList definitions={[]} loading={false} {...handlers()} />);
    expect(screen.getByText('No discovery definitions found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create definition/i })).toBeNull();
  });
});

describe('DiscoveryDefinitionList actions', () => {
  it('run, schedule toggle and delete call the handlers with the definition id', async () => {
    const h = handlers();
    render(<DiscoveryDefinitionList definitions={[def()]} loading={false} {...h} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run lan sweep' }));
    expect(h.onRunDefinition).toHaveBeenCalledWith('d1');

    fireEvent.click(screen.getByRole('switch', { name: 'Schedule for lan sweep' }));
    expect(h.onToggleSchedule).toHaveBeenCalledWith('d1', true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete lan sweep' }));
    expect(h.onDeleteDefinition).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Are you sure you want to delete "lan sweep"?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.onDeleteDefinition).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancelling the delete confirmation deletes nothing', () => {
    const h = handlers();
    render(<DiscoveryDefinitionList definitions={[def()]} loading={false} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete lan sweep' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(h.onDeleteDefinition).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('edit and create submit through the update and create handlers and close their dialogs', async () => {
    const h = handlers();
    render(<DiscoveryDefinitionList definitions={[def()]} loading={false} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit lan sweep' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Discovery Definition' });
    const name = within(dialog).getByLabelText(/^name/i) as HTMLInputElement;
    expect(name.value).toBe('lan sweep');
    fireEvent.change(name, { target: { value: 'lan sweep 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /update definition/i }));
    await waitFor(() => expect(h.onUpdateDefinition).toHaveBeenCalledTimes(1));
    expect(h.onUpdateDefinition.mock.calls[0][0]).toBe('d1');
    expect(h.onUpdateDefinition.mock.calls[0][1]).toEqual(expect.objectContaining({ name: 'lan sweep 2' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /create definition/i }));
    const create = screen.getByRole('dialog', { name: 'Create Discovery Definition' });
    fireEvent.change(within(create).getByLabelText(/^name/i), { target: { value: 'dmz' } });
    fireEvent.change(within(create).getByLabelText(/target/i), { target: { value: '192.0.2.0/24' } });
    fireEvent.click(within(create).getByRole('button', { name: /create definition/i }));
    await waitFor(() => expect(h.onCreateDefinition).toHaveBeenCalledTimes(1));
    expect(h.onCreateDefinition.mock.calls[0][0]).toEqual(expect.objectContaining({ name: 'dmz', provider: 'nmap' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
