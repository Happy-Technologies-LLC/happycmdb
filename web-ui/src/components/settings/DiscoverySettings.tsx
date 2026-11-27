// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery settings component
 * Cloud provider credentials and discovery configuration
 */

import React, { useState } from 'react';
import { Banner, Button, Disclosure, Icon, Input, Label, SectionHeading } from '@happy-technologies/design-system';
import { apiClient } from '../../services/api';
import { SecretInput, SecretTextarea } from '@/components/ui/secret-input';

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
  status: 'idle' | 'success' | 'error';
  message?: string;
}

type ProviderKey = keyof ProviderCredentials;

/**
 * `text` fields are plain DS inputs. `secret` and `secret-text` fields stay on the HAP-1213 secret inputs, whose value
 * never reaches a DOM attribute or text node (the DS ships no secret field). The AWS access key id is stored encrypted
 * by the server like the secret key, so it is a secret field; `type="text"` keeps it unmasked as before.
 */
type ProviderField =
  | { key: string; id: string; label: string; kind: 'text'; fallback?: string }
  | { key: string; id: string; label: string; kind: 'secret'; masked: boolean }
  | { key: string; id: string; label: string; kind: 'secret-text' };

const PROVIDERS: Array<{ key: ProviderKey; title: string; fields: ProviderField[] }> = [
  {
    key: 'aws',
    title: 'AWS',
    fields: [
      { key: 'accessKeyId', id: 'aws-access-key', label: 'Access Key ID', kind: 'secret', masked: false },
      { key: 'secretAccessKey', id: 'aws-secret-key', label: 'Secret Access Key', kind: 'secret', masked: true },
      { key: 'region', id: 'aws-region', label: 'Region', kind: 'text', fallback: 'us-east-1' },
    ],
  },
  {
    key: 'azure',
    title: 'Azure',
    fields: [
      { key: 'subscriptionId', id: 'azure-subscription', label: 'Subscription ID', kind: 'text' },
      { key: 'tenantId', id: 'azure-tenant', label: 'Tenant ID', kind: 'text' },
      { key: 'clientId', id: 'azure-client', label: 'Client ID', kind: 'text' },
      { key: 'clientSecret', id: 'azure-secret', label: 'Client Secret', kind: 'secret', masked: true },
    ],
  },
  {
    key: 'gcp',
    title: 'Google Cloud Platform',
    fields: [
      { key: 'projectId', id: 'gcp-project', label: 'Project ID', kind: 'text' },
      { key: 'credentials', id: 'gcp-credentials', label: 'Service Account Credentials (JSON)', kind: 'secret-text' },
    ],
  },
  {
    key: 'ssh',
    title: 'SSH',
    fields: [
      { key: 'username', id: 'ssh-username', label: 'Username', kind: 'text' },
      { key: 'privateKey', id: 'ssh-private-key', label: 'Private Key', kind: 'secret-text' },
    ],
  },
];

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

  const saveCredentials = async (provider: string) => {
    try {
      await apiClient.put(`/settings/discovery/${provider}`, {
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

    if (status.status === 'success') {
      return <Icon name="check-circle" size={20} className="text-[var(--hh-success-text)]" />;
    }

    if (status.status === 'error') {
      return <Icon name="x-circle" size={20} className="text-[var(--hh-error-text)]" />;
    }

    return null;
  };

  const toggleSection = (provider: string, open: boolean) => {
    setOpenSections((prev) => ({ ...prev, [provider]: open }));
  };

  const renderField = (provider: ProviderKey, field: ProviderField) => {
    const stored = (credentials[provider] as Record<string, string> | undefined)?.[field.key];
    const onChange = (e: { target: { value: string } }) =>
      handleCredentialChange(provider, field.key, e.target.value);

    if (field.kind === 'text') {
      return (
        <Input
          key={field.id}
          id={field.id}
          size="sm"
          label={field.label}
          value={stored || field.fallback || ''}
          onChange={onChange}
        />
      );
    }
    return (
      <div key={field.id} className="flex flex-col gap-2">
        <Label htmlFor={field.id}>{field.label}</Label>
        {field.kind === 'secret' ? (
          <SecretInput
            id={field.id}
            type={field.masked ? 'password' : 'text'}
            autoComplete={field.masked ? undefined : 'off'}
            value={stored || ''}
            onChange={onChange}
          />
        ) : (
          <SecretTextarea id={field.id} rows={4} value={stored || ''} onChange={onChange} />
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading className="mb-1">Discovery Settings</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Configure cloud provider credentials for automated discovery
        </p>
      </div>

      <div className="space-y-2">
        {PROVIDERS.map(({ key, title, fields }) => (
          <div key={key} className="rounded-[var(--hh-radius-lg)] border border-[var(--hh-hairline)] px-4">
            <Disclosure
              open={Boolean(openSections[key])}
              onOpenChange={(open) => toggleSection(key, open)}
              title={
                <span className="flex items-center gap-3">
                  <span>{title}</span>
                  {renderStatus(key)}
                </span>
              }
            >
              <div className="space-y-4 pt-1 pr-1">
                {connectionStatus[key]?.message &&
                  (connectionStatus[key].status === 'success' ? (
                    <Banner tone="success" role="status">
                      {connectionStatus[key].message}
                    </Banner>
                  ) : (
                    <Banner tone="danger">{connectionStatus[key].message}</Banner>
                  ))}
                {fields.map((field) => renderField(key, field))}
                <div className="flex gap-2">
                  <Button onClick={() => saveCredentials(key)}>Save</Button>
                </div>
              </div>
            </Disclosure>
          </div>
        ))}
      </div>
    </div>
  );
};
