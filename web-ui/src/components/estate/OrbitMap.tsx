// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import {
  ORBIT_CENTER,
  ORBIT_RINGS,
  ORBIT_VIEWBOX,
  isDimmed,
  orbitLayout,
  type Category,
  type EstateSample,
} from '@/lib/estate';

const CATEGORY_FILL: Record<Category, string> = {
  services: 'var(--hh-accent)',
  apps: 'var(--hh-indigo)',
  data: 'var(--hh-success)',
  infra: 'var(--hh-stage-accent)',
};

/**
 * ME6: the orbit, one tilted ring per category, drawn in SVG on the Stage background (N1: static SVG in this slice,
 * the three.js renderer is a later one). Every dot is a button: Tab to it, Enter or Space opens the CI (ME16).
 */
export function OrbitMap({
  sample,
  filter,
  onOpen,
}: {
  sample: EstateSample;
  filter: Category | null;
  onOpen: (id: string) => void;
}) {
  const positions = useMemo(() => orbitLayout(sample.nodes), [sample.nodes]);
  return (
    <svg
      role="group"
      aria-label="Orbit view of the estate"
      viewBox={`0 0 ${ORBIT_VIEWBOX.width} ${ORBIT_VIEWBOX.height}`}
      preserveAspectRatio="xMidYMid slice"
      className="h-full w-full"
    >
      {ORBIT_RINGS.map((ring) => (
        <ellipse
          key={ring.category}
          cx={ORBIT_CENTER.x}
          cy={ORBIT_CENTER.y}
          rx={ring.rx}
          ry={ring.ry}
          fill="none"
          stroke="var(--hh-stage-glass-active)"
        />
      ))}
      {sample.edges.map((e) => {
        const a = positions.get(e.source);
        const b = positions.get(e.target);
        if (!a || !b) return null;
        return (
          <line
            key={`${e.source}|${e.type}|${e.target}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="var(--hh-stage-glass-active)"
            opacity={filter ? 0.25 : 0.6}
          />
        );
      })}
      {sample.nodes.map((n) => {
        const p = positions.get(n.id);
        if (!p) return null;
        const open = () => onOpen(n.id);
        return (
          <g
            key={n.id}
            role="button"
            tabIndex={0}
            aria-label={`${n.name}, ${n.type}`}
            data-ci={n.id}
            opacity={isDimmed(n.category, filter) ? 0.18 : 1}
            className="cursor-pointer outline-none focus-visible:[&>circle]:stroke-[var(--hh-stage-text)]"
            onClick={open}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
              }
            }}
          >
            <title>{n.name}</title>
            <circle
              cx={p.x}
              cy={p.y}
              r={p.r}
              fill={CATEGORY_FILL[n.category]}
              strokeWidth={2}
              stroke="transparent"
            />
          </g>
        );
      })}
    </svg>
  );
}
