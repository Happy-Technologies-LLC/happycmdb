// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { DiscoveredCIResult } from '../../services/discovery.service';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Icon } from '@happy-technologies/design-system';

interface DiscoveryResultsModalProps {
  open: boolean;
  onClose: () => void;
  results: DiscoveredCIResult[];
  jobId: string;
}

export const DiscoveryResultsModal: React.FC<DiscoveryResultsModalProps> = ({
  open,
  onClose,
  results,
  jobId,
}) => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(0);
  const pageSize = 25;

  const uniqueTypes = Array.from(new Set(results.map((ci) => ci.type)));

  const filteredResults = results.filter((ci) => {
    const matchesSearch =
      searchTerm === '' ||
      ci.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ci.type.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = typeFilter === 'all' || ci.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const paginatedResults = filteredResults.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize
  );
  const totalPages = Math.ceil(filteredResults.length / pageSize);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Discovery Results - Job {jobId}</DialogTitle>
          <DialogDescription>
            {filteredResults.length} of {results.length} CIs
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4 my-4">
          <Input
            placeholder="Search by name or type..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1"
          />
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Filter by type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {uniqueTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedResults.map((ci) => (
                <TableRow key={ci.id}>
                  <TableCell className="min-w-[200px]">{ci.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{ci.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs uppercase">{ci.source}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={ci.status === 'active' ? 'secondary' : 'default'}>
                      {ci.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="w-10 h-2 bg-line-soft rounded-full overflow-hidden">
                        <div
                          className={`h-full ${
                            ci.confidenceScore >= 0.8
                              ? 'bg-success'
                              : ci.confidenceScore >= 0.5
                              ? 'bg-warning'
                              : 'bg-danger'
                          }`}
                          style={{ width: `${ci.confidenceScore * 100}%` }}
                        />
                      </div>
                      <span className="text-xs">
                        {(ci.confidenceScore * 100).toFixed(0)}%
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigate(`/inventory/${ci.id}`);
                        onClose();
                      }}
                    >
                      <Icon name="arrow-square-out" size={16} className="mr-1" />
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-muted-foreground">
              Page {currentPage + 1} of {totalPages}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={currentPage === totalPages - 1}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => {
              navigate('/inventory');
              onClose();
            }}
          >
            View All in Inventory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DiscoveryResultsModal;
