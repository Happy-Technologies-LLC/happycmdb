// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import { useCIs } from '../../hooks/useCIs';
import { Environment } from '../../services/ci.service';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { brand, environmentColors } from '@/lib/brandColors';

interface TopologyMapProps {
  environment?: Environment;
  height?: number;
}

export const TopologyMap: React.FC<TopologyMapProps> = ({
  environment,
  height = 700,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [selectedEnvironment, setSelectedEnvironment] = useState<Environment | ''>(
    environment || ''
  );

  const { data: cisData, isLoading, refetch } = useCIs({
    environment: selectedEnvironment || undefined,
    limit: 500,
  });

  useEffect(() => {
    if (!containerRef.current || !cisData?.data.length) return;

    const elements: ElementDefinition[] = [];
    const environmentGroups = new Map<Environment, string[]>();

    cisData.data.forEach((ci) => {
      elements.push({
        data: {
          id: ci.id,
          label: ci.name,
          type: ci.type,
          status: ci.status,
          environment: ci.environment,
        },
      });

      if (!environmentGroups.has(ci.environment)) {
        environmentGroups.set(ci.environment, []);
      }
      environmentGroups.get(ci.environment)?.push(ci.id);
    });

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (ele) => {
              const env = ele.data('environment');
              return environmentColors[env as Environment] || brand.inkSoft;
            },
            'border-width': 2,
            'border-color': (ele) => {
              const status = ele.data('status');
              if (status === 'active') return brand.success;
              if (status === 'inactive') return brand.inkSoft;
              if (status === 'maintenance') return brand.warning;
              return brand.danger;
            },
            label: 'data(label)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            color: brand.ink,
            'font-size': 9,
            'text-margin-y': 5,
            width: (ele: any) => {
              const type = ele.data('type');
              if (type === 'server' || type === 'database') return 50;
              if (type === 'container' || type === 'service') return 30;
              return 40;
            },
            height: (ele) => {
              const type = ele.data('type');
              if (type === 'server' || type === 'database') return 50;
              if (type === 'container' || type === 'service') return 30;
              return 40;
            },
            shape: (ele) => {
              const type = ele.data('type');
              if (type === 'server') return 'rectangle';
              if (type === 'database') return 'barrel';
              if (type === 'network-device') return 'diamond';
              if (type === 'load-balancer') return 'hexagon';
              return 'ellipse';
            },
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 4,
            'border-color': brand.warning,
          },
        },
      ],
      layout: {
        name: 'grid',
        padding: 50,
        spacingFactor: 1.5,
        avoidOverlap: true,
        condense: true,
      },
      minZoom: 0.2,
      maxZoom: 4,
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
  }, [cisData]);

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
      link.download = 'topology-map.png';
      link.click();
    }
  };

  const handleRefresh = () => {
    refetch();
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Network Topology Map</h2>
        <div className="flex gap-2 items-center">
          <Select
            value={selectedEnvironment}
            onValueChange={(value) => setSelectedEnvironment(value as Environment | '')}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select environment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Environments</SelectItem>
              <SelectItem value="production">Production</SelectItem>
              <SelectItem value="staging">Staging</SelectItem>
              <SelectItem value="development">Development</SelectItem>
              <SelectItem value="test">Test</SelectItem>
            </SelectContent>
          </Select>

          <Button size="icon" variant="outline" onClick={handleRefresh} title="Refresh">
            <Icon name="arrows-clockwise" size={16} />
          </Button>

          <Button size="icon" variant="outline" onClick={handleZoomIn} title="Zoom In">
            <Icon name="magnifying-glass-plus" size={16} />
          </Button>

          <Button size="icon" variant="outline" onClick={handleZoomOut} title="Zoom Out">
            <Icon name="magnifying-glass-minus" size={16} />
          </Button>

          <Button size="icon" variant="outline" onClick={handleCenter} title="Center">
            <Icon name="crosshair" size={16} />
          </Button>

          <Button size="icon" variant="outline" onClick={handleDownload} title="Download as PNG">
            <Icon name="download-simple" size={16} />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Card className="flex items-center justify-center p-12" style={{ height }}>
          <p className="text-muted-foreground">Loading topology...</p>
        </Card>
      ) : !cisData?.data.length ? (
        <Card className="flex items-center justify-center p-12" style={{ height }}>
          <p className="text-muted-foreground">No configuration items found</p>
        </Card>
      ) : (
        <div
          ref={containerRef}
          className="border rounded-lg bg-white"
          style={{ height, width: '100%' }}
        />
      )}

      <div className="mt-4 flex gap-4 flex-wrap items-center">
        <span className="text-xs text-muted-foreground">Environments:</span>
        <Badge className="bg-danger text-white">Production</Badge>
        <Badge className="bg-coral text-white">Staging</Badge>
        <Badge className="bg-success text-white">Development</Badge>
        <Badge className="bg-sky text-white">Test</Badge>
      </div>

      <div className="mt-2 flex gap-4 flex-wrap items-center">
        <span className="text-xs text-muted-foreground">Status:</span>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-success" />
          <span className="text-xs">Active</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-warning" />
          <span className="text-xs">Maintenance</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-ink-soft" />
          <span className="text-xs">Inactive</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-danger" />
          <span className="text-xs">Decommissioned</span>
        </div>
      </div>

      {cisData && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">
            Showing {cisData.data.length} of {cisData.total} configuration items
          </p>
        </div>
      )}
    </div>
  );
};

export default TopologyMap;
