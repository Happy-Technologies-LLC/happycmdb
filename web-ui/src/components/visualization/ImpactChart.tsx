// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import {
  Treemap,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from 'recharts';
import { ImpactAnalysis } from '../../services/ci.service';
import CITypeBadge from '../ci/CITypeBadge';
import CIStatusBadge from '../ci/CIStatusBadge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Separator } from '../ui/separator';
import { brand, ciTypeColors } from '@/lib/brandColors';

interface ImpactChartProps {
  data: ImpactAnalysis;
}

interface TreemapData {
  name: string;
  size: number;
  type: string;
  status: string;
  environment: string;
}

const IMPACT_COLORS: Record<string, string> = {
  high: brand.danger,
  medium: brand.warning,
  low: brand.success,
};

export const ImpactChart: React.FC<ImpactChartProps> = ({ data }) => {
  const getImpactLevel = (score: number): 'low' | 'medium' | 'high' => {
    if (score >= 0.7) return 'high';
    if (score >= 0.4) return 'medium';
    return 'low';
  };

  const impactLevel = getImpactLevel(data.impact_score);

  const upstreamTreemapData: TreemapData[] = data.upstream.map((ci) => ({
    name: ci.name,
    size: 100,
    type: ci.type,
    status: ci.status,
    environment: ci.environment,
  }));

  const downstreamTreemapData: TreemapData[] = data.downstream.map((ci) => ({
    name: ci.name,
    size: 100,
    type: ci.type,
    status: ci.status,
    environment: ci.environment,
  }));

  const CustomTreemapContent = (props: any) => {
    const { x, y, width, height, name, type, status } = props;

    if (width < 60 || height < 30 || !name) return null;

    const bgColor = ciTypeColors[type] || brand.inkSoft;
    const borderColor = status === 'active' ? brand.success : brand.danger;

    return (
      <g>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          style={{
            fill: bgColor,
            stroke: borderColor,
            strokeWidth: 2,
            opacity: 0.8,
          }}
        />
        {width > 80 && height > 40 && (
          <text
            x={x + width / 2}
            y={y + height / 2}
            textAnchor="middle"
            fill="#fff"
            fontSize={12}
          >
            {name.length > 15 ? `${name.substring(0, 15)}...` : name}
          </text>
        )}
      </g>
    );
  };

  return (
    <div className="space-y-6">
      <Alert variant={impactLevel === 'high' ? 'destructive' : 'default'}>
        <Icon name="warning" size={16} />
        <AlertTitle>Impact Analysis for {data.ci.name}</AlertTitle>
        <AlertDescription>
          This CI has a {impactLevel} impact score of {(data.impact_score * 100).toFixed(1)}%.
          Changes to this CI may affect {data.upstream.length + data.downstream.length} other
          configuration items.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-4xl font-bold text-primary mb-2">
              {(data.impact_score * 100).toFixed(1)}%
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Impact Score
            </p>
            <Badge
              className={impactLevel === 'high' ? 'bg-danger text-white' : impactLevel === 'medium' ? 'bg-warning text-white' : 'bg-success text-white'}
            >
              {impactLevel.toUpperCase()}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="trend-up" size={24} className="text-primary" />
              <span className="text-4xl font-bold">{data.upstream.length}</span>
            </div>
            <p className="text-sm text-muted-foreground mb-1">
              Upstream Dependencies
            </p>
            <p className="text-xs text-muted-foreground">
              CIs that this item depends on
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="trend-down" size={24} className="text-secondary" />
              <span className="text-4xl font-bold">{data.downstream.length}</span>
            </div>
            <p className="text-sm text-muted-foreground mb-1">
              Downstream Dependencies
            </p>
            <p className="text-xs text-muted-foreground">
              CIs that depend on this item
            </p>
          </CardContent>
        </Card>
      </div>

      {data.affected_environments.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <h3 className="text-sm font-semibold mb-3">
              Affected Environments
            </h3>
            <div className="flex gap-2 flex-wrap">
              {data.affected_environments.map((env) => (
                <Badge key={env} variant="outline" className="capitalize">
                  {env}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {data.upstream.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Upstream Dependencies</CardTitle>
              <p className="text-xs text-muted-foreground">
                CIs that {data.ci.name} depends on
              </p>
            </CardHeader>
            <CardContent>
              <Separator className="mb-4" />

              <ResponsiveContainer width="100%" height={300}>
                <Treemap
                  data={upstreamTreemapData}
                  dataKey="size"
                  aspectRatio={4 / 3}
                  stroke="#fff"
                  content={<CustomTreemapContent />}
                >
                  <RechartsTooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <Card className="p-3 shadow-lg">
                            <p className="text-sm font-bold mb-2">
                              {data.name}
                            </p>
                            <div className="flex gap-2 mb-1">
                              <CITypeBadge type={data.type} size="small" />
                              <CIStatusBadge status={data.status} size="small" />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Environment: {data.environment}
                            </p>
                          </Card>
                        );
                      }
                      return null;
                    }}
                  />
                </Treemap>
              </ResponsiveContainer>

              <div className="mt-4 max-h-[200px] overflow-y-auto space-y-2">
                {data.upstream.map((ci) => (
                  <div
                    key={ci.id}
                    className="p-2 border rounded-md"
                  >
                    <p className="text-sm font-medium mb-1">
                      {ci.name}
                    </p>
                    <div className="flex gap-2">
                      <CITypeBadge type={ci.type} size="small" />
                      <CIStatusBadge status={ci.status} size="small" />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {data.downstream.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Downstream Dependencies</CardTitle>
              <p className="text-xs text-muted-foreground">
                CIs that depend on {data.ci.name}
              </p>
            </CardHeader>
            <CardContent>
              <Separator className="mb-4" />

              <ResponsiveContainer width="100%" height={300}>
                <Treemap
                  data={downstreamTreemapData}
                  dataKey="size"
                  aspectRatio={4 / 3}
                  stroke="#fff"
                  content={<CustomTreemapContent />}
                >
                  <RechartsTooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <Card className="p-3 shadow-lg">
                            <p className="text-sm font-bold mb-2">
                              {data.name}
                            </p>
                            <div className="flex gap-2 mb-1">
                              <CITypeBadge type={data.type} size="small" />
                              <CIStatusBadge status={data.status} size="small" />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Environment: {data.environment}
                            </p>
                          </Card>
                        );
                      }
                      return null;
                    }}
                  />
                </Treemap>
              </ResponsiveContainer>

              <div className="mt-4 max-h-[200px] overflow-y-auto space-y-2">
                {data.downstream.map((ci) => (
                  <div
                    key={ci.id}
                    className="p-2 border rounded-md"
                  >
                    <p className="text-sm font-medium mb-1">
                      {ci.name}
                    </p>
                    <div className="flex gap-2">
                      <CITypeBadge type={ci.type} size="small" />
                      <CIStatusBadge status={ci.status} size="small" />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default ImpactChart;
