// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Configuration Modal
 * Multi-step wizard for configuring integration connectors
 */

import React, { useState, useEffect } from 'react';
import { X, Check, ArrowRight, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CronBuilder } from '@/components/ui/cron-builder';
import { FieldMappingBuilder } from './FieldMappingBuilder';
import { useCredentials } from '@/hooks/useCredentials';
import { formatProtocol } from '@/lib/credential-display';
import { apiClient } from '@/lib/api-client';

interface ConnectorConfigModalProps {
  template: {
    type: string;
    name: string;
    description: string;
    icon: string;
    config_schema: Record<string, any>;
  };
  onClose: () => void;
  onDeploy: (config: any) => void;
}

export const ConnectorConfigModal: React.FC<ConnectorConfigModalProps> = ({
  template,
  onClose,
  onDeploy,
}) => {
  const { credentials, loading: credentialsLoading } = useCredentials();
  const [step, setStep] = useState(1);
  const [loadingTemplate, setLoadingTemplate] = useState(true);
  const [fullTemplate, setFullTemplate] = useState<any>(null);
  const [config, setConfig] = useState<any>({
    name: '',
    type: template.type,
    enabled: true,
    credential_id: 'none',
    connection: {},
    field_mappings: {},  // Changed to object keyed by resource_id
    enabled_resources: [],
    schedule: {
      enabled: false,
      cron_expression: '0 9 * * *',
    },
  });

  // Load full connector template with resources and field_mappings
  useEffect(() => {
    const loadTemplate = async () => {
      try {
        setLoadingTemplate(true);
        const response = await apiClient.get<any>(`/connectors/installed/${template.type}`);
        const templateData = response.data;
        setFullTemplate(templateData);

        // Auto-populate field_mappings from template resources
        const initialMappings: any = {};
        const enabledResources: string[] = [];

        if (templateData.metadata?.resources) {
          templateData.metadata.resources.forEach((resource: any) => {
            if (resource.enabled_by_default !== false) {
              enabledResources.push(resource.id);
            }

            // Convert resource field_mappings to UI format
            if (resource.field_mappings) {
              initialMappings[resource.id] = Object.entries(resource.field_mappings).map(
                ([target, source], index) => ({
                  id: `${resource.id}_mapping_${index}`,
                  source_field: source as string,
                  target_field: target,
                  transformation: { type: 'direct' },
                  required: false,
                })
              );
            } else {
              initialMappings[resource.id] = [];
            }
          });
        }

        setConfig((prev: any) => ({
          ...prev,
          field_mappings: initialMappings,
          enabled_resources: enabledResources,
        }));
      } catch (error) {
        console.error('Failed to load connector template:', error);
      } finally {
        setLoadingTemplate(false);
      }
    };

    loadTemplate();
  }, [template.type]);

  const totalSteps = 3;

  const handleNext = () => {
    if (step < totalSteps) {
      setStep(step + 1);
    } else {
      onDeploy(config);
    }
  };

  const handleBack = () => {
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const updateConnection = (field: string, value: any) => {
    setConfig({
      ...config,
      connection: {
        ...config.connection,
        [field]: value,
      },
    });
  };

  const updateFieldMappings = (resourceId: string, mappings: any[]) => {
    setConfig({
      ...config,
      field_mappings: {
        ...config.field_mappings,
        [resourceId]: mappings,
      },
    });
  };

  const canProceed = () => {
    if (step === 1) {
      return config.name.trim().length > 0;
    }
    if (step === 2) {
      // Check required connection fields
      const schema = template.config_schema;
      return Object.entries(schema).every(([key, field]: [string, any]) => {
        if (field.required) {
          return config.connection[key]?.toString().trim().length > 0;
        }
        return true;
      });
    }
    return true;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <LiquidGlass
        variant="default"
        rounded="xl"
        className="w-full max-w-7xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{template.icon}</span>
            <div>
              <h2 className="text-2xl font-bold">Configure {template.name}</h2>
              <p className="text-sm text-muted-foreground">{template.description}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-muted rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center justify-center gap-4 p-6 border-b border-border bg-muted/20">
          {[1, 2, 3].map((stepNum) => (
            <div key={stepNum} className="flex items-center gap-2">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold transition-all ${
                  stepNum === step
                    ? 'bg-primary text-primary-foreground'
                    : stepNum < step
                    ? 'bg-green-500 text-white'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {stepNum < step ? <Check className="h-5 w-5" /> : stepNum}
              </div>
              <span className={`text-sm font-medium ${stepNum === step ? 'text-foreground' : 'text-muted-foreground'}`}>
                {stepNum === 1 && 'Basic Info'}
                {stepNum === 2 && 'Connection'}
                {stepNum === 3 && 'Field Mapping'}
              </span>
              {stepNum < 3 && (
                <ArrowRight className="h-4 w-4 text-muted-foreground ml-2" />
              )}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6" style={{ maxHeight: 'calc(90vh - 300px)' }}>
          {/* Step 1: Basic Info */}
          {step === 1 && (
            <div className="space-y-6 max-w-2xl mx-auto">
              <div className="space-y-2">
                <Label htmlFor="name">Connector Name *</Label>
                <Input
                  id="name"
                  placeholder={`My ${template.name} Integration`}
                  value={config.name}
                  onChange={(e) => setConfig({ ...config, name: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Give your connector instance a descriptive name
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description (Optional)</Label>
                <Textarea
                  id="description"
                  placeholder="Describe what this connector will be used for..."
                  value={config.description || ''}
                  onChange={(e) => setConfig({ ...config, description: e.target.value })}
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="credential">Credential (Optional)</Label>
                <Select
                  value={config.credential_id}
                  onValueChange={(value) => setConfig({ ...config, credential_id: value })}
                >
                  <SelectTrigger id="credential">
                    <SelectValue placeholder="Select a saved credential or configure manually" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (configure manually)</SelectItem>
                    {credentialsLoading ? (
                      <SelectItem value="loading" disabled>
                        Loading credentials...
                      </SelectItem>
                    ) : credentials.length === 0 ? (
                      <SelectItem value="no-creds" disabled>
                        No saved credentials
                      </SelectItem>
                    ) : (
                      credentials.map((cred) => (
                        <SelectItem key={cred.id} value={cred.id}>
                          {cred.name} ({formatProtocol(cred.protocol)})
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Reuse saved credentials from the Credentials page, or configure manually in the next step
                </p>
              </div>

              <div className="space-y-4 border-t pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="schedule-enabled">Enable Schedule</Label>
                    <p className="text-sm text-muted-foreground">
                      Run sync automatically on a schedule
                    </p>
                  </div>
                  <Switch
                    id="schedule-enabled"
                    checked={config.schedule.enabled}
                    onCheckedChange={(checked) =>
                      setConfig({
                        ...config,
                        schedule: { ...config.schedule, enabled: checked },
                      })
                    }
                  />
                </div>

                {config.schedule.enabled && (
                  <CronBuilder
                    value={config.schedule.cron_expression}
                    onChange={(cron) =>
                      setConfig({
                        ...config,
                        schedule: { ...config.schedule, cron_expression: cron },
                      })
                    }
                  />
                )}
              </div>

              <div className="flex items-center justify-between border-t pt-4">
                <div>
                  <Label htmlFor="enabled">Active</Label>
                  <p className="text-sm text-muted-foreground">
                    Inactive connectors cannot sync
                  </p>
                </div>
                <Switch
                  id="enabled"
                  checked={config.enabled}
                  onCheckedChange={(checked) => setConfig({ ...config, enabled: checked })}
                />
              </div>
            </div>
          )}

          {/* Step 2: Connection Config */}
          {step === 2 && (
            <div className="space-y-6 max-w-2xl mx-auto">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                <h3 className="font-semibold text-blue-900 mb-1">Connection Settings</h3>
                <p className="text-sm text-blue-700">
                  Configure the connection details to connect to your {template.name} instance
                </p>
              </div>

              {Object.entries(template.config_schema).map(([key, field]: [string, any]) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={key}>
                    {field.label} {field.required && <span className="text-red-500">*</span>}
                  </Label>

                  {field.type === 'select' ? (
                    <Select
                      value={config.connection[key] || field.default || field.options?.[0]}
                      onValueChange={(value) => updateConnection(key, value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={`Select ${field.label}`} />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options?.map((option: string) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : field.type === 'textarea' ? (
                    <Textarea
                      id={key}
                      placeholder={field.label}
                      value={config.connection[key] || ''}
                      onChange={(e) => updateConnection(key, e.target.value)}
                      rows={5}
                    />
                  ) : (
                    <Input
                      id={key}
                      type={field.type === 'password' ? 'password' : 'text'}
                      placeholder={field.label}
                      value={config.connection[key] || ''}
                      onChange={(e) => updateConnection(key, e.target.value)}
                    />
                  )}

                  {field.description && (
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                  )}
                </div>
              ))}

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mt-6">
                <h4 className="font-semibold text-yellow-900 text-sm mb-1">Security Note</h4>
                <p className="text-xs text-yellow-700">
                  Credentials are encrypted at rest and never exposed in logs or API responses
                </p>
              </div>
            </div>
          )}

          {/* Step 3: Field Mapping */}
          {step === 3 && (
            <div className="space-y-6">
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6">
                <h3 className="font-semibold text-purple-900 mb-1">Field Mapping by Resource</h3>
                <p className="text-sm text-purple-700">
                  Map fields from each {template.name} resource to HappyCMDB CI attributes.
                  Predefined mappings are loaded from the connector template.
                </p>
              </div>

              {loadingTemplate ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
                  <p className="text-sm text-muted-foreground mt-2">Loading connector resources...</p>
                </div>
              ) : fullTemplate?.metadata?.resources ? (
                <div className="space-y-6">
                  {fullTemplate.metadata.resources
                    .filter((resource: any) => resource.ci_type !== null)  // Exclude relationship resources
                    .map((resource: any) => (
                      <div key={resource.id} className="border rounded-lg p-4 space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-semibold text-lg">{resource.name}</h4>
                            <p className="text-sm text-muted-foreground">{resource.description}</p>
                          </div>
                          <Badge variant={config.enabled_resources.includes(resource.id) ? 'default' : 'secondary'}>
                            {config.enabled_resources.includes(resource.id) ? 'Enabled' : 'Disabled'}
                          </Badge>
                        </div>

                        {config.enabled_resources.includes(resource.id) && (
                          <FieldMappingBuilder
                            connectorType={template.type}
                            resourceName={resource.name}
                            mappings={config.field_mappings[resource.id] || []}
                            onChange={(mappings) => updateFieldMappings(resource.id, mappings)}
                          />
                        )}
                      </div>
                    ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  No resources found for this connector
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between p-6 border-t border-border bg-muted/20">
          <div className="text-sm text-muted-foreground">
            Step {step} of {totalSteps}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={step === 1 ? onClose : handleBack}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              {step === 1 ? 'Cancel' : 'Back'}
            </Button>
            <Button
              onClick={handleNext}
              disabled={!canProceed()}
            >
              {step === totalSteps ? 'Deploy Connector' : 'Next'}
              {step < totalSteps && <ArrowRight className="h-4 w-4 ml-2" />}
            </Button>
          </div>
        </div>
      </LiquidGlass>
    </div>
  );
};
