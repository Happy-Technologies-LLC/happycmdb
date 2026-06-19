// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Search, Play, Pause, CheckCircle, XCircle, Eye, Edit, Trash2,
  GitMerge, TrendingUp, Clock, Sparkles
} from 'lucide-react';
import { useAIPatterns } from '@/hooks/useAIPatterns';
import { useAuth } from '@/contexts/AuthContext';
import { AIPattern } from '@/services/ai-pattern.service';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { PatternDetailModal } from './PatternDetailModal';

export const PatternLibrary: React.FC = () => {
  const { patterns, loading, activatePattern, deactivatePattern, approvePattern, deletePattern } = useAIPatterns();
  const { user } = useAuth();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedPattern, setSelectedPattern] = useState<AIPattern | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  if (loading) {
    return <LoadingSpinner />;
  }

  // Get unique categories
  const categories = Array.from(new Set(patterns.map(p => p.category)));

  // Filter patterns
  const filteredPatterns = patterns.filter(pattern => {
    const matchesSearch = !searchTerm ||
      pattern.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      pattern.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
      pattern.description?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' || pattern.status === statusFilter;
    const matchesCategory = categoryFilter === 'all' || pattern.category === categoryFilter;

    return matchesSearch && matchesStatus && matchesCategory;
  });

  // Pagination
  const totalPages = Math.ceil(filteredPatterns.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedPatterns = filteredPatterns.slice(startIndex, endIndex);

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, categoryFilter]);

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; label: string; icon: any }> = {
      active: { variant: 'default', label: 'Active', icon: <CheckCircle className="h-3 w-3" /> },
      approved: { variant: 'secondary', label: 'Approved', icon: <CheckCircle className="h-3 w-3" /> },
      review: { variant: 'outline', label: 'In Review', icon: <Clock className="h-3 w-3" /> },
      draft: { variant: 'outline', label: 'Draft', icon: <Edit className="h-3 w-3" /> },
      deprecated: { variant: 'destructive', label: 'Deprecated', icon: <XCircle className="h-3 w-3" /> },
    };

    const config = variants[status] || variants.draft;

    return (
      <Badge variant={config.variant} className="flex items-center gap-1">
        {config.icon}
        {config.label}
      </Badge>
    );
  };

  const handleActivate = async (pattern: AIPattern) => {
    if (pattern.status === 'approved') {
      await activatePattern(pattern.patternId, user?.email || 'system');
    }
  };

  const handleDeactivate = async (pattern: AIPattern) => {
    if (pattern.isActive) {
      await deactivatePattern(pattern.patternId, user?.email || 'system');
    }
  };

  const handleApprove = async (pattern: AIPattern) => {
    if (pattern.status === 'review') {
      await approvePattern(pattern.patternId, user?.email || 'system');
    }
  };

  const handleDelete = async (pattern: AIPattern) => {
    if (confirm(`Are you sure you want to delete pattern "${pattern.name}"?`)) {
      await deletePattern(pattern.patternId);
    }
  };

  const handleViewDetails = (pattern: AIPattern) => {
    setSelectedPattern(pattern);
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
              placeholder="Search patterns..."
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
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="review">In Review</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
            </SelectContent>
          </Select>

          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-full md:w-[200px]">
              <SelectValue placeholder="Filter by category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map(cat => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </LiquidGlass>

      {/* Patterns Table */}
      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
              <TableHead className="text-right">Usage</TableHead>
              <TableHead className="text-right">Success Rate</TableHead>
              <TableHead className="text-right">Avg Time</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPatterns.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No patterns found
                </TableCell>
              </TableRow>
            ) : (
              paginatedPatterns.map((pattern) => {
                const successRate = pattern.usageCount > 0
                  ? (pattern.successCount / pattern.usageCount) * 100
                  : 0;

                return (
                  <TableRow
                    key={pattern.patternId}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => handleViewDetails(pattern)}
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {pattern.isActive && (
                          <Sparkles className="h-4 w-4 text-warning" />
                        )}
                        {pattern.name}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{pattern.category}</Badge>
                    </TableCell>
                    <TableCell>{getStatusBadge(pattern.status)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={pattern.confidenceScore >= 0.9 ? "default" : "secondary"}>
                        {(pattern.confidenceScore * 100).toFixed(0)}%
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{pattern.usageCount}</TableCell>
                    <TableCell className="text-right">
                      <span className={successRate >= 80 ? 'text-success' : 'text-warning'}>
                        {successRate.toFixed(0)}%
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {pattern.avgExecutionTimeMs}ms
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        {pattern.status === 'review' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleApprove(pattern)}
                            title="Approve"
                          >
                            <CheckCircle className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {pattern.status === 'approved' && !pattern.isActive && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleActivate(pattern)}
                            title="Activate"
                          >
                            <Play className="h-4 w-4 text-sky-text" />
                          </Button>
                        )}
                        {pattern.isActive && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeactivate(pattern)}
                            title="Deactivate"
                          >
                            <Pause className="h-4 w-4 text-warning" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewDetails(pattern)}
                          title="View Details"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {pattern.status === 'draft' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(pattern)}
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </LiquidGlass>

      {/* Pagination Controls */}
      {filteredPatterns.length > 0 && (
        <LiquidGlass size="sm" rounded="xl">
          <div className="p-4 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="text-sm text-muted-foreground">
              Showing {startIndex + 1}-{Math.min(endIndex, filteredPatterns.length)} of {filteredPatterns.length} patterns
            </div>

            <div className="flex items-center gap-2">
              <Select value={String(pageSize)} onValueChange={(val) => {
                setPageSize(Number(val));
                setCurrentPage(1);
              }}>
                <SelectTrigger className="w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 / page</SelectItem>
                  <SelectItem value="25">25 / page</SelectItem>
                  <SelectItem value="50">50 / page</SelectItem>
                  <SelectItem value="100">100 / page</SelectItem>
                </SelectContent>
              </Select>

              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                >
                  First
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>

                <div className="flex items-center px-3 text-sm">
                  Page {currentPage} of {totalPages}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                >
                  Last
                </Button>
              </div>
            </div>
          </div>
        </LiquidGlass>
      )}

      {/* Pattern Detail Modal */}
      {selectedPattern && (
        <PatternDetailModal
          pattern={selectedPattern}
          open={detailModalOpen}
          onClose={() => setDetailModalOpen(false)}
        />
      )}
    </div>
  );
};
