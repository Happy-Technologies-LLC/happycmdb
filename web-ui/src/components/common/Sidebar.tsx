// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@happy-technologies/design-system';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@contexts/AuthContext';
import ciService from '@services/ci.service';
import { cn } from '@/lib/utils';

const DRAWER_WIDTH = 264;

/** Live count source for a nav badge, if any. */
type NavCount = 'cis';

interface MenuItem {
  text: string;
  /** Phosphor duotone glyph name (kebab-case), rendered via the DS <Icon>. */
  icon: string;
  path: string;
  count?: NavCount;
}

interface MenuCategory {
  title: string;
  items: MenuItem[];
}

const menuCategories: MenuCategory[] = [
  {
    title: 'Configuration Plane',
    items: [{ text: 'Dashboard', icon: 'gauge', path: '/' }],
  },
  {
    title: 'Business Insights',
    items: [
      { text: 'Executive Dashboard', icon: 'trend-up', path: '/dashboards/executive' },
      { text: 'CIO Dashboard', icon: 'users-three', path: '/dashboards/cio' },
      { text: 'ITSM Dashboard', icon: 'pulse', path: '/dashboards/itsm' },
      { text: 'FinOps Dashboard', icon: 'currency-dollar', path: '/dashboards/finops' },
      { text: 'Business Service', icon: 'target', path: '/dashboards/business-service' },
    ],
  },
  {
    title: 'Service Management',
    items: [
      { text: 'Business Services', icon: 'tree-structure', path: '/business-services' },
      { text: 'Financial Management', icon: 'chart-pie', path: '/financial-management' },
    ],
  },
  {
    title: 'CMDB',
    items: [
      { text: 'Configuration Items', icon: 'database', path: '/cis', count: 'cis' },
      { text: 'Inventory', icon: 'list', path: '/inventory' },
      { text: 'Health Monitoring', icon: 'heartbeat', path: '/cmdb-health' },
      { text: 'Anomaly Detection', icon: 'warning', path: '/anomalies' },
    ],
  },
  {
    title: 'Discovery',
    items: [
      { text: 'Discovery Jobs', icon: 'cloud', path: '/discovery' },
      { text: 'Discovery Agents', icon: 'hard-drives', path: '/agents' },
    ],
  },
  {
    title: 'Integration',
    items: [
      { text: 'Connectors', icon: 'plugs', path: '/connectors' },
      { text: 'Connector Catalog', icon: 'package', path: '/connectors/catalog' },
    ],
  },
  {
    title: 'AI & Analytics',
    items: [
      { text: 'Pattern Learning', icon: 'sparkle', path: '/ai/patterns' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { text: 'Credentials', icon: 'key', path: '/credentials' },
      { text: 'Credential Sets', icon: 'key', path: '/credential-sets' },
    ],
  },
];

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
  variant?: 'permanent' | 'temporary';
}

const getInitials = (name?: string): string =>
  (name || 'User')
    .split(' ')
    .map((p) => p[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

const NavButton: React.FC<{
  item: MenuItem;
  active: boolean;
  count: number | null;
  onClick: () => void;
}> = ({ item, active, count, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={cn(
      'hh-focus hh-display relative mb-px flex w-full items-center gap-[11px] rounded-[var(--hh-radius-md)] px-[13px] py-2.5 text-left text-[14px] transition-colors',
      active
        ? 'bg-[var(--hh-accent-bg)] font-bold text-[var(--hh-text-primary)]'
        : 'font-medium text-[var(--hh-text-body)] hover:bg-[var(--hh-bg-elevated)]'
    )}
  >
    <span
      className={cn(
        'absolute bottom-2 left-0 top-2 w-[3px] rounded-r-[3px]',
        active ? 'bg-[var(--hh-accent)]' : 'bg-transparent'
      )}
    />
    <Icon
      name={item.icon}
      size={20}
      className={active ? 'text-[var(--hh-accent-text)]' : 'text-[var(--hh-border-strong)]'}
    />
    <span className="flex-1 truncate">{item.text}</span>
    {count != null && (
      <span
        className={cn(
          'hh-display rounded-[var(--hh-radius-pill)] px-2 py-px text-[11px] font-bold',
          active
            ? 'bg-white text-[var(--hh-accent-text)]'
            : 'bg-[var(--hh-bg-elevated)] text-[var(--hh-text-body)]'
        )}
      >
        {count}
      </span>
    )}
  </button>
);

const Sidebar: React.FC<SidebarProps> = ({ open = true, onClose, variant = 'permanent' }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  // Shares the ['dashboard-stats'] query (and cache) with the Dashboard so the
  // CI nav badge tracks the live estate total without a second fetch.
  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => ciService.getDashboardStats(),
    staleTime: 60000,
    refetchInterval: 300000,
  });

  const navCount = (item: MenuItem): number | null =>
    item.count === 'cis' ? stats?.total_cis ?? null : null;

  const handleNavigation = (path: string) => {
    navigate(path);
    if (onClose && variant === 'temporary') onClose();
  };

  const isSelected = (path: string): boolean =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const content = (
    <div className="flex h-full flex-col bg-[var(--hh-bg-surface)]">
      {/* Logo lockup */}
      <div className="flex items-center gap-3 border-b border-[var(--hh-border)] px-[22px] pb-[18px] pt-[22px]">
        <img src="/assets/logo.svg" alt="HappyCMDB" className="h-[34px] w-auto" />
        <div className="flex flex-col leading-none">
          <span className="hh-display text-[15px] font-extrabold tracking-[-0.01em] text-[var(--hh-text-primary)]">
            HappyCMDB
          </span>
          <span className="hh-display mt-[3px] text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[var(--hh-accent-text)]">
            Operator Console
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-3">
        {menuCategories.map((category) => (
          <div key={category.title} className="flex flex-col gap-0.5">
            <span className="hh-heading px-3 pb-1.5 pt-3.5 text-[9.5px] text-[var(--hh-border-strong)]">
              {category.title}
            </span>
            {category.items.map((item) => (
              <NavButton
                key={item.text}
                item={item}
                active={isSelected(item.path)}
                count={navCount(item)}
                onClick={() => handleNavigation(item.path)}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* Part of HappyHive */}
      <div className="relative m-3.5 overflow-hidden rounded-[var(--hh-radius-lg)] bg-gradient-to-br from-[var(--hh-navy)] to-[var(--hh-navy-deep)] p-3.5 text-white">
        <div className="flex items-center gap-2.5">
          <img src="/assets/happyhive-icon.png" alt="HappyHive" className="h-[34px] w-[34px]" />
          <div className="leading-[1.25]">
            <div className="hh-display text-[13px] font-bold">Part of HappyHive</div>
            <div className="text-[11px] text-white/65">Graph synced to HIVE</div>
          </div>
        </div>
        <div className="hh-display mt-[11px] flex items-center gap-[7px] text-[11px] text-white/[0.78]">
          <span className="h-[7px] w-[7px] rounded-full bg-[var(--hh-success)] shadow-[0_0_0_3px_var(--hh-success-bg)]" />
          Discovery tier · autonomous
        </div>
      </div>

      {/* Operator footer */}
      <div className="flex items-center gap-2.5 border-t border-[var(--hh-border)] px-[18px] pb-[18px] pt-3">
        <div className="hh-display flex h-[34px] w-[34px] items-center justify-center rounded-full bg-[var(--hh-accent-bg)] text-[13px] font-bold text-[var(--hh-accent-text)]">
          {getInitials(user?.full_name)}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="hh-display truncate text-[13px] font-semibold text-[var(--hh-text-primary)]">
            {user?.full_name || 'User'}
          </div>
          <div className="text-[11px] text-[var(--hh-text-muted)]">
            {user?.role || 'Config steward'}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Account menu"
            className="hh-focus rounded-[var(--hh-radius-sm)] p-1 text-[var(--hh-border-strong)] transition-colors hover:text-[var(--hh-text-body)] focus-visible:outline-none"
          >
            <Icon name="gear-six" size={18} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="hh-theme w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="font-display text-sm font-semibold text-navy">
                  {user?.full_name}
                </span>
                <span className="text-xs text-ink-soft">{user?.email}</span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleNavigation('/settings?tab=profile')}>
              <Icon name="user" size={16} className="mr-2" />
              <span>Profile</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNavigation('/settings')}>
              <Icon name="gear-six" size={16} className="mr-2" />
              <span>Settings</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout()}>
              <Icon name="sign-out" size={16} className="mr-2 text-danger" />
              <span className="text-danger">Logout</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  if (variant === 'temporary') {
    return (
      <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose?.()}>
        <SheetContent side="left" className="hh-theme w-[264px] p-0">
          {content}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      className="sticky top-0 hidden h-screen flex-none border-r border-[var(--hh-border)] lg:block"
      style={{ width: DRAWER_WIDTH }}
    >
      {content}
    </aside>
  );
};

export default Sidebar;
export { DRAWER_WIDTH };
