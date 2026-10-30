// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Icon } from '@happy-technologies/design-system';
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
    } catch (err) {
      logClientError('Error fetching agents:', err);
    } finally {
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

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="agent-selector" className="flex items-center gap-2">
          <Icon name="computer-tower" size={16} />
          Discovery Agent
        </Label>

        <Select
          value={selectedAgentId || 'auto'}
          onValueChange={(value) => {
            onAgentChange(value === 'auto' ? undefined : value);
          }}
          disabled={loading}
        >
          <SelectTrigger id="agent-selector">
            <SelectValue placeholder="Select an agent..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">
              <div className="flex items-center gap-2">
                <Icon name="sparkle" size={16} />
                Auto-select (Smart Routing)
                {recommendedAgent && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    Recommended
                  </Badge>
                )}
              </div>
            </SelectItem>

            {activeAgents.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                  Available Agents
                </div>
                {activeAgents.map((agent) => (
                  <SelectItem key={agent.agent_id} value={agent.agent_id}>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        {agent.hostname}
                        {agent.agent_id === recommendedAgent && (
                          <Badge variant="secondary" className="text-xs">
                            Best Match
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                        <Icon name="graph" size={12} />
                        {agent.reachable_networks.slice(0, 2).join(', ')}
                        {agent.reachable_networks.length > 2 && (
                          <span>+{agent.reachable_networks.length - 2} more</span>
                        )}
                      </div>
                    </div>
                  </SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>

        {selectedAgentId === undefined && (
          <Alert className="mt-2">
            <Icon name="sparkle" size={16} />
            <AlertDescription>
              <strong>Smart Routing Enabled:</strong> The system will automatically
              select the best agent based on network reachability and performance.
              {recommendedAgent && (
                <div className="mt-1 text-sm">
                  Recommended agent:{' '}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    {agents.find((a) => a.agent_id === recommendedAgent)?.hostname ||
                      recommendedAgent}
                  </code>
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        {activeAgents.length === 0 && (
          <Alert variant="destructive" className="mt-2">
            <Icon name="warning-circle" size={16} />
            <AlertDescription>
              No active agents found for provider <strong>{provider}</strong>.
              Please deploy and register an agent before using agent-based discovery.
            </AlertDescription>
          </Alert>
        )}

        {selectedAgentId && selectedAgentId !== 'auto' && (
          <div className="mt-2 p-3 bg-muted rounded-md">
            <div className="text-sm font-medium mb-1">Selected Agent Details:</div>
            {(() => {
              const agent = agents.find((a) => a.agent_id === selectedAgentId);
              if (!agent) return <div className="text-sm text-muted-foreground">Loading...</div>;

              return (
                <div className="space-y-1 text-sm">
                  <div><strong>Hostname:</strong> {agent.hostname}</div>
                  <div><strong>Networks:</strong> {agent.reachable_networks.join(', ')}</div>
                  <div>
                    <strong>Capabilities:</strong>{' '}
                    {agent.provider_capabilities.map((cap) => (
                      <Badge key={cap} variant="secondary" className="ml-1 text-xs">
                        {cap}
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
};
