// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import { Badge, Banner, Button, FieldList, Select } from '@happy-technologies/design-system';
import { logClientError } from '@/utils/logger';

interface Agent {
  id: string;
  agent_id: string;
  hostname: string;
  reachable_networks: string[];
  provider_capabilities: string[];
  status: string;
  last_heartbeat_at: string;
}

interface AgentSelectorProps {
  method: 'agentless' | 'agent';
  provider: string;
  selectedAgentId?: string;
  onAgentChange: (agentId: string | undefined) => void;
  targetNetworks?: string[];
}

export const AgentSelector: React.FC<AgentSelectorProps> = ({
  method,
  provider,
  selectedAgentId,
  onAgentChange,
  targetNetworks = [],
}) => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [recommendedAgent, setRecommendedAgent] = useState<string | null>(null);

  useEffect(() => {
    if (method === 'agent') {
      fetchAgents();
    }
  }, [method, provider]);

  useEffect(() => {
    if (method === 'agent' && targetNetworks.length > 0 && agents.length > 0) {
      findBestAgent();
    }
  }, [targetNetworks, agents, method]);

  const fetchAgents = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get<{ data?: Agent[] }>('/agents', {
        params: {
          status: 'active',
          provider,
        },
      });
      setAgents(response.data || []);
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      logClientError('Error fetching agents:', err);
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  };

  const findBestAgent = async () => {
    if (targetNetworks.length === 0 || !provider) return;

    try {
      const response = await apiClient.post<{ success: boolean; data: { agent_id?: string } }>('/agents/find-best', {
        targetNetworks,
        provider,
      });
      if (response.success && response.data.agent_id) {
        setRecommendedAgent(response.data.agent_id);
      }
    } catch (err) {
      logClientError('Error finding best agent:', err);
      setRecommendedAgent(null);
    }
  };

  if (method !== 'agent') {
    return null;
  }

  const activeAgents = agents.filter((a) => a.status === 'active');

  const networkSummary = (agent: Agent) =>
    agent.reachable_networks.slice(0, 2).join(', ') +
    (agent.reachable_networks.length > 2 ? ` +${agent.reachable_networks.length - 2} more` : '');

  const options = [
    { value: 'auto', label: `Auto-select (Smart Routing)${recommendedAgent ? ' - Recommended' : ''}` },
    ...activeAgents.map((agent) => ({
      value: agent.agent_id,
      label: `${agent.hostname}${agent.agent_id === recommendedAgent ? ' (Best Match)' : ''} [${networkSummary(agent)}]`,
    })),
  ];

  const selectedAgent =
    selectedAgentId && selectedAgentId !== 'auto'
      ? agents.find((a) => a.agent_id === selectedAgentId)
      : undefined;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Select
          id="agent-selector"
          label="Discovery Agent"
          value={selectedAgentId || 'auto'}
          onChange={(value) => {
            onAgentChange(value === 'auto' ? undefined : value);
          }}
          options={options}
          disabled={loading}
          hint={loading ? 'Loading agents…' : undefined}
        />

        {selectedAgentId === undefined && (
          <Banner tone="info" icon="sparkle" className="mt-2">
            <strong>Smart Routing Enabled:</strong> The system will automatically
            select the best agent based on network reachability and performance.
            {recommendedAgent && (
              <span className="mt-1 block text-sm">
                Recommended agent:{' '}
                <code className="hh-mono text-xs">
                  {agents.find((a) => a.agent_id === recommendedAgent)?.hostname ||
                    recommendedAgent}
                </code>
              </span>
            )}
          </Banner>
        )}

        {loadFailed && (
          <Banner tone="danger" icon="warning-circle" className="mt-2">
            Could not load agents for provider <strong>{provider}</strong>.{' '}
            <Button size="sm" variant="secondary" onClick={fetchAgents}>
              Try again
            </Button>
          </Banner>
        )}

        {loaded && !loading && !loadFailed && activeAgents.length === 0 && (
          <Banner tone="danger" icon="warning-circle" className="mt-2">
            No active agents found for provider <strong>{provider}</strong>.
            Please deploy and register an agent before using agent-based discovery.
          </Banner>
        )}

        {selectedAgentId && selectedAgentId !== 'auto' && (
          <div className="mt-2 rounded-[var(--hh-radius-md)] bg-[var(--hh-bg-elevated)] p-3">
            <div className="mb-1 text-sm font-medium">Selected Agent Details:</div>
            {selectedAgent ? (
              <FieldList
                fields={[
                  ['Hostname', selectedAgent.hostname],
                  ['Networks', selectedAgent.reachable_networks.join(', ')],
                  [
                    'Capabilities',
                    <span key="caps" className="flex flex-wrap gap-1">
                      {selectedAgent.provider_capabilities.map((cap) => (
                        <Badge key={cap} variant="neutral">
                          {cap}
                        </Badge>
                      ))}
                    </span>,
                  ],
                ]}
              />
            ) : (
              <div className="text-sm text-[var(--hh-text-muted)]">Loading...</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
