// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon, ProductLockup, Sidebar, SidebarNavItem, SidebarSection } from '@happy-technologies/design-system';
import ciService from '@services/ci.service';
import { NAV_SECTIONS, matchNav } from './navigation';

/** The DS icon rail (MF1, MF2): product lockup, "Workspace", one item per section in freeze order. */
export function AppRail() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeId = matchNav(pathname)?.section.id;

  // Shares the ['dashboard-stats'] query (and cache) with the Dashboard: the CI badge tracks the live estate total.
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => ciService.getDashboardStats(),
    staleTime: 60000,
    refetchInterval: 300000,
  });

  return (
    <Sidebar
      aria-label="Primary"
      logo={
        <ProductLockup
          name="HappyCMDB"
          logo={<Icon name="cube" size={32} className="text-[var(--hh-accent)]" />}
        />
      }
    >
      <SidebarSection label="Workspace">
        {NAV_SECTIONS.map((section) => (
          <SidebarNavItem
            key={section.id}
            icon={section.icon}
            label={section.label}
            href={section.items[0]!.path}
            active={section.id === activeId}
            count={section.id === 'cis' ? stats?.total_cis : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(section.items[0]!.path);
            }}
          />
        ))}
      </SidebarSection>
    </Sidebar>
  );
}
