// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Database,
  Cloud,
  Server,
  Key,
  Plug,
  Activity,
  AlertTriangle,
  Package,
  Sparkles,
  TrendingUp,
  Users,
  DollarSign,
  Target,
  Network,
  PieChart,
  Settings,
  LogOut,
  User as UserIcon,
  ChevronsUpDown,
} from 'lucide-react';
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
import { cn } from '@/lib/utils';

const DRAWER_WIDTH = 264;

interface MenuItem {
  text: string;
  icon: React.ReactElement;
  path: string;
}

interface MenuCategory {
  title: string;
  items: MenuItem[];
}

const menuCategories: MenuCategory[] = [
  {
    title: 'Configuration Plane',
    items: [
      { text: 'Dashboard', icon: <LayoutDashboard className="h-[18px] w-[18px]" />, path: '/' },
    ],
  },
  {
    title: 'Business Insights',
    items: [
      {
        text: 'Executive Dashboard',
        icon: <TrendingUp className="h-[18px] w-[18px]" />,
        path: '/dashboards/executive',
      },
      {
        text: 'CIO Dashboard',
        icon: <Users className="h-[18px] w-[18px]" />,
        path: '/dashboards/cio',
      },
      {
        text: 'ITSM Dashboard',
        icon: <Activity className="h-[18px] w-[18px]" />,
        path: '/dashboards/itsm',
      },
      {
        text: 'FinOps Dashboard',
        icon: <DollarSign className="h-[18px] w-[18px]" />,
        path: '/dashboards/finops',
      },
      {
        text: 'Business Service',
        icon: <Target className="h-[18px] w-[18px]" />,
        path: '/dashboards/business-service',
      },
    ],
  },
  {
    title: 'Service Management',
    items: [
      {
        text: 'Business Services',
        icon: <Network className="h-[18px] w-[18px]" />,
        path: '/business-services',
      },
      {
        text: 'Financial Management',
        icon: <PieChart className="h-[18px] w-[18px]" />,
        path: '/financial-management',
      },
    ],
  },
  {
    title: 'CMDB',
    items: [
      {
        text: 'Configuration Items',
        icon: <Database className="h-[18px] w-[18px]" />,
        path: '/cis',
      },
      {
        text: 'Health Monitoring',
        icon: <Activity className="h-[18px] w-[18px]" />,
        path: '/cmdb-health',
      },
      {
        text: 'Anomaly Detection',
        icon: <AlertTriangle className="h-[18px] w-[18px]" />,
        path: '/anomalies',
      },
    ],
  },
  {
    title: 'Discovery',
    items: [
      { text: 'Discovery Jobs', icon: <Cloud className="h-[18px] w-[18px]" />, path: '/discovery' },
      { text: 'Discovery Agents', icon: <Server className="h-[18px] w-[18px]" />, path: '/agents' },
    ],
  },
  {
    title: 'Integration',
    items: [
      { text: 'Connectors', icon: <Plug className="h-[18px] w-[18px]" />, path: '/connectors' },
      {
        text: 'Connector Catalog',
        icon: <Package className="h-[18px] w-[18px]" />,
        path: '/connectors/catalog',
      },
    ],
  },
  {
    title: 'AI & Analytics',
    items: [
      {
        text: 'Pattern Learning',
        icon: <Sparkles className="h-[18px] w-[18px]" />,
        path: '/ai/patterns',
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      { text: 'Credentials', icon: <Key className="h-[18px] w-[18px]" />, path: '/credentials' },
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

const Sidebar: React.FC<SidebarProps> = ({ open = true, onClose, variant = 'permanent' }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const handleNavigation = (path: string) => {
    navigate(path);
    if (onClose && variant === 'temporary') onClose();
  };

  const isSelected = (path: string): boolean =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const content = (
    <div className="flex h-full flex-col bg-white">
      {/* Logo lockup */}
      <div className="flex items-center gap-3 border-b border-line-soft px-5 py-[18px]">
        <img src="/assets/logo.svg" alt="HappyCMDB" className="h-9 w-auto" />
        <div className="flex flex-col leading-none">
          <span className="font-display text-[15px] font-extrabold tracking-[-0.01em] text-navy">
            HappyCMDB
          </span>
          <span className="mt-[3px] font-display text-[9.5px] font-semibold uppercase tracking-[0.16em] text-sky-text">
            Operator Console
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-2.5">
        {menuCategories.map((category) => (
          <div key={category.title} className="mb-0.5">
            <div className="px-3 pb-1.5 pt-3.5 font-display text-[9.5px] font-bold uppercase tracking-[0.13em] text-line">
              {category.title}
            </div>
            {category.items.map((item) => {
              const active = isSelected(item.path);
              return (
                <button
                  key={item.text}
                  onClick={() => handleNavigation(item.path)}
                  className={cn(
                    'relative mb-px flex w-full items-center gap-[11px] rounded-md px-3 py-2 text-left font-display text-[13px] transition-all',
                    active
                      ? 'bg-sky-soft font-bold text-navy'
                      : 'font-medium text-ink hover:bg-warm'
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-[7px] bottom-[7px] w-[3px] rounded-r bg-sky" />
                  )}
                  <span
                    className={cn(
                      'flex items-center justify-center',
                      active ? 'text-sky-text' : 'text-ink-soft'
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="flex-1 truncate">{item.text}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Part of HappyHive */}
      <div className="mx-3.5 mb-3.5 overflow-hidden rounded-lg bg-gradient-to-br from-navy to-navy-deep p-3.5 text-white">
        <div className="flex items-center gap-2.5">
          <img src="/assets/happyhive-icon.png" alt="HappyHive" className="h-[34px] w-[34px]" />
          <div className="leading-tight">
            <div className="font-display text-[13px] font-bold">Part of HappyHive</div>
            <div className="text-[11px] text-white/65">Graph synced to HIVE</div>
          </div>
        </div>
        <div className="mt-[11px] flex items-center gap-[7px] font-display text-[11px] text-white/80">
          <span className="h-[7px] w-[7px] rounded-full bg-[#4ade80] shadow-[0_0_0_3px_rgba(74,222,128,0.22)]" />
          Discovery tier · autonomous
        </div>
      </div>

      {/* User footer */}
      <div className="flex items-center gap-2.5 border-t border-line-soft px-4 py-3">
        <div className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-sky-soft font-display text-[13px] font-bold text-sky-text">
          {getInitials(user?.full_name)}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-display text-[13px] font-semibold text-navy">
            {user?.full_name || 'User'}
          </div>
          <div className="text-[11px] text-ink-soft">{user?.role || 'Config steward'}</div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Account menu"
            className="rounded-md p-1 text-line transition-colors hover:text-ink-soft focus-visible:outline-none"
          >
            <ChevronsUpDown className="h-[18px] w-[18px]" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-56">
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
              <UserIcon className="mr-2 h-4 w-4" />
              <span>Profile</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNavigation('/settings')}>
              <Settings className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut className="mr-2 h-4 w-4 text-danger" />
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
        <SheetContent side="left" className="w-[264px] p-0">
          {content}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      className="sticky top-0 hidden h-screen flex-none border-r border-line lg:block"
      style={{ width: DRAWER_WIDTH }}
    >
      {content}
    </aside>
  );
};

export default Sidebar;
export { DRAWER_WIDTH };
