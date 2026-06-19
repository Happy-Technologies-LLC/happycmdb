// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useRef, useState } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Focus,
  Download,
  Server,
  Cloud as CloudIcon,
  Box,
  Grid3x3,
  Code,
  Database,
  Network,
  HardDrive,
  Scale,
  CloudCog,
} from 'lucide-react';
import cytoscape, { Core, ElementDefinition, NodeSingular } from 'cytoscape';
import { CIRelationship } from '../../services/ci.service';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { brand, ciTypeColors, statusColors } from '@/lib/brandColors';

interface DependencyGraphProps {
  ciId: string;
  relationships: CIRelationship[];
  height?: number;
  depth?: number;
  onDepthChange?: (depth: number) => void;
}

const CI_TYPE_COLORS = ciTypeColors;

const CI_TYPE_SHAPES: Record<string, string> = {
  server: 'rectangle',
  'virtual-machine': 'roundrectangle',
  container: 'hexagon',
  application: 'ellipse',
  service: 'diamond',
  database: 'barrel',
  'network-device': 'octagon',
  storage: 'vee',
  'load-balancer': 'rhomboid',
  'cloud-resource': 'star',
};

// Icon SVG data URIs for node backgrounds
const CI_TYPE_ICONS: Record<string, string> = {
  server: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjgiIHg9IjIiIHk9IjIiIHJ4PSIyIiByeT0iMiIvPjxyZWN0IHdpZHRoPSIyMCIgaGVpZ2h0PSI4IiB4PSIyIiB5PSIxNCIgcng9IjIiIHJ5PSIyIi8+PGxpbmUgeDE9IjYiIHgyPSI2LjAxIiB5MT0iNiIgeTI9IjYiLz48bGluZSB4MT0iNiIgeDI9IjYuMDEiIHkxPSIxOCIgeTI9IjE4Ii8+PC9zdmc+',
  'virtual-machine': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE3LjUgMTlINEM5LjUgMTkgNiAxNS41IDYgMTFjMC00LjUgMy41LTggOC04IDQuNSAwIDguMSAzLjUgOC41IDcuOSAwIC4xIDAgLjMuMSAxLjF6Ii8+PHBhdGggZD0iTTEzIDE3djMuNWMwIC42LS40IDEtMSAxaC0yYy0uNiAwLTEtLjQtMS0xVjE3Ii8+PC9zdmc+',
  container: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTIxIDE2VjhhMiAyIDAgMCAwLTEtMS43M2wtNy00YTIgMiAwIDAgMC0yIDBsLTcgNEEyIDIgMCAwIDAgMyA4djhhMiAyIDAgMCAwIDEgMS43M2w3IDRhMiAyIDAgMCAwIDIgMGw3LTRBMiAyIDAgMCAwIDIxIDE2eiIvPjxwb2x5bGluZSBwb2ludHM9IjMuMjkgNyAxMiAxMi4wOCAyMC43MSA3Ii8+PGxpbmUgeDE9IjEyIiB4Mj0iMTIiIHkxPSIyMi4wOCIgeTI9IjEyIi8+PC9zdmc+',
  application: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3Qgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiB4PSIzIiB5PSIzIiByeD0iMiIvPjxwYXRoIGQ9Ik0zIDloMTgiLz48cGF0aCBkPSJNMyAxNWgxOCIvPjxwYXRoIGQ9Ik05IDN2MTgiLz48cGF0aCBkPSJNMTUgM3YxOCIvPjwvc3ZnPg==',
  service: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBvbHlsaW5lIHBvaW50cz0iMTYgMTggMjIgMTIgMTYgNiIvPjxwb2x5bGluZSBwb2ludHM9IjggNiAyIDEyIDggMTgiLz48L3N2Zz4=',
  database: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGVsbGlwc2UgY3g9IjEyIiBjeT0iNSIgcng9IjkiIHJ5PSIzIi8+PHBhdGggZD0iTTMgNXYxNGE5IDMgMCAwIDAgMTggMFY1Ii8+PC9zdmc+',
  'network-device': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiB4PSI0IiB5PSI0IiByeD0iMiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjIiLz48cGF0aCBkPSJNMTIgNnYyIi8+PHBhdGggZD0iTTEyIDE2djIiLz48cGF0aCBkPSJtNiAxMiAyIDIiLz48cGF0aCBkPSJtMTYgMTAgMiAyIi8+PC9zdmc+',
  storage: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0ibTYgOCAyLTQgMy00IDMgNCAyIDQiLz48cGF0aCBkPSJNNCAxMmgyIi8+PHBhdGggZD0iTTE4IDEyaDIiLz48cGF0aCBkPSJNNiAyMGgyIi8+PHBhdGggZD0iTTE2IDIwaDIiLz48cGF0aCBkPSJNNiAxNmgyIi8+PHBhdGggZD0iTTE2IDE2aDIiLz48cGF0aCBkPSJNNiA4djEyIi8+PHBhdGggZD0iTTE4IDh2MTIiLz48L3N2Zz4=',
  'load-balancer': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0ibTMgOSAzLTMgMy0zIi8+PHBhdGggZD0iTTYgOXYxMmExIDEgMCAwIDAgMSAxaDEyYTEgMSAwIDAgMCAxLTF2LTIiLz48cGF0aCBkPSJtMjEgOC0zIDMtMyAzIi8+PHBhdGggZD0iTTE4IDl2MWExIDEgMCAwIDEtMSAxaC00YTEgMSAwIDAgMS0xLTFWOSIvPjwvc3ZnPg==',
  'cloud-resource': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMyIvPjxwYXRoIGQ9Ik0xMiAzdjMiLz48cGF0aCBkPSJNMTIgMTh2MyIvPjxwYXRoIGQ9Ik0zIDEyaDMiLz48cGF0aCBkPSJNMTggMTJoMyIvPjxwYXRoIGQ9Im0xOSA2LTIuMSAyLjEiLz48cGF0aCBkPSJtNy4xIDE1LjktMi4xIDIuMSIvPjxwYXRoIGQ9Im0xOSAxOC0yLjEtMi4xIi8+PHBhdGggZD0ibTcuMSA4LjEtMi4xLTIuMSIvPjwvc3ZnPg==',
};


export const DependencyGraph: React.FC<DependencyGraphProps> = ({
  ciId,
  relationships,
  height = 600,
  depth = 1,
  onDepthChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [layout, setLayout] = useState<'hierarchical' | 'circular' | 'grid'>('hierarchical');
  const [showLabels, setShowLabels] = useState(true);
  const [localDepth, setLocalDepth] = useState(depth);

  useEffect(() => {
    if (!containerRef.current || !relationships.length) return;

    const nodes = new Map<string, ElementDefinition>();
    const edges: ElementDefinition[] = [];

    relationships.forEach((rel) => {
      if (rel.source_ci && !nodes.has(rel.source_ci.id)) {
        nodes.set(rel.source_ci.id, {
          data: {
            id: rel.source_ci.id,
            label: rel.source_ci.name,
            type: rel.source_ci.type,
            status: rel.source_ci.status,
            environment: rel.source_ci.environment,
          },
        });
      }

      if (rel.target_ci && !nodes.has(rel.target_ci.id)) {
        nodes.set(rel.target_ci.id, {
          data: {
            id: rel.target_ci.id,
            label: rel.target_ci.name,
            type: rel.target_ci.type,
            status: rel.target_ci.status,
            environment: rel.target_ci.environment,
          },
        });
      }

      edges.push({
        data: {
          id: rel.id,
          source: rel.source_ci_id,
          target: rel.target_ci_id,
          label: rel.type,
          relationshipType: rel.type,
        },
      });
    });

    const textColor = brand.ink;
    const edgeColor = brand.line;

    // Status border colors by lifecycle state
    const statusBorderColors: Record<string, string> = {
      active: statusColors.active,
      inactive: statusColors.inactive,
      maintenance: statusColors.maintenance,
      decommissioned: statusColors.decommissioned,
    };

    const cy = cytoscape({
      container: containerRef.current,
      elements: [...Array.from(nodes.values()), ...edges],
      style: [
        {
          selector: 'node',
          style: {
            shape: ((ele: NodeSingular) => {
              const type = ele.data('type');
              return CI_TYPE_SHAPES[type] || 'ellipse';
            }) as any,
            'background-color': ((ele: NodeSingular) => {
              const type = ele.data('type');
              return CI_TYPE_COLORS[type] || brand.inkSoft;
            }) as any,
            'background-image': ((ele: NodeSingular) => {
              const type = ele.data('type');
              return CI_TYPE_ICONS[type] || '';
            }) as any,
            'background-clip': 'none',
            'background-width': '50%',
            'background-height': '50%',
            'border-width': 3,
            'border-color': ((ele: NodeSingular) => {
              const status = ele.data('status');
              return statusBorderColors[status] || statusColors.inactive;
            }) as any,
            label: showLabels ? 'data(label)' : '',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 8,
            color: textColor,
            'font-size': 10,
            'text-outline-width': 2,
            'text-outline-color': ((ele: NodeSingular) => {
              const type = ele.data('type');
              return CI_TYPE_COLORS[type] || brand.inkSoft;
            }) as any,
            width: 50,
            height: 50,
          },
        },
        {
          selector: `node[id="${ciId}"]`,
          style: {
            'border-width': 5,
            'border-color': brand.warning,
            width: 70,
            height: 70,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': edgeColor,
            'target-arrow-color': edgeColor,
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: showLabels ? 'data(label)' : '',
            'font-size': 8,
            color: textColor,
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 5,
            'border-color': brand.warning,
          },
        },
      ],
      layout: getLayoutConfig(layout),
      minZoom: 0.3,
      maxZoom: 3,
    });

    cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      const data = node.data();
      console.log('Node clicked:', data);
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
    };
  }, [relationships, ciId, showLabels, layout]);

  const getLayoutConfig = (layoutType: string) => {
    switch (layoutType) {
      case 'hierarchical':
        return {
          name: 'breadthfirst',
          directed: true,
          padding: 50,
          spacingFactor: 1.5,
        };
      case 'circular':
        return {
          name: 'circle',
          padding: 50,
          spacingFactor: 1.5,
        };
      case 'grid':
        return {
          name: 'grid',
          padding: 50,
          spacingFactor: 1.5,
        };
      default:
        return {
          name: 'breadthfirst',
          directed: true,
          padding: 50,
        };
    }
  };

  const handleLayoutChange = (newLayout: 'hierarchical' | 'circular' | 'grid') => {
    setLayout(newLayout);
  };

  const handleZoomIn = () => {
    if (cyRef.current) {
      cyRef.current.zoom(cyRef.current.zoom() * 1.2);
    }
  };

  const handleZoomOut = () => {
    if (cyRef.current) {
      cyRef.current.zoom(cyRef.current.zoom() * 0.8);
    }
  };

  const handleCenter = () => {
    if (cyRef.current) {
      cyRef.current.fit(undefined, 50);
    }
  };

  const handleDownload = () => {
    if (cyRef.current) {
      const png = cyRef.current.png({ scale: 2, bg: '#fff' });
      const link = document.createElement('a');
      link.href = png;
      link.download = `dependency-graph-${ciId}.png`;
      link.click();
    }
  };

  const handleDepthChange = (newDepth: number) => {
    setLocalDepth(newDepth);
    if (onDepthChange) {
      onDepthChange(newDepth);
    }
  };

  if (!relationships.length) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-muted-foreground">
          No relationships to display
        </p>
      </Card>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Dependency Graph</h2>
        <div className="flex gap-2 items-center">
          <div className="flex border rounded-md">
            <Button
              variant={layout === 'hierarchical' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleLayoutChange('hierarchical')}
              className="rounded-r-none"
            >
              Hierarchical
            </Button>
            <Button
              variant={layout === 'circular' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleLayoutChange('circular')}
              className="rounded-none border-l border-r"
            >
              Circular
            </Button>
            <Button
              variant={layout === 'grid' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleLayoutChange('grid')}
              className="rounded-l-none"
            >
              Grid
            </Button>
          </div>

          <div className="flex items-center gap-2 border rounded-md px-3 py-1">
            <Label htmlFor="depth" className="text-sm whitespace-nowrap">Depth:</Label>
            <select
              id="depth"
              value={localDepth}
              onChange={(e) => handleDepthChange(parseInt(e.target.value))}
              className="text-sm bg-transparent border-none focus:outline-none focus:ring-0 cursor-pointer"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="labels"
              checked={showLabels}
              onCheckedChange={setShowLabels}
            />
            <Label htmlFor="labels" className="text-sm">Labels</Label>
          </div>

          <Button size="icon" variant="outline" onClick={handleZoomIn} title="Zoom In">
            <ZoomIn className="h-4 w-4" />
          </Button>

          <Button size="icon" variant="outline" onClick={handleZoomOut} title="Zoom Out">
            <ZoomOut className="h-4 w-4" />
          </Button>

          <Button size="icon" variant="outline" onClick={handleCenter} title="Center">
            <Focus className="h-4 w-4" />
          </Button>

          <Button size="icon" variant="outline" onClick={handleDownload} title="Download as PNG">
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="border rounded-lg bg-background"
        style={{ height, width: '100%' }}
      />

      {/* Legend */}
      <div className="mt-4 space-y-3">
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Status (Border Color)</h4>
          <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-[3px]" style={{ borderColor: brand.warning }} />
              <span className="text-xs">Current CI</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-4 h-4 rounded-full border-[3px]"
                style={{ borderColor: statusColors.active }}
              />
              <span className="text-xs capitalize">Active</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-4 h-4 rounded-full border-[3px]"
                style={{ borderColor: statusColors.inactive }}
              />
              <span className="text-xs capitalize">Inactive</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-4 h-4 rounded-full border-[3px]"
                style={{ borderColor: statusColors.maintenance }}
              />
              <span className="text-xs capitalize">Maintenance</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-[3px]" style={{ borderColor: statusColors.decommissioned }} />
              <span className="text-xs capitalize">Decommissioned</span>
            </div>
          </div>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">CI Type (Shape & Color)</h4>
          <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS.server }}>
                <Server className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Server</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-sm flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS['virtual-machine'] }}>
                <CloudIcon className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">VM</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS.container, clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' }}>
                <Box className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Container</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS.application }}>
                <Grid3x3 className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Application</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS.service, clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' }}>
                <Code className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Service</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-sm flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS.database }}>
                <Database className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Database</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS['network-device'], clipPath: 'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)' }}>
                <Network className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Network</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS.storage, clipPath: 'polygon(50% 0%, 100% 100%, 0% 100%)' }}>
                <HardDrive className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Storage</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS['load-balancer'], clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' }}>
                <Scale className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Load Balancer</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 flex items-center justify-center" style={{ backgroundColor: CI_TYPE_COLORS['cloud-resource'], clipPath: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' }}>
                <CloudCog className="w-3 h-3 text-white" />
              </div>
              <span className="text-xs">Cloud</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DependencyGraph;
