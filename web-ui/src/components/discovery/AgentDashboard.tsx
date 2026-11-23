import React, { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import { AgentList } from './AgentList';
import { AgentStatusCard } from './AgentStatusCard';
import { Badge, Card, Icon, PageHeader, SectionHeading, TabPanel, Tabs } from '@happy-technologies/design-system';
import { logClientError } from '@/utils/logger';

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

// HAP-1826: the capabilities the setup snippets advertise. The happycmdb/agent image (Dockerfile.agent) ships no nmap,
// so `nmap` must not be listed here until that image installs it (pinned, no file caps, with a CI proof like the API image).
const ADVERTISED_CAPABILITIES = 'ssh';

type DashboardTab = 'agents' | 'setup';
const TABS_ID = 'agent-dashboard-tabs';
const TAB_OPTIONS: Array<{ value: DashboardTab; label: string; icon: string }> = [
  { value: 'agents', label: 'Agents', icon: 'computer-tower' },
  { value: 'setup', label: 'Setup Guide', icon: 'file-code' },
];

const CODE_BLOCK = 'hh-mono rounded-[var(--hh-radius-md)] bg-[var(--hh-bg-elevated)] p-4 text-sm text-[var(--hh-text-primary)]';
const MUTED = 'text-sm text-[var(--hh-text-muted)]';

export const AgentDashboard: React.FC = () => {
  // null until a read has answered: the cards show a dash, never a zero the server did not send.
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [tab, setTab] = useState<DashboardTab>('agents');

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const fetchStats = async () => {
    try {
      const response = await apiClient.get<{ data?: unknown[] }>('/agents');
      const agents = response.data || [];

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
      setStatsFailed(false);
    } catch (err) {
      setStatsFailed(true);
      logClientError('Error fetching agent stats:', err);
    }
  };

  const successRate =
    stats && stats.totalJobs > 0
      ? Math.round((stats.successfulJobs / stats.totalJobs) * 100)
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Discovery · Agents"
        title="Discovery Agents"
        lede="Manage and monitor distributed discovery agents across your networks"
      />

      <AgentStatusCard
        totalAgents={stats?.totalAgents ?? null}
        activeAgents={stats?.activeAgents ?? null}
        offlineAgents={stats?.offlineAgents ?? null}
        totalJobs={stats?.totalJobs ?? null}
        successRate={successRate}
        loading={stats === null && !statsFailed}
      />

      <div className="space-y-4">
        <Tabs id={TABS_ID} value={tab} onChange={setTab} options={TAB_OPTIONS} aria-label="Discovery agents" />

        <TabPanel tabsId={TABS_ID} value="agents" selected={tab === 'agents'} className="space-y-4">
          {tab === 'agents' && <AgentList />}
        </TabPanel>

        <TabPanel tabsId={TABS_ID} value="setup" selected={tab === 'setup'} className="space-y-4">
          {tab === 'setup' && (
            <Card className="space-y-6">
              <div>
                <SectionHeading className="mb-1">Agent Setup Guide</SectionHeading>
                <p className={MUTED}>Deploy discovery agents to enable distributed network scanning</p>
              </div>

              <div>
                <SectionHeading level={3} className="mb-2">1. Install Agent</SectionHeading>
                <div className={CODE_BLOCK}>
                  <div># Download and install the agent</div>
                  <div>npm install -g @cmdb/agent</div>
                  <div className="mt-2"># Or with Docker</div>
                  <div>docker pull happycmdb/agent:latest</div>
                </div>
              </div>

              <div>
                <SectionHeading level={3} className="mb-2">2. Configure Agent</SectionHeading>
                <div className={CODE_BLOCK}>
                  <div># Set API endpoint</div>
                  <div>export CMDB_API_URL=http://your-cmdb-server:3000</div>
                  <div className="mt-2"># Set agent capabilities</div>
                  <div>export CMDB_CAPABILITIES={ADVERTISED_CAPABILITIES}</div>
                  <div className="mt-2"># Configure reachable networks</div>
                  <div>export CMDB_NETWORKS=10.0.0.0/8,172.16.0.0/12</div>
                </div>
              </div>

              <div>
                <SectionHeading level={3} className="mb-2">3. Start Agent</SectionHeading>
                <div className={CODE_BLOCK}>
                  <div># Start the agent</div>
                  <div>cmdb-agent start</div>
                  <div className="mt-2"># Or with Docker</div>
                  <div>docker run -d \</div>
                  <div className="ml-4">-e CMDB_API_URL=http://your-server:3000 \</div>
                  <div className="ml-4">-e CMDB_CAPABILITIES={ADVERTISED_CAPABILITIES} \</div>
                  <div className="ml-4">-e CMDB_NETWORKS=10.0.0.0/8 \</div>
                  <div className="ml-4">happycmdb/agent:latest</div>
                </div>
              </div>

              <div>
                <SectionHeading level={3} className="mb-2">4. Verify Registration</SectionHeading>
                <p className={`${MUTED} mb-2`}>
                  The agent should appear in the agents list above within 60 seconds.
                  Check the agent status to ensure it's <Badge variant="success">ACTIVE</Badge>.
                </p>
              </div>

              <div className="rounded-[var(--hh-radius-md)] bg-[var(--hh-accent-bg)] p-4 text-[var(--hh-accent-text)]">
                <SectionHeading level={4} className="mb-2">
                  <span className="inline-flex items-center gap-2">
                    <Icon name="graph" size={16} />
                    Network Requirements
                  </span>
                </SectionHeading>
                <ul className="list-inside list-disc space-y-1 text-sm text-[var(--hh-text-body)]">
                  <li>Agent needs network access to CMDB API server (port 3000)</li>
                  <li>nmap is not included in the agent image; TCP connect scans (-sT, -sV) run from the API server and need no added Linux capabilities</li>
                  <li>For SSH: Needs to reach target hosts on port 22</li>
                  <li>Agent sends heartbeat every 60 seconds</li>
                </ul>
              </div>
            </Card>
          )}
        </TabPanel>
      </div>
    </div>
  );
};
