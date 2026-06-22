// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Transformation Builder Component
 * Visual field mapping interface for data transformation rules
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TransformationRule, FieldMapping } from '../../types';
import { apiClient } from '../../lib/api-client';
import { Icon } from '@happy-technologies/design-system';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

interface TransformationBuilderProps {
  ruleId?: string;
}

const TRANSFORMATION_TYPES = [
  { value: 'direct', label: 'Direct Mapping', icon: '↔️' },
  { value: 'script', label: 'JavaScript Transform', icon: '📝' },
  { value: 'lookup', label: 'Lookup Table', icon: '📋' },
  { value: 'constant', label: 'Constant Value', icon: '🔒' },
];

const COMMON_SOURCE_FIELDS: Record<string, string[]> = {
  servicenow: ['sys_id', 'name', 'u_ci_type', 'ip_address', 'os', 'install_status'],
  jira: ['id', 'key', 'summary', 'project.key', 'status.name', 'assignee.displayName'],
  aws: ['InstanceId', 'InstanceType', 'State.Name', 'PrivateIpAddress', 'Tags'],
};

const TARGET_FIELDS = [
  'name',
  'ci_type',
  'status',
  'environment',
  'ip_address',
  'hostname',
  'os',
  'version',
  'owner',
  'cost_center',
  'tags',
];

export const TransformationBuilder: React.FC<TransformationBuilderProps> = ({ ruleId }) => {
  const [sourceSystem, setSourceSystem] = useState('servicenow');
  const [targetCIType, setTargetCIType] = useState('server');
  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [ruleDescription, setRuleDescription] = useState('');
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (data: Partial<TransformationRule>) =>
      apiClient.post<TransformationRule>('/transformations', data),
    onSuccess: () => {
      toast.success('Transformation rule saved');
      queryClient.invalidateQueries({ queryKey: ['transformations'] });
    },
    onError: () => toast.error('Failed to save transformation rule'),
  });

  const addMapping = () => {
    setFieldMappings([
      ...fieldMappings,
      {
        source_field: '',
        target_field: '',
        transformation_type: 'direct',
        is_required: false,
      },
    ]);
  };

  const updateMapping = (index: number, updates: Partial<FieldMapping>) => {
    const updated = [...fieldMappings];
    updated[index] = { ...updated[index], ...updates };
    setFieldMappings(updated);
  };

  const removeMapping = (index: number) => {
    setFieldMappings(fieldMappings.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (!ruleName || fieldMappings.length === 0) {
      toast.error('Please provide a name and at least one field mapping');
      return;
    }

    saveMutation.mutate({
      name: ruleName,
      description: ruleDescription,
      source_system: sourceSystem,
      target_ci_type: targetCIType,
      field_mappings: fieldMappings,
      is_active: true,
    });
  };

  const sourceFields = COMMON_SOURCE_FIELDS[sourceSystem] || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Transformation Builder</h2>
        <p className="text-muted-foreground mt-1">
          Create visual field mappings to transform data from source systems to CMDB CIs
        </p>
      </div>

      {/* Rule Configuration */}
      <LiquidGlass variant="default" rounded="xl">
        <h3 className="text-lg font-semibold mb-4">Rule Configuration</h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Rule Name</Label>
            <Input
              type="text"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder="e.g., ServiceNow Server Mapping"
            />
          </div>

          <div>
            <Label>Description</Label>
            <Input
              type="text"
              value={ruleDescription}
              onChange={(e) => setRuleDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>

          <div>
            <Label>Source System</Label>
            <select
              value={sourceSystem}
              onChange={(e) => setSourceSystem(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="servicenow">ServiceNow</option>
              <option value="jira">Jira</option>
              <option value="aws">AWS</option>
              <option value="azure">Azure</option>
              <option value="gcp">Google Cloud</option>
            </select>
          </div>

          <div>
            <Label>Target CI Type</Label>
            <select
              value={targetCIType}
              onChange={(e) => setTargetCIType(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="server">Server</option>
              <option value="virtual-machine">Virtual Machine</option>
              <option value="application">Application</option>
              <option value="database">Database</option>
              <option value="network-device">Network Device</option>
              <option value="storage">Storage</option>
            </select>
          </div>
        </div>
      </LiquidGlass>

      {/* Field Mappings */}
      <LiquidGlass variant="default" rounded="xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Field Mappings</h3>
          <Button onClick={addMapping}>
            <Icon name="plus" size={16} />
            Add Mapping
          </Button>
        </div>

        <div className="space-y-3">
          {fieldMappings.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No field mappings defined. Click "Add Mapping" to start.
            </div>
          ) : (
            fieldMappings.map((mapping, index) => (
              <div
                key={index}
                className="grid grid-cols-12 gap-3 items-center p-3 border border-border rounded-lg hover:bg-accent/50 transition-colors"
              >
                {/* Source Field */}
                <div className="col-span-3">
                  <select
                    value={mapping.source_field}
                    onChange={(e) => updateMapping(index, { source_field: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">Select source field...</option>
                    {sourceFields.map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Arrow */}
                <div className="col-span-1 flex justify-center">
                  <Icon name="arrow-right" size={20} className="text-muted-foreground" />
                </div>

                {/* Transformation Type */}
                <div className="col-span-3">
                  <select
                    value={mapping.transformation_type}
                    onChange={(e) =>
                      updateMapping(index, {
                        transformation_type: e.target.value as FieldMapping['transformation_type'],
                      })
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {TRANSFORMATION_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.icon} {type.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Target Field */}
                <div className="col-span-3">
                  <select
                    value={mapping.target_field}
                    onChange={(e) => updateMapping(index, { target_field: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">Select target field...</option>
                    {TARGET_FIELDS.map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Actions */}
                <div className="col-span-2 flex gap-2 justify-end">
                  <label className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={mapping.is_required}
                      onChange={(e) => updateMapping(index, { is_required: e.target.checked })}
                      className="rounded"
                    />
                    Required
                  </label>
                  <Button
                    onClick={() => removeMapping(index)}
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                  >
                    <Icon name="trash" size={16} />
                  </Button>
                </div>

                {/* Script Editor for 'script' type */}
                {mapping.transformation_type === 'script' && (
                  <div className="col-span-12 mt-2">
                    <Label>
                      <Icon name="code" size={16} className="inline mr-1" />
                      Transformation Script (JavaScript)
                    </Label>
                    <textarea
                      value={mapping.transformation_config?.script || ''}
                      onChange={(e) =>
                        updateMapping(index, {
                          transformation_config: { script: e.target.value },
                        })
                      }
                      className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      rows={4}
                      placeholder="// Example: value.toUpperCase()"
                    />
                  </div>
                )}

                {/* Constant Value for 'constant' type */}
                {mapping.transformation_type === 'constant' && (
                  <div className="col-span-12 mt-2">
                    <Label>Constant Value</Label>
                    <Input
                      type="text"
                      value={mapping.transformation_config?.constant_value || ''}
                      onChange={(e) =>
                        updateMapping(index, {
                          transformation_config: { constant_value: e.target.value },
                        })
                      }
                      placeholder="Enter constant value..."
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </LiquidGlass>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button variant="outline">Cancel</Button>
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending}
        >
          <Icon name="floppy-disk" size={16} />
          {saveMutation.isPending ? 'Saving...' : 'Save Rule'}
        </Button>
      </div>
    </div>
  );
};
