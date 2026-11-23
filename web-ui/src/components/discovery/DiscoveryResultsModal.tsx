// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { DiscoveredCIResult } from '../../services/discovery.service';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  ConfidenceBar,
  DataTable,
  Dialog,
  Input,
  NativeSelect,
  Pagination,
  SectionHeading,
  type Column,
} from '@happy-technologies/design-system';

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

  const totalPages = Math.ceil(filteredResults.length / pageSize);
  // A filter that shrinks the result set must not leave the table on a page past the end.
  const page = Math.min(currentPage, Math.max(0, totalPages - 1));
  const paginatedResults = filteredResults.slice(page * pageSize, (page + 1) * pageSize);

  const columns: Array<Column<DiscoveredCIResult>> = [
    { header: 'Name', className: 'min-w-[200px]', render: (ci) => ci.name },
    { header: 'Type', render: (ci) => <Badge variant="neutral">{ci.type}</Badge> },
    { header: 'Source', render: (ci) => <span className="text-xs uppercase">{ci.source}</span> },
    {
      header: 'Status',
      render: (ci) => <Badge variant={ci.status === 'active' ? 'success' : 'info'}>{ci.status}</Badge>,
    },
    {
      header: 'Confidence',
      // No score is shown as a dash, not as 0%.
      render: (ci) =>
        typeof ci.confidenceScore === 'number' ? <ConfidenceBar value={ci.confidenceScore} /> : '\u2013',
    },
    {
      header: 'Actions',
      render: (ci) => (
        <Button
          variant="ghost"
          icon="arrow-square-out"
          onClick={() => {
            navigate(`/inventory/${ci.id}`);
            onClose();
          }}
        >
          View
        </Button>
      ),
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-label={`Discovery Results - Job ${jobId}`}
      className="max-w-6xl!"
    >
      <div className="max-h-[90vh] space-y-4 overflow-y-auto p-6">
        <div>
          <SectionHeading className="mb-1">Discovery Results - Job {jobId}</SectionHeading>
          <p className="text-sm text-[var(--hh-text-muted)]">
            {filteredResults.length} of {results.length} CIs
          </p>
        </div>

        <div className="flex gap-4">
          <Input
            size="sm"
            aria-label="Search by name or type"
            placeholder="Search by name or type..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            containerClassName="flex-1"
          />
          <NativeSelect
            size="sm"
            aria-label="Filter by type"
            containerClassName="w-[200px]"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">All Types</option>
            {uniqueTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </NativeSelect>
        </div>

        <DataTable
          rows={paginatedResults}
          columns={columns}
          rowKey={(ci) => ci.id}
          caption="Discovered CIs"
          emptyLabel={results.length === 0 ? 'This job discovered no CIs' : 'No CIs match the current filters'}
          footer={
            totalPages > 1 ? (
              <Pagination
                page={page + 1}
                pageCount={totalPages}
                onChange={(next) => setCurrentPage(next - 1)}
              />
            ) : undefined
          }
        />

        <div className="flex justify-end gap-3">
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
        </div>
      </div>
    </Dialog>
  );
};

export default DiscoveryResultsModal;
