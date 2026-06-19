// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Trash2, RefreshCw, Server, Activity, Network } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1';

export const AgentList: React.FC = () => {
  const [agents, setAgents] = useState<DiscoveryAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_BASE_URL}/agents`);
      setAgents(response.data.data || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch agents');
      console.error('Error fetching agents:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
    // Refresh every 10 seconds
    const interval = setInterval(fetchAgents, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleDelete = async (agentId: string) => {
    if (!confirm(`Are you sure you want to delete agent ${agentId}?`)) {
      return;
    }

    try {
      await axios.delete(`${API_BASE_URL}/agents/${agentId}`);
      await fetchAgents();
    } catch (err: any) {
      alert(`Failed to delete agent: ${err.message}`);
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      active: 'default',
      inactive: 'secondary',
      offline: 'destructive',
      disabled: 'outline',
    };

    return (
      <Badge variant={variants[status] || 'outline'}>
        {status.toUpperCase()}
      </Badge>
    );
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

  if (loading && agents.length === 0) {
    return (
      <LiquidGlass size="sm" rounded="xl" className="p-6">
        <div className="flex items-center justify-center h-32">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </LiquidGlass>
    );
  }

  return (
    <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
      <div className="p-6 border-b border-border/50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Server className="h-5 w-5" />
              Discovery Agents
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Registered agents for distributed discovery across networks
            </p>
          </div>
          <Button onClick={fetchAgents} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>
      <div className="p-6">
        {error && (
          <div className="bg-destructive/10 text-destructive px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {agents.length === 0 ? (
          <div className="text-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No agents registered</h3>
            <p className="text-sm text-muted-foreground">
              Deploy and start a discovery agent to begin distributed network scanning
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Networks</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Heartbeat</TableHead>
                <TableHead>Success Rate</TableHead>
                <TableHead>Jobs</TableHead>
                <TableHead>CIs Found</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <div>
                      <div className="font-medium">{agent.hostname}</div>
                      <div className="text-xs text-muted-foreground">
                        {agent.agent_id}
                      </div>
                      {agent.platform && (
                        <div className="text-xs text-muted-foreground mt-1">
                          {agent.platform}/{agent.arch} • v{agent.version}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {getStatusBadge(agent.status)}
                      {isStale(agent.last_heartbeat_at) && (
                        <Badge variant="outline" className="text-xs">
                          STALE
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-start gap-1 max-w-xs">
                      <Network className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                      <div className="text-sm">
                        {agent.reachable_networks.length > 0 ? (
                          agent.reachable_networks.map((network, i) => (
                            <div key={i} className="truncate">
                              {network}
                            </div>
                          ))
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {agent.provider_capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary" className="text-xs">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 text-sm">
                      <Activity className="h-3 w-3 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        {formatDistanceToNow(new Date(agent.last_heartbeat_at), {
                          addSuffix: true,
                        })}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">
                      {calculateSuccessRate(agent)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">
                      <div className="text-success">
                        ✓ {agent.total_jobs_completed}
                      </div>
                      {agent.total_jobs_failed > 0 && (
                        <div className="text-danger">
                          ✗ {agent.total_jobs_failed}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">
                      {agent.total_cis_discovered.toLocaleString()}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      onClick={() => handleDelete(agent.agent_id)}
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </LiquidGlass>
  );
};
