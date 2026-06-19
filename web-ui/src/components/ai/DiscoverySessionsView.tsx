// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Eye, Search, CheckCircle, XCircle, Clock, Sparkles, Brain } from 'lucide-react';
import { useDiscoverySessions } from '@/hooks/useDiscoverySessions';
import { AIDiscoverySession } from '@/services/ai-pattern.service';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { SessionDetailModal } from './SessionDetailModal';

export const DiscoverySessionsView: React.FC = () => {
  const { sessions, loading } = useDiscoverySessions();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [selectedSession, setSelectedSession] = useState<AIDiscoverySession | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  if (loading) {
    return <LoadingSpinner />;
  }

  // Get unique providers
  const providers = Array.from(new Set(sessions.map(s => s.provider)));

  // Filter sessions
  const filteredSessions = sessions.filter(session => {
    const matchesSearch = !searchTerm ||
      session.targetHost.toLowerCase().includes(searchTerm.toLowerCase()) ||
      session.sessionId.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' || session.status === statusFilter;
    const matchesProvider = providerFilter === 'all' || session.provider === providerFilter;

    return matchesSearch && matchesStatus && matchesProvider;
  });

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; label: string; icon: any }> = {
      completed: { variant: 'default', label: 'Completed', icon: <CheckCircle className="h-3 w-3" /> },
      failed: { variant: 'destructive', label: 'Failed', icon: <XCircle className="h-3 w-3" /> },
      running: { variant: 'outline', label: 'Running', icon: <Clock className="h-3 w-3 animate-spin" /> },
    };

    const config = variants[status] || variants.running;

    return (
      <Badge variant={config.variant} className="flex items-center gap-1">
        {config.icon}
        {config.label}
      </Badge>
    );
  };

  const handleViewDetails = (session: AIDiscoverySession) => {
    setSelectedSession(session);
    setDetailModalOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <LiquidGlass size="sm" rounded="xl">
        <div className="p-4 flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by host or session ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="running">Running</SelectItem>
            </SelectContent>
          </Select>

          <Select value={providerFilter} onValueChange={setProviderFilter}>
            <SelectTrigger className="w-full md:w-[180px]">
              <SelectValue placeholder="Filter by provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Providers</SelectItem>
              {providers.map(provider => (
                <SelectItem key={provider} value={provider}>{provider}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </LiquidGlass>

      {/* Sessions Table */}
      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Target</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
              <TableHead className="text-right">CIs Found</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredSessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No discovery sessions found
                </TableCell>
              </TableRow>
            ) : (
              filteredSessions.map((session) => (
                <TableRow
                  key={session.sessionId}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => handleViewDetails(session)}
                >
                  <TableCell className="font-medium">
                    <div className="flex flex-col">
                      <span className="font-mono text-sm">{session.targetHost}</span>
                      <span className="text-xs text-muted-foreground">:{session.targetPort}</span>
                    </div>
                  </TableCell>
                  <TableCell>{getStatusBadge(session.status)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Brain className="h-4 w-4 text-navy" />
                      <span className="text-sm">{session.provider}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={session.confidenceScore >= 0.8 ? "default" : "secondary"}>
                      {(session.confidenceScore * 100).toFixed(0)}%
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {session.discoveredCIs?.length || 0}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={session.estimatedCost > 0 ? 'text-warning' : 'text-success'}>
                      ${session.estimatedCost?.toFixed(4) || '0.0000'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {session.durationMs ? `${(session.durationMs / 1000).toFixed(1)}s` : '-'}
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">
                      {new Date(session.startedAt).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleViewDetails(session)}
                      title="View Details"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </LiquidGlass>

      {/* Session Detail Modal */}
      {selectedSession && (
        <SessionDetailModal
          session={selectedSession}
          open={detailModalOpen}
          onClose={() => setDetailModalOpen(false)}
        />
      )}
    </div>
  );
};
