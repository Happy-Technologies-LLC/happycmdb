// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Bell, Search, Building2, ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../lib/api-client';
import { HealthStatus } from '../../types';

interface HeaderProps {
  onMenuClick?: () => void;
}

// Live service-health → topbar status-dot color. Unknown/missing → neutral line.
const STATUS_DOT: Record<HealthStatus['status'], string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-danger',
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
    <header className="sticky top-0 z-20 flex items-center gap-5 border-b border-line bg-white/[0.86] px-5 py-3 backdrop-blur-md md:px-8">
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          aria-label="Open menu"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-md text-ink-soft hover:bg-warm lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
      )}

      {/* Global search */}
      <div className="relative flex min-w-0 max-w-[520px] flex-1 items-center">
        <Search className="pointer-events-none absolute left-4 h-[18px] w-[18px] text-line" />
        <input
          onKeyDown={handleSearch}
          placeholder="Search CIs, services, hostnames, IPs…"
          className="w-full rounded-full border-2 border-line bg-warm py-[10px] pl-11 pr-4 font-body text-sm text-ink outline-none transition-all placeholder:text-ink-soft/70 focus:border-sky focus:bg-white focus:ring-4 focus:ring-sky/10"
        />
      </div>

      {/* Tenant selector */}
      <button className="hidden items-center gap-2.5 rounded-full border border-line bg-warm px-3 py-1.5 transition-colors hover:border-sky sm:flex">
        <Building2 className="h-4 w-4 text-sky-text" />
        <span className="font-display text-[13px] font-semibold text-navy">Happy Technologies</span>
        <ChevronDown className="h-3.5 w-3.5 text-line" />
      </button>

      {/* Service status — driven by live /cmdb-health/services */}
      <div className="hidden items-center gap-3.5 lg:flex">
        <span
          className="flex items-center gap-1.5 font-display text-xs text-ink-soft"
          title={`Neo4j graph: ${graph?.status ?? 'unknown'}`}
        >
          <span
            className={`h-2 w-2 rounded-full ${graph ? STATUS_DOT[graph.status] : 'bg-line'} ${graph ? 'animate-pulse' : ''}`}
          />
          Graph
        </span>
        <span
          className="flex items-center gap-1.5 font-display text-xs text-ink-soft"
          title={`Data mart: ${mart?.status ?? 'unknown'}`}
        >
          <span
            className={`h-2 w-2 rounded-full ${mart ? STATUS_DOT[mart.status] : 'bg-line'} ${mart ? 'animate-pulse' : ''}`}
          />
          Mart
        </span>
      </div>

      {/* Notifications */}
      <button
        aria-label="Notifications"
        className="flex h-10 w-10 flex-none items-center justify-center rounded-md border border-line bg-white text-ink-soft transition-colors hover:border-sky hover:text-sky-text"
      >
        <Bell className="h-[19px] w-[19px]" />
      </button>
    </header>
  );
};

export default Header;
