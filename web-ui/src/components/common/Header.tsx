// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@happy-technologies/design-system';
import { apiClient } from '../../lib/api-client';
import { HealthStatus } from '../../types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface HeaderProps {
  onMenuClick?: () => void;
}

// Live service-health -> topbar status-dot color. Unknown/missing -> neutral line.
const STATUS_DOT: Record<HealthStatus['status'], string> = {
  healthy: 'bg-[var(--hh-success)]',
  degraded: 'bg-[var(--hh-warning)]',
  down: 'bg-[var(--hh-danger)]',
};

const Header: React.FC<HeaderProps> = ({ onMenuClick }) => {
  const navigate = useNavigate();

  // Shares the ['service-health'] query key (and cache) with HealthDashboard so the
  // topbar dots track the same live /cmdb-health/services data without a second fetch.
  const { data: services } = useQuery({
    queryKey: ['service-health'],
    queryFn: () => apiClient.get<HealthStatus[]>('/cmdb-health/services'),
    refetchInterval: 10000,
  });

  const graph = services?.find((s) => /neo4j|graph/i.test(s.service));
  const mart = services?.find((s) => /mart|warehouse/i.test(s.service));

  const handleSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const value = e.currentTarget.value.trim();
    navigate(value ? `/cis?search=${encodeURIComponent(value)}` : '/cis');
  };

  return (
    <header className="sticky top-0 z-20 flex items-center gap-5 border-b border-[var(--hh-border)] bg-[var(--hh-bg-glass)] px-5 py-3 backdrop-blur-md md:px-8">
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          aria-label="Open menu"
          className="hh-focus flex h-10 w-10 flex-none items-center justify-center rounded-[var(--hh-radius-md)] text-[var(--hh-text-body)] hover:bg-[var(--hh-bg-elevated)] lg:hidden"
        >
          <Icon name="list" size={20} />
        </button>
      )}

      {/* Natural-language search */}
      <div className="relative flex min-w-0 max-w-[520px] flex-1 items-center">
        <Icon
          name="magnifying-glass"
          size={18}
          className="pointer-events-none absolute left-4 text-[var(--hh-border-strong)]"
        />
        <input
          onKeyDown={handleSearch}
          placeholder="Search CIs, services, hostnames, IPs…"
          spellCheck={false}
          aria-label="Search CIs, services, hostnames, IPs"
          className="hh-focus hh-body w-full rounded-[var(--hh-radius-pill)] border-2 border-[var(--hh-border)] bg-[var(--hh-bg-page)] py-[10px] pl-11 pr-4 text-sm text-[var(--hh-text-primary)] outline-none transition-colors placeholder:text-[var(--hh-text-muted)] focus:border-[var(--hh-accent)] focus:bg-white"
        />
      </div>

      {/* Tenant switcher */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="hh-focus hidden items-center gap-2.5 rounded-[var(--hh-radius-pill)] border border-[var(--hh-border)] bg-[var(--hh-bg-page)] px-3 py-1.5 transition-colors hover:border-[var(--hh-accent)] sm:flex">
            <Icon name="buildings" size={16} className="text-[var(--hh-accent-text)]" />
            <span className="hh-display text-[13px] font-semibold text-[var(--hh-text-primary)]">
              Happy Technologies
            </span>
            <Icon name="caret-down" size={13} className="text-[var(--hh-border-strong)]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Tenant</DropdownMenuLabel>
          <DropdownMenuItem>Happy Technologies</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Service status - driven by live /cmdb-health/services */}
      <div className="hidden items-center gap-3.5 lg:flex">
        <span
          className="hh-display flex items-center gap-1.5 text-xs text-[var(--hh-text-body)]"
          title={`Neo4j graph: ${graph?.status ?? 'unknown'}`}
        >
          <span
            className={`h-2 w-2 rounded-full ${graph ? STATUS_DOT[graph.status] : 'bg-[var(--hh-border-strong)]'} ${graph ? 'animate-[hh-pulse_2.4s_ease-in-out_infinite]' : ''}`}
          />
          Graph
        </span>
        <span
          className="hh-display flex items-center gap-1.5 text-xs text-[var(--hh-text-body)]"
          title={`Data mart: ${mart?.status ?? 'unknown'}`}
        >
          <span
            className={`h-2 w-2 rounded-full ${mart ? STATUS_DOT[mart.status] : 'bg-[var(--hh-border-strong)]'} ${mart ? 'animate-[hh-pulse_2.4s_ease-in-out_infinite]' : ''}`}
          />
          Mart
        </span>
      </div>

      {/* Notifications */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Notifications"
            className="hh-focus flex h-10 w-10 flex-none items-center justify-center rounded-[var(--hh-radius-md)] border border-[var(--hh-border)] bg-white text-[var(--hh-text-body)] transition-colors hover:border-[var(--hh-accent)] hover:text-[var(--hh-accent-text)]"
          >
            <Icon name="bell" size={19} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          <DropdownMenuItem disabled>No new notifications</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
};

export default Header;
