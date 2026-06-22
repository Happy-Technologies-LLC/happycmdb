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
import { Checkbox } from '../ui/checkbox';
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
import { credentialService, type AuthProtocol } from '../../services/credential.service';
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
  const { credentials, loading: credentialsLoading } = useCredentials();

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
  const [saveCredentials, setSaveCredentials] = useState(false);
  const [credentialName, setCredentialName] = useState('');
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>(
    definition?.field_mappings || {}
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const configFormRef = React.useRef<DiscoveryConfigFormRef>(null);

  // Map discovery provider to credential protocol
  const getProtocolForProvider = (provider: DiscoveryProvider): AuthProtocol | null => {
    switch (provider) {
      case 'ssh':
        return 'ssh_key'; // Could also be ssh_password, we accept both
      case 'nmap':
        return null; // nmap doesn't require credentials
      default:
        return null;
    }
  };

  // Filter credentials by provider - accept both ssh_key and ssh_password for SSH
  const providerCredentials = credentials.filter((cred) => {
    const protocol = getProtocolForProvider(provider);
    if (!protocol) return false;
    if (provider === 'ssh') {
      return cred.protocol === 'ssh_key' || cred.protocol === 'ssh_password';
    }
    return cred.protocol === protocol;
  });

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

    if (saveCredentials && !credentialName.trim()) {
      newErrors.credentialName = 'Credential name is required when saving credentials';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const extractCredentialsFromConfig = (currentConfig: Record<string, any>): Record<string, any> | null => {
    // Extract credentials based on provider type
    if (provider === 'ssh' && currentConfig.credentials) {
      return {
        username: currentConfig.credentials.username,
        password: currentConfig.credentials.password,
        private_key: currentConfig.credentials.privateKey,
      };
    }
    return null;
  };

  const buildFormData = (): DiscoveryDefinitionInput => {
    // Get current config from child component to ensure we have latest state
    const currentConfig = configFormRef.current?.getConfig() || config;

    const formData = {
      name: name.trim(),
      description: description.trim() || undefined,
      provider,
      method,
      credentialId: credentialId && credentialId !== 'none' ? credentialId : undefined,
      agentId: method === 'agent' ? agentId : undefined,
      config: currentConfig,
      field_mappings: Object.keys(fieldMappings).length > 0 ? fieldMappings : undefined,
      schedule: {
        enabled: scheduleEnabled,
        cronExpression: scheduleEnabled ? cronExpression.trim() : undefined,
      },
      active,
    };
    console.log('DiscoveryDefinitionForm: buildFormData returning:', formData);
    return formData;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    let finalCredentialId = credentialId;

    // If user wants to save credentials, create them first
    if (saveCredentials && credentialId === 'none') {
      try {
        const currentConfig = configFormRef.current?.getConfig() || config;
        const credentialData = extractCredentialsFromConfig(currentConfig);

        if (credentialData) {
          const protocol = getProtocolForProvider(provider);
          if (!protocol) {
            setErrors({ ...errors, submit: `Cannot save credentials for provider: ${provider}` });
            return;
          }

          const newCredential = await credentialService.createCredential({
            name: credentialName.trim(),
            protocol: protocol,
            scope: 'universal', // Default to universal scope for discovery credentials
            credentials: credentialData,
          });
          finalCredentialId = newCredential.id;

          // Remove credentials from config since they're now in a credential record
          const configWithoutCreds = { ...currentConfig };
          delete configWithoutCreds.credentials;
          setConfig(configWithoutCreds);
        }
      } catch (error: any) {
        setErrors({ ...errors, submit: `Failed to save credentials: ${error.message}` });
        return;
      }
    }

    const formData = {
      ...buildFormData(),
      credentialId: finalCredentialId && finalCredentialId !== 'none' ? finalCredentialId : undefined,
    };
    console.log('DiscoveryDefinitionForm: handleSubmit calling onSubmit with:', formData);
    onSubmit(formData);
  };

  const handleAdHocRun = () => {
    if (!validateForm()) {
      return;
    }

    if (onAdHocRun) {
      onAdHocRun(buildFormData());
    }
  };

  const handleConfigSubmit = (newConfig: Record<string, any>) => {
    console.log('DiscoveryDefinitionForm: handleConfigSubmit called with:', newConfig);
    setConfig(newConfig);
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

          <div className="space-y-2">
            <Label htmlFor="credential">Credential (Optional)</Label>
            <Select value={credentialId} onValueChange={setCredentialId}>
              <SelectTrigger id="credential">
                <SelectValue placeholder="Select a credential or use environment variables" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (use environment variables)</SelectItem>
                {credentialsLoading ? (
                  <SelectItem value="loading" disabled>
                    Loading credentials...
                  </SelectItem>
                ) : providerCredentials.length === 0 ? (
                  <SelectItem value="no-creds" disabled>
                    No credentials for {provider.toUpperCase()}
                  </SelectItem>
                ) : (
                  providerCredentials.map((cred) => (
                    <SelectItem key={cred.id} value={cred.id}>
                      {cred.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Credentials are managed on the Credentials page. Select one here or leave as
              "None" to use environment variables.
            </p>
          </div>

          {credentialId === 'none' && !isEditMode && (
            <div className="space-y-3 p-4 border rounded-lg bg-muted/50">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="saveCredentials"
                  checked={saveCredentials}
                  onCheckedChange={(checked) => setSaveCredentials(checked as boolean)}
                />
                <Label htmlFor="saveCredentials" className="cursor-pointer">
                  Save credentials for reuse
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                When checked, any credentials you enter in the configuration below will be saved
                as a reusable credential that can be used in other discovery definitions.
              </p>

              {saveCredentials && (
                <div className="space-y-2">
                  <Label htmlFor="credentialName">Credential Name *</Label>
                  <Input
                    id="credentialName"
                    placeholder="e.g., AWS Production Account"
                    value={credentialName}
                    onChange={(e) => setCredentialName(e.target.value)}
                    className={errors.credentialName ? 'border-destructive' : ''}
                  />
                  {errors.credentialName && (
                    <p className="text-sm text-destructive">{errors.credentialName}</p>
                  )}
                </div>
              )}
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
            onSubmit={handleConfigSubmit}
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
          <Button type="button" variant="secondary" onClick={handleAdHocRun}>
            <Icon name="play-circle" size={16} className="mr-2" />
            Run Once
          </Button>
        )}
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
