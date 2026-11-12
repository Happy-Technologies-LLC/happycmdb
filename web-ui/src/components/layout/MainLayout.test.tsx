// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ThemeProvider } from '@/contexts/ThemeContext';
import MainLayout from './MainLayout';

const auth = vi.hoisted(() => ({
  user: { username: 'ada', full_name: 'Ada Lovelace', role: 'operator' } as Record<string, string> | null,
  logout: vi.fn(),
}));
vi.mock('@contexts/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, logout: auth.logout }),
}));
vi.mock('@services/ci.service', () => ({
  default: { getDashboardStats: vi.fn().mockResolvedValue({ total_cis: 1234 }) },
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn().mockResolvedValue([]) } }));

const Where = () => {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
};

function renderShell(path: string) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<MainLayout />}>
              <Route path="/" element={<p>Overview screen</p>} />
              <Route path="/cis" element={<p>CI list screen</p>} />
              <Route path="/cis/:id" element={<p>CI detail screen</p>} />
              <Route path="/discovery" element={<p>Discovery screen</p>} />
              <Route path="/agents" element={<p>Agents screen</p>} />
              <Route path="/settings" element={<p>Settings screen</p>} />
            </Route>
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const rail = () => screen.getByRole('complementary', { name: 'Primary' });

beforeEach(() => {
  cleanup();
  localStorage.clear();
  auth.user = { username: 'ada', full_name: 'Ada Lovelace', role: 'operator' };
  auth.logout.mockReset();
});

describe('shell rail', () => {
  it('lists the seven destinations in order with the CI total as a badge', async () => {
    renderShell('/');
    const links = within(rail()).getAllByRole('link');
    expect(links.map((l) => l.querySelector('.sr-only')?.textContent)).toEqual([
      'Dashboard',
      'Configuration items',
      'Business services',
      'Discovery',
      'Connectors',
      'Analytics',
      'Settings',
    ]);
    // A collapsed rail shows the count as a dot with the number for assistive tech.
    expect(await within(rail()).findByText('1234')).toBeInTheDocument();
  });

  it('marks the section of the current route active, including a detail route', () => {
    renderShell('/cis/ci-7');
    const active = within(rail()).getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAccessibleName(/configuration items/i);
    expect(screen.getByText('CI detail screen')).toBeInTheDocument();
  });

  it('opens the first screen of a section and moves the active state', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await user.click(within(rail()).getByRole('link', { name: /^discovery/i }));
    expect(screen.getByTestId('where')).toHaveTextContent('/discovery');
    expect(screen.getByText('Discovery screen')).toBeInTheDocument();
    const active = within(rail()).getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAccessibleName(/^discovery/i);
  });

  it('reaches a section\'s other screens through the strip above the page', async () => {
    const user = userEvent.setup();
    renderShell('/discovery');
    await user.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/agents');
    expect(screen.getByText('Agents screen')).toBeInTheDocument();
  });

  it.each([
    ['Ctrl held', { ctrlKey: true }],
    ['Cmd held', { metaKey: true }],
    ['Shift held', { shiftKey: true }],
    ['Alt held', { altKey: true }],
    ['a non-primary button', { button: 1 }],
  ])('leaves a click with %s to the browser (open in a new tab) instead of routing in place', (_label, init) => {
    renderShell('/');
    const link = within(rail()).getByRole('link', { name: /^discovery/i });
    // fireEvent returns false when a handler called preventDefault: the browser would then not open the link.
    expect(fireEvent.click(link, init)).toBe(true);
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
    expect(link).toHaveAttribute('href', '/discovery');
  });
});

describe('shell topbar', () => {
  it('greets the signed-in user by first name', () => {
    renderShell('/');
    expect(screen.getByText(/^Good (morning|afternoon|evening), Ada$/)).toBeInTheDocument();
  });

  it('names the search box for assistive tech', () => {
    renderShell('/');
    expect(screen.getByRole('searchbox', { name: 'Search CIs, services, hostnames, IPs' })).toBeInTheDocument();
  });

  it('Enter in search opens the CI list filtered by the text; empty search opens the plain list', async () => {
    const user = userEvent.setup();
    renderShell('/settings');
    const search = screen.getByRole('searchbox');
    await user.type(search, 'web server 01{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/cis?search=web%20server%2001');
    await user.clear(search);
    await user.type(search, '{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/cis$/);
  });
});

describe('account menu', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: /account menu for ada lovelace/i }));

  it('shows who is signed in with the role the server reports', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await open(user);
    expect(await screen.findByText('Ada Lovelace · operator')).toBeInTheDocument();
  });

  it('shows the signed-in email under the name, as the old sidebar menu did', async () => {
    const user = userEvent.setup();
    auth.user = { username: 'ada', full_name: 'Ada Lovelace', role: 'operator', email: 'ada@example.com' };
    renderShell('/');
    await open(user);
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
  });

  it('Profile and Settings navigate to the settings screen', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Profile' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings?tab=profile');
  });

  it('the theme item switches the theme and the choice is stored', async () => {
    const user = userEvent.setup();
    renderShell('/');
    expect(document.querySelector('.hh-theme')).toHaveAttribute('data-theme', 'light');
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Switch to dark theme' }));
    expect(document.querySelector('.hh-theme')).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('hh-theme')).toBe('dark');
    await open(user);
    expect(await screen.findByRole('menuitem', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('Sign out calls logout', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await open(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });
});
