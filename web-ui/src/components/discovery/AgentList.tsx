// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  EmptyState,
  Icon,
  IconButton,
  SectionHeading,
  type BadgeVariant,
  type Column,
} from '@happy-technologies/design-system';
import { RequirePermission } from '@/components/common/RequirePermission';
import { QueryState } from '@/components/estate/SurfaceState';
import { classifyError } from '@/lib/estate';
import { formatDistanceToNow } from 'date-fns';
import { logClientError } from '@/utils/logger';

interface DiscoveryAgent {
  id: string;
  agent_id: string;
  hostname: string;
  provider_capabilities: string[];
  reachable_networks: string[];
  version?: string;
  platform?: string;
  arch?: string;
  status: 'active' | 'inactive' | 'offline' | 'disabled';
  last_heartbeat_at: string;
  last_job_at?: string;
  total_jobs_completed: number;
  total_jobs_failed: number;
  total_cis_discovered: number;
  tags?: string[];
  registered_at: string;
}

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  active: 'success',
  inactive: 'neutral',
  offline: 'danger',
  disabled: 'neutral',
};

const MUTED = 'text-[var(--hh-text-muted)]';

export const AgentList: React.FC = () => {
  const [agents, setAgents] = useState<DiscoveryAgent[]>([]);
  const [settled, setSettled] = useState(false); // the first read has answered, with rows or with an error
  const [error, setError] = useState<unknown>(null);

  const fetchAgents = async () => {
    try {
      const response = await apiClient.get<{ data?: DiscoveryAgent[] }>('/agents');
      setAgents(response.data || []);
      setError(null);
    } catch (err: any) {
      setError(err ?? new Error('Failed to fetch agents'));
      logClientError('Error fetching agents:', err);
    } finally {
      setSettled(true);
    }
  };

  useEffect(() => {
    fetchAgents();
    // Refresh every 10 seconds
    const interval = setInterval(fetchAgents, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleDelete = async (agentId: string) => {
    if (agentId === '.' || agentId === '..') return; // a whole dot segment would resolve outside /agents/ even when encoded
    if (!confirm(`Are you sure you want to delete agent ${agentId}?`)) {
      return;
    }

    try {
      await apiClient.delete(`/agents/${encodeURIComponent(agentId)}`);
      await fetchAgents();
    } catch (err: any) {
      alert(`Failed to delete agent: ${err.message}`);
    }
  };

  const calculateSuccessRate = (agent: DiscoveryAgent): string => {
    const total = agent.total_jobs_completed + agent.total_jobs_failed;
    if (total === 0) return 'N/A';
    return `${Math.round((agent.total_jobs_completed / total) * 100)}%`;
  };

  const isStale = (lastHeartbeat: string): boolean => {
    const diff = Date.now() - new Date(lastHeartbeat).getTime();
    return diff > 5 * 60 * 1000; // 5 minutes
  };

  const columns: Array<Column<DiscoveryAgent>> = [
    {
      header: 'Agent',
      render: (agent) => (
        <div>
          <div className="font-medium">{agent.hostname}</div>
          <div className={`text-xs ${MUTED}`}>{agent.agent_id}</div>
          {agent.platform && (
            <div className={`mt-1 text-xs ${MUTED}`}>
              {agent.platform}/{agent.arch} • v{agent.version}
            </div>
          )}
        </div>
      ),
    },
    {
      header: 'Status',
      render: (agent) => (
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[agent.status] ?? 'neutral'} dot>
            {agent.status.toUpperCase()}
          </Badge>
          {isStale(agent.last_heartbeat_at) && <Badge variant="warning">STALE</Badge>}
        </div>
      ),
    },
    {
      header: 'Networks',
      render: (agent) => (
        <div className="flex max-w-xs items-start gap-1">
          <Icon name="graph" size={16} className={`mt-0.5 flex-shrink-0 ${MUTED}`} />
          <div className="text-sm">
            {agent.reachable_networks.length > 0 ? (
              agent.reachable_networks.map((network, i) => (
                <div key={i} className="truncate">
                  {network}
                </div>
              ))
            ) : (
              <span className={MUTED}>None</span>
            )}
          </div>
        </div>
      ),
    },
    {
      header: 'Capabilities',
      render: (agent) => (
        <div className="flex flex-wrap gap-1">
          {agent.provider_capabilities.map((cap) => (
            <Badge key={cap} variant="neutral">
              {cap}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      header: 'Heartbeat',
      render: (agent) => (
        <div className="flex items-center gap-1 text-sm">
          <Icon name="pulse" size={12} className={MUTED} />
          <span className={MUTED}>
            {formatDistanceToNow(new Date(agent.last_heartbeat_at), { addSuffix: true })}
          </span>
        </div>
      ),
    },
    {
      header: 'Success Rate',
      render: (agent) => <div className="text-sm font-medium">{calculateSuccessRate(agent)}</div>,
    },
    {
      header: 'Jobs',
      render: (agent) => (
        <div className="text-sm">
          <div className="text-[var(--hh-success-text)]">✓ {agent.total_jobs_completed}</div>
          {agent.total_jobs_failed > 0 && (
            <div className="text-[var(--hh-error-text)]">✗ {agent.total_jobs_failed}</div>
          )}
        </div>
      ),
    },
    {
      header: 'CIs Found',
      render: (agent) => (
        <div className="text-sm font-medium">{agent.total_cis_discovered.toLocaleString()}</div>
      ),
    },
    {
      header: 'Actions',
      className: 'text-right',
      render: (agent) => (
        <RequirePermission permission="write">
          <IconButton
            icon="trash"
            variant="ghost"
            size="sm"
            aria-label={`Delete agent ${agent.agent_id}`}
            className="text-[var(--hh-error-text)]"
            onClick={() => handleDelete(agent.agent_id)}
          />
        </RequirePermission>
      ),
    },
  ];

  const initialLoad = !settled;
  const failed = error !== null && agents.length === 0;

  return (
    <section className="space-y-4" aria-label="Registered discovery agents">
      <SectionHeading
        right={
          <Button onClick={fetchAgents} variant="outline" icon="arrows-clockwise">
            Refresh
          </Button>
        }
      >
        <span className="inline-flex items-center gap-2">
          <Icon name="computer-tower" size={20} />
          Discovery Agents
        </span>
      </SectionHeading>
      <p className={`text-sm ${MUTED}`}>
        Registered agents for distributed discovery across networks
      </p>

      {error !== null && agents.length > 0 && (
        <Banner tone="danger" icon="warning-circle">
          {classifyError(error).message}
        </Banner>
      )}

      {initialLoad || failed ? (
        <QueryState what="discovery agents" loading={initialLoad} error={error} onRetry={fetchAgents} />
      ) : agents.length === 0 ? (
        <EmptyState
          icon="computer-tower"
          title="No agents registered"
          description="Deploy and start a discovery agent to begin distributed network scanning"
        />
      ) : (
        <DataTable rows={agents} columns={columns} rowKey={(agent) => agent.id} caption="Discovery agents" />
      )}
    </section>
  );
};
