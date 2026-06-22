// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@happy-technologies/design-system';
import { formatDistanceToNow } from 'date-fns';

export interface Incident {
  id: string;
  title: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  affectedCI: string;
  assignedTeam?: string;
  createdAt: string;
  age?: number; // in hours
}

interface IncidentTableProps {
  incidents: Incident[];
  title?: string;
  description?: string;
  onIncidentClick?: (incident: Incident) => void;
  showFilters?: boolean;
}

const PRIORITY_COLORS = {
  P1: 'bg-danger-soft text-danger',
  P2: 'bg-warning-soft text-warning',
  P3: 'bg-warning-soft text-warning',
  P4: 'bg-sky-soft text-sky-text',
  P5: 'bg-warm-alt text-ink-soft',
};

const STATUS_COLORS = {
  open: 'bg-danger-soft text-danger',
  'in-progress': 'bg-sky-soft text-sky-text',
  resolved: 'bg-success-soft text-success',
  closed: 'bg-warm-alt text-ink-soft',
};

export const IncidentTable: React.FC<IncidentTableProps> = ({
  incidents,
  title = 'Open Incidents',
  description = 'Current incidents by priority',
  onIncidentClick,
  showFilters = false,
}) => {
  const [priorityFilter, setPriorityFilter] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<string | null>(null);

  const filteredIncidents = incidents.filter((incident) => {
    if (priorityFilter && incident.priority !== priorityFilter) return false;
    if (statusFilter && incident.status !== statusFilter) return false;
    return true;
  });

  const getAgeDisplay = (createdAt: string) => {
    try {
      return formatDistanceToNow(new Date(createdAt), { addSuffix: true });
    } catch {
      return 'Unknown';
    }
  };

  return (
    <LiquidGlass variant="default" rounded="xl">
      <div>
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
      
      
        {showFilters && (
          <div className="flex gap-2 mb-4 flex-wrap">
            <select
              className="px-3 py-1 border border-border rounded-md text-sm"
              value={priorityFilter || ''}
              onChange={(e) => setPriorityFilter(e.target.value || null)}
            >
              <option value="">All Priorities</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
              <option value="P4">P4</option>
              <option value="P5">P5</option>
            </select>
            <select
              className="px-3 py-1 border border-border rounded-md text-sm"
              value={statusFilter || ''}
              onChange={(e) => setStatusFilter(e.target.value || null)}
            >
              <option value="">All Statuses</option>
              <option value="open">Open</option>
              <option value="in-progress">In Progress</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-2 text-sm font-semibold">Priority</th>
                <th className="text-left py-3 px-2 text-sm font-semibold">Title</th>
                <th className="text-left py-3 px-2 text-sm font-semibold">Affected CI</th>
                <th className="text-left py-3 px-2 text-sm font-semibold">Status</th>
                <th className="text-left py-3 px-2 text-sm font-semibold">Age</th>
                <th className="text-left py-3 px-2 text-sm font-semibold">Assigned To</th>
              </tr>
            </thead>
            <tbody>
              {filteredIncidents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    No incidents found
                  </td>
                </tr>
              ) : (
                filteredIncidents.map((incident) => (
                  <tr
                    key={incident.id}
                    className="border-b border-border hover:bg-accent cursor-pointer transition-colors"
                    onClick={() => onIncidentClick?.(incident)}
                  >
                    <td className="py-3 px-2">
                      <Badge className={PRIORITY_COLORS[incident.priority]}>
                        {incident.priority}
                      </Badge>
                    </td>
                    <td className="py-3 px-2">
                      <div className="flex items-start gap-2">
                        <Icon name="warning-circle" size={16} className="mt-0.5 text-danger" />
                        <span className="text-sm font-medium">{incident.title}</span>
                      </div>
                    </td>
                    <td className="py-3 px-2 text-sm">{incident.affectedCI}</td>
                    <td className="py-3 px-2">
                      <Badge className={STATUS_COLORS[incident.status]} variant="outline">
                        {incident.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-2">
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Icon name="clock" size={12} />
                        {getAgeDisplay(incident.createdAt)}
                      </div>
                    </td>
                    <td className="py-3 px-2">
                      {incident.assignedTeam ? (
                        <div className="flex items-center gap-1 text-sm">
                          <Icon name="user" size={12} />
                          {incident.assignedTeam}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">Unassigned</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </LiquidGlass>
  );
};
