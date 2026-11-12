// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from 'react-router-dom';
import { Avatar, Menu, type MenuItem } from '@happy-technologies/design-system';
import { useAuth } from '@contexts/AuthContext';
import { useTheme } from '@contexts/ThemeContext';

/** MF6, F5, F13: the avatar opens the account menu: identity and role, profile, settings, theme, sign out. */
export function AccountMenu() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const name = user?.full_name || user?.username || 'Account';

  const items: MenuItem[] = [
    { label: `${name} · ${user?.role ?? 'unknown role'}`, icon: 'user-circle', disabled: true },
    ...(user?.email ? [{ label: user.email, icon: 'envelope-simple', disabled: true }] : []),
    { label: 'Profile', icon: 'user', onClick: () => navigate('/settings?tab=profile') },
    { label: 'Settings', icon: 'gear-six', onClick: () => navigate('/settings') },
    {
      label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      icon: theme === 'dark' ? 'sun' : 'moon',
      onClick: toggleTheme,
    },
    { label: 'Sign out', icon: 'sign-out', danger: true, onClick: () => void logout() },
  ];

  return (
    <Menu
      align="end"
      aria-label="Account"
      triggerClassName="rounded-full"
      trigger={<Avatar name={name} src={user?.avatar} aria-label={`Account menu for ${name}`} />}
      items={items}
    />
  );
}
