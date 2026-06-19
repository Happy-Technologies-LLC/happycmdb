// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Plus, Search, Filter, Trash2, Edit2, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Eyebrow } from '@/components/ui/eyebrow';
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
import CredentialForm from '@/components/credentials/CredentialForm';
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

export const Credentials: React.FC = () => {
  const { showToast } = useToast();
  const [credentials, setCredentials] = useState<UnifiedCredentialSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [loading, setLoading] = useState(false);
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
      console.error('Failed to load credentials:', error);
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
      console.error('Failed to create credential:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to create credential';
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
        credentials: data.credentials,
        tags: data.tags,
      });
      setEditDialogOpen(false);
      setSelectedCredential(null);
      loadCredentials();
      showToast('Credential updated successfully', 'success');
    } catch (error: any) {
      console.error('Failed to update credential:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to update credential';
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
      console.error('Failed to delete credential:', error);
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
      console.error('Failed to load credential details:', error);
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
      console.error('Failed to load credential for editing:', error);
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
      console.error('Failed to load credential for deletion:', error);
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
      console.error('Failed to test credential:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to test credential';
      showToast(errorMessage, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };


  const formatDate = (date: string | Date) => {
    const dateObj = new Date(date);
    return dateObj.toLocaleDateString('en-US', {
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
          <Eyebrow>Discovery · Credentials</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">Discovery Credentials</h1>
          <p className="mt-1.5 text-ink-soft">
            Manage reusable credentials for discovery definitions
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Create Credential
        </Button>
      </div>

      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        {/* Filters */}
        <div className="p-4 flex flex-wrap gap-3 items-center border-b border-border/50">
          <div className="relative flex-1 min-w-[250px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search credentials by name or type..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-3 py-2 border border-input rounded-md text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="relative min-w-[150px]">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <select
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value as 'all' | 'discovery' | 'connector');
                setProtocolFilter('all'); // Reset protocol filter when category changes
              }}
              className="w-full pl-10 pr-8 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All Categories</option>
              <option value="discovery">Discovery</option>
              <option value="connector">Connector</option>
            </select>
          </div>

          <div className="relative min-w-[180px]">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <select
              value={protocolFilter}
              onChange={(e) => {
                setProtocolFilter(e.target.value as AuthProtocol | 'all');
                if (e.target.value !== 'all') {
                  setCategoryFilter('all'); // Clear category filter when specific protocol is selected
                }
              }}
              className="w-full pl-10 pr-8 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted/30 border-b border-border/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Used By
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
              ) : credentials.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No credentials found. Create your first credential to get started.
                  </td>
                </tr>
              ) : (
                credentials.map((credential) => (
                  <tr
                    key={credential.id}
                    className="hover:bg-muted/50 cursor-pointer transition-colors"
                    onClick={() => openDetailDialog(credential)}
                  >
                    <td className="px-4 py-3">
                      <div>
                        <span className="text-sm font-medium text-foreground">{credential.name}</span>
                        {credential.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 max-w-[300px] truncate">
                            {credential.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{formatProtocol(credential.protocol)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-foreground">
                        {credential.usage_count || 0} definition{credential.usage_count !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {!credential.tags || credential.tags.length === 0 ? (
                        <span className="text-sm text-muted-foreground">-</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {credential.tags.slice(0, 2).map((tag: string) => (
                            <Badge key={tag} variant="outline" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                          {credential.tags.length > 2 && (
                            <Badge variant="outline" className="text-xs">
                              +{credential.tags.length - 2}
                            </Badge>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">{formatDate(credential.created_at)}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openDetailDialog(credential);
                          }}
                          className="p-1.5 hover:bg-muted rounded transition-colors"
                          title="View Details"
                        >
                          <Eye className="w-4 h-4 text-muted-foreground" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditDialog(credential);
                          }}
                          className="p-1.5 hover:bg-primary/10 rounded transition-colors"
                          title="Edit"
                        >
                          <Edit2 className="w-4 h-4 text-primary" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openDeleteDialog(credential);
                          }}
                          className="p-1.5 hover:bg-destructive/10 rounded transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3 flex items-center justify-between border-t border-border/50">
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground">Rows per page:</span>
            <select
              value={rowsPerPage}
              onChange={(e) => {
                setRowsPerPage(parseInt(e.target.value, 10));
                setPage(0);
              }}
              className="px-2 py-1 border border-input rounded text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {[5, 10, 25, 50].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground">
              {page * rowsPerPage + 1}-{Math.min((page + 1) * rowsPerPage, total)} of {total}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="px-3 py-1 border border-input rounded text-sm bg-background text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={(page + 1) * rowsPerPage >= total}
                className="px-3 py-1 border border-input rounded text-sm bg-background text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </LiquidGlass>

      {/* Create Dialog */}
      <FormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <FormDialogContent>
          <FormDialogHeader>
            <FormDialogTitle>Create Credential</FormDialogTitle>
          </FormDialogHeader>
          <FormDialogBody>
            <div className="overflow-y-auto max-h-[calc(85vh-12rem)]">
              <CredentialForm
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
            <FormDialogTitle>Edit Credential</FormDialogTitle>
          </FormDialogHeader>
          <FormDialogBody>
            <div className="overflow-y-auto max-h-[calc(85vh-12rem)]">
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
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>

      {/* Detail Dialog */}
      <FormDialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <FormDialogContent>
          <FormDialogHeader>
            <FormDialogTitle>Credential Details</FormDialogTitle>
          </FormDialogHeader>
          <FormDialogBody>
            <div className="overflow-y-auto max-h-[calc(85vh-12rem)]">
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
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Credential</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{selectedCredential?.name}"?
              {selectedCredential?.usage_count && selectedCredential.usage_count > 0 && (
                <span className="block mt-2 text-destructive font-medium">
                  Warning: This credential is used by {selectedCredential.usage_count} discovery
                  definition{selectedCredential.usage_count !== 1 ? 's' : ''}. Deleting it may
                  affect those definitions.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setSelectedCredential(null);
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

export default Credentials;
