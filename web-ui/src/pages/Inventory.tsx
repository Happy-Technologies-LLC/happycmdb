// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import CIList from '../components/ci/CIList';
import CICard from '../components/ci/CICard';
import CIForm from '../components/ci/CIForm';
import { useCIs, useCIActions } from '../hooks/useCIs';
import { CI, CreateCIRequest, UpdateCIRequest } from '../services/ci.service';

type ViewMode = 'list' | 'grid';

export const Inventory: React.FC = () => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedCI, setSelectedCI] = useState<CI | null>(null);

  const { data: cisData, isLoading } = useCIs({ limit: 100 });
  const { createCI, updateCI, deleteCI, isCreating, isUpdating, isDeleting } = useCIActions();

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
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Configuration Items
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage and view all configuration items in your CMDB
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex border rounded-md">
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="icon"
              onClick={() => setViewMode('list')}
              className="rounded-r-none"
            >
              <Icon name="rows" size={16} />
            </Button>
            <Button
              variant={viewMode === 'grid' ? 'default' : 'ghost'}
              size="icon"
              onClick={() => setViewMode('grid')}
              className="rounded-l-none"
            >
              <Icon name="squares-four" size={16} />
            </Button>
          </div>
          <Button onClick={handleCreateClick}>
            <Icon name="plus" size={16} className="mr-2" />
            Add CI
          </Button>
        </div>
      </div>

      {viewMode === 'list' ? (
        <CIList
          onEdit={handleEditClick}
          onDelete={handleDeleteClick}
          onView={handleViewClick}
          showActions={true}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {isLoading ? (
            <div className="col-span-full text-center text-muted-foreground py-8">
              Loading...
            </div>
          ) : cisData?.data.length === 0 ? (
            <div className="col-span-full text-center text-muted-foreground py-8">
              No configuration items found
            </div>
          ) : (
            cisData?.data.map((ci) => (
              <CICard
                key={ci.id}
                ci={ci}
                onEdit={handleEditClick}
                onDelete={handleDeleteClick}
                onView={handleViewClick}
                showActions={true}
              />
            ))
          )}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Configuration Item</DialogTitle>
          </DialogHeader>
          <CIForm
            onSubmit={handleCreateSubmit}
            onCancel={() => setCreateDialogOpen(false)}
            isSubmitting={isCreating}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Configuration Item</DialogTitle>
          </DialogHeader>
          {selectedCI && (
            <CIForm
              ci={selectedCI}
              onSubmit={handleEditSubmit}
              onCancel={() => setEditDialogOpen(false)}
              isSubmitting={isUpdating}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Configuration Item</DialogTitle>
            <DialogDescription>
              This action cannot be undone. Are you sure?
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning" className="my-4">
            <Icon name="warning" size={16} />
            <AlertDescription>
              This action cannot be undone. All relationships and data associated with this CI will be lost.
            </AlertDescription>
          </Alert>
          <p className="text-sm">
            Are you sure you want to delete <strong>{selectedCI?.name}</strong>?
          </p>
          <DialogFooter className="mt-4">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Inventory;
