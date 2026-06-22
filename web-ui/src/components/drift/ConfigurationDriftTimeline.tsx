// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/components/ui/button";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Badge } from "@/components/ui/badge";
/**
 * Configuration Drift Timeline Component
 * Visualize configuration drift over time with baseline comparison
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { driftApi } from '../../api/drift';
import { DriftDetectionResult, DriftedField, BaselineSnapshot } from '../../types';
import { Icon } from '@happy-technologies/design-system';
import { toast } from 'sonner';
import { formatDistanceToNow, format } from 'date-fns';

interface ConfigurationDriftTimelineProps {
  ciId: string;
}

export const ConfigurationDriftTimeline: React.FC<ConfigurationDriftTimelineProps> = ({
  ciId,
}) => {
  const [showBaselines, setShowBaselines] = useState(false);
  const queryClient = useQueryClient();

  const { data: driftHistory, isLoading } = useQuery({
    queryKey: ['drift', 'history', ciId],
    queryFn: () => driftApi.getHistory(ciId, 50),
    enabled: !!ciId,
  });

  const { data: baseline } = useQuery({
    queryKey: ['drift', 'baseline', ciId],
    queryFn: () => driftApi.getApprovedBaseline(ciId, 'configuration'),
    enabled: !!ciId,
  });

  const detectDriftMutation = useMutation({
    mutationFn: () => driftApi.detect(ciId),
    onSuccess: () => {
      toast.success('Drift detection completed');
      queryClient.invalidateQueries({ queryKey: ['drift'] });
    },
    onError: () => toast.error('Failed to detect drift'),
  });

  const createBaselineMutation = useMutation({
    mutationFn: () => driftApi.createBaseline(ciId, 'configuration', 'current_user'),
    onSuccess: () => {
      toast.success('Baseline created successfully');
      queryClient.invalidateQueries({ queryKey: ['drift'] });
    },
    onError: () => toast.error('Failed to create baseline'),
  });

  const approveBaselineMutation = useMutation({
    mutationFn: (baselineId: string) => driftApi.approveBaseline(baselineId, 'current_user'),
    onSuccess: () => {
      toast.success('Baseline approved');
      queryClient.invalidateQueries({ queryKey: ['drift'] });
    },
    onError: () => toast.error('Failed to approve baseline'),
  });

  const getDriftScoreColor = (score: number) => {
    if (score >= 80) return 'text-red-600';
    if (score >= 50) return 'text-orange-600';
    if (score >= 30) return 'text-yellow-600';
    return 'text-green-600';
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'high':
        return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'medium':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'low':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getChangeTypeIcon = (changeType: string) => {
    switch (changeType) {
      case 'added':
        return <span className="text-green-600">+</span>;
      case 'removed':
        return <span className="text-red-600">-</span>;
      case 'modified':
        return <span className="text-blue-600">~</span>;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Configuration Drift Detection</h2>
        <p className="text-muted-foreground mt-1">
          Track configuration changes and compare against approved baselines
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => detectDriftMutation.mutate()}
          disabled={detectDriftMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          <Icon name="git-diff" size={16} />
          {detectDriftMutation.isPending ? 'Detecting...' : 'Detect Drift Now'}
        </button>
        <button
          onClick={() => createBaselineMutation.mutate()}
          disabled={createBaselineMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 border rounded hover:bg-accent/50 transition-colors"
        >
          <Icon name="calendar" size={16} />
          Create Baseline
        </button>
        <button
          onClick={() => setShowBaselines(!showBaselines)}
          className="flex items-center gap-2 px-4 py-2 border rounded hover:bg-accent/50 transition-colors"
        >
          View Baselines
        </button>
      </div>

      {/* Current Baseline */}
      {baseline && (
        <div className="bg-white rounded-lg shadow-sm border p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Icon name="check-circle" size={24} className="text-green-500" />
              <div>
                <h3 className="font-semibold">Current Approved Baseline</h3>
                <p className="text-sm text-muted-foreground">
                  Created {formatDistanceToNow(new Date(baseline.created_at))} ago by{' '}
                  {baseline.created_by}
                </p>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              {baseline.approved_by && `Approved by ${baseline.approved_by}`}
            </div>
          </div>
        </div>
      )}

      {/* Drift Timeline */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Drift Detection History</h3>

        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading drift history...</div>
        ) : driftHistory && driftHistory.length > 0 ? (
          <div className="relative">
            {/* Timeline Line */}
            <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-gray-200"></div>

            <div className="space-y-6">
              {driftHistory.map((drift, index) => (
                <div key={index} className="relative pl-20">
                  {/* Timeline Dot */}
                  <div
                    className={`absolute left-6 w-5 h-5 rounded-full border-4 border-white ${
                      drift.has_drift ? 'bg-orange-500' : 'bg-green-500'
                    }`}
                  ></div>

                  {/* Drift Card */}
                  <div className="bg-white rounded-lg shadow-sm border p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <h4 className="font-semibold">
                            {drift.has_drift ? 'Drift Detected' : 'No Drift'}
                          </h4>
                          {drift.has_drift && (
                            <span
                              className={`px-2 py-1 rounded text-xs font-medium ${getDriftScoreColor(
                                drift.drift_score
                              )}`}
                            >
                              Score: {drift.drift_score}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {format(new Date(drift.detected_at), 'PPpp')}
                        </p>
                      </div>
                      {drift.has_drift && <Icon name="warning-circle" size={20} className="text-orange-500" />}
                    </div>

                    {/* Drifted Fields */}
                    {drift.has_drift && drift.drifted_fields.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-sm font-medium">
                          Changes ({drift.drifted_fields.length}):
                        </div>
                        <div className="space-y-2">
                          {drift.drifted_fields.slice(0, 5).map((field, fieldIndex) => (
                            <div
                              key={fieldIndex}
                              className="flex items-start gap-2 p-2 bg-gray-50 rounded text-sm"
                            >
                              <div className="mt-0.5">{getChangeTypeIcon(field.change_type)}</div>
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="font-medium">{field.field_name}</span>
                                  <span
                                    className={`px-2 py-0.5 rounded text-xs ${getSeverityColor(
                                      field.severity
                                    )}`}
                                  >
                                    {field.severity}
                                  </span>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground mt-1">
                                  <div>
                                    <span className="font-medium">Baseline:</span>{' '}
                                    {field.baseline_value !== null
                                      ? String(field.baseline_value)
                                      : 'null'}
                                  </div>
                                  <div>
                                    <span className="font-medium">Current:</span>{' '}
                                    {field.current_value !== null
                                      ? String(field.current_value)
                                      : 'null'}
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                          {drift.drifted_fields.length > 5 && (
                            <div className="text-sm text-gray-500 text-center">
                              + {drift.drifted_fields.length - 5} more changes
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            No drift detection history available. Run detection to get started.
          </div>
        )}
      </div>

      {/* Summary Statistics */}
      {driftHistory && driftHistory.length > 0 && (
        <LiquidGlass variant="default" rounded="xl">
          <h3 className="text-lg font-semibold mb-4">Drift Statistics</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <div className="text-sm font-medium text-muted-foreground mt-1">Total Detections</div>
              <div className="text-2xl font-bold mt-1">{driftHistory.length}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground mt-1">With Drift</div>
              <div className="text-2xl font-bold mt-1 text-orange-600">
                {driftHistory.filter((d) => d.has_drift).length}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground mt-1">Average Drift Score</div>
              <div className="text-2xl font-bold mt-1">
                {Math.round(
                  driftHistory.reduce((sum, d) => sum + d.drift_score, 0) / driftHistory.length
                )}
              </div>
            </div>
          </div>
        </LiquidGlass>
      )}
    </div>
  );
};
