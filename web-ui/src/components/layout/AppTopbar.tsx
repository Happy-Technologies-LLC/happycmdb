// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { MobileNavButton, SearchInput, Topbar } from '@happy-technologies/design-system';
import { useAuth } from '@contexts/AuthContext';
import { AccountMenu } from './AccountMenu';
import { ServiceHealthDots } from './ServiceHealthDots';
import { greeting } from './greeting';

/**
 * MF3, MF4: date and greeting from the signed-in user (GET /auth/me), the existing CI search, service dots, account
 * menu. No bell (N11) and no tenant switcher: neither has a backend.
 */
export function AppTopbar({ navOpen, onToggleNav }: { navOpen: boolean; onToggleNav: () => void }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const now = new Date();

  // Enter opens the CI list filtered by the text: the search the app already had, no new endpoint.
  const search = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    const text = query.trim();
    navigate(text ? `/cis?search=${encodeURIComponent(text)}` : '/cis');
  };

  return (
    <Topbar>
      <MobileNavButton expanded={navOpen} onClick={onToggleNav} />
      <div className="min-w-0">
        <div className="hh-heading hidden text-[length:var(--hh-text-2xs)] text-[var(--hh-text-muted)] sm:block">
          {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <div className="hh-display truncate text-[20px] font-light tracking-[-0.02em] sm:text-[26px]">
          {greeting(now, user?.full_name ?? '')}
        </div>
      </div>
      <SearchInput
        value={query}
        onChange={setQuery}
        onKeyDown={search}
        placeholder="Search CIs, services, hostnames, IPs"
        aria-label="Search CIs, services, hostnames, IPs"
        className="mx-auto hidden w-[min(420px,36cqi)] sm:block"
      />
      <div className="ml-auto flex items-center gap-4 sm:ml-0">
        <ServiceHealthDots />
        <AccountMenu />
      </div>
    </Topbar>
  );
}
