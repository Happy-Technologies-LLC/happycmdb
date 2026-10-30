// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import {
  DiscoveryProvider,
  DiscoveryDefinition,
  DiscoveryDefinitionInput,
} from '../../services/discovery.service';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Alert, AlertDescription } from '../ui/alert';
import { Icon } from '@happy-technologies/design-system';
import DiscoveryConfigForm, { DiscoveryConfigFormRef } from './DiscoveryConfigForm';
import { AgentSelector } from './AgentSelector';
import { useCredentials } from '../../hooks/useCredentials';
import { CronBuilder } from '../ui/cron-builder';
import { credentialService } from '../../services/credential.service';
import { FieldMappingBuilder } from '../connectors/FieldMappingBuilder';

interface DiscoveryDefinitionFormProps {
  definition?: DiscoveryDefinition;
  onSubmit: (data: DiscoveryDefinitionInput) => void;
  onCancel: () => void;
  showAdHocAction?: boolean;
  onAdHocRun?: (data: DiscoveryDefinitionInput) => void;
}

// Only TRUE network discovery protocols
// Cloud/API providers (AWS, Azure, GCP, Kubernetes, etc.) are now Connectors
const PROVIDERS: DiscoveryProvider[] = [
  'nmap',
  'ssh',
  'active-directory',
  'snmp'
];

export const DiscoveryDefinitionForm: React.FC<DiscoveryDefinitionFormProps> = ({
  definition,
  onSubmit,
  onCancel,
  showAdHocAction = false,
  onAdHocRun,
}) => {
  const isEditMode = !!definition;
  const { credentials } = useCredentials();

  const [name, setName] = useState(definition?.name || '');
  const [description, setDescription] = useState(definition?.description || '');
  const [provider, setProvider] = useState<DiscoveryProvider>(
    definition?.provider || 'nmap'
  );
  const [method, setMethod] = useState<'agentless' | 'agent'>(
    definition?.method || 'agentless'
  );
  const [credentialId, setCredentialId] = useState(definition?.credentialId || 'none');
  const [agentId, setAgentId] = useState<string | undefined>(definition?.agentId);
  const [config, setConfig] = useState<Record<string, any>>(definition?.config || {});
  const [scheduleEnabled, setScheduleEnabled] = useState(
    definition?.schedule.enabled || false
  );
  const [cronExpression, setCronExpression] = useState(
    definition?.schedule.cronExpression || '0 9 * * *'
  );
  const [active, setActive] = useState(definition?.active ?? true);
  // HAP-774 C-12: a new SSH secret lives only here and goes only to the credential API, never into config.
  const [newCred, setNewCred] = useState({ name: '', username: '', auth: 'password', secret: '', port: '' });
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>(
    definition?.field_mappings || {}
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const configFormRef = React.useRef<DiscoveryConfigFormRef>(null);

  const unsupported = provider === 'active-directory' || provider === 'snmp';
  const sshCredentials = credentials.filter(
    (cred) => cred.protocol === 'ssh_password' || cred.protocol === 'ssh_key'
  );
  const createSshCredential = provider === 'ssh' && credentialId === 'none';
  const setNewCredField = (key: keyof typeof newCred, value: string) =>
    setNewCred((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    // Reset config when provider changes
    if (!isEditMode) {
      setConfig({});
    }
  }, [provider, isEditMode]);

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = 'Name is required';
    }

    if (unsupported) {
      newErrors.submit = `${provider.toUpperCase()} discovery is unsupported`;
    }

    if (createSshCredential) {
      if (!newCred.name.trim()) newErrors.credentialName = 'Credential name is required';
      if (!newCred.username.trim()) newErrors.credentialUsername = 'Username is required';
      if (!newCred.secret) newErrors.credentialSecret = 'A password or private key is required';
      const port = Number(newCred.port);
      if (newCred.port && !(/^\d{1,5}$/.test(newCred.port) && port >= 1 && port <= 65535)) newErrors.credentialPort = 'Port must be a whole number from 1 to 65535';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const buildFormData = (): DiscoveryDefinitionInput => {
    // Get current config from child component to ensure we have latest state
    const currentConfig = configFormRef.current?.getConfig() || config;

    return {
      name: name.trim(),
      description: description.trim() || undefined,
      provider,
      method,
      credentialId: provider === 'ssh' && credentialId !== 'none' ? credentialId : undefined,
      agentId: method === 'agent' ? agentId : undefined,
      config: currentConfig,
      field_mappings: Object.keys(fieldMappings).length > 0 ? fieldMappings : undefined,
      schedule: {
        enabled: scheduleEnabled,
        cronExpression: scheduleEnabled ? cronExpression.trim() : undefined,
      },
      active,
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    let finalCredentialId = credentialId;

    if (createSshCredential) {
      const { name: credentialName, username, auth, secret, port } = newCred;
      const secretField = auth === 'key' ? { private_key: secret } : { password: secret };
      try {
        const created = await credentialService.createCredential({
          name: credentialName.trim(),
          protocol: auth === 'key' ? 'ssh_key' : 'ssh_password',
          scope: 'ssh',
          credentials: { username: username.trim(), ...secretField, ...(port ? { port: Number(port) } : {}) },
        });
        finalCredentialId = created.id;
        setCredentialId(created.id);
        setNewCred((current) => ({ ...current, secret: '' }));
      } catch {
        setErrors({ submit: 'Failed to save the SSH credential' });
        return;
      }
    }

    onSubmit({
      ...buildFormData(),
      credentialId: provider === 'ssh' && finalCredentialId !== 'none' ? finalCredentialId : undefined,
    });
  };

  const handleAdHocRun = () => {
    // HAP-774 L2: an ad-hoc run cannot carry a new credential; it must be saved first.
    if (createSshCredential || !validateForm()) {
      return;
    }

    if (onAdHocRun) {
      onAdHocRun(buildFormData());
    }
  };

  const handleCronChange = (newCron: string) => {
    setCronExpression(newCron);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Basic Information</CardTitle>
          <CardDescription>
            {isEditMode
              ? 'Update the basic details of your discovery definition'
              : 'Configure basic details for your discovery definition'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              placeholder="e.g., AWS Production Discovery"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={errors.name ? 'border-destructive' : ''}
            />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Optional description of what this discovery covers"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider">Provider *</Label>
            <Select
              value={provider}
              onValueChange={(value) => setProvider(value as DiscoveryProvider)}
              disabled={isEditMode}
            >
              <SelectTrigger id="provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isEditMode && (
              <p className="text-xs text-muted-foreground">
                Provider cannot be changed after creation
              </p>
            )}
          </div>

          {provider === 'ssh' && (
            <div className="space-y-2">
              <Label htmlFor="credential">SSH Credential *</Label>
              <Select value={credentialId} onValueChange={setCredentialId}>
                <SelectTrigger id="credential">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Create a new SSH credential</SelectItem>
                  {sshCredentials.map((cred) => (
                    <SelectItem key={cred.id} value={cred.id}>
                      {cred.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {createSshCredential && (
            <div className="space-y-3 p-4 border rounded-lg bg-muted/50">
              {([
                ['name', 'Credential Name *', 'text', errors.credentialName],
                ['username', 'Username *', 'text', errors.credentialUsername],
                ['port', 'Port (optional, default 22)', 'number', errors.credentialPort],
              ] as const).map(([key, label, type, error]) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`ssh-cred-${key}`}>{label}</Label>
                  <Input
                    id={`ssh-cred-${key}`}
                    type={type}
                    value={newCred[key]}
                    onChange={(e) => setNewCredField(key, e.target.value)}
                  />
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              ))}
              <div className="space-y-2">
                <Label htmlFor="ssh-cred-auth">Authentication</Label>
                <Select
                  value={newCred.auth}
                  onValueChange={(auth) => setNewCred((current) => ({ ...current, auth, secret: '' }))}
                >
                  <SelectTrigger id="ssh-cred-auth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="password">Password</SelectItem>
                    <SelectItem value="key">Private key (PEM)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                {newCred.auth === 'key' ? (
                  <>
                    <Label htmlFor="ssh-cred-secret">Private Key (PEM text) *</Label>
                    <Textarea
                      id="ssh-cred-secret"
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      value={newCred.secret}
                      onChange={(e) => setNewCredField('secret', e.target.value)}
                      rows={6}
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                  </>
                ) : (
                  <>
                    <Label htmlFor="ssh-cred-secret">Password *</Label>
                    <Input
                      id="ssh-cred-secret"
                      type="password"
                      autoComplete="new-password"
                      value={newCred.secret}
                      onChange={(e) => setNewCredField('secret', e.target.value)}
                    />
                  </>
                )}
                {errors.credentialSecret && (
                  <p className="text-sm text-destructive">{errors.credentialSecret}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Saved as an encrypted credential; the definition stores only its id.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="method">Discovery Method *</Label>
            <Select
              value={method}
              onValueChange={(value) => setMethod(value as 'agentless' | 'agent')}
            >
              <SelectTrigger id="method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agentless">Agentless (Direct from server)</SelectItem>
                <SelectItem value="agent">Agent-based (Distributed agents)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {method === 'agentless'
                ? 'Discovery runs directly from this server. Requires network access to target resources.'
                : 'Discovery runs on distributed agents. Best for accessing resources in isolated networks.'}
            </p>
          </div>

          {method === 'agent' && (
            <AgentSelector
              method={method}
              provider={provider}
              selectedAgentId={agentId}
              onAgentChange={setAgentId}
              targetNetworks={config.targets || []}
            />
          )}

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="active">Active</Label>
              <p className="text-sm text-muted-foreground">
                Inactive definitions cannot be run
              </p>
            </div>
            <Switch id="active" checked={active} onCheckedChange={setActive} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Discovery Configuration</CardTitle>
          <CardDescription>
            Configure provider-specific discovery settings
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DiscoveryConfigForm
            ref={configFormRef}
            provider={provider}
            initialConfig={config}
            onSubmit={setConfig}
            showActions={false}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Field Mappings (Optional)</CardTitle>
          <CardDescription>
            Map discovered fields to standard CI properties or custom metadata fields
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldMappingBuilder
            connectorType={provider}
            mappings={Object.entries(fieldMappings).map(([target, source], index) => ({
              id: `mapping_${index}`,
              source_field: source,
              target_field: target,
              transformation: { type: 'direct' as const },
              required: false,
            }))}
            onChange={(mappings) => {
              const newFieldMappings: Record<string, string> = {};
              mappings.forEach((mapping) => {
                if (mapping.source_field && mapping.target_field) {
                  newFieldMappings[mapping.target_field] = mapping.source_field;
                }
              });
              setFieldMappings(newFieldMappings);
            }}
          />
          <p className="text-sm text-muted-foreground mt-4">
            Field mappings allow you to extract specific data from discovered resources.
            Use dot notation for nested paths (e.g., <code className="bg-muted px-1 py-0.5 rounded">Tags.0.Value</code> or <code className="bg-muted px-1 py-0.5 rounded">PrivateIpAddress</code>).
            Standard CI fields (like <code className="bg-muted px-1 py-0.5 rounded">name</code>, <code className="bg-muted px-1 py-0.5 rounded">ip_address</code>)
            will be mapped to top-level properties. All other fields become metadata.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>
            Configure automatic discovery schedule using cron expressions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="schedule-enabled">Enable Schedule</Label>
              <p className="text-sm text-muted-foreground">
                Run discovery automatically on a schedule
              </p>
            </div>
            <Switch
              id="schedule-enabled"
              checked={scheduleEnabled}
              onCheckedChange={setScheduleEnabled}
            />
          </div>

          {scheduleEnabled && (
            <CronBuilder value={cronExpression} onChange={handleCronChange} />
          )}
        </CardContent>
      </Card>

      {errors.submit && (
        <Alert variant="destructive">
          <Icon name="warning-circle" size={16} />
          <AlertDescription>{errors.submit}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {showAdHocAction && onAdHocRun && (
          <Button type="button" variant="secondary" onClick={handleAdHocRun} disabled={createSshCredential}>
            <Icon name="play-circle" size={16} className="mr-2" />
            Run Once
          </Button>
        )}
        {showAdHocAction && onAdHocRun && createSshCredential && <p className="text-xs text-muted-foreground self-center">Save the credential first to run once</p>}
        <Button type="submit">
          {showAdHocAction ? (
            <>
              <Icon name="floppy-disk" size={16} className="mr-2" />
              Save & Run
            </>
          ) : (
            isEditMode ? 'Update Definition' : 'Create Definition'
          )}
        </Button>
      </div>
    </form>
  );
};

export default DiscoveryDefinitionForm;
