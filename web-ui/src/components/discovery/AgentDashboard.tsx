import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { AgentList } from './AgentList';
import { AgentStatusCard } from './AgentStatusCard';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';
import { Server, Network, FileCode } from 'lucide-react';

interface AgentStats {
  totalAgents: number;
  activeAgents: number;
  inactiveAgents: number;
  offlineAgents: number;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  totalCIsDiscovered: number;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1';

export const AgentDashboard: React.FC = () => {
  const [stats, setStats] = useState<AgentStats>({
    totalAgents: 0,
    activeAgents: 0,
    inactiveAgents: 0,
    offlineAgents: 0,
    totalJobs: 0,
    successfulJobs: 0,
    failedJobs: 0,
    totalCIsDiscovered: 0,
  });

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const fetchStats = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/agents`);
      const agents = response.data.data || [];

      const calculated = agents.reduce(
        (acc: AgentStats, agent: any) => ({
          totalAgents: acc.totalAgents + 1,
          activeAgents: acc.activeAgents + (agent.status === 'active' ? 1 : 0),
          inactiveAgents: acc.inactiveAgents + (agent.status === 'inactive' ? 1 : 0),
          offlineAgents: acc.offlineAgents + (agent.status === 'offline' ? 1 : 0),
          totalJobs: acc.totalJobs + agent.total_jobs_completed + agent.total_jobs_failed,
          successfulJobs: acc.successfulJobs + agent.total_jobs_completed,
          failedJobs: acc.failedJobs + agent.total_jobs_failed,
          totalCIsDiscovered: acc.totalCIsDiscovered + agent.total_cis_discovered,
        }),
        {
          totalAgents: 0,
          activeAgents: 0,
          inactiveAgents: 0,
          offlineAgents: 0,
          totalJobs: 0,
          successfulJobs: 0,
          failedJobs: 0,
          totalCIsDiscovered: 0,
        }
      );

      setStats(calculated);
    } catch (err) {
      console.error('Error fetching agent stats:', err);
    }
  };

  const successRate =
    stats.totalJobs > 0
      ? Math.round((stats.successfulJobs / stats.totalJobs) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Discovery Agents</h1>
        <p className="text-muted-foreground mt-2">
          Manage and monitor distributed discovery agents across your networks
        </p>
      </div>

      <AgentStatusCard
        totalAgents={stats.totalAgents}
        activeAgents={stats.activeAgents}
        offlineAgents={stats.offlineAgents}
        totalJobs={stats.totalJobs}
        successRate={successRate}
      />

      <Tabs defaultValue="agents" className="space-y-4">
        <TabsList>
          <TabsTrigger value="agents">
            <Server className="h-4 w-4 mr-2" />
            Agents
          </TabsTrigger>
          <TabsTrigger value="setup">
            <FileCode className="h-4 w-4 mr-2" />
            Setup Guide
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="space-y-4">
          <AgentList />
        </TabsContent>

        <TabsContent value="setup" className="space-y-4">
          <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
            <div className="p-6 border-b border-border/50">
              <h2 className="text-xl font-semibold">Agent Setup Guide</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Deploy discovery agents to enable distributed network scanning
              </p>
            </div>
            <div className="p-6 space-y-6">
              <div>
                <h3 className="text-lg font-semibold mb-2">1. Install Agent</h3>
                <div className="bg-muted p-4 rounded-md font-mono text-sm">
                  <div># Download and install the agent</div>
                  <div>npm install -g @cmdb/agent</div>
                  <div className="mt-2"># Or with Docker</div>
                  <div>docker pull happycmdb/agent:latest</div>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-semibold mb-2">2. Configure Agent</h3>
                <div className="bg-muted p-4 rounded-md font-mono text-sm">
                  <div># Set API endpoint</div>
                  <div>export CMDB_API_URL=http://your-cmdb-server:3000</div>
                  <div className="mt-2"># Set agent capabilities</div>
                  <div>export CMDB_CAPABILITIES=nmap,ssh</div>
                  <div className="mt-2"># Configure reachable networks</div>
                  <div>export CMDB_NETWORKS=10.0.0.0/8,172.16.0.0/12</div>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-semibold mb-2">3. Start Agent</h3>
                <div className="bg-muted p-4 rounded-md font-mono text-sm">
                  <div># Start the agent</div>
                  <div>cmdb-agent start</div>
                  <div className="mt-2"># Or with Docker</div>
                  <div>docker run -d \</div>
                  <div className="ml-4">-e CMDB_API_URL=http://your-server:3000 \</div>
                  <div className="ml-4">-e CMDB_CAPABILITIES=nmap,ssh \</div>
                  <div className="ml-4">-e CMDB_NETWORKS=10.0.0.0/8 \</div>
                  <div className="ml-4">--cap-add=NET_RAW --cap-add=NET_ADMIN \</div>
                  <div className="ml-4">happycmdb/agent:latest</div>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-semibold mb-2">4. Verify Registration</h3>
                <p className="text-sm text-muted-foreground mb-2">
                  The agent should appear in the agents list above within 60 seconds.
                  Check the agent status to ensure it's <Badge>ACTIVE</Badge>.
                </p>
              </div>

              <div className="bg-blue-50 dark:bg-blue-950 p-4 rounded-md">
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  Network Requirements
                </h4>
                <ul className="list-disc list-inside text-sm space-y-1 text-muted-foreground">
                  <li>Agent needs network access to CMDB API server (port 3000)</li>
                  <li>For nmap: Requires NET_RAW and NET_ADMIN capabilities</li>
                  <li>For SSH: Needs to reach target hosts on port 22</li>
                  <li>Agent sends heartbeat every 60 seconds</li>
                </ul>
              </div>
            </div>
          </LiquidGlass>
        </TabsContent>
      </Tabs>
    </div>
  );
};
