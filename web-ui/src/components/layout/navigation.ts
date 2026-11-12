// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1252 S1 (N1, MF1): the app's navigation, one source for the rail and the section strip.
 *
 * The design freeze fixes the rail at seven destinations in this order. A rail item opens its section's first screen;
 * the section's other screens sit in the strip above the page (components/layout/SectionNav.tsx), because the
 * design-system rail is an icon rail and cannot hold sub-menus. Every route the 21-item sidebar reached is listed
 * exactly once; `/cis/:id` belongs to the CIs section through its `/cis` prefix.
 */

export interface NavItem {
  label: string;
  path: string;
}

export interface NavSection {
  id: string;
  label: string;
  /** Phosphor glyph slug. */
  icon: string;
  items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'squares-four',
    items: [
      { label: 'Overview', path: '/' },
      { label: 'Executive', path: '/dashboards/executive' },
      { label: 'CIO', path: '/dashboards/cio' },
      { label: 'ITSM', path: '/dashboards/itsm' },
      { label: 'FinOps', path: '/dashboards/finops' },
      { label: 'Business service', path: '/dashboards/business-service' },
    ],
  },
  {
    id: 'cis',
    label: 'Configuration items',
    icon: 'cube',
    items: [
      { label: 'Configuration items', path: '/cis' },
      { label: 'Inventory', path: '/inventory' },
      { label: 'Health', path: '/cmdb-health' },
      { label: 'Anomalies', path: '/anomalies' },
    ],
  },
  {
    id: 'services',
    label: 'Business services',
    icon: 'stack',
    items: [
      { label: 'Business services', path: '/business-services' },
      { label: 'Financial management', path: '/financial-management' },
    ],
  },
  {
    id: 'discovery',
    label: 'Discovery',
    icon: 'magnifying-glass',
    items: [
      { label: 'Discovery jobs', path: '/discovery' },
      { label: 'Agents', path: '/agents' },
      { label: 'Job queue', path: '/jobs' },
      { label: 'Credentials', path: '/credentials' },
      { label: 'Credential sets', path: '/credential-sets' },
    ],
  },
  {
    id: 'connectors',
    label: 'Connectors',
    icon: 'plugs-connected',
    items: [
      { label: 'Connectors', path: '/connectors' },
      { label: 'Catalog', path: '/connectors/catalog' },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    icon: 'chart-bar',
    items: [
      { label: 'Analytics and reporting', path: '/analytics' },
      { label: 'Pattern learning', path: '/ai/patterns' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'gear-six',
    items: [{ label: 'Settings', path: '/settings' }],
  },
];

const covers = (itemPath: string, pathname: string): boolean =>
  itemPath === '/' ? pathname === '/' : pathname === itemPath || pathname.startsWith(`${itemPath}/`);

export interface NavMatch {
  section: NavSection;
  item: NavItem;
}

/** The section and item for a pathname: the longest item path that covers it, or null (an unknown route). */
export function matchNav(pathname: string): NavMatch | null {
  let best: NavMatch | null = null;
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (covers(item.path, pathname) && (!best || item.path.length > best.item.path.length)) {
        best = { section, item };
      }
    }
  }
  return best;
}
