// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1826: the Setup Guide must not tell operators to advertise a capability the happycmdb/agent image cannot serve
// (it ships no nmap), in either the shell or the `docker run` snippet.
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import axios from 'axios';
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null, Eyebrow: () => null }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => true }));
// No real network: the dashboard's stats and list requests end here with an empty fleet.
axios.defaults.adapter = async (config) => ({ data: { success: true, data: [] }, status: 200, statusText: 'OK', headers: {}, config });
// apiClient copies axios.defaults (adapter included) when its module loads, so the view loads after the adapter is set.
const { AgentDashboard } = await import('./AgentDashboard');

it('the Setup Guide advertises no nmap capability in the shell or docker snippet (HAP-1826)', () => {
  render(<AgentDashboard />);
  fireEvent.mouseDown(screen.getByRole('tab', { name: /Setup Guide/ }), { button: 0 });
  const advertised = screen.getAllByText(/CMDB_CAPABILITIES=/).map((el) => /CMDB_CAPABILITIES=([^\s\\]*)/.exec(el.textContent ?? '')![1]);
  expect(advertised).toHaveLength(2); // the shell export and the docker run flag
  for (const value of advertised) {
    expect(value.split(',')).not.toContain('nmap');
    expect(value).not.toBe('');
  }
});
