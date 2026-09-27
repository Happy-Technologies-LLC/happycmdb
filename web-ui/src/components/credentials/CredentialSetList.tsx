import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  FormDialog,
  FormDialogContent,
  FormDialogHeader,
  FormDialogBody,
  FormDialogTitle,
} from '@/components/ui/form-dialog';
import CredentialSetForm from './CredentialSetForm';
import {
  credentialService,
  type CredentialSetSummary,
  type CredentialSetInput,
  type CredentialSetUpdateInput,
} from '@/services/credential.service';
import { useToast } from '@/contexts/ToastContext';
import { formatProtocol, formatScope, formatLabel } from '@/lib/credential-display';

export const CredentialSetList: React.FC = () => {
  const { showToast } = useToast();
  const [sets, setSets] = useState<CredentialSetSummary[]>([]);
  const [loading, setLoading] = useState(false);

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedSet, setSelectedSet] = useState<CredentialSetSummary | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadSets = async () => {
    try {
      setLoading(true);
      const data = await credentialService.getCredentialSets();
      setSets(data);
    } catch (error) {
      console.error('Failed to load credential sets:', error);
      showToast('Failed to load credential sets', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSets();
  }, []);

  const handleCreate = async (data: CredentialSetInput | CredentialSetUpdateInput) => {
    try {
      setIsSubmitting(true);
      await credentialService.createCredentialSet(data as CredentialSetInput);
      setCreateDialogOpen(false);
      loadSets();
      showToast('Credential set created successfully', 'success');
    } catch (error: any) {
      console.error('Failed to create credential set:', error);
      const errorMessage =
        error?.response?.data?.message || error?.message || 'Failed to create credential set';
      showToast(errorMessage, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = async (data: CredentialSetInput | CredentialSetUpdateInput) => {
    if (!selectedSet) return;
    try {
      setIsSubmitting(true);
      await credentialService.updateCredentialSet(selectedSet.id, data as CredentialSetUpdateInput);
      setEditDialogOpen(false);
      setSelectedSet(null);
      loadSets();
      showToast('Credential set updated successfully', 'success');
    } catch (error: any) {
      console.error('Failed to update credential set:', error);
      const errorMessage =
        error?.response?.data?.message || error?.message || 'Failed to update credential set';
      showToast(errorMessage, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedSet) return;
    try {
      setIsSubmitting(true);
      await credentialService.deleteCredentialSet(selectedSet.id);
      setDeleteDialogOpen(false);
      setSelectedSet(null);
      loadSets();
      showToast('Credential set deleted successfully', 'success');
    } catch (error: any) {
      console.error('Failed to delete credential set:', error);
      const errorMessage =
        error?.response?.data?.message || error?.message || 'Failed to delete credential set';
      showToast(errorMessage, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };


  const formatDate = (dateString: Date) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Credential Sets</h1>
          <p className="text-muted-foreground mt-1">
            Manage groups of credentials for sequential or parallel authentication
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Icon name="plus" size={16} className="mr-2" />
          Create Set
        </Button>
      </div>

      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted/30 border-b border-border/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Strategy
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Credentials
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Tags
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Created
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center">
                    <div className="flex justify-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  </td>
                </tr>
              ) : sets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No credential sets found. Create your first set to get started.
                  </td>
                </tr>
              ) : (
                sets.map((set) => (
                  <tr
                    key={set.id}
                    className="hover:bg-muted/50 cursor-pointer transition-colors"
                    onClick={() => {
                      setSelectedSet(set);
                      setDetailDialogOpen(true);
                    }}
                  >
                    <td className="px-4 py-3">
                      <div>
                        <span className="text-sm font-medium text-foreground">{set.name}</span>
                        {set.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 max-w-[300px] truncate">
                            {set.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{formatLabel(set.strategy)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-foreground">
                        {set.credentials.length} credential{set.credentials.length !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {!set.tags || set.tags.length === 0 ? (
                        <span className="text-sm text-muted-foreground">-</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {set.tags.slice(0, 2).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                          {set.tags.length > 2 && (
                            <Badge variant="outline" className="text-xs">
                              +{set.tags.length - 2}
                            </Badge>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {formatDate(set.created_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSet(set);
                            setDetailDialogOpen(true);
                          }}
                          className="p-1.5 hover:bg-muted rounded transition-colors"
                          title="View Details"
                        >
                          <Icon name="eye" size={16} className="text-muted-foreground" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSet(set);
                            setEditDialogOpen(true);
                          }}
                          className="p-1.5 hover:bg-primary/10 rounded transition-colors"
                          title="Edit"
                        >
                          <Icon name="pencil-simple" size={16} className="text-primary" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSet(set);
                            setDeleteDialogOpen(true);
                          }}
                          className="p-1.5 hover:bg-destructive/10 rounded transition-colors"
                          title="Delete"
                        >
                          <Icon name="trash" size={16} className="text-destructive" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </LiquidGlass>

      {/* Create Dialog */}
      <FormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <FormDialogContent>
          <FormDialogHeader>
            <FormDialogTitle>Create Credential Set</FormDialogTitle>
          </FormDialogHeader>
          <FormDialogBody>
            <div className="overflow-y-auto max-h-[calc(85vh-12rem)]">
              <CredentialSetForm
                onSubmit={handleCreate}
                onCancel={() => setCreateDialogOpen(false)}
                isSubmitting={isSubmitting}
              />
            </div>
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>

      {/* Edit Dialog */}
      <FormDialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <FormDialogContent>
          <FormDialogHeader>
            <FormDialogTitle>Edit Credential Set</FormDialogTitle>
          </FormDialogHeader>
          <FormDialogBody>
            <div className="overflow-y-auto max-h-[calc(85vh-12rem)]">
              {selectedSet && (
                <CredentialSetForm
                  set={selectedSet}
                  onSubmit={handleEdit}
                  onCancel={() => {
                    setEditDialogOpen(false);
                    setSelectedSet(null);
                  }}
                  isSubmitting={isSubmitting}
                />
              )}
            </div>
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>

      {/* Detail Dialog */}
      <FormDialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <FormDialogContent>
          <FormDialogHeader>
            <FormDialogTitle>Credential Set Details</FormDialogTitle>
          </FormDialogHeader>
          <FormDialogBody>
            <div className="overflow-y-auto max-h-[calc(85vh-12rem)] space-y-4">
              {selectedSet && (
                <>
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground">Name</h3>
                    <p className="text-base font-medium">{selectedSet.name}</p>
                  </div>
                  {selectedSet.description && (
                    <div>
                      <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
                      <p className="text-sm">{selectedSet.description}</p>
                    </div>
                  )}
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground">Strategy</h3>
                    <Badge variant="secondary" className="mt-1">
                      {formatLabel(selectedSet.strategy)}
                    </Badge>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-2">
                      Credentials ({selectedSet.credentials.length})
                    </h3>
                    <div className="space-y-2">
                      {selectedSet.credentials.map((cred, index) => (
                        <div
                          key={cred.id}
                          className="p-3 border border-border rounded-lg bg-muted/20"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">#{index + 1}</span>
                                <span className="text-sm font-medium">{cred.name}</span>
                              </div>
                              {cred.description && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  {cred.description}
                                </p>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <Badge variant="outline">{formatProtocol(cred.protocol)}</Badge>
                              <Badge variant="outline">{formatScope(cred.scope)}</Badge>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {selectedSet.tags && selectedSet.tags.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium text-muted-foreground mb-2">Tags</h3>
                      <div className="flex flex-wrap gap-2">
                        {selectedSet.tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Credential Set</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{selectedSet?.name}"?
              {selectedSet?.usage_count && selectedSet.usage_count > 0 && (
                <span className="block mt-2 text-destructive font-medium">
                  Warning: This credential set is used by {selectedSet.usage_count} discovery
                  definition{selectedSet.usage_count !== 1 ? 's' : ''}. Deleting it may affect
                  those definitions.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setSelectedSet(null);
              }}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isSubmitting}>
              {isSubmitting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CredentialSetList;
