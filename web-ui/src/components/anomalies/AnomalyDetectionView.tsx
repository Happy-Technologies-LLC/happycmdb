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
import { AlertTriangle, CheckCircle, XCircle, Eye, Filter } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';

export const AnomalyDetectionView: React.FC = () => {
  const [selectedSeverity, setSelectedSeverity] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('detected');
  const queryClient = useQueryClient();

  const { data: anomalies, isLoading } = useQuery({
    queryKey: ['anomalies', 'recent'],
    queryFn: () => anomaliesApi.getRecent(24, 100),
    refetchInterval: 30000, // Auto-refresh every 30s
  });

  const { data: stats } = useQuery({
    queryKey: ['anomalies', 'stats'],
    queryFn: anomaliesApi.getStats,
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'investigating' | 'resolved' | 'false_positive' }) =>
      anomaliesApi.updateStatus(id, status, 'current_user'),
    onSuccess: () => {
      toast.success('Anomaly status updated');
      queryClient.invalidateQueries({ queryKey: ['anomalies'] });
    },
    onError: () => toast.error('Failed to update anomaly status'),
  });

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'destructive';
      case 'high':
        return 'destructive';
      case 'medium':
        return 'warning';
      case 'low':
        return 'default';
      case 'info':
        return 'secondary';
      default:
        return 'secondary';
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical':
      case 'high':
        return <XCircle className="h-5 w-5" />;
      case 'medium':
        return <AlertTriangle className="h-5 w-5" />;
      default:
        return <Eye className="h-5 w-5" />;
    }
  };

  const filteredAnomalies = anomalies?.filter((anomaly) => {
    const severityMatch = selectedSeverity === 'all' || anomaly.severity === selectedSeverity;
    const statusMatch = selectedStatus === 'all' || anomaly.status === selectedStatus;
    return severityMatch && statusMatch;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Anomaly Detection</h2>
        <p className="text-muted-foreground mt-1">
          AI-powered detection of unusual patterns and configuration issues
        </p>
      </div>

      {/* Statistics */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <LiquidGlass variant="default" rounded="xl">
            <div className="text-sm font-medium text-muted-foreground">Total Anomalies</div>
            <div className="text-2xl font-bold mt-1">{stats.total}</div>
          </LiquidGlass>
          <LiquidGlass variant="default" rounded="xl">
            <div className="text-sm font-medium text-muted-foreground">Critical</div>
            <div className="text-2xl font-bold mt-1 text-danger">
              {stats.by_severity.critical || 0}
            </div>
          </LiquidGlass>
          <LiquidGlass variant="default" rounded="xl">
            <div className="text-sm font-medium text-muted-foreground">High</div>
            <div className="text-2xl font-bold mt-1 text-warning">
              {stats.by_severity.high || 0}
            </div>
          </LiquidGlass>
          <LiquidGlass variant="default" rounded="xl">
            <div className="text-sm font-medium text-muted-foreground">Unresolved</div>
            <div className="text-2xl font-bold mt-1">
              {(stats.by_status.detected || 0) + (stats.by_status.investigating || 0)}
            </div>
          </LiquidGlass>
        </div>
      )}

      {/* Filters */}
      <LiquidGlass variant="default" rounded="xl">
        <div className="flex items-center gap-4 flex-wrap">
          <Filter className="h-5 w-5 text-muted-foreground" />
          <div className="flex gap-2 flex-wrap">
            <span className="text-sm font-medium">Severity:</span>
            {['all', 'critical', 'high', 'medium', 'low', 'info'].map((severity) => (
              <Button
                key={severity}
                onClick={() => setSelectedSeverity(severity)}
                variant={selectedSeverity === severity ? 'default' : 'outline'}
                size="sm"
              >
                {severity.charAt(0).toUpperCase() + severity.slice(1)}
              </Button>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap">
            <span className="text-sm font-medium">Status:</span>
            {['all', 'detected', 'investigating', 'resolved', 'false_positive'].map((status) => (
              <Button
                key={status}
                onClick={() => setSelectedStatus(status)}
                variant={selectedStatus === status ? 'default' : 'outline'}
                size="sm"
              >
                {status.replace('_', ' ').charAt(0).toUpperCase() + status.slice(1).replace('_', ' ')}
              </Button>
            ))}
          </div>
        </div>
      </LiquidGlass>

      {/* Anomalies List */}
      <div className="space-y-3">
        {isLoading ? (
          <LiquidGlass variant="default" rounded="xl">
            <div className="text-center py-8 text-muted-foreground">Loading anomalies...</div>
          </LiquidGlass>
        ) : filteredAnomalies && filteredAnomalies.length > 0 ? (
          filteredAnomalies.map((anomaly) => (
            <LiquidGlass
              key={anomaly.id}
              variant="default"
              rounded="xl"
              className="hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-start gap-3 flex-1">
                  <div className={`p-2 rounded`}>
                    {getSeverityIcon(anomaly.severity)}
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-lg">{anomaly.anomaly_type.replace(/_/g, ' ').toUpperCase()}</h4>
                    <p className="text-muted-foreground mt-1">{anomaly.description}</p>
                    <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground flex-wrap">
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
                <div className="bg-accent/30 rounded p-3 mb-3">
                  <div className="text-sm font-medium mb-2">Metrics:</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                    {Object.entries(anomaly.metrics).map(([key, value]) => (
                      <div key={key}>
                        <span className="text-muted-foreground">{key.replace(/_/g, ' ')}:</span>{' '}
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
                {anomaly.status === 'detected' && (
                  <Button
                    onClick={() =>
                      updateStatusMutation.mutate({ id: anomaly.id, status: 'investigating' })
                    }
                    size="sm"
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
                      size="sm"
                      variant="default"
                      disabled={updateStatusMutation.isPending}
                    >
                      Resolve
                    </Button>
                    <Button
                      onClick={() =>
                        updateStatusMutation.mutate({ id: anomaly.id, status: 'false_positive' })
                      }
                      size="sm"
                      variant="outline"
                      disabled={updateStatusMutation.isPending}
                    >
                      Mark False Positive
                    </Button>
                  </>
                )}
                {anomaly.status === 'resolved' && (
                  <div className="flex items-center gap-2 text-success text-sm">
                    <CheckCircle className="h-4 w-4" />
                    Resolved
                    {anomaly.resolved_at &&
                      ` ${formatDistanceToNow(new Date(anomaly.resolved_at))} ago`}
                  </div>
                )}
              </div>
            </LiquidGlass>
          ))
        ) : (
          <LiquidGlass variant="default" rounded="xl">
            <div className="text-center py-8 text-muted-foreground">
              No anomalies found matching the selected filters
            </div>
          </LiquidGlass>
        )}
      </div>
    </div>
  );
};
