// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Configuration Modal
 * Multi-step wizard for configuring integration connectors
 */

import React, { useState, useEffect, useCallback, useId } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  SectionHeading,
  Select,
  Stepper,
  Switch,
  Textarea,
} from '@happy-technologies/design-system';
// Documented localUi exceptions: the DS ships no secret field yet (SecretInput/SecretTextarea keep a typed secret
// out of the DOM tree, HAP-1213), and the cron builder is a shared component owned outside this lane.
import { SecretInput, SecretTextarea } from '@/components/ui/secret-input';
import { CronBuilder } from '@/components/ui/cron-builder';
import { QueryState } from '@/components/estate/SurfaceState';
import { FieldMappingBuilder } from './FieldMappingBuilder';
import { apiClient } from '@/lib/api-client';

/** How a connection field is rendered. `sensitive` and `format` come from the connector's schema property. */
interface ConnectorConfigField {
  type?: string;
  format?: string;
  sensitive?: boolean;
  [key: string]: any;
}

/**
 * HAP-1895: which secret control (if any) a field needs. A sensitive multi-line field (`format: 'textarea'`,
 * e.g. an oracle-cloud PEM `private_key`) cannot be a password input, so it gets `SecretTextarea`; every other
 * sensitive field, `type: 'password'` or `format: 'password'` gets `SecretInput`. Neither mirrors the value into the DOM.
 */
function secretControl(field: ConnectorConfigField): 'textarea' | 'input' | null {
  if (field.sensitive === true && (field.type === 'textarea' || field.format === 'textarea')) return 'textarea';
  if (field.sensitive === true || field.type === 'password' || field.format === 'password') return 'input';
  return null;
}

interface ConnectorConfigModalProps {
  template: {
    type: string;
    name: string;
    description: string;
    icon: string;
    config_schema: Record<string, ConnectorConfigField>;
  };
  onClose: () => void;
  onDeploy: (config: any) => void;
}

export const ConnectorConfigModal: React.FC<ConnectorConfigModalProps> = ({
  template,
  onClose,
  onDeploy,
}) => {
  const [step, setStep] = useState(1);
  const [loadingTemplate, setLoadingTemplate] = useState(true);
  const [fullTemplate, setFullTemplate] = useState<any>(null);
  // A failed template read is shown (with a retry) instead of reading as "no resources". Only a fixed value is
  // kept: the template endpoint is untrusted, so its error payload is never echoed.
  const [templateFailure, setTemplateFailure] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const titleId = useId();
  const [config, setConfig] = useState<any>({
    name: '',
    type: template.type,
    enabled: true,
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
        setTemplateFailure(null);
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
        setFullTemplate(null);
        setTemplateFailure(
          (error as { response?: { status?: number } } | null)?.response?.status === 403
            ? { response: { status: 403 } }
            : new Error('Request failed'),
        );
      } finally {
        setLoadingTemplate(false);
      }
    };

    loadTemplate();
  }, [template.type, loadAttempt]);

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

  // CronBuilder invokes onChange in an effect; keep its callback stable to
  // avoid retriggering that effect on every schedule-state render.
  const updateScheduleExpression = useCallback((cron: string) => {
    setConfig((previous: any) => previous.schedule.cron_expression === cron ? previous : {
      ...previous,
      schedule: { ...previous.schedule, cron_expression: cron },
    });
  }, []);

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
    <Dialog
      open
      onClose={onClose}
      aria-labelledby={titleId}
      className="flex max-h-[90vh] flex-col"
      style={{ maxWidth: '80rem' }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[var(--hh-hairline)] p-6 pr-16">
        <span className="text-3xl">{template.icon}</span>
        <div className="min-w-0">
          <SectionHeading id={titleId} level={2} className="mb-0">
            Configure {template.name}
          </SectionHeading>
          <p className="text-sm text-[var(--hh-text-muted)]">{template.description}</p>
        </div>
      </div>

      {/* Progress Steps */}
      <div className="border-b border-[var(--hh-hairline)] bg-[var(--hh-bg-elevated)] p-6">
        <Stepper
          current={step - 1}
          className="justify-center gap-8"
          steps={[{ label: 'Basic Info' }, { label: 'Connection' }, { label: 'Field Mapping' }]}
        />
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {/* Step 1: Basic Info */}
        {step === 1 && (
          <div className="mx-auto max-w-2xl space-y-6">
            <Input
              id="name"
              label="Connector Name *"
              hint="Give your connector instance a descriptive name"
              placeholder={`My ${template.name} Integration`}
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
            />

            <Textarea
              id="description"
              label="Description (Optional)"
              placeholder="Describe what this connector will be used for..."
              value={config.description || ''}
              onChange={(e) => setConfig({ ...config, description: e.target.value })}
              rows={3}
            />

            <div className="space-y-4 border-t border-[var(--hh-hairline)] pt-4">
              <div className="space-y-1">
                <Switch
                  id="schedule-enabled"
                  label="Enable Schedule"
                  checked={config.schedule.enabled}
                  onChange={(checked) =>
                    setConfig({
                      ...config,
                      schedule: { ...config.schedule, enabled: checked },
                    })
                  }
                />
                <p className="text-sm text-[var(--hh-text-muted)]">
                  Run sync automatically on a schedule
                </p>
              </div>

              {config.schedule.enabled && (
                <CronBuilder
                  value={config.schedule.cron_expression}
                  onChange={updateScheduleExpression}
                />
              )}
            </div>

            <div className="space-y-1 border-t border-[var(--hh-hairline)] pt-4">
              <Switch
                id="enabled"
                label="Active"
                checked={config.enabled}
                onChange={(checked) => setConfig({ ...config, enabled: checked })}
              />
              <p className="text-sm text-[var(--hh-text-muted)]">
                Inactive connectors cannot sync
              </p>
            </div>
          </div>
        )}

        {/* Step 2: Connection Config */}
        {step === 2 && (
          <div className="mx-auto max-w-2xl space-y-6">
            <Banner tone="info" icon="info">
              <strong className="block font-semibold">Connection Settings</strong>
              <span className="text-sm font-normal">
                Configure the connection details to connect to your {template.name} instance
              </span>
            </Banner>

            {Object.entries(template.config_schema).map(([key, field]: [string, any]) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={key}>
                  {field.label} {field.required && <span className="text-[var(--hh-error-text)]">*</span>}
                </Label>

                {field.type === 'select' ? (
                  <Select
                    id={key}
                    value={config.connection[key] || field.default || field.options?.[0] || ''}
                    onChange={(value) => updateConnection(key, value)}
                    options={(field.options ?? []).map((option: string) => ({ value: option, label: option }))}
                  />
                ) : secretControl(field) === 'textarea' ? (
                  <SecretTextarea
                    id={key}
                    placeholder={field.label}
                    value={config.connection[key] || ''}
                    onChange={(e) => updateConnection(key, e.target.value)}
                    rows={5}
                  />
                ) : field.type === 'textarea' ? (
                  <Textarea
                    id={key}
                    placeholder={field.label}
                    value={config.connection[key] || ''}
                    onChange={(e) => updateConnection(key, e.target.value)}
                    rows={5}
                  />
                ) : secretControl(field) === 'input' ? (
                  <SecretInput
                    id={key}
                    autoComplete="new-password"
                    placeholder={field.label}
                    value={config.connection[key] || ''}
                    onChange={(e) => updateConnection(key, e.target.value)}
                  />
                ) : (
                  <Input
                    id={key}
                    type="text"
                    placeholder={field.label}
                    value={config.connection[key] || ''}
                    onChange={(e) => updateConnection(key, e.target.value)}
                  />
                )}

                {field.description && (
                  <p className="text-xs text-[var(--hh-text-muted)]">{field.description}</p>
                )}
              </div>
            ))}

            <Banner tone="neutral" icon="lock-key">
              <strong className="block font-semibold">Security Note</strong>
              <span className="text-xs font-normal">
                Credentials are encrypted at rest and never exposed in logs or API responses
              </span>
            </Banner>
          </div>
        )}

        {/* Step 3: Field Mapping */}
        {step === 3 && (
          <div className="space-y-6">
            <Banner tone="info" icon="info">
              <strong className="block font-semibold">Field Mapping by Resource</strong>
              <span className="text-sm font-normal">
                Map fields from each {template.name} resource to HappyCMDB CI attributes.
                Predefined mappings are loaded from the connector template.
              </span>
            </Banner>

            {loadingTemplate ? (
              <EmptyState loading label="Loading connector resources..." />
            ) : templateFailure ? (
              <QueryState
                what="connector resources"
                error={templateFailure}
                onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
              />
            ) : fullTemplate?.metadata?.resources ? (
              <div className="space-y-6">
                {fullTemplate.metadata.resources
                  .filter((resource: any) => resource.ci_type !== null)  // Exclude relationship resources
                  .map((resource: any) => (
                    <Card key={resource.id} className="space-y-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <SectionHeading level={3} className="mb-1">{resource.name}</SectionHeading>
                          <p className="text-sm text-[var(--hh-text-muted)]">{resource.description}</p>
                        </div>
                        <Badge variant={config.enabled_resources.includes(resource.id) ? 'info' : 'neutral'}>
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
                    </Card>
                  ))}
              </div>
            ) : (
              <EmptyState label="No resources found for this connector" />
            )}
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="flex items-center justify-between border-t border-[var(--hh-hairline)] bg-[var(--hh-bg-elevated)] p-6">
        <div className="text-sm text-[var(--hh-text-muted)]">
          Step {step} of {totalSteps}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="md" icon="arrow-left" onClick={step === 1 ? onClose : handleBack}>
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>
          <Button
            size="md"
            iconRight={step < totalSteps ? 'arrow-right' : undefined}
            onClick={handleNext}
            disabled={!canProceed()}
          >
            {step === totalSteps ? 'Deploy Connector' : 'Next'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
