// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockRefreshUser, mockLogout, mockUpdateProfile, mockChangePassword, mockRevokeOtherSessions } = vi.hoisted(() => ({
  mockRefreshUser: vi.fn(),
  mockLogout: vi.fn(),
  mockUpdateProfile: vi.fn(),
  mockChangePassword: vi.fn(),
  mockRevokeOtherSessions: vi.fn(),
}));

// mockUser is read by the useAuth() mock below at render time; reassigning
// it and then calling `rerender` simulates AuthContext picking up a fresh
// /auth/me response (e.g. after refreshUser(), or a page reload that
// remounts this component with the already-persisted user).
let mockUser: { full_name: string; email: string; avatar?: string };

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, refreshUser: mockRefreshUser, logout: mockLogout }),
}));

vi.mock('../../services/api', () => ({
  api: {
    updateProfile: mockUpdateProfile,
    changePassword: mockChangePassword,
    revokeOtherSessions: mockRevokeOtherSessions,
    deleteAccount: vi.fn(),
  },
}));

// Radix's AvatarImage only renders an <img> once it has confirmed the image
// loaded, which never happens in jsdom (no real network fetch). Replace it
// with a plain <img> so the avatar src is directly assertable.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AvatarImage: ({ src, alt }: { src?: string; alt?: string }) =>
    src ? <img data-testid="avatar-preview" src={src} alt={alt} /> : null,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="avatar-fallback">{children}</div>
  ),
}));

import { UserProfile } from './UserProfile';

describe('UserProfile avatar persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { full_name: 'Alice Example', email: 'alice@example.com', avatar: undefined };
  });

  it('initializes the avatar preview from the authenticated user on mount, so a reload shows the persisted image immediately', () => {
    mockUser = {
      full_name: 'Alice Example',
      email: 'alice@example.com',
      avatar: 'data:image/png;base64,persistedAvatar',
    };

    render(<UserProfile />);

    const img = screen.getByTestId('avatar-preview') as HTMLImageElement;
    expect(img.src).toContain('data:image/png;base64,persistedAvatar');
  });

  it('shows no avatar image (falls back to initials) when the authenticated user has none', () => {
    render(<UserProfile />);

    expect(screen.queryByTestId('avatar-preview')).toBeNull();
    expect(screen.getByTestId('avatar-fallback')).toBeTruthy();
  });

  it('picks up the avatar refreshUser returns after a profile update (update -> reread survives remount)', async () => {
    const user = userEvent.setup();
    mockUpdateProfile.mockResolvedValue({ full_name: 'Alice Example', email: 'alice@example.com' });
    mockRefreshUser.mockImplementation(async () => {
      mockUser = { ...mockUser, avatar: 'data:image/png;base64,serverPersistedAfterSave' };
    });

    const { rerender } = render(<UserProfile />);
    expect(screen.queryByTestId('avatar-preview')).toBeNull();

    await user.click(screen.getByRole('button', { name: /update profile/i }));

    await waitFor(() => expect(mockRefreshUser).toHaveBeenCalledTimes(1));

    // Simulate the remount/re-render AuthContext triggers once its state
    // updates with the freshly-read user (or a genuine page reload).
    rerender(<UserProfile />);

    const img = screen.getByTestId('avatar-preview') as HTMLImageElement;
    expect(img.src).toContain('data:image/png;base64,serverPersistedAfterSave');
  });
});

describe('UserProfile profile update when the session ends during refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { full_name: 'Alice Example', email: 'alice@example.com' };
    mockUpdateProfile.mockResolvedValue({ full_name: 'Alice Example', email: 'alice@example.com' });
  });

  it('shows the fixed sign-in-again message and no success toast when refreshUser reports the session ended', async () => {
    const user = userEvent.setup();
    mockRefreshUser.mockResolvedValue('session-ended');
    render(<UserProfile />);

    await user.click(screen.getByRole('button', { name: /update profile/i }));

    expect(await screen.findByText('Your session ended; please sign in again')).toBeTruthy();
    expect(screen.queryByText('Profile updated successfully')).toBeNull();
  });

  it('still shows the success toast when the refresh succeeded', async () => {
    const user = userEvent.setup();
    mockRefreshUser.mockResolvedValue('refreshed');
    render(<UserProfile />);

    await user.click(screen.getByRole('button', { name: /update profile/i }));

    expect(await screen.findByText('Profile updated successfully')).toBeTruthy();
    expect(screen.queryByText('Your session ended; please sign in again')).toBeNull();
  });
});

describe('UserProfile password change (HAP-1285 review)', () => {
  beforeEach(() => {
    mockUser = { full_name: 'Alice Example', email: 'alice@example.com', avatar: undefined };
  });

  it('keeps the long "other sessions and API keys revoked" notice on screen past the 3 s auto-hide', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<UserProfile />);
      const next = `pw-${crypto.randomUUID()}`;
      await user.type(screen.getByLabelText('Current Password'), `pw-${crypto.randomUUID()}`);
      await user.type(screen.getByLabelText('New Password'), next);
      await user.type(screen.getByLabelText('Confirm New Password'), next);
      await user.click(screen.getByRole('button', { name: 'Change Password' }));
      const notice = await screen.findByText(/API keys have been revoked/);

      await act(async () => { vi.advanceTimersByTime(10_000); });

      expect(notice).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('UserProfile sign out other sessions (HAP-1716)', () => {
  beforeEach(() => {
    mockUser = { full_name: 'Alice Example', email: 'alice@example.com', avatar: undefined };
    mockChangePassword.mockReset();
    mockRevokeOtherSessions.mockReset();
  });

  it('a rate-limited password change points at the step-up, which sends the typed password and confirms', async () => {
    mockChangePassword.mockRejectedValue({ response: { status: 429, data: { success: false, error: 'Too Many Requests' } } });
    mockRevokeOtherSessions.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<UserProfile />);
    const owner = `pw-${crypto.randomUUID()}`;
    const next = `pw-${crypto.randomUUID()}`;
    await user.type(screen.getByLabelText('Current Password'), owner);
    await user.type(screen.getByLabelText('New Password'), next);
    await user.type(screen.getByLabelText('Confirm New Password'), next);
    await user.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(await screen.findByText(/You can still sign out other sessions below/)).toBeInTheDocument();

    const revoke = screen.getByRole('button', { name: 'Sign out other sessions' });
    expect(revoke).toBeDisabled();
    await user.type(screen.getByLabelText('Current password to confirm'), owner);
    await user.click(revoke);

    expect(mockRevokeOtherSessions).toHaveBeenCalledExactlyOnceWith(owner);
    expect(await screen.findByText(/Your password is unchanged/)).toBeInTheDocument();
    expect(screen.getByLabelText('Current password to confirm')).toHaveValue('');
  });

  it('a refused step-up shows the server message and keeps the typed password out of the success notice', async () => {
    mockRevokeOtherSessions.mockRejectedValue({ response: { status: 400, data: { message: 'Current password is incorrect' } } });
    const user = userEvent.setup();
    render(<UserProfile />);
    await user.type(screen.getByLabelText('Current password to confirm'), `pw-${crypto.randomUUID()}`);
    await user.click(screen.getByRole('button', { name: 'Sign out other sessions' }));

    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
    expect(screen.queryByText(/Your password is unchanged/)).not.toBeInTheDocument();
  });
});
