// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
// jsdom implements neither the Pointer Events capture API nor scrollIntoView,
// both of which Radix UI's Select uses internally.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
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

// Backend rows use the real REST envelope ({success, data, pagination} for
// lists, {success, data} for writes) and the canonical business_criticality
// enum accepted by business-service.routes.ts: critical|high|medium|low.
const apiService = {
  service_id: 'bs-portal',
  name: 'Customer Portal',
  description: 'Public customer portal',
  service_classification: 'application',
  tbm_tower: 'application',
  business_criticality: 'critical',
  operational_status: 'active',
  owned_by: 'Platform Team',
  metadata: {
    revenue_impact: 500000,
    user_count: 12000,
    supporting_cis: 4,
    monthly_cost: 8200,
  },
};

const row = (overrides: Record<string, unknown>) => ({ ...apiService, ...overrides });

const listOf = (data: unknown[]) => ({
  success: true,
  data,
  pagination: { page: 1, limit: 50, total: data.length, totalPages: 1 },
});

const rowFor = async (name: string) => {
  const tr = (await screen.findByText(name)).closest('tr');
  expect(tr).not.toBeNull();
  return tr as HTMLElement;
};

const choose = async (user: UserEvent, trigger: HTMLElement, label: string) => {
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: label }));
};

describe('BusinessServices page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders each canonical criticality distinctly and non-canonical values as Unknown', async () => {
    apiClient.get.mockResolvedValue(
      listOf([
        row({ service_id: 'bs-c', name: 'Svc Critical', business_criticality: 'critical' }),
        row({ service_id: 'bs-h', name: 'Svc High', business_criticality: 'high' }),
        row({ service_id: 'bs-m', name: 'Svc Medium', business_criticality: 'medium' }),
        row({ service_id: 'bs-l', name: 'Svc Low', business_criticality: 'low' }),
        row({ service_id: 'bs-x', name: 'Svc Legacy', business_criticality: 'tier_1' }),
      ])
    );

    render(<BusinessServices />);

    expect(within(await rowFor('Svc Critical')).getByText('Critical')).toBeInTheDocument();
    expect(within(await rowFor('Svc High')).getByText('High')).toBeInTheDocument();
    expect(within(await rowFor('Svc Medium')).getByText('Medium')).toBeInTheDocument();
    expect(within(await rowFor('Svc Low')).getByText('Low')).toBeInTheDocument();
    expect(within(await rowFor('Svc Legacy')).getByText('Unknown')).toBeInTheDocument();
    expect(within(await rowFor('Svc Critical')).getByText('$500,000')).toBeInTheDocument();
  });

  it('filters rows by canonical criticality', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue(
      listOf([
        row({ service_id: 'bs-c', name: 'Svc Critical', business_criticality: 'critical' }),
        row({ service_id: 'bs-l', name: 'Svc Low', business_criticality: 'low' }),
      ])
    );

    render(<BusinessServices />);
    await rowFor('Svc Low');

    await choose(user, screen.getByRole('combobox', { name: /filter by criticality/i }), 'Critical');

    expect(screen.getByText('Svc Critical')).toBeInTheDocument();
    expect(screen.queryByText('Svc Low')).not.toBeInTheDocument();
  });

  it('requires an explicit criticality on create and sends the canonical value', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue(listOf([]));
    apiClient.post.mockResolvedValue({
      success: true,
      data: row({ service_id: 'bs-new-service', name: 'New Service', business_criticality: 'high' }),
    });

    render(<BusinessServices />);
    await screen.findByText('No services found');

    await user.click(screen.getByRole('button', { name: /create service/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/service name/i), 'New Service');

    const submit = within(dialog).getByRole('button', { name: /create service/i });
    expect(submit).toBeDisabled();

    await choose(user, within(dialog).getByRole('combobox', { name: /^criticality$/i }), 'High');
    await user.click(submit);

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        '/business-services',
        expect.objectContaining({ name: 'New Service', business_criticality: 'high' })
      )
    );
    const created = await rowFor('New Service');
    expect(within(created).getByText('High')).toBeInTheDocument();
  });

  it('starts editing at the stored criticality and sends the changed canonical value', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue(listOf([apiService]));
    apiClient.patch.mockResolvedValue({
      success: true,
      data: row({ name: 'Customer Portal V2', business_criticality: 'low', operational_status: 'inactive' }),
    });

    render(<BusinessServices />);
    const [editButton] = within(await rowFor('Customer Portal')).getAllByRole('button');
    await user.click(editButton);

    const dialog = await screen.findByRole('dialog');
    const trigger = within(dialog).getByRole('combobox', { name: /^criticality$/i });
    expect(trigger).toHaveTextContent('Critical');

    const nameInput = within(dialog).getByLabelText(/service name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Customer Portal V2');
    await choose(user, trigger, 'Low');
    await user.click(within(dialog).getByRole('button', { name: /update service/i }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/business-services/bs-portal',
        expect.objectContaining({ business_criticality: 'low' })
      )
    );
    const updated = await rowFor('Customer Portal V2');
    expect(within(updated).getByText('Low')).toBeInTheDocument();
    expect(within(updated).getByText('inactive')).toBeInTheDocument();
  });

  it('requires an explicit selection before saving a row with unknown criticality', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue(listOf([row({ business_criticality: 'tier_3' })]));

    render(<BusinessServices />);
    const [editButton] = within(await rowFor('Customer Portal')).getAllByRole('button');
    await user.click(editButton);

    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: /update service/i });
    expect(submit).toBeDisabled();

    await choose(user, within(dialog).getByRole('combobox', { name: /^criticality$/i }), 'Medium');
    expect(submit).toBeEnabled();
  });

  it('keeps the form and current row when the server rejects the write', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue(listOf([apiService]));
    // Exact 400 body emitted by validateRequest (validation.middleware.ts) when
    // updateBusinessServiceSchema rejects name.min(3). The page reads only
    // `error`, so it shows its generic fallback for this underscored envelope.
    apiClient.patch.mockRejectedValue({
      response: {
        status: 400,
        data: {
          _success: false,
          _error: 'Validation Error',
          _message: '"name" length must be at least 3 characters long',
          _details: [
            {
              _field: 'name',
              _message: '"name" length must be at least 3 characters long',
              _type: 'string.min',
            },
          ],
        },
      },
    });

    render(<BusinessServices />);
    const [editButton] = within(await rowFor('Customer Portal')).getAllByRole('button');
    await user.click(editButton);

    const dialog = await screen.findByRole('dialog');
    const nameInput = within(dialog).getByLabelText(/service name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'No');
    await user.click(within(dialog).getByRole('button', { name: /update service/i }));

    expect(await screen.findByText('Failed to save business service')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByLabelText(/service name/i)).toHaveValue('No');
    expect(screen.queryByText('Business service updated successfully')).not.toBeInTheDocument();
    expect(within(await rowFor('Customer Portal')).getByText('Critical')).toBeInTheDocument();
  });
});
