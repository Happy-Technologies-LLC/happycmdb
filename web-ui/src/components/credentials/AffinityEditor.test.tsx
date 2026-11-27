// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CredentialAffinity } from '@/services/credential.service';
import { AffinityEditor } from './AffinityEditor';

afterEach(cleanup);

const mount = (affinity: CredentialAffinity = {}) => {
  const onChange = vi.fn();
  render(<AffinityEditor affinity={affinity} onChange={onChange} />);
  return onChange;
};

describe('AffinityEditor list fields', () => {
  it('adds a trimmed network on Enter and on the add button, clearing the input', async () => {
    const user = userEvent.setup();
    const onChange = mount({ networks: ['10.0.0.0/8'], priority: 3 });
    const input = screen.getByLabelText('Network CIDRs');

    await user.type(input, '  192.168.1.0/24  {Enter}');
    expect(onChange).toHaveBeenLastCalledWith({
      networks: ['10.0.0.0/8', '192.168.1.0/24'],
      priority: 3,
    });
    expect(input).toHaveValue('');

    await user.type(input, '172.16.0.0/12');
    await user.click(screen.getByRole('button', { name: 'Add network CIDR' }));
    expect(onChange).toHaveBeenLastCalledWith({
      networks: ['10.0.0.0/8', '172.16.0.0/12'],
      priority: 3,
    });
  });

  it('ignores a blank entry and keeps a duplicate in the input without calling onChange', async () => {
    const user = userEvent.setup();
    const onChange = mount({ hostname_patterns: ['db-*'] });
    const input = screen.getByLabelText('Hostname Patterns');

    await user.type(input, '   {Enter}');
    await user.clear(input);
    await user.type(input, 'db-*{Enter}');

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('db-*');
  });

  it('removes one entry and leaves the others in order', async () => {
    const user = userEvent.setup();
    const onChange = mount({ hostname_patterns: ['a-*', 'b-*', 'c-*'] });
    const tag = screen.getByText('b-*').closest('span') as HTMLElement;

    await user.click(within(tag).getByRole('button', { name: 'Remove' }));

    expect(onChange).toHaveBeenCalledWith({ hostname_patterns: ['a-*', 'c-*'] });
  });
});

describe('AffinityEditor toggles', () => {
  it('shows the selected values as pressed and toggles a value on', async () => {
    const user = userEvent.setup();
    const onChange = mount({ environments: ['production'] });
    const group = screen.getByRole('group', { name: 'Environments' });

    expect(within(group).getByRole('button', { name: 'production' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'staging' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(within(group).getByRole('button', { name: 'staging' }));
    expect(onChange).toHaveBeenCalledWith({ environments: ['production', 'staging'] });
  });

  it('toggles a selected value off', async () => {
    const user = userEvent.setup();
    const onChange = mount({ os_types: ['linux', 'windows'] });
    const group = screen.getByRole('group', { name: 'Operating Systems' });

    await user.click(within(group).getByRole('button', { name: 'linux' }));

    expect(onChange).toHaveBeenCalledWith({ os_types: ['windows'] });
  });

  it('shows cloud providers upper-cased but stores them lower-case', async () => {
    const user = userEvent.setup();
    const onChange = mount({});

    await user.click(screen.getByRole('button', { name: 'AWS' }));

    expect(onChange).toHaveBeenCalledWith({ cloud_providers: ['aws'] });
  });

  it('keeps the device-type group separate from the operating-system group', async () => {
    const user = userEvent.setup();
    const onChange = mount({});

    await user.click(within(screen.getByRole('group', { name: 'Device Types' })).getByRole('button', { name: 'server' }));

    expect(onChange).toHaveBeenCalledWith({ device_types: ['server'] });
  });
});

describe('AffinityEditor priority', () => {
  it('shows 5 when no priority is set and reports the chosen number', () => {
    const onChange = mount({ networks: ['10.0.0.0/8'] });
    const slider = screen.getByLabelText('Priority');

    expect(slider).toHaveValue('5');
    fireEvent.change(slider, { target: { value: '8' } });

    expect(onChange).toHaveBeenCalledWith({ networks: ['10.0.0.0/8'], priority: 8 });
  });
});
