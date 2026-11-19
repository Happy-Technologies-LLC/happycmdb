// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import {
  DiscoveryProvider,
  DiscoveryDefinition,
  DiscoveryDefinitionInput,
} from '../../services/discovery.service';
import {
  Banner,
  Button,
  Card,
  Input,
  Label,
  SectionHeading,
  Select,
  Switch,
  Textarea,
} from '@happy-technologies/design-system';
// Secret fields stay on the local unmirrored-value primitives (HAP-1213 DOM contract): the DS Input/Textarea
// mirror `value` into the DOM tree, so no secret field may move onto them.
import { SecretInput, SecretTextarea } from '../ui/secret-input';
import { RequirePermission } from '@/components/common/RequirePermission';
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
const PROVIDER_OPTIONS = PROVIDERS.map((p) => ({ value: p, label: p.toUpperCase() }));
const AUTH_OPTIONS = [
  { value: 'password', label: 'Password' },
  { value: 'key', label: 'Private key (PEM)' },
];
const METHOD_OPTIONS = [
  { value: 'agentless', label: 'Agentless (Direct from server)' },
  { value: 'agent', label: 'Agent-based (Distributed agents)' },
];
const MUTED = 'text-sm text-[var(--hh-text-muted)]';
const CODE = 'rounded-[var(--hh-radius-sm)] bg-[var(--hh-bg-elevated)] px-1 py-0.5';

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
  // HAP-1213: an abandoned secret must not outlive the "Create a new SSH credential" section; non-secret fields stay.
  const clearNewCredSecret = () => setNewCred((current) => (current.secret ? { ...current, secret: '' } : current));
  const selectCredential = (value: string) => {
    setCredentialId(value);
    if (value !== 'none') clearNewCredSecret();
  };

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

  const sectionHint = (text: string) => <p className={MUTED}>{text}</p>;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card className="space-y-4">
        <div>
          <SectionHeading level={3} className="!mb-1">Basic Information</SectionHeading>
          {sectionHint(
            isEditMode
              ? 'Update the basic details of your discovery definition'
              : 'Configure basic details for your discovery definition'
          )}
        </div>

        <Input
          id="name"
          label="Name *"
          placeholder="e.g., AWS Production Discovery"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
        />

        <Textarea
          id="description"
          label="Description"
          placeholder="Optional description of what this discovery covers"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />

        <Select
          id="provider"
          label="Provider *"
          value={provider}
          onChange={(value) => {
            setProvider(value as DiscoveryProvider);
            // The new-credential section is SSH-only, so leaving SSH abandons its secret.
            if (value !== 'ssh') clearNewCredSecret();
          }}
          options={PROVIDER_OPTIONS}
          disabled={isEditMode}
          hint={isEditMode ? 'Provider cannot be changed after creation' : undefined}
        />

        {provider === 'ssh' && (
          <Select
            id="credential"
            label="SSH Credential *"
            value={credentialId}
            onChange={selectCredential}
            options={[
              { value: 'none', label: 'Create a new SSH credential' },
              ...sshCredentials.map((cred) => ({ value: cred.id, label: cred.name })),
            ]}
          />
        )}

        {createSshCredential && (
          <div className="space-y-3 rounded-[var(--hh-radius-lg)] bg-[var(--hh-bg-elevated)] p-4">
            {([
              ['name', 'Credential Name *', 'text', errors.credentialName],
              ['username', 'Username *', 'text', errors.credentialUsername],
              ['port', 'Port (optional, default 22)', 'number', errors.credentialPort],
            ] as const).map(([key, label, type, error]) => (
              <Input
                key={key}
                id={`ssh-cred-${key}`}
                label={label}
                type={type}
                value={newCred[key]}
                onChange={(e) => setNewCredField(key, e.target.value)}
                error={error}
              />
            ))}
            <Select
              id="ssh-cred-auth"
              label="Authentication"
              value={newCred.auth}
              onChange={(auth) => setNewCred((current) => ({ ...current, auth, secret: '' }))}
              options={AUTH_OPTIONS}
            />
            <div className="flex flex-col gap-2">
              {newCred.auth === 'key' ? (
                <>
                  <Label htmlFor="ssh-cred-secret">Private Key (PEM text) *</Label>
                  <SecretTextarea
                    id="ssh-cred-secret"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    value={newCred.secret}
                    onChange={(e) => setNewCredField('secret', e.target.value)}
                    rows={6}
                    className="font-mono text-xs"
                  />
                </>
              ) : (
                <>
                  <Label htmlFor="ssh-cred-secret">Password *</Label>
                  <SecretInput
                    id="ssh-cred-secret"
                    value={newCred.secret}
                    onChange={(e) => setNewCredField('secret', e.target.value)}
                  />
                </>
              )}
              {errors.credentialSecret && (
                <p className="text-sm text-[var(--hh-error-text)]">{errors.credentialSecret}</p>
              )}
              <p className="text-xs text-[var(--hh-text-muted)]">
                Saved as an encrypted credential; the definition stores only its id.
              </p>
            </div>
          </div>
        )}

        <Select
          id="method"
          label="Discovery Method *"
          value={method}
          onChange={(value) => setMethod(value as 'agentless' | 'agent')}
          options={METHOD_OPTIONS}
          hint={
            method === 'agentless'
              ? 'Discovery runs directly from this server. Requires network access to target resources.'
              : 'Discovery runs on distributed agents. Best for accessing resources in isolated networks.'
          }
        />

        {method === 'agent' && (
          <AgentSelector
            method={method}
            provider={provider}
            selectedAgentId={agentId}
            onAgentChange={setAgentId}
            targetNetworks={config.targets || []}
          />
        )}

        <div className="space-y-1">
          <Switch id="active" label="Active" checked={active} onChange={setActive} />
          {sectionHint('Inactive definitions cannot be run')}
        </div>
      </Card>

      <Card className="space-y-4">
        <div>
          <SectionHeading level={3} className="!mb-1">Discovery Configuration</SectionHeading>
          {sectionHint('Configure provider-specific discovery settings')}
        </div>
        <DiscoveryConfigForm
          ref={configFormRef}
          provider={provider}
          initialConfig={config}
          onSubmit={setConfig}
          showActions={false}
        />
      </Card>

      <Card className="space-y-4">
        <div>
          <SectionHeading level={3} className="!mb-1">Field Mappings (Optional)</SectionHeading>
          {sectionHint('Map discovered fields to standard CI properties or custom metadata fields')}
        </div>
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
        <p className={MUTED}>
          Field mappings allow you to extract specific data from discovered resources.
          Use dot notation for nested paths (e.g., <code className={CODE}>Tags.0.Value</code> or <code className={CODE}>PrivateIpAddress</code>).
          Standard CI fields (like <code className={CODE}>name</code>, <code className={CODE}>ip_address</code>)
          will be mapped to top-level properties. All other fields become metadata.
        </p>
      </Card>

      <Card className="space-y-4">
        <div>
          <SectionHeading level={3} className="!mb-1">Schedule</SectionHeading>
          {sectionHint('Configure automatic discovery schedule using cron expressions')}
        </div>
        <div className="space-y-1">
          <Switch
            id="schedule-enabled"
            label="Enable Schedule"
            checked={scheduleEnabled}
            onChange={setScheduleEnabled}
          />
          {sectionHint('Run discovery automatically on a schedule')}
        </div>

        {scheduleEnabled && (
          <CronBuilder value={cronExpression} onChange={handleCronChange} />
        )}
      </Card>

      {errors.submit && (
        <Banner tone="danger" icon="warning-circle">
          {errors.submit}
        </Banner>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="md" onClick={onCancel}>
          Cancel
        </Button>
        {showAdHocAction && onAdHocRun && (
          <Button
            type="button"
            variant="secondary"
            size="md"
            icon="play-circle"
            onClick={handleAdHocRun}
            disabled={createSshCredential}
          >
            Run Once
          </Button>
        )}
        {showAdHocAction && onAdHocRun && createSshCredential && (
          <p className="self-center text-xs text-[var(--hh-text-muted)]">Save the credential first to run once</p>
        )}
        {/* POST/PUT /discovery/definitions need write; Run Once (platform-admin /jobs) stays visible */}
        <RequirePermission permission="write">
          <Button type="submit" size="md" icon={showAdHocAction ? 'floppy-disk' : undefined}>
            {showAdHocAction ? 'Save & Run' : isEditMode ? 'Update Definition' : 'Create Definition'}
          </Button>
        </RequirePermission>
      </div>
    </form>
  );
};

export default DiscoveryDefinitionForm;
