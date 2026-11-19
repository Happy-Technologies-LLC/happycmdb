// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Anomaly Detection View Component
 * Visualize and manage detected anomalies
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { anomaliesApi } from '../../api/anomalies';
import { Anomaly } from '../../types';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  MetricCard,
  PageHeader,
  type BadgeVariant,
} from '@happy-technologies/design-system';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { RequirePermission } from '@/components/common/RequirePermission';
import { QueryState } from '@/components/estate/SurfaceState';

export const AnomalyDetectionView: React.FC = () => {
  const [selectedSeverity, setSelectedSeverity] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('detected');
  const queryClient = useQueryClient();

  const {
    data: anomalies,
    isLoading,
    error: anomaliesError,
    refetch: refetchAnomalies,
  } = useQuery({
    queryKey: ['anomalies', 'recent'],
    queryFn: () => anomaliesApi.getRecent(24, 100),
    refetchInterval: 30000, // Auto-refresh every 30s
  });

  const {
    data: stats,
    error: statsError,
    refetch: refetchStats,
  } = useQuery({
    queryKey: ['anomalies', 'stats'],
    queryFn: anomaliesApi.getStats,
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'investigating' | 'resolved' | 'false_positive' }) =>
      anomaliesApi.updateStatus(id, status),
    onSuccess: () => {
      toast.success('Anomaly status updated');
      queryClient.invalidateQueries({ queryKey: ['anomalies'] });
    },
    onError: () => toast.error('Failed to update anomaly status'),
  });

  const getSeverityColor = (severity: string): BadgeVariant => {
    switch (severity) {
      case 'critical':
      case 'high':
        return 'danger';
      case 'medium':
        return 'warning';
      case 'low':
        return 'info';
      default:
        return 'neutral';
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical':
      case 'high':
        return <Icon name="x-circle" size={20} />;
      case 'medium':
        return <Icon name="warning" size={20} />;
      default:
        return <Icon name="eye" size={20} />;
    }
  };

  const filteredAnomalies = anomalies?.filter((anomaly) => {
    const severityMatch = selectedSeverity === 'all' || anomaly.severity === selectedSeverity;
    const statusMatch = selectedStatus === 'all' || anomaly.status === selectedStatus;
    return severityMatch && statusMatch;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AI insights"
        title="Anomaly Detection"
        lede="AI-powered detection of unusual patterns and configuration issues"
      />

      {/* Statistics */}
      {stats ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <MetricCard layout="compact" label="Total Anomalies" value={stats.total} />
          <MetricCard
            layout="compact"
            label="Critical"
            value={stats.by_severity.critical || 0}
            valueClass="text-[var(--hh-error-text)]"
          />
          <MetricCard
            layout="compact"
            label="High"
            value={stats.by_severity.high || 0}
            valueClass="text-[var(--hh-warning-text)]"
          />
          <MetricCard
            layout="compact"
            label="Unresolved"
            value={(stats.by_status.detected || 0) + (stats.by_status.investigating || 0)}
          />
        </div>
      ) : (
        statsError && (
          <Card as="section" aria-label="Anomaly statistics">
            <QueryState what="anomaly statistics" error={statsError} onRetry={() => void refetchStats()} />
          </Card>
        )
      )}

      {/* Filters */}
      <Card>
        <div className="flex items-center gap-4 flex-wrap">
          <Icon name="funnel" size={20} className="text-[var(--hh-text-muted)]" />
          <div className="flex gap-2 flex-wrap items-center" role="group" aria-label="Severity">
            <span className="text-sm font-medium">Severity:</span>
            {['all', 'critical', 'high', 'medium', 'low', 'info'].map((severity) => (
              <Button
                key={severity}
                onClick={() => setSelectedSeverity(severity)}
                variant={selectedSeverity === severity ? 'primary' : 'secondary'}
                aria-pressed={selectedSeverity === severity}
              >
                {severity.charAt(0).toUpperCase() + severity.slice(1)}
              </Button>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap items-center" role="group" aria-label="Status">
            <span className="text-sm font-medium">Status:</span>
            {['all', 'detected', 'investigating', 'resolved', 'false_positive'].map((status) => (
              <Button
                key={status}
                onClick={() => setSelectedStatus(status)}
                variant={selectedStatus === status ? 'primary' : 'secondary'}
                aria-pressed={selectedStatus === status}
              >
                {status.replace('_', ' ').charAt(0).toUpperCase() + status.slice(1).replace('_', ' ')}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {/* Anomalies List */}
      <div className="space-y-3">
        {isLoading || anomaliesError ? (
          <Card>
            <QueryState
              what="anomalies"
              loading={isLoading}
              error={anomaliesError}
              onRetry={() => void refetchAnomalies()}
            />
          </Card>
        ) : filteredAnomalies && filteredAnomalies.length > 0 ? (
          filteredAnomalies.map((anomaly) => (
            <Card key={anomaly.id} as="article">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-start gap-3 flex-1">
                  <div className="p-2 rounded">{getSeverityIcon(anomaly.severity)}</div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-lg">{anomaly.anomaly_type.replace(/_/g, ' ').toUpperCase()}</h4>
                    <p className="text-[var(--hh-text-muted)] mt-1">{anomaly.description}</p>
                    <div className="flex items-center gap-3 mt-2 text-sm text-[var(--hh-text-muted)] flex-wrap">
                      <span>CI: {anomaly.ci_name}</span>
                      <span>•</span>
                      <span>
                        Detected {formatDistanceToNow(new Date(anomaly.detected_at))} ago
                      </span>
                      <span>•</span>
                      <span>Confidence: {anomaly.confidence_score}%</span>
                    </div>
                  </div>
                </div>
                <Badge variant={getSeverityColor(anomaly.severity)}>
                  {anomaly.severity.toUpperCase()}
                </Badge>
              </div>

              {/* Metrics */}
              {anomaly.metrics && Object.keys(anomaly.metrics).length > 0 && (
                <div className="bg-[var(--hh-bg-elevated)] rounded p-3 mb-3">
                  <div className="text-sm font-medium mb-2">Metrics:</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                    {Object.entries(anomaly.metrics).map(([key, value]) => (
                      <div key={key}>
                        <span className="text-[var(--hh-text-muted)]">{key.replace(/_/g, ' ')}:</span>{' '}
                        <span className="font-medium">
                          {typeof value === 'number' ? value.toFixed(2) : String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 flex-wrap">
                {/* PATCH /anomalies/:id/status requires 'write' */}
                <RequirePermission permission="write">
                  {anomaly.status === 'detected' && (
                    <Button
                      onClick={() =>
                        updateStatusMutation.mutate({ id: anomaly.id, status: 'investigating' })
                      }
                      disabled={updateStatusMutation.isPending}
                    >
                      Investigate
                    </Button>
                  )}
                  {(anomaly.status === 'detected' || anomaly.status === 'investigating') && (
                    <>
                      <Button
                        onClick={() =>
                          updateStatusMutation.mutate({ id: anomaly.id, status: 'resolved' })
                        }
                        disabled={updateStatusMutation.isPending}
                      >
                        Resolve
                      </Button>
                      <Button
                        onClick={() =>
                          updateStatusMutation.mutate({ id: anomaly.id, status: 'false_positive' })
                        }
                        variant="outline"
                        disabled={updateStatusMutation.isPending}
                      >
                        Mark False Positive
                      </Button>
                    </>
                  )}
                </RequirePermission>
                {anomaly.status === 'resolved' && (
                  <Badge variant="success" dot>
                    Resolved
                    {anomaly.resolved_at &&
                      ` ${formatDistanceToNow(new Date(anomaly.resolved_at))} ago`}
                  </Badge>
                )}
              </div>
            </Card>
          ))
        ) : (
          <Card>
            <EmptyState label="No anomalies found matching the selected filters" />
          </Card>
        )}
      </div>
    </div>
  );
};
