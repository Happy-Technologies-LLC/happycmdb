// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { Toaster } from 'sonner';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { render } from '@/tests/utils/test-utils';

const { apiClient, real, auth } = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  // `real.on` routes reads through the real api-client (its interceptors report a 403 to the shell).
  real: { on: false },
  // These screens gate their write controls on the signed-in server role (HAP-1252 S1): operator writes, viewer only reads.
  auth: { role: 'operator' },
}));

vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>();
  return {
    apiClient: {
      ...apiClient,
      get: (...args: Parameters<typeof apiClient.get>) =>
        real.on ? actual.apiClient.get(args[0], args[1]) : apiClient.get(...args),
    },
  };
});

import BusinessServices from './BusinessServices';
import { ForbiddenHost } from '../components/layout/ForbiddenHost';
import { EMPTY_VALUE } from '../lib/dashboardValue';
vi.mock('@contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@contexts/AuthContext')>()),
  useAuth: () => ({ user: { role: auth.role } }),
}));

// Backend rows use the real REST envelope ({success, items, next_cursor, as_of}
// for the C1 list, {success, data} for writes) and the canonical business_criticality
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

const listOf = (items: unknown[]) => ({
  success: true,
  items,
  next_cursor: null,
  as_of: '2026-11-05T00:00:00.000Z',
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
    expect(apiClient.post.mock.calls[0]?.[1]).not.toHaveProperty('service_id');
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

    // test-utils provides ToastProvider but not the Toaster that App.tsx mounts,
    // so mount it here to observe the error toast the user actually sees.
    render(
      <>
        <BusinessServices />
        <Toaster />
      </>
    );
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

  it('HAP-1424: lists a service\'s offerings, adds one, and retires one with If-Match on its version', async () => {
    const user = userEvent.setup();
    const offering = {
      offering_id: 'so-1', service_id: 'bs-portal', tenant_id: 'org-1', name: 'Password reset', description: null,
      audience: 'internal', lifecycle: 'planned', service_level: {}, version: 2, updated_at: '2026-11-05T10:00:00.000Z',
    };
    apiClient.get.mockImplementation(async (url: string) =>
      url === '/business-services/bs-portal/offerings' ? { success: true, data: [offering] } : listOf([apiService]));
    apiClient.post.mockResolvedValue({
      success: true, data: { ...offering, offering_id: 'so-2', name: 'Laptop request', audience: 'customer', version: 1 },
    });
    apiClient.patch.mockResolvedValue({ success: true, data: { ...offering, lifecycle: 'retired', version: 3 } });

    render(<BusinessServices />);
    await user.click(within(await rowFor('Customer Portal')).getByRole('button', { name: /offerings/i }));
    const dialog = await screen.findByRole('dialog');
    const listed = (await within(dialog).findByText('Password reset')).closest('li') as HTMLElement;

    await user.type(within(dialog).getByLabelText(/offering name/i), 'Laptop request');
    await choose(user, within(dialog).getByRole('combobox', { name: /^audience$/i }), 'Customer');
    await user.type(within(dialog).getByLabelText(/availability target/i), '99.5');
    await user.click(within(dialog).getByRole('button', { name: /add offering/i }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/business-services/bs-portal/offerings', {
      name: 'Laptop request', description: '', audience: 'customer', lifecycle: 'planned',
      service_level: { availability_target: 99.5 },
    }));
    expect(await within(dialog).findByText('Laptop request')).toBeInTheDocument();

    await user.click(within(listed).getByRole('button', { name: /edit/i }));
    expect(within(dialog).getByLabelText(/offering name/i)).toHaveValue('Password reset');
    await choose(user, within(dialog).getByRole('combobox', { name: /^lifecycle$/i }), 'Retired');
    await user.click(within(dialog).getByRole('button', { name: /save offering/i }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/service-offerings/so-1',
      expect.objectContaining({ lifecycle: 'retired' }), { headers: { 'If-Match': '"2"' } }));
    expect(await within(listed).findByText('retired')).toBeInTheDocument();
  });

  describe('read states', () => {
    afterEach(() => {
      real.on = false;
    });

    it('shows a loading state, and no total, while the list is being read', async () => {
      apiClient.get.mockReturnValue(new Promise(() => {}));

      render(<BusinessServices />);

      expect(await screen.findByRole('status')).toHaveTextContent(/loading business services/i);
      expect(screen.queryByText('$0')).not.toBeInTheDocument();
      expect(screen.queryByText('No services found')).not.toBeInTheDocument();
      expect(screen.getAllByText(EMPTY_VALUE).length).toBeGreaterThanOrEqual(4);
    });

    it('shows an empty state with a create call to action for a writer', async () => {
      apiClient.get.mockResolvedValue(listOf([]));

      render(<BusinessServices />);

      expect(await screen.findByText('No services found')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create your first service/i })).toBeInTheDocument();
    });

    it('shows the empty state to a viewer without any create control', async () => {
      auth.role = 'viewer';
      apiClient.get.mockResolvedValue(listOf([]));

      render(<BusinessServices />);

      expect(await screen.findByText('No services found')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /create/i })).not.toBeInTheDocument();
    });

    it('shows a retryable error, not a blank list or a zero total, when the read fails', async () => {
      const user = userEvent.setup();
      apiClient.get.mockRejectedValueOnce(new Error('Network Error'));
      apiClient.get.mockResolvedValueOnce(listOf([apiService]));

      render(<BusinessServices />);

      expect(await screen.findByText('Could not load business services')).toBeInTheDocument();
      expect(screen.getByText('Network Error')).toBeInTheDocument();
      expect(screen.queryByText('No services found')).not.toBeInTheDocument();
      expect(screen.queryByText('$0')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /try again/i }));

      expect(await rowFor('Customer Portal')).toBeInTheDocument();
      expect(screen.queryByText('Could not load business services')).not.toBeInTheDocument();
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });

    it('answers a server 403 with the shell banner and its own not-permitted state, not a spinner or a retry', async () => {
      const actual = await vi.importActual<typeof import('../lib/api-client')>('../lib/api-client');
      // The real client and its real interceptors; only the wire is played.
      (actual.apiClient as unknown as { client: { defaults: { adapter: unknown } } }).client.defaults.adapter =
        async (config: InternalAxiosRequestConfig) => {
          const response = {
            data: { _error: 'Forbidden', _message: "Permission 'read' required" },
            status: 403, statusText: '', headers: {}, config, request: {},
          };
          throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {}, response);
        };
      real.on = true;

      render(
        <>
          <ForbiddenHost />
          <BusinessServices />
        </>
      );

      expect(await screen.findByText('No access to business services')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent("Permission 'read' required");
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
      expect(screen.queryByText('No services found')).not.toBeInTheDocument();
    });

    it('shows a figure the row does not carry as unknown, never as 0', async () => {
      apiClient.get.mockResolvedValue(listOf([row({ service_id: 'bs-bare', name: 'Bare Service', metadata: undefined })]));

      render(<BusinessServices />);
      const bare = await rowFor('Bare Service');

      // Revenue impact, users, monthly cost and supporting CIs.
      expect(within(bare).getAllByText(EMPTY_VALUE)).toHaveLength(4);
      expect(within(bare).queryByText('$0')).not.toBeInTheDocument();
      expect(within(bare).queryByText('0')).not.toBeInTheDocument();
      // Nothing is known to total.
      expect(screen.queryByText('$0')).not.toBeInTheDocument();
    });

    it('totals only the figures that are known', async () => {
      apiClient.get.mockResolvedValue(
        listOf([apiService, row({ service_id: 'bs-bare', name: 'Bare Service', metadata: undefined })])
      );

      render(<BusinessServices />);
      await rowFor('Bare Service');

      // $500,000 appears in the Customer Portal row and as the total.
      expect(screen.getAllByText('$500,000')).toHaveLength(2);
      expect(screen.getAllByText('$8,200')).toHaveLength(2);
    });
  });

  describe('write controls by role', () => {
    beforeEach(() => {
      auth.role = 'operator';
    });
    afterEach(() => {
      auth.role = 'operator';
    });

    it('lets a viewer read the list, search and filter, and offers no create, edit or delete', async () => {
      auth.role = 'viewer';
      const user = userEvent.setup();
      apiClient.get.mockResolvedValue(
        listOf([
          apiService,
          row({ service_id: 'bs-l', name: 'Svc Low', business_criticality: 'low' }),
        ])
      );

      render(<BusinessServices />);
      await rowFor('Customer Portal');

      expect(screen.getByPlaceholderText('Search services...')).toBeInTheDocument();
      await choose(user, screen.getByRole('combobox', { name: /filter by criticality/i }), 'Low');
      expect(screen.queryByText('Customer Portal')).not.toBeInTheDocument();
      expect(screen.getByText('Svc Low')).toBeInTheDocument();

      expect(screen.queryByRole('button', { name: /create service/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^edit /i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^delete /i })).not.toBeInTheDocument();
      // Offerings are a read: the viewer can still open them.
      expect(screen.getByRole('button', { name: 'Offerings for Svc Low' })).toBeInTheDocument();
    });

    it.each(['operator', 'admin'])('shows an %s the create, edit and delete controls', async (role) => {
      auth.role = role;
      apiClient.get.mockResolvedValue(listOf([apiService]));

      render(<BusinessServices />);
      await rowFor('Customer Portal');

      expect(screen.getByRole('button', { name: /^create service$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit Customer Portal' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete Customer Portal' })).toBeInTheDocument();
    });

    it('deletes the confirmed row with the same request as before', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      apiClient.get.mockResolvedValue(
        listOf([apiService, row({ service_id: 'bs-l', name: 'Svc Low', business_criticality: 'low' })])
      );
      apiClient.delete.mockResolvedValue({ success: true });

      render(<BusinessServices />);
      await rowFor('Svc Low');
      await user.click(screen.getByRole('button', { name: 'Delete Svc Low' }));

      await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/business-services/bs-l'));
      await waitFor(() => expect(screen.queryByText('Svc Low')).not.toBeInTheDocument());
      expect(screen.getByText('Customer Portal')).toBeInTheDocument();
      vi.restoreAllMocks();
    });

    it('keeps the row when the delete is not confirmed', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      apiClient.get.mockResolvedValue(listOf([apiService]));

      render(<BusinessServices />);
      await rowFor('Customer Portal');
      await user.click(screen.getByRole('button', { name: 'Delete Customer Portal' }));

      expect(apiClient.delete).not.toHaveBeenCalled();
      expect(screen.getByText('Customer Portal')).toBeInTheDocument();
      vi.restoreAllMocks();
    });
  });
});
