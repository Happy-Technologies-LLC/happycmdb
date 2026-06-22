// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery settings component
 * Cloud provider credentials and discovery configuration
 */

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { apiClient } from '../../services/auth.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface ProviderCredentials {
  aws?: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
  };
  azure?: {
    subscriptionId: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  gcp?: {
    projectId: string;
    credentials: string;
  };
  ssh?: {
    privateKey: string;
    username: string;
  };
}

interface ConnectionStatus {
  provider: string;
  status: 'idle' | 'testing' | 'success' | 'error';
  message?: string;
}

export const DiscoverySettings: React.FC = () => {
  const [credentials, setCredentials] = useState<ProviderCredentials>({});
  const [connectionStatus, setConnectionStatus] = useState<Record<string, ConnectionStatus>>({});
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  const handleCredentialChange = (provider: string, field: string, value: string) => {
    setCredentials((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider as keyof ProviderCredentials],
        [field]: value,
      },
    }));
  };

  const testConnection = async (provider: string) => {
    setConnectionStatus((prev) => ({
      ...prev,
      [provider]: { provider, status: 'testing' },
    }));

    try {
      await apiClient.post(`/api/v1/discovery/test-connection`, {
        provider,
        credentials: credentials[provider as keyof ProviderCredentials],
      });

      setConnectionStatus((prev) => ({
        ...prev,
        [provider]: {
          provider,
          status: 'success',
          message: 'Connection successful',
        },
      }));
    } catch (error: any) {
      setConnectionStatus((prev) => ({
        ...prev,
        [provider]: {
          provider,
          status: 'error',
          message: error.response?.data?.message || 'Connection failed',
        },
      }));
    }
  };

  const saveCredentials = async (provider: string) => {
    try {
      await apiClient.put(`/api/v1/settings/discovery/${provider}`, {
        credentials: credentials[provider as keyof ProviderCredentials],
      });

      setConnectionStatus((prev) => ({
        ...prev,
        [provider]: {
          provider,
          status: 'success',
          message: 'Credentials saved successfully',
        },
      }));
    } catch (error: any) {
      setConnectionStatus((prev) => ({
        ...prev,
        [provider]: {
          provider,
          status: 'error',
          message: error.response?.data?.message || 'Failed to save credentials',
        },
      }));
    }
  };

  const renderStatus = (provider: string) => {
    const status = connectionStatus[provider];
    if (!status) return null;

    if (status.status === 'testing') {
      return <Icon name="spinner-gap" size={20} className="animate-spin text-muted-foreground" />;
    }

    if (status.status === 'success') {
      return <Icon name="check-circle" size={20} className="text-green-600" />;
    }

    if (status.status === 'error') {
      return <Icon name="x-circle" size={20} className="text-destructive" />;
    }

    return null;
  };

  const toggleSection = (provider: string) => {
    setOpenSections(prev => ({ ...prev, [provider]: !prev[provider] }));
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Discovery Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure cloud provider credentials for automated discovery
        </p>
      </div>

      <div className="space-y-2">
        {/* AWS */}
        <Collapsible open={openSections.aws} onOpenChange={() => toggleSection('aws')}>
          <div className="border rounded-lg">
            <CollapsibleTrigger className="flex items-center justify-between w-full p-4 hover:bg-accent/50 transition-colors">
              <div className="flex items-center gap-3 flex-1">
                <span className="font-medium">AWS</span>
                {renderStatus('aws')}
              </div>
              <Icon name="caret-down" size={20} className={`transition-transform ${openSections.aws ? 'transform rotate-180' : ''}`} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="p-4 pt-0 space-y-4">
                {connectionStatus.aws?.message && (
                  <Alert variant={connectionStatus.aws.status === 'success' ? 'default' : 'destructive'}>
                    <AlertDescription>{connectionStatus.aws.message}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="aws-access-key">Access Key ID</Label>
                  <Input
                    id="aws-access-key"
                    value={credentials.aws?.accessKeyId || ''}
                    onChange={(e) => handleCredentialChange('aws', 'accessKeyId', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="aws-secret-key">Secret Access Key</Label>
                  <Input
                    id="aws-secret-key"
                    type="password"
                    value={credentials.aws?.secretAccessKey || ''}
                    onChange={(e) => handleCredentialChange('aws', 'secretAccessKey', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="aws-region">Region</Label>
                  <Input
                    id="aws-region"
                    value={credentials.aws?.region || 'us-east-1'}
                    onChange={(e) => handleCredentialChange('aws', 'region', e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => testConnection('aws')}
                    disabled={connectionStatus.aws?.status === 'testing'}
                  >
                    Test Connection
                  </Button>
                  <Button onClick={() => saveCredentials('aws')}>
                    Save
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* Azure */}
        <Collapsible open={openSections.azure} onOpenChange={() => toggleSection('azure')}>
          <div className="border rounded-lg">
            <CollapsibleTrigger className="flex items-center justify-between w-full p-4 hover:bg-accent/50 transition-colors">
              <div className="flex items-center gap-3 flex-1">
                <span className="font-medium">Azure</span>
                {renderStatus('azure')}
              </div>
              <Icon name="caret-down" size={20} className={`transition-transform ${openSections.azure ? 'transform rotate-180' : ''}`} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="p-4 pt-0 space-y-4">
                {connectionStatus.azure?.message && (
                  <Alert variant={connectionStatus.azure.status === 'success' ? 'default' : 'destructive'}>
                    <AlertDescription>{connectionStatus.azure.message}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="azure-subscription">Subscription ID</Label>
                  <Input
                    id="azure-subscription"
                    value={credentials.azure?.subscriptionId || ''}
                    onChange={(e) => handleCredentialChange('azure', 'subscriptionId', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="azure-tenant">Tenant ID</Label>
                  <Input
                    id="azure-tenant"
                    value={credentials.azure?.tenantId || ''}
                    onChange={(e) => handleCredentialChange('azure', 'tenantId', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="azure-client">Client ID</Label>
                  <Input
                    id="azure-client"
                    value={credentials.azure?.clientId || ''}
                    onChange={(e) => handleCredentialChange('azure', 'clientId', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="azure-secret">Client Secret</Label>
                  <Input
                    id="azure-secret"
                    type="password"
                    value={credentials.azure?.clientSecret || ''}
                    onChange={(e) => handleCredentialChange('azure', 'clientSecret', e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => testConnection('azure')}
                    disabled={connectionStatus.azure?.status === 'testing'}
                  >
                    Test Connection
                  </Button>
                  <Button onClick={() => saveCredentials('azure')}>
                    Save
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* GCP */}
        <Collapsible open={openSections.gcp} onOpenChange={() => toggleSection('gcp')}>
          <div className="border rounded-lg">
            <CollapsibleTrigger className="flex items-center justify-between w-full p-4 hover:bg-accent/50 transition-colors">
              <div className="flex items-center gap-3 flex-1">
                <span className="font-medium">Google Cloud Platform</span>
                {renderStatus('gcp')}
              </div>
              <Icon name="caret-down" size={20} className={`transition-transform ${openSections.gcp ? 'transform rotate-180' : ''}`} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="p-4 pt-0 space-y-4">
                {connectionStatus.gcp?.message && (
                  <Alert variant={connectionStatus.gcp.status === 'success' ? 'default' : 'destructive'}>
                    <AlertDescription>{connectionStatus.gcp.message}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="gcp-project">Project ID</Label>
                  <Input
                    id="gcp-project"
                    value={credentials.gcp?.projectId || ''}
                    onChange={(e) => handleCredentialChange('gcp', 'projectId', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gcp-credentials">Service Account Credentials (JSON)</Label>
                  <Textarea
                    id="gcp-credentials"
                    rows={4}
                    value={credentials.gcp?.credentials || ''}
                    onChange={(e) => handleCredentialChange('gcp', 'credentials', e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => testConnection('gcp')}
                    disabled={connectionStatus.gcp?.status === 'testing'}
                  >
                    Test Connection
                  </Button>
                  <Button onClick={() => saveCredentials('gcp')}>
                    Save
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* SSH */}
        <Collapsible open={openSections.ssh} onOpenChange={() => toggleSection('ssh')}>
          <div className="border rounded-lg">
            <CollapsibleTrigger className="flex items-center justify-between w-full p-4 hover:bg-accent/50 transition-colors">
              <div className="flex items-center gap-3 flex-1">
                <span className="font-medium">SSH</span>
                {renderStatus('ssh')}
              </div>
              <Icon name="caret-down" size={20} className={`transition-transform ${openSections.ssh ? 'transform rotate-180' : ''}`} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="p-4 pt-0 space-y-4">
                {connectionStatus.ssh?.message && (
                  <Alert variant={connectionStatus.ssh.status === 'success' ? 'default' : 'destructive'}>
                    <AlertDescription>{connectionStatus.ssh.message}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="ssh-username">Username</Label>
                  <Input
                    id="ssh-username"
                    value={credentials.ssh?.username || ''}
                    onChange={(e) => handleCredentialChange('ssh', 'username', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ssh-private-key">Private Key</Label>
                  <Textarea
                    id="ssh-private-key"
                    rows={4}
                    value={credentials.ssh?.privateKey || ''}
                    onChange={(e) => handleCredentialChange('ssh', 'privateKey', e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => testConnection('ssh')}
                    disabled={connectionStatus.ssh?.status === 'testing'}
                  >
                    Test Connection
                  </Button>
                  <Button onClick={() => saveCredentials('ssh')}>
                    Save
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </div>
    </div>
  );
};
