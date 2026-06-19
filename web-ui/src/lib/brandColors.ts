// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Happy Technologies brand palette as concrete hex values, for use in
 * contexts that cannot consume CSS custom properties or Tailwind classes
 * (Recharts series, Cytoscape styles, canvas, inline SVG fills).
 *
 * Mirrors src/styles/ds/tokens/colors.css. Keep in sync with that file.
 */
export const brand = {
  navy: '#1e2a4a',
  navyLight: '#2d3d66',
  navyDeep: '#1a2744',
  sky: '#5cc3fb',
  skyLight: '#7ad0fc',
  skyText: '#1a7fb8',
  coral: '#ff7564',
  coralDark: '#f0604e',
  success: '#10b981',
  warning: '#f5a623',
  danger: '#f0604e',
  ink: '#2d3748',
  inkSoft: '#4a5568',
  line: '#dce4ed',
  warm: '#f5f8fb',
  warmAlt: '#edf2f7',
} as const;

/**
 * Ordered categorical palette for multi-series charts. Sky leads (signature
 * accent), navy anchors, coral for emphasis, then supporting hues.
 */
export const chartSeries: string[] = [
  brand.sky,
  brand.navy,
  brand.coral,
  brand.skyText,
  brand.warning,
  brand.success,
  brand.navyLight,
  brand.skyLight,
];

/** Map a 0–100 health score to a brand status color. */
export const healthColor = (score: number): string =>
  score >= 80 ? brand.success : score >= 50 ? brand.warning : brand.danger;

/**
 * Categorical color per CI type for graph/topology nodes. Drawn from the
 * brand palette so the dependency graph and service maps stay on-brand
 * while keeping types visually distinct.
 */
export const ciTypeColors: Record<string, string> = {
  server: brand.sky,
  'virtual-machine': brand.navy,
  container: brand.skyLight,
  application: brand.coral,
  service: brand.success,
  database: brand.skyText,
  'network-device': brand.navyLight,
  storage: brand.warning,
  'load-balancer': brand.coralDark,
  'cloud-resource': brand.navyDeep,
};

/** Brand status color for CI lifecycle states. */
export const statusColors: Record<string, string> = {
  active: brand.success,
  inactive: brand.inkSoft,
  maintenance: brand.warning,
  decommissioned: brand.danger,
};

/** Brand color per environment tier. */
export const environmentColors: Record<string, string> = {
  production: brand.navy,
  staging: brand.sky,
  development: brand.skyText,
  test: brand.coral,
};
