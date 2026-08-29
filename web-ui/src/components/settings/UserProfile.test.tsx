// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockRefreshUser, mockLogout, mockUpdateProfile } = vi.hoisted(() => ({
  mockRefreshUser: vi.fn(),
  mockLogout: vi.fn(),
  mockUpdateProfile: vi.fn(),
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
    changePassword: vi.fn(),
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
