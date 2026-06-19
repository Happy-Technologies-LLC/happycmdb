import React from 'react';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Server, Activity, CheckCircle, XCircle } from 'lucide-react';

interface AgentStatusCardProps {
  totalAgents: number;
  activeAgents: number;
  offlineAgents: number;
  totalJobs: number;
  successRate: number;
}

export const AgentStatusCard: React.FC<AgentStatusCardProps> = ({
  totalAgents,
  activeAgents,
  offlineAgents,
  totalJobs,
  successRate,
}) => {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
      <LiquidGlass size="sm" rounded="xl" className="p-[22px]">
        <div className="flex items-center justify-between">
          <span className="font-display text-[12.5px] font-semibold text-ink-soft">Total Agents</span>
          <span className="flex h-11 w-11 items-center justify-center rounded-md bg-sky-soft text-sky-text">
            <Server className="h-5 w-5" />
          </span>
        </div>
        <div className="mt-3 font-display text-[2.3rem] font-extrabold leading-none tracking-[-0.02em] text-navy">
          {totalAgents}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Registered agents</p>
      </LiquidGlass>

      <LiquidGlass size="sm" rounded="xl" className="p-[22px]">
        <div className="flex items-center justify-between">
          <span className="font-display text-[12.5px] font-semibold text-ink-soft">Active</span>
          <span className="flex h-11 w-11 items-center justify-center rounded-md bg-success-soft text-success">
            <CheckCircle className="h-5 w-5" />
          </span>
        </div>
        <div className="mt-3 font-display text-[2.3rem] font-extrabold leading-none tracking-[-0.02em] text-success">
          {activeAgents}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {totalAgents > 0
            ? `${Math.round((activeAgents / totalAgents) * 100)}% online`
            : 'No agents'}
        </p>
      </LiquidGlass>

      <LiquidGlass size="sm" rounded="xl" className="p-[22px]">
        <div className="flex items-center justify-between">
          <span className="font-display text-[12.5px] font-semibold text-ink-soft">Offline</span>
          <span className="flex h-11 w-11 items-center justify-center rounded-md bg-danger-soft text-danger">
            <XCircle className="h-5 w-5" />
          </span>
        </div>
        <div className="mt-3 font-display text-[2.3rem] font-extrabold leading-none tracking-[-0.02em] text-danger">
          {offlineAgents}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Need attention</p>
      </LiquidGlass>

      <LiquidGlass size="sm" rounded="xl" className="p-[22px]">
        <div className="flex items-center justify-between">
          <span className="font-display text-[12.5px] font-semibold text-ink-soft">Total Jobs</span>
          <span className="flex h-11 w-11 items-center justify-center rounded-md bg-sky-soft text-sky-text">
            <Activity className="h-5 w-5" />
          </span>
        </div>
        <div className="mt-3 font-display text-[2.3rem] font-extrabold leading-none tracking-[-0.02em] text-navy">
          {totalJobs}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Completed</p>
      </LiquidGlass>

      <LiquidGlass size="sm" rounded="xl" className="p-[22px]">
        <div className="flex items-center justify-between">
          <span className="font-display text-[12.5px] font-semibold text-ink-soft">Success Rate</span>
          <span className="flex h-11 w-11 items-center justify-center rounded-md bg-sky-soft text-sky-text">
            <Activity className="h-5 w-5" />
          </span>
        </div>
        <div className="mt-3 font-display text-[2.3rem] font-extrabold leading-none tracking-[-0.02em] text-navy">
          {successRate}%
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Overall performance</p>
      </LiquidGlass>
    </div>
  );
};
