// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * API Keys manager component
 * Generate, view, and revoke API keys
 */

import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { apiClient } from '../../services/auth.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

interface ApiKey {
  id: string;
  name: string;
  key: string;
  scopes: string[];
  created_at: string;
  last_used?: string;
}

export const ApiKeysManager: React.FC = () => {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [newKeyData, setNewKeyData] = useState({
    name: '',
    scopes: {
      read: true,
      write: false,
      delete: false,
      admin: false,
    },
  });
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    try {
      const response = await apiClient.get<{ keys: ApiKey[] }>('/api/v1/auth/api-keys');
      setApiKeys(response.data.keys);
    } catch (error) {
      console.error('Failed to fetch API keys:', error);
    }
  };

  const handleGenerateKey = async () => {
    try {
      const scopes = Object.entries(newKeyData.scopes)
        .filter(([_, enabled]) => enabled)
        .map(([scope]) => scope);

      const response = await apiClient.post<{ key: ApiKey }>('/api/v1/auth/api-keys', {
        name: newKeyData.name,
        scopes,
      });

      setGeneratedKey(response.data.key.key);
      await fetchApiKeys();
      setNewKeyData({
        name: '',
        scopes: { read: true, write: false, delete: false, admin: false },
      });
    } catch (error: any) {
      console.error('Failed to generate API key:', error);
    }
  };

  const handleRevokeKey = async () => {
    if (!selectedKeyId) return;

    try {
      await apiClient.delete(`/api/v1/auth/api-keys/${selectedKeyId}`);
      await fetchApiKeys();
      setRevokeDialogOpen(false);
      setSelectedKeyId(null);
    } catch (error) {
      console.error('Failed to revoke API key:', error);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const maskKey = (key: string): string => {
    if (key.length <= 8) return key;
    return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">API Keys</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Generate and manage API keys for programmatic access
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Icon name="plus" size={16} className="mr-2" />
          Generate New Key
        </Button>
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apiKeys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No API keys yet. Generate one to get started.
                </TableCell>
              </TableRow>
            ) : (
              apiKeys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <code className="text-sm bg-muted px-2 py-1 rounded">
                        {maskKey(key.key)}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => copyToClipboard(key.key)}
                      >
                        <Icon name="copy" size={16} />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {key.scopes.map((scope) => (
                        <Badge key={scope} variant="secondary">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>{formatDate(key.created_at)}</TableCell>
                  <TableCell>
                    {key.last_used ? formatDate(key.last_used) : 'Never'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => {
                        setSelectedKeyId(key.id);
                        setRevokeDialogOpen(true);
                      }}
                    >
                      <Icon name="trash" size={16} />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create API Key Dialog */}
      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) setGeneratedKey(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate New API Key</DialogTitle>
          </DialogHeader>
          {generatedKey ? (
            <div className="space-y-4">
              <Alert>
                <AlertDescription className="space-y-2">
                  <p className="text-sm">
                    Your API key has been generated. Copy it now - you won't be able to see it again!
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <code className="flex-1 text-xs bg-muted px-3 py-2 rounded break-all">
                      {generatedKey}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => copyToClipboard(generatedKey)}
                    >
                      <Icon name="copy" size={16} />
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="key-name">Key Name</Label>
                <Input
                  id="key-name"
                  value={newKeyData.name}
                  onChange={(e) => setNewKeyData({ ...newKeyData, name: e.target.value })}
                  placeholder="My API Key"
                />
              </div>
              <div className="space-y-3">
                <Label>Scopes</Label>
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="scope-read"
                      checked={newKeyData.scopes.read}
                      onCheckedChange={(checked: boolean) =>
                        setNewKeyData({
                          ...newKeyData,
                          scopes: { ...newKeyData.scopes, read: checked as boolean },
                        })
                      }
                    />
                    <Label htmlFor="scope-read" className="text-sm font-normal cursor-pointer">
                      Read
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="scope-write"
                      checked={newKeyData.scopes.write}
                      onCheckedChange={(checked: boolean) =>
                        setNewKeyData({
                          ...newKeyData,
                          scopes: { ...newKeyData.scopes, write: checked as boolean },
                        })
                      }
                    />
                    <Label htmlFor="scope-write" className="text-sm font-normal cursor-pointer">
                      Write
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="scope-delete"
                      checked={newKeyData.scopes.delete}
                      onCheckedChange={(checked: boolean) =>
                        setNewKeyData({
                          ...newKeyData,
                          scopes: { ...newKeyData.scopes, delete: checked as boolean },
                        })
                      }
                    />
                    <Label htmlFor="scope-delete" className="text-sm font-normal cursor-pointer">
                      Delete
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="scope-admin"
                      checked={newKeyData.scopes.admin}
                      onCheckedChange={(checked: boolean) =>
                        setNewKeyData({
                          ...newKeyData,
                          scopes: { ...newKeyData.scopes, admin: checked as boolean },
                        })
                      }
                    />
                    <Label htmlFor="scope-admin" className="text-sm font-normal cursor-pointer">
                      Admin
                    </Label>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            {generatedKey ? (
              <Button
                onClick={() => {
                  setCreateDialogOpen(false);
                  setGeneratedKey(null);
                }}
              >
                Close
              </Button>
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
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke API Key Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API Key</DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke this API key? Applications using this key will no longer be able to access the API.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevokeKey}>
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
