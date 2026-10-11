import React from 'react';
import { useDiscoveryJobs } from '../../hooks/useDiscoveryJobs';
import { JobStatus } from '../../services/discovery.service';
import { useNavigate } from 'react-router-dom';
import { LiquidGlass } from '../ui/liquid-glass';
import { Badge } from '../ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';

const STATUS_CONFIG: Record<JobStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  pending: { variant: 'outline', label: 'Pending' },
  running: { variant: 'default', label: 'Running' },
  completed: { variant: 'secondary', label: 'Completed' },
  failed: { variant: 'destructive', label: 'Failed' },
  cancelled: { variant: 'outline', label: 'Cancelled' },
};

export const DiscoveryDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { jobs } = useDiscoveryJobs({ limit: 5, sortBy: 'createdAt', sortOrder: 'desc' }, false);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Discovery Dashboard</h2>
        <p className="text-sm text-muted-foreground">
          Monitor and manage multi-cloud discovery operations
        </p>
      </div>

      <LiquidGlass size="sm" rounded="xl" className="p-6">
        <h3 className="text-lg font-semibold">Discovery statistics unavailable</h3>
        <p className="text-sm text-muted-foreground">
          Global discovery statistics and provider totals are unavailable while tenant-safe reporting is being established.
        </p>
      </LiquidGlass>

      <div>
        <h3 className="text-lg font-semibold mb-4">Recent Jobs</h3>
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job ID</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">CIs Discovered</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!jobs || jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center">
                    <p className="text-sm text-muted-foreground py-4">
                      No recent jobs
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow
                    key={job.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate('/discovery?tab=jobs&jobId=' + job.id)}
                  >
                    <TableCell>
                      <span className="font-mono text-sm">
                        {job.id}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {job.provider.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_CONFIG[job.status].variant}>
                        {STATUS_CONFIG[job.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{job.discoveredCIs}</TableCell>
                    <TableCell>
                      {new Date(job.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </LiquidGlass>
      </div>
    </div>
  );
};

export default DiscoveryDashboard;
