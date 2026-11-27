// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/tests/utils/test-utils';

const { apiClient, auth } = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  // The write controls follow the signed-in server role (HAP-1252 S1).
  auth: { role: 'operator' },
}));

vi.mock('../../lib/api-client', () => ({ apiClient }));
vi.mock('@contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@contexts/AuthContext')>()),
  useAuth: () => ({ user: { role: auth.role } }),
}));

import { ServiceOfferingsDialog, type ServiceOffering } from './ServiceOfferingsDialog';

const service = { id: 'bs-portal', name: 'Customer Portal' };

const offering = (overrides: Partial<ServiceOffering> = {}): ServiceOffering => ({
  offering_id: 'so-1',
  service_id: 'bs-portal',
  name: 'Password reset',
  description: null,
  audience: 'internal',
  lifecycle: 'live',
  service_level: { availability_target: 99.9 },
  version: 2,
  updated_at: '2026-11-05T00:00:00.000Z',
  ...overrides,
});

const envelope = (data: unknown) => ({ success: true, data });

const renderDialog = () => render(<ServiceOfferingsDialog service={service} onClose={vi.fn()} />);

describe('ServiceOfferingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.role = 'operator';
  });
  afterEach(() => {
    auth.role = 'operator';
  });

  it('shows a loading state while the offerings are read', async () => {
    apiClient.get.mockReturnValue(new Promise(() => {}));

    renderDialog();

    expect(await screen.findByRole('status')).toHaveTextContent(/loading offerings/i);
    expect(screen.queryByText('No offerings yet.')).not.toBeInTheDocument();
  });

  it('shows an empty state when the service has no offerings', async () => {
    apiClient.get.mockResolvedValue(envelope([]));

    renderDialog();

    expect(await screen.findByText('No offerings yet.')).toBeInTheDocument();
  });

  it('shows a retryable error, not an empty list, when the read fails', async () => {
    const user = userEvent.setup();
    apiClient.get.mockRejectedValueOnce(new Error('Network Error'));
    apiClient.get.mockResolvedValueOnce(envelope([offering()]));

    renderDialog();

    expect(await screen.findByText('Could not load offerings')).toBeInTheDocument();
    expect(screen.queryByText('No offerings yet.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Password reset')).toBeInTheDocument();
    expect(screen.queryByText('Could not load offerings')).not.toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('shows a not-permitted state, not an empty list or a retry, when the read is forbidden', async () => {
    apiClient.get.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { _error: 'Forbidden', _message: "Permission 'read' required" } },
    });

    renderDialog();

    expect(await screen.findByText('No access to offerings')).toBeInTheDocument();
    expect(screen.queryByText('No offerings yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('lets a viewer read the offerings but offers no edit, add or form', async () => {
    auth.role = 'viewer';
    apiClient.get.mockResolvedValue(envelope([offering()]));

    renderDialog();

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Password reset')).toBeInTheDocument();
    expect(within(dialog).getByText('live')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^edit /i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /add offering|save offering/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/offering name/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: /lifecycle/i })).not.toBeInTheDocument();
  });

  it.each(['operator', 'admin'])('gives an %s the edit control and the add form', async (role) => {
    auth.role = role;
    apiClient.get.mockResolvedValue(envelope([offering()]));

    renderDialog();

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('button', { name: 'Edit Password reset' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/offering name/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /add offering/i })).toBeDisabled();
  });

  it('enables Add only once the name has three characters, then posts the form', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue(envelope([]));
    apiClient.post.mockResolvedValue(envelope(offering({ offering_id: 'so-2', name: 'Laptop request', lifecycle: 'planned', version: 1 })));

    renderDialog();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('No offerings yet.');
    const add = within(dialog).getByRole('button', { name: /add offering/i });

    await user.type(within(dialog).getByLabelText(/offering name/i), 'La');
    expect(add).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/offering name/i), 'ptop request');
    expect(add).toBeEnabled();
    await user.type(within(dialog).getByLabelText(/availability target/i), '99.5');
    await user.click(add);

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/business-services/bs-portal/offerings', {
      name: 'Laptop request',
      description: '',
      audience: 'internal',
      lifecycle: 'planned',
      service_level: { availability_target: 99.5 },
    }));
    expect(await within(dialog).findByText('Laptop request')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/offering name/i)).toHaveValue('');
  });

  it('does not offer a backward lifecycle step when editing a live offering', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue(envelope([offering()]));
    apiClient.patch.mockResolvedValue(envelope(offering({ lifecycle: 'retiring', version: 3 })));

    renderDialog();
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Edit Password reset' }));

    const lifecycle = within(dialog).getByRole('combobox', { name: /^lifecycle$/i });
    expect(lifecycle).toHaveTextContent('Live');
    await user.click(lifecycle);
    expect(screen.queryByRole('option', { name: 'Planned' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Retiring' }));
    await user.click(within(dialog).getByRole('button', { name: /save offering/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/service-offerings/so-1',
      expect.objectContaining({ lifecycle: 'retiring' }), { headers: { 'If-Match': '"2"' } }));
  });

  it('keeps the form filled in when the server refuses the write', async () => {
    const user = userEvent.setup();
    apiClient.get.mockResolvedValue(envelope([]));
    apiClient.post.mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { error: 'Duplicate offering' } } });

    renderDialog();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('No offerings yet.');
    await user.type(within(dialog).getByLabelText(/offering name/i), 'Laptop request');
    await user.click(within(dialog).getByRole('button', { name: /add offering/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    expect(within(dialog).getByLabelText(/offering name/i)).toHaveValue('Laptop request');
    expect(within(dialog).queryByText('Laptop request', { selector: 'li *' })).not.toBeInTheDocument();
  });
});
