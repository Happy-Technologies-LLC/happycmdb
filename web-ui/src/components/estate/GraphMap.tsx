// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import { CATEGORY_ORDER, isDimmed, type Category, type EstateSample } from '@/lib/estate';

const CATEGORY_TOKEN: Record<Category, string> = {
  services: '--hh-accent',
  apps: '--hh-indigo',
  data: '--hh-success',
  infra: '--hh-stage-accent',
};

/** Room for the stage title (top) and the legend (bottom) around the graph. */
const LAYOUT_PADDING = 96;

/**
 * ME7: the dependency graph, Cytoscape on the Stage background (N1). Colours are the design-system tokens read from
 * the mounted element, so light and dark need no second palette. Nodes open their CI on tap (ME16); the List view
 * is the keyboard path, since a canvas has no focusable nodes.
 */
export function GraphMap({
  sample,
  filter,
  onOpen,
}: {
  sample: EstateSample;
  filter: Category | null;
  onOpen: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const cy = useRef<Core | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const token = (name: string) => getComputedStyle(el).getPropertyValue(name).trim();
    const fill = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, token(CATEGORY_TOKEN[c])]));
    let graph: Core;
    try {
      graph = cytoscape({
        container: el,
        elements: [
          ...sample.nodes.map((n) => ({ data: { id: n.id, label: n.name, category: n.category } })),
          ...sample.edges.map((e) => ({
            data: { id: `${e.source}|${e.type}|${e.target}`, source: e.source, target: e.target },
          })),
        ],
        style: [
          {
            selector: 'node',
            style: {
              width: 10,
              height: 10,
              'background-color': (n) =>
                fill[n.data('category') as Category] ?? token('--hh-stage-accent'),
              label: '',
            },
          },
          {
            selector: 'edge',
            style: {
              width: 1,
              'line-color': token('--hh-stage-glass-active'),
              'curve-style': 'haystack',
            },
          },
          { selector: '.dim', style: { opacity: 0.18 } },
          {
            selector: 'node:active, node:selected',
            style: { 'border-width': 2, 'border-color': token('--hh-stage-text') },
          },
        ],
        layout: { name: 'cose', animate: false, padding: LAYOUT_PADDING, fit: true },
        userZoomingEnabled: false,
        userPanningEnabled: false,
        boxSelectionEnabled: false,
        autoungrabify: true,
      });
    } catch {
      setFailed(true);
      return;
    }
    graph.on('tap', 'node', (event) => open.current(String(event.target.id())));
    cy.current = graph;
    return () => {
      graph.destroy();
      cy.current = null;
    };
  }, [sample]);

  useEffect(() => {
    cy.current?.batch(() => {
      cy.current?.nodes().forEach((n) => {
        n.toggleClass('dim', isDimmed(n.data('category') as Category, filter));
      });
    });
  }, [filter, sample]);

  if (failed) {
    return (
      <p
        role="status"
        className="hh-mono p-[var(--hh-pad)] pt-[var(--hh-pad)] text-[length:var(--hh-text-xs)] text-[var(--hh-stage-muted)]"
      >
        The graph needs canvas support and could not start in this browser. Use the List view.
      </p>
    );
  }
  return (
    <div
      ref={host}
      role="img"
      aria-label="Dependency graph of the estate. Use the List view for keyboard access."
      className="h-full w-full"
    />
  );
}
