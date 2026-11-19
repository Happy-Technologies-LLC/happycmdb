// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/contexts/ToastContext';
import CIList from '../components/ci/CIList';
import CICard from '../components/ci/CICard';
import CIDrawer from '../components/ci/CIDrawer';
import CIForm from '../components/ci/CIForm';
import { QueryState } from '../components/estate/SurfaceState';
import { useCIs, useCIActions } from '../hooks/useCIs';
import { usePermission } from '@/hooks/usePermission';
import { RequirePermission } from '@/components/common/RequirePermission';
import { CI, CreateCIRequest, UpdateCIRequest } from '../services/ci.service';

/**
 * The create and edit form is wider than the dialog default (max-w-md) and scrolls inside the viewport. Inline,
 * because the DS joins class names without merging, so a max-w class here would race the default one in the
 * stylesheet.
 */
const FORM_DIALOG: React.CSSProperties = { maxWidth: '42rem', maxHeight: '90vh', overflowY: 'auto' };

type ViewMode = 'list' | 'grid';

export const Inventory: React.FC = () => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedCI, setSelectedCI] = useState<CI | null>(null);
  const [peekCI, setPeekCI] = useState<CI | null>(null);

  const { data: cisData, isLoading, error, refetch } = useCIs({ limit: 100 });
  const { createCI, updateCI, deleteCI, isCreating, isUpdating, isDeleting } = useCIActions();
  // POST /api/v1/cis, PUT /api/v1/cis/:id, DELETE /api/v1/cis/:id all require 'write' (ci.routes.ts)
  const canWrite = usePermission('write');

  const handleCreateClick = () => {
    setCreateDialogOpen(true);
  };

  const handleCreateSubmit = async (data: CreateCIRequest | UpdateCIRequest) => {
    const result = await createCI(data as CreateCIRequest);
    if (result.success) {
      setCreateDialogOpen(false);
      showToast('Configuration item created successfully', 'success');
    } else {
      showToast(`Failed to create CI: ${result.error}`, 'error');
    }
  };

  const handleEditClick = (ci: CI) => {
    setSelectedCI(ci);
    setEditDialogOpen(true);
  };

  const handleEditSubmit = async (data: UpdateCIRequest) => {
    if (!selectedCI) return;

    const result = await updateCI(selectedCI.id, data);
    if (result.success) {
      setEditDialogOpen(false);
      setSelectedCI(null);
      showToast('Configuration item updated successfully', 'success');
    } else {
      showToast(`Failed to update CI: ${result.error}`, 'error');
    }
  };

  const handleDeleteClick = (ci: CI) => {
    setSelectedCI(ci);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!selectedCI) return;

    const result = await deleteCI(selectedCI.id);
    if (result.success) {
      setDeleteDialogOpen(false);
      setSelectedCI(null);
      showToast('Configuration item deleted successfully', 'success');
    } else {
      showToast(`Failed to delete CI: ${result.error}`, 'error');
    }
  };

  const handleViewClick = (ci: CI) => {
    navigate(`/inventory/${ci.id}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="CMDB · Inventory"
        title="Configuration Items"
        lede="Manage and view all configuration items in your CMDB"
        actions={
          <>
            <SegmentedControl<ViewMode>
              aria-label="View mode"
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: 'list', label: 'List', icon: 'rows' },
                { value: 'grid', label: 'Grid', icon: 'squares-four' },
              ]}
            />
            <RequirePermission permission="write">
              <Button icon="plus" onClick={handleCreateClick}>
                Add CI
              </Button>
            </RequirePermission>
          </>
        }
      />

      {viewMode === 'list' ? (
        <CIList
          onEdit={canWrite ? handleEditClick : undefined}
          onDelete={canWrite ? handleDeleteClick : undefined}
          onView={handleViewClick}
          showActions={true}
        />
      ) : isLoading || error ? (
        <QueryState
          what="configuration items"
          loading={isLoading}
          error={error}
          onRetry={() => void refetch()}
        />
      ) : cisData?.data.length === 0 ? (
        <EmptyState label="No configuration items found" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {cisData?.data.map((ci) => (
            <CICard
              key={ci.id}
              ci={ci}
              onEdit={canWrite ? handleEditClick : undefined}
              onDelete={canWrite ? handleDeleteClick : undefined}
              onView={handleViewClick}
              onPeek={setPeekCI}
              showActions={true}
            />
          ))}
        </div>
      )}

      {peekCI && (
        <CIDrawer
          ciId={peekCI.id}
          open
          onClose={() => setPeekCI(null)}
          onOpenFull={() => {
            const ci = peekCI;
            setPeekCI(null);
            handleViewClick(ci);
          }}
        />
      )}

      {/* Create Dialog */}
      <Dialog
        open={canWrite && createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        aria-label="Create Configuration Item"
        style={FORM_DIALOG}
      >
        <CIForm
          onSubmit={handleCreateSubmit}
          onCancel={() => setCreateDialogOpen(false)}
          isSubmitting={isCreating}
        />
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={canWrite && editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        aria-label="Edit Configuration Item"
        style={FORM_DIALOG}
      >
        {selectedCI && (
          <CIForm
            ci={selectedCI}
            onSubmit={handleEditSubmit}
            onCancel={() => setEditDialogOpen(false)}
            isSubmitting={isUpdating}
          />
        )}
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={canWrite && deleteDialogOpen}
        title="Delete Configuration Item"
        tone="danger"
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete'}
        onConfirm={() => {
          if (!isDeleting) void handleDeleteConfirm();
        }}
        onCancel={() => {
          if (!isDeleting) setDeleteDialogOpen(false);
        }}
        body={
          <div className="space-y-3">
            <Banner tone="warning" icon="warning">
              This action cannot be undone. All relationships and data associated with this CI will be lost.
            </Banner>
            <p>
              Are you sure you want to delete <strong>{selectedCI?.name}</strong>?
            </p>
          </div>
        }
      />
    </div>
  );
};

export default Inventory;
