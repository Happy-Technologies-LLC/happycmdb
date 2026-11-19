import React, { useState, useEffect } from 'react';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  Dialog,
  FieldList,
  IconButton,
  ListRow,
  PageHeader,
  SectionHeading,
  Tag,
  type Column,
} from '@happy-technologies/design-system';
import CredentialSetForm from './CredentialSetForm';
import { RequirePermission } from '@/components/common/RequirePermission';
import { QueryState } from '@/components/estate/SurfaceState';
import {
  credentialService,
  type CredentialSetSummary,
  type CredentialSetInput,
  type CredentialSetUpdateInput,
} from '@/services/credential.service';
import { useToast } from '@/contexts/ToastContext';
import { formatProtocol, formatScope, formatLabel } from '@/lib/credential-display';
import { logClientError } from '@/utils/logger';

export const CredentialSetList: React.FC = () => {
  const { showToast } = useToast();
  const [sets, setSets] = useState<CredentialSetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<{ cause: unknown } | null>(null);

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
      setLoadFailure(null);
      const data = await credentialService.getCredentialSets();
      setSets(data);
    } catch (error) {
      logClientError('Failed to load credential sets:', error);
      setLoadFailure({ cause: error });
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
      logClientError('Failed to create credential set:', error);
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
      logClientError('Failed to update credential set:', error);
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
      logClientError('Failed to delete credential set:', error);
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

  const openDetail = (set: CredentialSetSummary) => {
    setSelectedSet(set);
    setDetailDialogOpen(true);
  };

  const columns: Array<Column<CredentialSetSummary>> = [
    {
      header: 'Name',
      render: (set) => (
        <div>
          <span className="text-sm font-medium">{set.name}</span>
          {set.description && (
            <p className="mt-0.5 max-w-[300px] truncate text-xs text-[var(--hh-text-muted)]">
              {set.description}
            </p>
          )}
        </div>
      ),
    },
    {
      header: 'Strategy',
      render: (set) => <Badge variant="neutral">{formatLabel(set.strategy)}</Badge>,
    },
    {
      header: 'Credentials',
      render: (set) =>
        `${set.credentials.length} credential${set.credentials.length !== 1 ? 's' : ''}`,
    },
    {
      header: 'Tags',
      render: (set) =>
        !set.tags || set.tags.length === 0 ? (
          <span className="text-[var(--hh-text-muted)]">-</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {set.tags.slice(0, 2).map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
            {set.tags.length > 2 && <Tag>+{set.tags.length - 2}</Tag>}
          </div>
        ),
    },
    {
      header: 'Created',
      render: (set) => (
        <span className="text-[var(--hh-text-muted)]">{formatDate(set.created_at)}</span>
      ),
    },
    {
      header: 'Actions',
      className: 'text-right',
      render: (set) => (
        <div className="flex justify-end gap-1">
          <IconButton
            icon="eye"
            variant="ghost"
            size="sm"
            shape="rounded"
            aria-label="View Details"
            title="View Details"
            onClick={() => openDetail(set)}
          />
          <RequirePermission permission="write">
            <IconButton
              icon="pencil-simple"
              variant="ghost"
              size="sm"
              shape="rounded"
              aria-label="Edit"
              title="Edit"
              onClick={() => {
                setSelectedSet(set);
                setEditDialogOpen(true);
              }}
            />
            <IconButton
              icon="trash"
              variant="ghost"
              size="sm"
              shape="rounded"
              aria-label="Delete"
              title="Delete"
              onClick={() => {
                setSelectedSet(set);
                setDeleteDialogOpen(true);
              }}
            />
          </RequirePermission>
        </div>
      ),
    },
  ];

  const usageCount = selectedSet?.usage_count ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Credentials"
        title="Credential Sets"
        lede="Manage groups of credentials for sequential or parallel authentication"
        actions={
          <RequirePermission permission="write">
            <Button icon="plus" onClick={() => setCreateDialogOpen(true)}>
              Create Set
            </Button>
          </RequirePermission>
        }
      />

      {loading || loadFailure ? (
        <QueryState
          what="credential sets"
          loading={loading}
          error={loadFailure?.cause}
          onRetry={loadSets}
        />
      ) : (
        <DataTable
          caption="Credential sets"
          rows={sets}
          columns={columns}
          rowKey={(set) => set.id}
          onRowClick={openDetail}
          emptyLabel="No credential sets found. Create your first set to get started."
        />
      )}

      {/* Create Dialog */}
      <Dialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        aria-label="Create Credential Set"
        className="max-w-3xl!"
      >
        <div className="p-6">
          <SectionHeading className="pr-10">Create Credential Set</SectionHeading>
          <div className="max-h-[70vh] overflow-y-auto">
            <CredentialSetForm
              onSubmit={handleCreate}
              onCancel={() => setCreateDialogOpen(false)}
              isSubmitting={isSubmitting}
            />
          </div>
        </div>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        aria-label="Edit Credential Set"
        className="max-w-3xl!"
      >
        <div className="p-6">
          <SectionHeading className="pr-10">Edit Credential Set</SectionHeading>
          <div className="max-h-[70vh] overflow-y-auto">
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
        </div>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog
        open={detailDialogOpen}
        onClose={() => setDetailDialogOpen(false)}
        aria-label="Credential Set Details"
        className="max-w-2xl!"
      >
        <div className="p-6">
          <SectionHeading className="pr-10">Credential Set Details</SectionHeading>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto">
            {selectedSet && (
              <>
                <FieldList
                  fields={[
                    ['Name', selectedSet.name],
                    ['Description', selectedSet.description],
                    ['Strategy', <Badge variant="neutral">{formatLabel(selectedSet.strategy)}</Badge>],
                  ]}
                />
                <div>
                  <SectionHeading level={3}>
                    Credentials ({selectedSet.credentials.length})
                  </SectionHeading>
                  <div className="space-y-1">
                    {selectedSet.credentials.map((cred, index) => (
                      <ListRow
                        key={cred.id}
                        leading={
                          <span className="hh-mono text-xs text-[var(--hh-text-muted)]">
                            #{index + 1}
                          </span>
                        }
                        title={cred.name}
                        description={cred.description}
                        actions={
                          <>
                            <Badge variant="neutral">{formatProtocol(cred.protocol)}</Badge>
                            <Badge variant="neutral">{formatScope(cred.scope)}</Badge>
                          </>
                        }
                      />
                    ))}
                  </div>
                </div>
                {selectedSet.tags && selectedSet.tags.length > 0 && (
                  <div>
                    <SectionHeading level={3}>Tags</SectionHeading>
                    <div className="flex flex-wrap gap-2">
                      {selectedSet.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        aria-label="Delete Credential Set"
      >
        <div className="space-y-4 p-6">
          <SectionHeading className="pr-10">Delete Credential Set</SectionHeading>
          <p className="text-sm">Are you sure you want to delete "{selectedSet?.name}"?</p>
          {usageCount > 0 && (
            <Banner tone="danger">
              Warning: This credential set is used by {usageCount} discovery definition
              {usageCount !== 1 ? 's' : ''}. Deleting it may affect those definitions.
            </Banner>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteDialogOpen(false);
                setSelectedSet(null);
              }}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} disabled={isSubmitting}>
              {isSubmitting ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
};

export default CredentialSetList;
