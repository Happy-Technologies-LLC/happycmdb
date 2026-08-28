// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/tests/utils/test-utils';

const { apiClient } = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../lib/api-client', () => ({ apiClient }));

import BusinessServices from './BusinessServices';

// Backend rows always use the real REST envelope: {success, data, pagination}
// for list reads and {success, data} for single-record writes. These tests
// guard against api-client's Axios-only unwrap leaking the raw envelope into
// mapAPIToUI, which previously produced undefined-field crashes.
const apiService = {
  service_id: 'bs-portal',
  name: 'Customer Portal',
  description: 'Public customer portal',
  service_classification: 'application',
  tbm_tower: 'application',
  business_criticality: 'tier_1',
  operational_status: 'active',
  owned_by: 'Platform Team',
  metadata: {
    revenue_impact: 500000,
    user_count: 12000,
    supporting_cis: 4,
    monthly_cost: 8200,
  },
};

describe('BusinessServices page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unwraps the {success,data,pagination} list envelope when loading services', async () => {
    apiClient.get.mockResolvedValue({
      success: true,
      data: [apiService],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
    });

    render(<BusinessServices />);
    const row = (await screen.findByText('Customer Portal')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Tier 1')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('$500,000')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('12,000')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/business-services');
    expect(screen.queryByText('No services found')).not.toBeInTheDocument();
  });

  it('unwraps the {success,data} envelope when creating a service', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue({ success: true, data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } });
    apiClient.post.mockResolvedValue({
      success: true,
      data: {
        ...apiService,
        service_id: 'bs-new-service',
        name: 'New Service',
        business_criticality: 'tier_2',
      },
    });

    render(<BusinessServices />);
    await screen.findByText('No services found');

    await user.click(screen.getByRole('button', { name: /create service/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/service name/i), 'New Service');
    await user.click(within(dialog).getByRole('button', { name: /create service/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/business-services', expect.any(Object)));

    // Rendered row must reflect the server's response envelope (tier 2 from
    // the mocked response), not just the locally-typed form data.
    expect(await screen.findByText('New Service')).toBeInTheDocument();
    expect(screen.getByText('Tier 2')).toBeInTheDocument();
    expect(screen.queryByText('No services found')).not.toBeInTheDocument();
  });

  it('unwraps the {success,data} envelope when editing a service', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue({
      success: true,
      data: [apiService],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
    });
    apiClient.patch.mockResolvedValue({
      success: true,
      data: {
        ...apiService,
        name: 'Customer Portal V2',
        business_criticality: 'tier_3',
        operational_status: 'inactive',
      },
    });

    render(<BusinessServices />);
    const row = (await screen.findByText('Customer Portal')).closest('tr');
    expect(row).not.toBeNull();

    const [editButton] = within(row as HTMLElement).getAllByRole('button');
    await user.click(editButton);

    const dialog = await screen.findByRole('dialog');
    const nameInput = within(dialog).getByLabelText(/service name/i);
    expect(nameInput).toHaveValue('Customer Portal');

    await user.clear(nameInput);
    await user.type(nameInput, 'Customer Portal V2');
    await user.click(within(dialog).getByRole('button', { name: /update service/i }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith('/business-services/bs-portal', expect.any(Object))
    );

    // The updated row must reflect the server response (tier 3, inactive),
    // proving mapAPIToUI ran against updatedService.data, not the raw envelope.
    expect(await screen.findByText('Customer Portal V2')).toBeInTheDocument();
    expect(screen.getByText('Tier 3')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
  });
});
