// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResourceSelector } from './ResourceSelector';
import type { ConnectorResource } from '@/services/connector.service';

const RESOURCES: ConnectorResource[] = [
  {
    id: 'vpcs',
    name: 'VPCs',
    description: 'Virtual private clouds',
    ciType: 'network',
    enabledByDefault: true,
    operations: ['list', 'get'],
    configurationSchema: { region: { type: 'string' } },
    extraction: { incremental: true, batchSize: 50 },
  },
  {
    id: 'subnets',
    name: 'Subnets',
    enabledByDefault: false,
    operations: [],
    extraction: { incremental: false, dependsOn: ['vpcs'] },
  },
  {
    id: 'instances',
    name: 'Instances',
    enabledByDefault: false,
    operations: [],
  },
];

function Harness({
  initial = [],
  onChangeSpy,
  resources = RESOURCES,
}: {
  initial?: string[];
  onChangeSpy?: (resources: string[], configs: Record<string, any>) => void;
  resources?: ConnectorResource[];
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  const [configs, setConfigs] = useState<Record<string, any>>({});
  return (
    <ResourceSelector
      resources={resources}
      selectedResources={selected}
      resourceConfigs={configs}
      onChange={(next, nextConfigs) => {
        onChangeSpy?.(next, nextConfigs);
        setSelected(next);
        setConfigs(nextConfigs);
      }}
    />
  );
}

afterEach(cleanup);

describe('ResourceSelector', () => {
  it('selecting a resource with dependsOn also selects its dependency', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);

    expect(screen.getByText('0 / 3 selected')).toBeInTheDocument();
    // Subnets requires VPCs, which is unselected: the checkbox is locked.
    expect(screen.getByRole('checkbox', { name: 'Subnets' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'VPCs' }));
    expect(spy).toHaveBeenLastCalledWith(['vpcs'], {});
    expect(screen.getByText('1 / 3 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Subnets' }));
    expect(spy).toHaveBeenLastCalledWith(['vpcs', 'subnets'], {});
    expect(screen.getByText('2 / 3 selected')).toBeInTheDocument();
    expect(screen.getByText('Required by:')).toBeInTheDocument();
  });

  it('un-checking a resource removes its dependents', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={['vpcs', 'subnets', 'instances']} onChangeSpy={spy} />);
    expect(screen.getByText('3 / 3 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'VPCs' }));
    expect(spy).toHaveBeenLastCalledWith(['instances'], {});
    expect(screen.getByText('1 / 3 selected')).toBeInTheDocument();
  });

  it('locks a resource with an unselected dependency and names what it requires', () => {
    render(<Harness initial={['subnets']} />);
    expect(screen.getByRole('checkbox', { name: 'Subnets' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('This resource requires: VPCs');
    expect(screen.getByText('Depends on:')).toBeInTheDocument();
  });

  it('Clear all calls onChange([], {}) and is absent when nothing is selected', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={['vpcs']} onChangeSpy={spy} />);

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(spy).toHaveBeenCalledWith([], {});
    expect(screen.getByText('0 / 3 selected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('toggles the configuration block of an enabled resource with a schema', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['vpcs']} />);

    expect(screen.queryByText(/Configuration form for VPCs/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Configuration' }));
    expect(screen.getByText(/Configuration form for VPCs/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide Configuration' }));
    expect(screen.queryByText(/Configuration form for VPCs/)).not.toBeInTheDocument();
  });

  it('offers no configuration toggle for an unselected resource', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /Configuration/ })).not.toBeInTheDocument();
  });

  it('shows the loading state and no fabricated 0 / 0 count while loading', () => {
    render(
      <ResourceSelector
        resources={[]}
        selectedResources={[]}
        resourceConfigs={{}}
        onChange={vi.fn()}
        loading
      />
    );
    expect(screen.getByText('Loading connector resources…')).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 0 selected/)).not.toBeInTheDocument();
    expect(screen.queryByText(/of\s*0\s*resources selected/)).not.toBeInTheDocument();
  });

  it('shows an empty state instead of 0 / 0 when the connector lists no resources', () => {
    render(<Harness resources={[]} />);
    expect(screen.getByText('No resources available for this connector')).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 0 selected/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('shows a failure with Try again that calls onRetry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const error = Object.assign(new Error('Request failed with status code 500'), {
      response: { status: 500 },
    });
    render(
      <ResourceSelector
        resources={[]}
        selectedResources={[]}
        resourceConfigs={{}}
        onChange={vi.fn()}
        error={error}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Could not load connector resources')).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 0 selected/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the no-access state with the server reason and no retry on a 403', () => {
    const error = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { _message: 'Permission denied' } },
    });
    render(
      <ResourceSelector
        resources={[]}
        selectedResources={[]}
        resourceConfigs={{}}
        onChange={vi.fn()}
        error={error}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText('No access to connector resources')).toBeInTheDocument();
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('Loading connector resources…')).not.toBeInTheDocument();
  });
});
