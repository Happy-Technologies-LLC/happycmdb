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
  Brain,
  Sparkles,
  TrendingUp,
  Users,
  DollarSign,
  Shield,
  Target,
  Network,
  PieChart,
} from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

const DRAWER_WIDTH = 240;

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
    title: '',
    items: [
      {
        text: 'Dashboard',
        icon: <LayoutDashboard className="h-5 w-5" />,
        path: '/',
      },
    ],
  },
  {
    title: 'Business Insights',
    items: [
      {
        text: 'Executive Dashboard',
        icon: <TrendingUp className="h-5 w-5" />,
        path: '/dashboards/executive',
      },
      {
        text: 'CIO Dashboard',
        icon: <Users className="h-5 w-5" />,
        path: '/dashboards/cio',
      },
      {
        text: 'ITSM Dashboard',
        icon: <Activity className="h-5 w-5" />,
        path: '/dashboards/itsm',
      },
      {
        text: 'FinOps Dashboard',
        icon: <DollarSign className="h-5 w-5" />,
        path: '/dashboards/finops',
      },
      {
        text: 'Business Service',
        icon: <Target className="h-5 w-5" />,
        path: '/dashboards/business-service',
      },
    ],
  },
  {
    title: 'Service Management',
    items: [
      {
        text: 'Business Services',
        icon: <Network className="h-5 w-5" />,
        path: '/business-services',
      },
      {
        text: 'Financial Management',
        icon: <PieChart className="h-5 w-5" />,
        path: '/financial-management',
      },
    ],
  },
  {
    title: 'CMDB',
    items: [
      {
        text: 'Configuration Items',
        icon: <Database className="h-5 w-5" />,
        path: '/cis',
      },
      {
        text: 'Health Monitoring',
        icon: <Activity className="h-5 w-5" />,
        path: '/cmdb-health',
      },
      {
        text: 'Anomaly Detection',
        icon: <AlertTriangle className="h-5 w-5" />,
        path: '/anomalies',
      },
    ],
  },
  {
    title: 'Discovery',
    items: [
      {
        text: 'Discovery Jobs',
        icon: <Cloud className="h-5 w-5" />,
        path: '/discovery',
      },
      {
        text: 'Discovery Agents',
        icon: <Server className="h-5 w-5" />,
        path: '/agents',
      },
    ],
  },
  {
    title: 'Integration',
    items: [
      {
        text: 'Connectors',
        icon: <Plug className="h-5 w-5" />,
        path: '/connectors',
      },
      {
        text: 'Connector Catalog',
        icon: <Package className="h-5 w-5" />,
        path: '/connectors/catalog',
      },
    ],
  },
  {
    title: 'AI & Analytics',
    items: [
      {
        text: 'Pattern Learning',
        icon: <Sparkles className="h-5 w-5" />,
        path: '/ai/patterns',
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      {
        text: 'Credentials',
        icon: <Key className="h-5 w-5" />,
        path: '/credentials',
      },
    ],
  },
];

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
  variant?: 'permanent' | 'temporary';
}

const Sidebar: React.FC<SidebarProps> = ({
  open = true,
  onClose,
  variant = 'permanent',
}) => {
  const navigate = useNavigate();
  const location = useLocation();

  const handleNavigation = (path: string) => {
    navigate(path);
    if (onClose && variant === 'temporary') {
      onClose();
    }
  };

  const isSelected = (path: string): boolean => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(path);
  };

  const sidebarContent = (
    <>
      {/* Spacer for fixed header */}
      <div className="h-16" />

      <div className="flex flex-col h-full overflow-auto">
        <nav className="flex-1 px-2 py-4">
          {menuCategories.map((category, categoryIndex) => (
            <div key={category.title || 'main'} className="mb-4">
              {category.title && (
                <h3 className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {category.title}
                </h3>
              )}
              {category.items.map((item) => (
                <button
                  key={item.text}
                  onClick={() => handleNavigation(item.path)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-normal transition-colors mb-1',
                    isSelected(item.path)
                      ? 'bg-primary text-primary-foreground font-semibold hover:bg-primary/90'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <span className={cn(
                    'flex items-center justify-center w-5 h-5',
                    isSelected(item.path) ? 'text-primary-foreground' : 'text-muted-foreground'
                  )}>
                    {item.icon}
                  </span>
                  <span className={isSelected(item.path) ? 'font-semibold' : 'font-normal'}>
                    {item.text}
                  </span>
                </button>
              ))}
              {categoryIndex < menuCategories.length - 1 && <Separator className="my-3" />}
            </div>
          ))}
        </nav>

        <div className="px-4 py-4 border-t">
          <p className="text-xs text-muted-foreground text-center">
            HappyCMDB v3.0
          </p>
          <p className="text-xs text-muted-foreground text-center">
            Open Source
          </p>
        </div>
      </div>
    </>
  );

  if (variant === 'temporary') {
    return (
      <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose?.()}>
        <SheetContent side="left" className="p-0 w-60">
          {sidebarContent}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      className="fixed left-0 top-0 h-screen bg-background border-r"
      style={{ width: DRAWER_WIDTH }}
    >
      {sidebarContent}
    </aside>
  );
};

export default Sidebar;
export { DRAWER_WIDTH };
