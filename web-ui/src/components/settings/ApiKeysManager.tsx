// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * API Keys manager component
 * Generate, view, and revoke API keys
 */

import React, { useState, useEffect } from 'react';
import {
  Badge,
  Banner,
  Button,
  type Column,
  ConfirmDialog,
  CopyButton,
  DataTable,
  Dialog,
  IconButton,
  Input,
  SectionHeading,
} from '@happy-technologies/design-system';
import { apiClient } from '../../services/api';
import { QueryState } from '@/components/estate/SurfaceState';
import { logClientError } from '@/utils/logger';

interface ApiKey {
  _id: string;
  _name: string;
  _role: string;
  _enabled: boolean;
  _createdAt: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

interface ApiKeysResponse {
  success: boolean;
  data: ApiKey[];
}

interface GenerateApiKeyResponse {
  success: boolean;
  data: {
    _apiKey: string;
    _id: string;
    _name: string;
    expiresAt?: string | null;
  };
}

export const ApiKeysManager: React.FC = () => {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [newKeyData, setNewKeyData] = useState({
    name: '',
  });
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Kept as an error so QueryState can tell a refused read (403) from any other failure.
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    fetchApiKeys(true);
  }, []);

  const fetchApiKeys = async (showLoading = false) => {
    setLoadError(null);
    if (showLoading) setIsLoading(true);
    try {
      const response = await apiClient.get<ApiKeysResponse>('/auth/api-keys');
      setApiKeys(response.data.data);
    } catch (error: any) {
      logClientError('Failed to fetch API keys:', error);
      setLoadError(
        error.response?.status === 403
          ? error
          : new Error(error.response?.data?.message || 'Failed to load API keys')
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateKey = async () => {
    try {
      const response = await apiClient.post<GenerateApiKeyResponse>('/auth/api-key', {
        name: newKeyData.name,
      });

      setGeneratedKey(response.data.data._apiKey);
      await fetchApiKeys();
      setNewKeyData({ name: '' });
    } catch (error: unknown) {
      logClientError('Failed to generate API key:', error);
    }
  };

  const handleRevokeKey = async () => {
    if (!selectedKeyId) return;

    try {
      await apiClient.delete(`/auth/api-key/${selectedKeyId}`);
      await fetchApiKeys();
      setRevokeDialogOpen(false);
      setSelectedKeyId(null);
    } catch (error) {
      logClientError('Failed to revoke API key:', error);
    }
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const columns: Array<Column<ApiKey>> = [
    { header: 'Name', render: (key) => <span className="font-medium">{key._name}</span> },
    { header: 'Role', render: (key) => <Badge variant="neutral">{key._role}</Badge> },
    { header: 'Created', render: (key) => formatDate(key._createdAt) },
    { header: 'Last Used', render: (key) => (key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never') },
    {
      header: 'Actions',
      className: 'text-right',
      render: (key) => (
        <IconButton
          icon="trash"
          variant="ghost"
          size="sm"
          aria-label={`Revoke ${key._name}`}
          onClick={() => {
            setSelectedKeyId(key._id);
            setRevokeDialogOpen(true);
          }}
        />
      ),
    },
  ];

  const closeCreateDialog = () => {
    setCreateDialogOpen(false);
    setGeneratedKey(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <SectionHeading className="mb-1">API Keys</SectionHeading>
          <p className="text-sm text-[var(--hh-text-muted)]">
            Generate and manage API keys for programmatic access
          </p>
        </div>
        <Button icon="plus" onClick={() => setCreateDialogOpen(true)}>
          Generate New Key
        </Button>
      </div>

      {isLoading || loadError !== null ? (
        <QueryState
          what="API keys"
          loading={isLoading}
          error={loadError}
          onRetry={() => fetchApiKeys(true)}
        />
      ) : (
        <DataTable
          rows={apiKeys}
          columns={columns}
          rowKey={(key) => key._id}
          caption="API keys"
          emptyLabel="No API keys yet. Generate one to get started."
        />
      )}

      {/* Create API Key Dialog */}
      <Dialog open={createDialogOpen} onClose={closeCreateDialog} aria-label="Generate New API Key">
        <div className="space-y-4 p-6">
          <div>
            <SectionHeading className="mb-1 pr-8">Generate New API Key</SectionHeading>
            <p className="text-sm text-[var(--hh-text-muted)]">
              Create an API key for programmatic access.
            </p>
          </div>
          {generatedKey ? (
            <div className="space-y-2">
              <Banner tone="success" icon="check-circle" role="status">
                Your API key has been generated. Copy it now - you won't be able to see it again!
              </Banner>
              <div className="flex items-center gap-2">
                <code className="hh-mono flex-1 rounded-[var(--hh-radius-md)] bg-[var(--hh-bg-elevated)] px-3 py-2 text-xs break-all">
                  {generatedKey}
                </code>
                <CopyButton iconOnly value={generatedKey} aria-label="Copy API key" />
              </div>
            </div>
          ) : (
            <Input
              id="key-name"
              size="sm"
              label="Key Name"
              value={newKeyData.name}
              onChange={(e) => setNewKeyData({ name: e.target.value })}
              placeholder="My API Key"
            />
          )}
          <div className="flex items-center justify-end gap-3">
            {generatedKey ? (
              <Button onClick={closeCreateDialog}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleGenerateKey} disabled={!newKeyData.name}>
                  Generate
                </Button>
              </>
            )}
          </div>
        </div>
      </Dialog>

      {/* Revoke API Key Dialog */}
      <ConfirmDialog
        open={revokeDialogOpen}
        title="Revoke API Key"
        body="Are you sure you want to revoke this API key? Applications using this key will no longer be able to access the API."
        confirmLabel="Revoke"
        tone="danger"
        onConfirm={handleRevokeKey}
        onCancel={() => setRevokeDialogOpen(false)}
      />
    </div>
  );
};
