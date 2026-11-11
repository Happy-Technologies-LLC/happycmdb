// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1893: typed profile passwords live in the input value property only, never in the DOM tree.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const { changePassword } = vi.hoisted(() => ({ changePassword: vi.fn() }));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { full_name: 'Alice Example', email: 'alice@example.com' },
    refreshUser: vi.fn(),
    logout: vi.fn(),
  }),
}));
vi.mock('../../services/api', () => ({
  api: { updateProfile: vi.fn(), changePassword, deleteAccount: vi.fn() },
}));

import { UserProfile } from './UserProfile';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FIELDS = [
  { label: 'Current Password', autoComplete: 'current-password' },
  { label: 'New Password', autoComplete: 'new-password' },
  { label: 'Confirm New Password', autoComplete: 'new-password' },
];

describe('UserProfile password fields (HAP-1893)', () => {
  it('keeps every typed password out of the DOM tree and in the input value property', () => {
    render(<UserProfile />);
    const typed = FIELDS.map(({ label }) => {
      const marker = secretMarker('profile');
      const field = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.change(field, { target: { value: marker } });
      return { marker, field };
    });
    for (const { field } of typed) {
      fireEvent.change(field, { target: { value: `${field.value}-more` } });
    }

    for (const { marker, field } of typed) {
      expect(field.value).toBe(`${marker}-more`);
      expect(domLeaks(marker)).toEqual([]);
    }
  });

  it('masks every password field with the right autofill hint', () => {
    render(<UserProfile />);
    for (const { label, autoComplete } of FIELDS) {
      const field = screen.getByLabelText(label);
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', autoComplete);
    }
  });

  it('still submits the typed passwords to changePassword() and clears the fields after', async () => {
    changePassword.mockResolvedValue(undefined);
    render(<UserProfile />);
    const current = secretMarker('cur');
    const next = secretMarker('new');
    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
    expect(changePassword).toHaveBeenCalledWith({ currentPassword: current, newPassword: next });
    await waitFor(() =>
      expect((screen.getByLabelText('New Password') as HTMLInputElement).value).toBe('')
    );
  });
});
