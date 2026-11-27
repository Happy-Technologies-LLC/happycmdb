// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  IconButton,
  Input,
  NativeSelect,
  PageHeader,
  Pagination,
  SectionHeading,
  Tag,
  type Column,
} from '@happy-technologies/design-system';
import CredentialForm, { hasSecretEntry } from '@/components/credentials/CredentialForm';
import { RequirePermission } from '@/components/common/RequirePermission';
import { QueryState } from '@/components/estate/SurfaceState';
import CredentialDetail from '@/components/credentials/CredentialDetail';
import {
  credentialService,
  type UnifiedCredentialSummary,
  type UnifiedCredentialInput,
  type UnifiedCredential,
  type AuthProtocol,
} from '@/services/credential.service';
import { useToast } from '@/contexts/ToastContext';
import { formatProtocol } from '@/lib/credential-display';
import { logClientError } from '@/utils/logger';

// The DS Dialog is a narrow panel (max-w-md); the credential form and detail need the wide one. Its body scrolls, the panel does not.
const DIALOG_WIDE = 'max-w-3xl!';
const DIALOG_BODY = 'max-h-[85vh] overflow-y-auto p-6';

export const Credentials: React.FC = () => {
  const { showToast } = useToast();
  const [credentials, setCredentials] = useState<UnifiedCredentialSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [loading, setLoading] = useState(true);
  // The read's failure as thrown (boxed: a throw of nothing is still a failure), so QueryState can tell a 403 from any other error.
  const [loadError, setLoadError] = useState<{ error: unknown } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<AuthProtocol | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'discovery' | 'connector'>('all');

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState<UnifiedCredential | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isDiscoveryProtocol = (protocol: AuthProtocol): boolean => {
    return ['aws_iam', 'azure_sp', 'gcp_sa', 'ssh_key', 'ssh_password', 'snmp_v2c', 'snmp_v3'].includes(protocol);
  };

  const isConnectorProtocol = (protocol: AuthProtocol): boolean => {
    return ['oauth2', 'api_key', 'basic', 'bearer'].includes(protocol);
  };

  const loadCredentials = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const response = await credentialService.listCredentials({
        limit: rowsPerPage,
        page: page,
        protocol: protocolFilter !== 'all' ? protocolFilter : undefined,
      });

      // Apply category filter client-side
      let filteredData = response.data;
      if (categoryFilter === 'discovery') {
        filteredData = response.data.filter((cred) => isDiscoveryProtocol(cred.protocol));
      } else if (categoryFilter === 'connector') {
        filteredData = response.data.filter((cred) => isConnectorProtocol(cred.protocol));
      }

      setCredentials(filteredData);
      setTotal(filteredData.length);
    } catch (error) {
      logClientError('Failed to load credentials:', error);
      // A failed read shows an error, never the previous rows or an empty list.
      setCredentials([]);
      setTotal(0);
      setLoadError({ error });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCredentials();
  }, [page, rowsPerPage, searchQuery, protocolFilter, categoryFilter]);

  const handleCreate = async (data: UnifiedCredentialInput) => {
    try {
      setIsSubmitting(true);
      await credentialService.createCredential(data);
      setCreateDialogOpen(false);
      loadCredentials();
      showToast('Credential created successfully', 'success');
    } catch (error: any) {
      logClientError('Failed to create credential:', error);
      const errorMessage = error?.response?.data?._message || error?.response?.data?.message || error?.message || 'Failed to create credential';
      showToast(errorMessage, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = async (data: UnifiedCredentialInput) => {
    if (!selectedCredential) return;
    try {
      setIsSubmitting(true);
      await credentialService.updateCredential(selectedCredential.id, {
        name: data.name,
        description: data.description,
        // HAP-1227: the stored secret stays unless a new payload was typed; the redacted read is never sent back.
        ...(hasSecretEntry(data.credentials) && { credentials: data.credentials }),
        tags: data.tags,
      });
      setEditDialogOpen(false);
      setSelectedCredential(null);
      loadCredentials();
      showToast('Credential updated successfully', 'success');
    } catch (error: any) {
      logClientError('Failed to update credential:', error);
      const errorMessage = error?.response?.data?._message || error?.response?.data?.message || error?.message || 'Failed to update credential';
      showToast(errorMessage, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedCredential) return;
    try {
      setIsSubmitting(true);
      await credentialService.deleteCredential(selectedCredential.id);
      setDeleteDialogOpen(false);
      setSelectedCredential(null);
      loadCredentials();
      showToast('Credential deleted successfully', 'success');
    } catch (error: any) {
      logClientError('Failed to delete credential:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to delete credential';
      showToast(errorMessage, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openDetailDialog = async (credential: UnifiedCredentialSummary) => {
    try {
      const fullCredential = await credentialService.getCredential(credential.id);
      setSelectedCredential(fullCredential);
      setDetailDialogOpen(true);
    } catch (error: any) {
      logClientError('Failed to load credential details:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to load credential details';
      showToast(errorMessage, 'error');
    }
  };

  const openEditDialog = async (credential: UnifiedCredentialSummary) => {
    try {
      const fullCredential = await credentialService.getCredential(credential.id);
      setSelectedCredential(fullCredential);
      setEditDialogOpen(true);
    } catch (error: any) {
      logClientError('Failed to load credential for editing:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to load credential';
      showToast(errorMessage, 'error');
    }
  };

  const openDeleteDialog = async (credential: UnifiedCredentialSummary) => {
    try {
      const fullCredential = await credentialService.getCredential(credential.id);
      setSelectedCredential(fullCredential);
      setDeleteDialogOpen(true);
    } catch (error: any) {
      logClientError('Failed to load credential for deletion:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to load credential';
      showToast(errorMessage, 'error');
    }
  };

  const handleTestCredential = async () => {
    if (!selectedCredential) return;
    try {
      setIsSubmitting(true);
      const result = await credentialService.validateCredential(selectedCredential.id);
      if (result.valid) {
        showToast('Credential is valid', 'success');
      } else {
        showToast(result.message || 'Credential validation failed', 'error');
      }
    } catch (error: any) {
      logClientError('Failed to test credential:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to test credential';
      showToast(errorMessage, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };


  const formatDate = (date?: string | Date) => {
    const dateObj = date ? new Date(date) : null;
    if (!dateObj || Number.isNaN(dateObj.getTime())) return '-';
    return dateObj.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const usageLabel = (count: number | undefined) =>
    typeof count === 'number' ? `${count} definition${count !== 1 ? 's' : ''}` : '-';

  const rowAction = (
    icon: string,
    verb: string,
    title: string,
    credential: UnifiedCredentialSummary,
    onClick: (credential: UnifiedCredentialSummary) => void
  ) => (
    <IconButton
      icon={icon}
      variant="ghost"
      size="sm"
      shape="rounded"
      aria-label={`${verb} ${credential.name}`}
      title={title}
      onClick={() => onClick(credential)}
    />
  );

  const columns: Column<UnifiedCredentialSummary>[] = [
    {
      header: 'Name',
      render: (credential) => (
        <div>
          <span className="text-sm font-medium text-[var(--hh-text-primary)]">{credential.name}</span>
          {credential.description && (
            <p className="mt-0.5 max-w-[300px] truncate text-xs text-[var(--hh-text-muted)]">
              {credential.description}
            </p>
          )}
        </div>
      ),
    },
    { header: 'Type', render: (credential) => <Badge variant="info">{formatProtocol(credential.protocol)}</Badge> },
    { header: 'Used By', render: (credential) => usageLabel(credential.usage_count) },
    {
      header: 'Tags',
      render: (credential) =>
        !credential.tags || credential.tags.length === 0 ? (
          '-'
        ) : (
          <div className="flex flex-wrap gap-1">
            {credential.tags.slice(0, 2).map((tag: string) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
            {credential.tags.length > 2 && <Tag>+{credential.tags.length - 2}</Tag>}
          </div>
        ),
    },
    { header: 'Created', render: (credential) => formatDate(credential.created_at) },
    {
      header: 'Actions',
      className: 'text-right',
      render: (credential) => (
        <div className="flex justify-end gap-1">
          {rowAction('eye', 'View', 'View Details', credential, openDetailDialog)}
          <RequirePermission permission="write">
            {rowAction('pencil-simple', 'Edit', 'Edit', credential, openEditDialog)}
            {rowAction('trash', 'Delete', 'Delete', credential, openDeleteDialog)}
          </RequirePermission>
        </div>
      ),
    },
  ];

  const usageWarning = selectedCredential?.usage_count ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Discovery · Credentials"
        title="Discovery Credentials"
        lede="Manage reusable credentials for discovery definitions"
        actions={
          <RequirePermission permission="write">
            <Button icon="plus" onClick={() => setCreateDialogOpen(true)}>
              Create Credential
            </Button>
          </RequirePermission>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <Input
          size="sm"
          icon="magnifying-glass"
          type="text"
          aria-label="Search credentials"
          placeholder="Search credentials by name or type..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          containerClassName="min-w-[250px] flex-1"
        />
        <NativeSelect
          size="sm"
          aria-label="Category"
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value as 'all' | 'discovery' | 'connector');
            setProtocolFilter('all'); // Reset protocol filter when category changes
          }}
          containerClassName="min-w-[150px]"
        >
          <option value="all">All Categories</option>
          <option value="discovery">Discovery</option>
          <option value="connector">Connector</option>
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label="Protocol"
          value={protocolFilter}
          onChange={(e) => {
            setProtocolFilter(e.target.value as AuthProtocol | 'all');
            if (e.target.value !== 'all') {
              setCategoryFilter('all'); // Clear category filter when specific protocol is selected
            }
          }}
          containerClassName="min-w-[180px]"
        >
          <option value="all">All Protocols</option>
          <optgroup label="Cloud Providers">
            <option value="aws_iam">AWS IAM</option>
            <option value="azure_sp">Azure Service Principal</option>
            <option value="gcp_sa">GCP Service Account</option>
          </optgroup>
          <optgroup label="Network & SSH">
            <option value="ssh_key">SSH Key</option>
            <option value="ssh_password">SSH Password</option>
            <option value="snmp_v2c">SNMP v2c</option>
            <option value="snmp_v3">SNMP v3</option>
          </optgroup>
          <optgroup label="Authentication">
            <option value="oauth2">OAuth 2.0</option>
            <option value="api_key">API Key</option>
            <option value="basic">Basic Auth</option>
            <option value="bearer">Bearer Token</option>
          </optgroup>
          <optgroup label="Other">
            <option value="certificate">Certificate</option>
            <option value="kerberos">Kerberos</option>
            <option value="winrm">WinRM</option>
          </optgroup>
        </NativeSelect>
      </div>

      {loadError ? (
        <QueryState what="credentials" error={loadError.error} onRetry={loadCredentials} />
      ) : loading && credentials.length === 0 ? (
        <QueryState what="credentials" loading />
      ) : (
        <DataTable
          caption="Credentials"
          rows={credentials}
          columns={columns}
          rowKey={(credential) => credential.id}
          onRowClick={openDetailDialog}
          emptyLabel="No credentials found. Create your first credential to get started."
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3">
              <NativeSelect
                size="sm"
                aria-label="Rows per page"
                value={String(rowsPerPage)}
                onChange={(e) => {
                  setRowsPerPage(parseInt(e.target.value, 10));
                  setPage(0);
                }}
              >
                {[5, 10, 25, 50].map((value) => (
                  <option key={value} value={value}>
                    {value} per page
                  </option>
                ))}
              </NativeSelect>
              <Pagination
                mode="range"
                offset={page * rowsPerPage}
                limit={rowsPerPage}
                total={total}
                onChange={(offset) => setPage(Math.floor(offset / rowsPerPage))}
              />
            </div>
          }
        />
      )}

      <Dialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        aria-label="Create credential"
        className={DIALOG_WIDE}
      >
        <div className={DIALOG_BODY}>
          <SectionHeading className="pr-10">Create Credential</SectionHeading>
          <CredentialForm
            onSubmit={handleCreate}
            onCancel={() => setCreateDialogOpen(false)}
            isSubmitting={isSubmitting}
          />
        </div>
      </Dialog>

      <Dialog
        open={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        aria-label="Edit credential"
        className={DIALOG_WIDE}
      >
        <div className={DIALOG_BODY}>
          <SectionHeading className="pr-10">Edit Credential</SectionHeading>
          {selectedCredential && (
            <CredentialForm
              credential={selectedCredential}
              onSubmit={handleEdit}
              onCancel={() => {
                setEditDialogOpen(false);
                setSelectedCredential(null);
              }}
              isSubmitting={isSubmitting}
            />
          )}
        </div>
      </Dialog>

      <Dialog
        open={detailDialogOpen}
        onClose={() => setDetailDialogOpen(false)}
        aria-label="Credential details"
        className={DIALOG_WIDE}
      >
        <div className={DIALOG_BODY}>
          <SectionHeading className="pr-10">Credential Details</SectionHeading>
          {selectedCredential && (
            <CredentialDetail
              credential={selectedCredential}
              usageCount={selectedCredential.usage_count}
              onEdit={() => {
                setDetailDialogOpen(false);
                setEditDialogOpen(true);
              }}
              onDelete={() => {
                setDetailDialogOpen(false);
                setDeleteDialogOpen(true);
              }}
              onTest={handleTestCredential}
            />
          )}
        </div>
      </Dialog>

      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        aria-label="Delete credential"
      >
        <div className="space-y-4 p-6">
          <SectionHeading className="mb-0 pr-10">Delete Credential</SectionHeading>
          <p className="text-sm">Are you sure you want to delete "{selectedCredential?.name}"?</p>
          {usageWarning > 0 && (
            <p className="text-sm font-medium text-[var(--hh-error-text)]">
              Warning: This credential is used by {usageWarning} discovery definition
              {usageWarning !== 1 ? 's' : ''}. Deleting it may affect those definitions.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteDialogOpen(false);
                setSelectedCredential(null);
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

export default Credentials;
