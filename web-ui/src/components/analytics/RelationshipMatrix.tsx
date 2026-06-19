// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * RelationshipMatrix Component
 * Heatmap showing relationship type counts between CI types
 */

import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { useRelationshipMatrix } from '../../hooks/useAnalytics';
import { ExportButton } from './ExportButton';
import { brand } from '@/lib/brandColors';

export const RelationshipMatrix: React.FC = () => {
  const { data, loading, error } = useRelationshipMatrix();

  const matrixData = useMemo(() => {
    if (!data || data.length === 0) return null;

    // Get unique source and target types
    const sourceTypes = Array.from(new Set(data.map((d) => d.source_type)));
    const targetTypes = Array.from(new Set(data.map((d) => d.target_type)));
    const relationshipTypes = Array.from(
      new Set(data.map((d) => d.relationship_type))
    );

    // Find max count for color scaling
    const maxCount = Math.max(...data.map((d) => d.count));

    // Create matrix lookup
    const matrix = new Map<string, number>();
    data.forEach((item) => {
      const key = `${item.source_type}|${item.target_type}|${item.relationship_type}`;
      matrix.set(key, item.count);
    });

    return {
      sourceTypes,
      targetTypes,
      relationshipTypes,
      maxCount,
      matrix,
    };
  }, [data]);

  const getColorForCount = (count: number, max: number): string => {
    if (count === 0) return brand.warmAlt;
    const intensity = count / max;
    if (intensity > 0.75) return brand.navy;
    if (intensity > 0.5) return brand.skyText;
    if (intensity > 0.25) return brand.sky;
    return brand.skyLight;
  };

  if (loading) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Relationship Matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center items-center h-[300px]">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Relationship Matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>Failed to load data</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.length === 0 || !matrixData) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Relationship Matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertDescription>No data available</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Relationship Type Matrix</CardTitle>
          <ExportButton data={data} filename="relationship_matrix" />
        </div>
      </CardHeader>

      <CardContent>
        <p className="text-sm text-muted-foreground mb-5">
          Heatmap showing relationship counts between CI types
        </p>

        <div className="overflow-x-auto">
          {matrixData.relationshipTypes.map((relType) => (
            <div key={relType} className="mb-6">
              <h3 className="text-base font-semibold mb-3">
                {relType}
              </h3>

              <div className="border rounded-lg overflow-hidden">
                {/* Header row */}
                <div className="flex bg-muted">
                  <div className="w-32 p-2 border-r border-b border-border">
                    <span className="text-xs font-semibold">
                      Source \ Target
                    </span>
                  </div>
                  {matrixData.targetTypes.map((targetType) => (
                    <div
                      key={targetType}
                      className="w-24 p-2 border-r border-b border-border text-center"
                    >
                      <span className="text-xs font-semibold">
                        {targetType}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Data rows */}
                {matrixData.sourceTypes.map((sourceType) => (
                  <div key={sourceType} className="flex">
                    <div className="w-32 p-2 border-r border-b border-border bg-muted/50">
                      <span className="text-xs font-medium">
                        {sourceType}
                      </span>
                    </div>
                    {matrixData.targetTypes.map((targetType) => {
                      const key = `${sourceType}|${targetType}|${relType}`;
                      const count = matrixData.matrix.get(key) || 0;
                      const color = getColorForCount(count, matrixData.maxCount);

                      return (
                        <div
                          key={targetType}
                          className="w-24 p-2 border-r border-b border-border text-center"
                          style={{ backgroundColor: color }}
                        >
                          <span
                            className={`text-xs ${
                              count > 0 ? 'font-semibold' : 'text-muted-foreground'
                            }`}
                          >
                            {count > 0 ? count : '-'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="mt-5 pt-5 border-t border-border">
          <p className="text-sm font-semibold mb-2">
            Intensity
          </p>
          <div className="flex h-6 mb-1">
            {[brand.warmAlt, brand.skyLight, brand.sky, brand.skyText, brand.navy].map((color, idx) => (
              <div
                key={idx}
                className="flex-1 border border-border"
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-muted-foreground">
              0
            </span>
            <span className="text-xs text-muted-foreground">
              Max: {matrixData.maxCount}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
