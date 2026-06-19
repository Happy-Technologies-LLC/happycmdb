// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useRef, useState } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Focus,
  Download,
  RefreshCw,
  Layers,
  Server,
  Database,
  Network,
  Box,
} from 'lucide-react';
import cytoscape, { Core, ElementDefinition, NodeSingular } from 'cytoscape';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { brand, ciTypeColors } from '@/lib/brandColors';

interface BusinessService {
  id: string;
  name: string;
  tier: number;
  criticality: string;
}

interface CI {
  id: string;
  name: string;
  type: string;
  status: string;
  environment: string;
}

interface ServiceMapProps {
  businessServiceId?: string;
  height?: number;
  onNodeClick?: (node: { id: string; type: 'service' | 'ci'; data: any }) => void;
}

const SERVICE_COLORS = {
  TIER_0: brand.danger,
  TIER_1: brand.coral,
  TIER_2: brand.warning,
  TIER_3: brand.sky,
};

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

// Mock data - will be replaced with actual API calls
const mockData = {
  services: [
    { id: 'bs-1', name: 'Customer Portal', tier: 0, criticality: 'TIER_0' },
    { id: 'bs-2', name: 'Internal ERP', tier: 1, criticality: 'TIER_1' },
  ],
  cis: [
    { id: 'ci-1', name: 'Web Server 1', type: 'server', status: 'active', environment: 'production' },
    { id: 'ci-2', name: 'App Server 1', type: 'application', status: 'active', environment: 'production' },
    { id: 'ci-3', name: 'Database Primary', type: 'database', status: 'active', environment: 'production' },
    { id: 'ci-4', name: 'Load Balancer', type: 'load-balancer', status: 'active', environment: 'production' },
    { id: 'ci-5', name: 'Cache Server', type: 'server', status: 'active', environment: 'production' },
  ],
  relationships: [
    { from: 'bs-1', to: 'ci-1', type: 'SUPPORTS' },
    { from: 'bs-1', to: 'ci-4', type: 'SUPPORTS' },
    { from: 'ci-4', to: 'ci-1', type: 'ROUTES_TO' },
    { from: 'ci-1', to: 'ci-2', type: 'CONNECTS_TO' },
    { from: 'ci-2', to: 'ci-3', type: 'USES' },
    { from: 'ci-2', to: 'ci-5', type: 'USES' },
  ],
};

export const ServiceMap: React.FC<ServiceMapProps> = ({
  businessServiceId,
  height = 700,
  onNodeClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [layout, setLayout] = useState<'hierarchical' | 'dagre' | 'breadthfirst'>('hierarchical');
  const [showLabels, setShowLabels] = useState(true);
  const [groupByLayer, setGroupByLayer] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;

    const elements: ElementDefinition[] = [];

    // Add business service nodes
    mockData.services.forEach((service) => {
      if (!businessServiceId || service.id === businessServiceId) {
        elements.push({
          data: {
            id: service.id,
            label: service.name,
            type: 'business-service',
            tier: service.tier,
            criticality: service.criticality,
            layer: 0,
          },
          classes: 'business-service',
        });
      }
    });

    // Add CI nodes
    mockData.cis.forEach((ci) => {
      elements.push({
        data: {
          id: ci.id,
          label: ci.name,
          type: ci.type,
          status: ci.status,
          environment: ci.environment,
          layer: 1,
        },
        classes: 'ci',
      });
    });

    // Add edges
    mockData.relationships.forEach((rel, idx) => {
      if (!businessServiceId || rel.from === businessServiceId || mockData.relationships.some(r => r.to === rel.from)) {
        elements.push({
          data: {
            id: `edge-${idx}`,
            source: rel.from,
            target: rel.to,
            label: rel.type,
          },
        });
      }
    });

    const textColor = brand.ink;
    const edgeColor = brand.line;

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        // Business Service nodes
        {
          selector: 'node.business-service',
          style: {
            shape: 'round-rectangle',
            'background-color': ((ele: NodeSingular) => {
              const criticality = ele.data('criticality');
              return SERVICE_COLORS[criticality as keyof typeof SERVICE_COLORS] || brand.inkSoft;
            }) as any,
            'border-width': 4,
            'border-color': brand.warning,
            label: showLabels ? 'data(label)' : '',
            'text-valign': 'center',
            'text-halign': 'center',
            color: '#ffffff',
            'font-size': 14,
            'font-weight': 'bold',
            'text-outline-width': 2,
            'text-outline-color': ((ele: NodeSingular) => {
              const criticality = ele.data('criticality');
              return SERVICE_COLORS[criticality as keyof typeof SERVICE_COLORS] || brand.inkSoft;
            }) as any,
            width: 120,
            height: 80,
            padding: '15px',
          },
        },
        // CI nodes
        {
          selector: 'node.ci',
          style: {
            shape: ((ele: NodeSingular) => {
              const type = ele.data('type');
              return CI_TYPE_SHAPES[type] || 'ellipse';
            }) as any,
            'background-color': ((ele: NodeSingular) => {
              const type = ele.data('type');
              return CI_TYPE_COLORS[type] || brand.inkSoft;
            }) as any,
            'border-width': 3,
            'border-color': ((ele: NodeSingular) => {
              const status = ele.data('status');
              const colors: Record<string, string> = {
                active: brand.success,
                inactive: brand.inkSoft,
                maintenance: brand.warning,
                decommissioned: brand.danger,
              };
              return colors[status] || brand.inkSoft;
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
        // Edges
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
            'text-background-color': '#fff',
            'text-background-opacity': 0.8,
            'text-background-padding': '2px',
          },
        },
        // Selected nodes
        {
          selector: 'node:selected',
          style: {
            'border-width': 5,
            'border-color': brand.warning,
          },
        },
      ],
      layout: getLayoutConfig(layout),
      minZoom: 0.2,
      maxZoom: 4,
    });

    cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      const data = node.data();
      const nodeType = node.hasClass('business-service') ? 'service' : 'ci';
      console.log('Node clicked:', nodeType, data);
      if (onNodeClick) {
        onNodeClick({ id: data.id, type: nodeType, data });
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
    };
  }, [businessServiceId, showLabels, layout]);

  const getLayoutConfig = (layoutType: string) => {
    switch (layoutType) {
      case 'hierarchical':
        return {
          name: 'breadthfirst',
          directed: true,
          padding: 80,
          spacingFactor: 2,
          grid: groupByLayer,
        };
      case 'dagre':
        return {
          name: 'breadthfirst',
          directed: true,
          padding: 50,
          spacingFactor: 1.75,
        };
      case 'breadthfirst':
        return {
          name: 'breadthfirst',
          directed: true,
          padding: 50,
          spacingFactor: 1.5,
          circle: true,
        };
      default:
        return {
          name: 'breadthfirst',
          directed: true,
          padding: 50,
        };
    }
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
      link.download = `service-map-${businessServiceId || 'all'}.png`;
      link.click();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold">Service Map</h2>
          <p className="text-sm text-muted-foreground">
            Visualize business services and their supporting infrastructure
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <div className="flex border rounded-md">
            <Button
              variant={layout === 'hierarchical' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setLayout('hierarchical')}
              className="rounded-r-none"
            >
              Hierarchical
            </Button>
            <Button
              variant={layout === 'dagre' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setLayout('dagre')}
              className="rounded-none border-l border-r"
            >
              Compact
            </Button>
            <Button
              variant={layout === 'breadthfirst' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setLayout('breadthfirst')}
              className="rounded-l-none"
            >
              Radial
            </Button>
          </div>

          <div className="flex items-center gap-2 border rounded-md px-3 py-1">
            <Switch
              id="group-layers"
              checked={groupByLayer}
              onCheckedChange={setGroupByLayer}
            />
            <Label htmlFor="group-layers" className="text-sm">Group Layers</Label>
          </div>

          <div className="flex items-center gap-2 border rounded-md px-3 py-1">
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
      <div className="grid grid-cols-2 gap-4">
        <Card className="p-4">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Business Service Tiers
          </h4>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ backgroundColor: SERVICE_COLORS.TIER_0 }} />
              <span className="text-xs">Tier 0 - Mission Critical</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ backgroundColor: SERVICE_COLORS.TIER_1 }} />
              <span className="text-xs">Tier 1 - Business Critical</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ backgroundColor: SERVICE_COLORS.TIER_2 }} />
              <span className="text-xs">Tier 2 - Important</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ backgroundColor: SERVICE_COLORS.TIER_3 }} />
              <span className="text-xs">Tier 3 - Standard</span>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Server className="h-4 w-4" />
            CI Status (Border Color)
          </h4>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-[3px] border-success" />
              <span className="text-xs">Active</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-[3px] border-ink-soft" />
              <span className="text-xs">Inactive</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-[3px] border-warning" />
              <span className="text-xs">Maintenance</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-[3px] border-danger" />
              <span className="text-xs">Decommissioned</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default ServiceMap;
