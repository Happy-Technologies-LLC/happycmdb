// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/components/ui/button";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
/**
 * Drift Tracking Panel Component
 * Enhanced configuration drift tracking with calendar visualization and timeline
 */

import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { driftApi } from '../../api/drift';
import { DriftDetectionResult } from '../../types';
import { Icon } from '@happy-technologies/design-system';
import { toast } from 'sonner';
import { formatDistanceToNow, format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isToday, isSameMonth } from 'date-fns';

interface DriftTrackingPanelProps {
  ciId: string;
  ciName: string;
}

interface DayDriftData {
  date: Date;
  drifts: DriftDetectionResult[];
  hasDrift: boolean;
  maxScore: number;
}

export const DriftTrackingPanel: React.FC<DriftTrackingPanelProps> = ({
  ciId,
  ciName,
}) => {
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [viewMode, setViewMode] = useState<'calendar' | 'timeline'>('calendar');
  const queryClient = useQueryClient();

  const { data: driftHistory, isLoading } = useQuery({
    queryKey: ['drift', 'history', ciId],
    queryFn: () => driftApi.getHistory(ciId, 90), // 90 days of history
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

  // Calendar data calculations
  const calendarData = useMemo(() => {
    if (!driftHistory) return [];

    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

    return days.map((date) => {
      const dayDrifts = driftHistory.filter((drift) =>
        isSameDay(new Date(drift.detected_at), date)
      );
      return {
        date,
        drifts: dayDrifts,
        hasDrift: dayDrifts.some((d) => d.has_drift),
        maxScore: Math.max(...dayDrifts.map((d) => d.drift_score), 0),
      } as DayDriftData;
    });
  }, [driftHistory, currentMonth]);

  // Filtered drifts for selected date
  const selectedDrifts = useMemo(() => {
    if (!selectedDate || !driftHistory) return [];
    return driftHistory.filter((drift) =>
      isSameDay(new Date(drift.detected_at), selectedDate)
    );
  }, [selectedDate, driftHistory]);

  // Statistics
  const stats = useMemo(() => {
    if (!driftHistory) return { total: 0, withDrift: 0, avgScore: 0, trend: 0 };

    const withDrift = driftHistory.filter((d) => d.has_drift);
    const avgScore =
      driftHistory.length > 0
        ? driftHistory.reduce((sum, d) => sum + d.drift_score, 0) / driftHistory.length
        : 0;

    // Calculate trend (compare last 30 days vs previous 30 days)
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const recent = driftHistory.filter(
      (d) => new Date(d.detected_at) > thirtyDaysAgo
    );
    const previous = driftHistory.filter(
      (d) =>
        new Date(d.detected_at) > sixtyDaysAgo &&
        new Date(d.detected_at) <= thirtyDaysAgo
    );

    const recentAvg =
      recent.length > 0
        ? recent.reduce((sum, d) => sum + d.drift_score, 0) / recent.length
        : 0;
    const previousAvg =
      previous.length > 0
        ? previous.reduce((sum, d) => sum + d.drift_score, 0) / previous.length
        : 0;

    const trend = previousAvg > 0 ? ((recentAvg - previousAvg) / previousAvg) * 100 : 0;

    return {
      total: driftHistory.length,
      withDrift: withDrift.length,
      avgScore: Math.round(avgScore),
      trend: Math.round(trend),
    };
  }, [driftHistory]);

  const getDriftScoreColor = (score: number) => {
    if (score >= 80) return 'bg-red-500';
    if (score >= 50) return 'bg-orange-500';
    if (score >= 30) return 'bg-yellow-500';
    return 'bg-green-500';
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
        return <span className="text-green-600 font-bold">+</span>;
      case 'removed':
        return <span className="text-red-600 font-bold">-</span>;
      case 'modified':
        return <span className="text-blue-600 font-bold">~</span>;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header and Actions */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-2xl font-bold">Configuration Drift Tracking</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor configuration changes for {ciName}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setViewMode(viewMode === 'calendar' ? 'timeline' : 'calendar')}
          >
            {viewMode === 'calendar' ? <Icon name="pulse" size={16} className="mr-2" /> : <Icon name="calendar" size={16} className="mr-2" />}
            {viewMode === 'calendar' ? 'Timeline View' : 'Calendar View'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => createBaselineMutation.mutate()}
            disabled={createBaselineMutation.isPending}
          >
            <Icon name="calendar" size={16} className="mr-2" />
            Create Baseline
          </Button>
          <Button
            size="sm"
            onClick={() => detectDriftMutation.mutate()}
            disabled={detectDriftMutation.isPending}
          >
            <Icon name="git-diff" size={16} className="mr-2" />
            {detectDriftMutation.isPending ? 'Detecting...' : 'Detect Now'}
          </Button>
        </div>
      </div>

      {/* Statistics Dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <LiquidGlass variant="default" rounded="xl">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Total Detections</div>
              <div className="text-3xl font-bold mt-1">{stats.total}</div>
            </div>
            <Icon name="pulse" size={32} className="text-muted-foreground opacity-50" />
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-muted-foreground">With Drift</div>
              <div className="text-3xl font-bold mt-1 text-orange-600">{stats.withDrift}</div>
            </div>
            <Icon name="warning-circle" size={32} className="text-orange-500 opacity-50" />
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Avg Drift Score</div>
              <div className="text-3xl font-bold mt-1">{stats.avgScore}</div>
            </div>
            <Icon name="git-diff" size={32} className="text-muted-foreground opacity-50" />
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-muted-foreground">30-Day Trend</div>
              <div className={`text-3xl font-bold mt-1 ${stats.trend > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {stats.trend > 0 ? '+' : ''}{stats.trend}%
              </div>
            </div>
            {stats.trend > 0 ? (
              <Icon name="trend-up" size={32} className="text-red-500 opacity-50" />
            ) : (
              <Icon name="trend-down" size={32} className="text-green-500 opacity-50" />
            )}
          </div>
        </LiquidGlass>
      </div>

      {/* Current Baseline */}
      {baseline && (
        <Card className="p-4 border-l-4 border-l-green-500">
          <div className="flex items-center gap-3">
            <Icon name="check-circle" size={24} className="text-green-500" />
            <div className="flex-1">
              <h4 className="font-semibold">Current Approved Baseline</h4>
              <p className="text-sm text-muted-foreground">
                Created {formatDistanceToNow(new Date(baseline.created_at))} ago by {baseline.created_by}
                {baseline.approved_by && ` • Approved by ${baseline.approved_by}`}
              </p>
            </div>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div className="text-center py-12">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent" />
          <p className="mt-4 text-muted-foreground">Loading drift history...</p>
        </div>
      ) : viewMode === 'calendar' ? (
        /* Calendar View */
        <div className="space-y-4">
          {/* Calendar Navigation */}
          <div className="flex items-center justify-between">
            <h4 className="text-lg font-semibold">
              {format(currentMonth, 'MMMM yyyy')}
            </h4>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCurrentMonth(
                    new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1)
                  )
                }
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentMonth(new Date())}
              >
                Today
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCurrentMonth(
                    new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1)
                  )
                }
              >
                Next
              </Button>
            </div>
          </div>

          {/* Calendar Grid */}
          <Card className="p-4">
            <div className="grid grid-cols-7 gap-2">
              {/* Day Headers */}
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <div key={day} className="text-center text-sm font-semibold text-muted-foreground py-2">
                  {day}
                </div>
              ))}

              {/* Calendar Days */}
              {calendarData.map((dayData, index) => {
                const isSelected = selectedDate && isSameDay(dayData.date, selectedDate);
                const isCurrentDay = isToday(dayData.date);

                return (
                  <button
                    key={index}
                    onClick={() => setSelectedDate(dayData.date)}
                    className={`
                      relative p-2 rounded-lg border transition-all
                      ${isSelected ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500 ring-offset-2' : 'border-gray-200 hover:border-gray-300'}
                      ${isCurrentDay ? 'font-bold' : ''}
                      ${!isSameMonth(dayData.date, currentMonth) ? 'opacity-40' : ''}
                    `}
                  >
                    <div className="text-sm">{format(dayData.date, 'd')}</div>
                    {dayData.hasDrift && (
                      <div
                        className={`absolute bottom-1 left-1/2 transform -translate-x-1/2 w-2 h-2 rounded-full ${getDriftScoreColor(
                          dayData.maxScore
                        )}`}
                      />
                    )}
                    {dayData.drifts.length > 0 && (
                      <div className="absolute top-1 right-1 text-xs text-muted-foreground">
                        {dayData.drifts.length}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Selected Date Details */}
          {selectedDate && selectedDrifts.length > 0 && (
            <Card className="p-4">
              <h4 className="font-semibold mb-4">
                {format(selectedDate, 'MMMM d, yyyy')} - {selectedDrifts.length} Detection(s)
              </h4>
              <div className="space-y-3">
                {selectedDrifts.map((drift, index) => (
                  <div key={index} className="border rounded-lg p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {drift.has_drift ? 'Drift Detected' : 'No Drift'}
                          </span>
                          {drift.has_drift && (
                            <Badge variant="outline" className={getDriftScoreColor(drift.drift_score)}>
                              Score: {drift.drift_score}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {format(new Date(drift.detected_at), 'h:mm a')}
                        </p>
                      </div>
                      {drift.has_drift && <Icon name="warning-circle" size={20} className="text-orange-500" />}
                    </div>

                    {drift.has_drift && drift.drifted_fields.length > 0 && (
                      <div className="space-y-2 mt-3">
                        {drift.drifted_fields.slice(0, 3).map((field, fieldIndex) => (
                          <div
                            key={fieldIndex}
                            className="flex items-start gap-2 p-2 bg-muted/50 rounded text-sm"
                          >
                            <div className="mt-0.5">{getChangeTypeIcon(field.change_type)}</div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className="font-medium">{field.field_name}</span>
                                <Badge variant="outline" className={getSeverityColor(field.severity)}>
                                  {field.severity}
                                </Badge>
                              </div>
                              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                                <div className="truncate">
                                  <span className="font-medium">Baseline:</span>{' '}
                                  {field.baseline_value !== null ? String(field.baseline_value) : 'null'}
                                </div>
                                <div className="truncate">
                                  <span className="font-medium">Current:</span>{' '}
                                  {field.current_value !== null ? String(field.current_value) : 'null'}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                        {drift.drifted_fields.length > 3 && (
                          <div className="text-xs text-center text-muted-foreground">
                            + {drift.drifted_fields.length - 3} more changes
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {selectedDate && selectedDrifts.length === 0 && (
            <Card className="p-8 text-center">
              <p className="text-muted-foreground">
                No drift detections on {format(selectedDate, 'MMMM d, yyyy')}
              </p>
            </Card>
          )}
        </div>
      ) : (
        /* Timeline View */
        <div className="space-y-4">
          <h4 className="text-lg font-semibold">Drift Detection Timeline</h4>
          {driftHistory && driftHistory.length > 0 ? (
            <div className="relative">
              {/* Timeline Line */}
              <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-border"></div>

              <div className="space-y-6">
                {driftHistory.slice(0, 20).map((drift, index) => (
                  <div key={index} className="relative pl-20">
                    {/* Timeline Dot */}
                    <div
                      className={`absolute left-6 w-5 h-5 rounded-full border-4 border-background ${
                        drift.has_drift ? 'bg-orange-500' : 'bg-green-500'
                      }`}
                    />

                    {/* Drift Card */}
                    <Card className="p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <div className="flex items-center gap-3 mb-1">
                            <h5 className="font-semibold">
                              {drift.has_drift ? 'Drift Detected' : 'No Drift'}
                            </h5>
                            {drift.has_drift && (
                              <Badge variant="outline" className={getDriftScoreColor(drift.drift_score)}>
                                Score: {drift.drift_score}
                              </Badge>
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
                                className="flex items-start gap-2 p-2 bg-muted/50 rounded text-sm"
                              >
                                <div className="mt-0.5">{getChangeTypeIcon(field.change_type)}</div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <span className="font-medium">{field.field_name}</span>
                                    <Badge variant="outline" className={getSeverityColor(field.severity)}>
                                      {field.severity}
                                    </Badge>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground mt-1">
                                    <div className="truncate">
                                      <span className="font-medium">Baseline:</span>{' '}
                                      {field.baseline_value !== null
                                        ? String(field.baseline_value)
                                        : 'null'}
                                    </div>
                                    <div className="truncate">
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
                    </Card>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Card className="p-8 text-center">
              <p className="text-muted-foreground">
                No drift detection history available. Run detection to get started.
              </p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
};

export default DriftTrackingPanel;
