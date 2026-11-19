import React from 'react';
import { MetricCard } from '@happy-technologies/design-system';

/**
 * A figure is `null` while it is unknown (not loaded yet, or the read failed): it renders as a dash, never as 0.
 * `successRate` is also `null` while no job has run, since a rate over zero jobs is not 0%.
 */
interface AgentStatusCardProps {
  totalAgents: number | null;
  activeAgents: number | null;
  offlineAgents: number | null;
  totalJobs: number | null;
  successRate: number | null;
  /** The first read is still in flight. */
  loading?: boolean;
}

const UNKNOWN = '\u2013';

export const AgentStatusCard: React.FC<AgentStatusCardProps> = ({
  totalAgents,
  activeAgents,
  offlineAgents,
  totalJobs,
  successRate,
  loading = false,
}) => {
  const onlineNote =
    totalAgents === null || activeAgents === null
      ? 'Unavailable'
      : totalAgents > 0
        ? `${Math.round((activeAgents / totalAgents) * 100)}% online`
        : 'No agents';

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
      <MetricCard
        icon="computer-tower"
        label="Total Agents"
        value={totalAgents ?? UNKNOWN}
        sub="Registered agents"
        loading={loading}
      />
      <MetricCard
        icon="check-circle"
        tone="success"
        label="Active"
        value={activeAgents ?? UNKNOWN}
        sub={onlineNote}
        loading={loading}
      />
      <MetricCard
        icon="x-circle"
        tone="danger"
        label="Offline"
        value={offlineAgents ?? UNKNOWN}
        sub="Need attention"
        loading={loading}
      />
      <MetricCard
        icon="pulse"
        label="Total Jobs"
        value={totalJobs ?? UNKNOWN}
        sub="Completed"
        loading={loading}
      />
      <MetricCard
        icon="pulse"
        label="Success Rate"
        value={successRate ?? (totalJobs === null ? UNKNOWN : 'N/A')}
        unit={successRate === null ? undefined : '%'}
        sub="Overall performance"
        loading={loading}
      />
    </div>
  );
};
