// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Field Mapping Builder Component
 * Visual interface for creating source-to-target field mappings with transformations
 */

import React, { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Icon,
  IconButton,
  Input,
  Label,
  NativeSelect,
  SectionHeading,
} from '@happy-technologies/design-system';

interface FieldMapping {
  id: string;
  source_field: string;
  target_field: string;
  transformation?: {
    type: 'direct' | 'expression' | 'lookup' | 'conditional';
    expression?: string;
    lookup_table?: string;
    if_condition?: string;
    then_value?: any;
    else_value?: any;
  };
  default_value?: any;
  required: boolean;
}

interface FieldMappingBuilderProps {
  connectorType: string;
  resourceName?: string;
  mappings: FieldMapping[];
  onChange: (mappings: FieldMapping[]) => void;
}

// Standard HappyCMDB CI fields (NOT stored in metadata)
const STANDARD_CI_FIELDS = [
  { value: 'name', label: 'Name', required: true, category: 'Core' },
  { value: 'type', label: 'CI Type', required: true, category: 'Core' },
  { value: 'status', label: 'Status', required: false, category: 'Core' },
  { value: 'environment', label: 'Environment', required: false, category: 'Core' },
  { value: 'description', label: 'Description', required: false, category: 'Core' },
  { value: 'external_id', label: 'External ID', required: false, category: 'Core' },
  { value: 'ip_address', label: 'IP Address', required: false, category: 'Identity' },
  { value: 'hostname', label: 'Hostname', required: false, category: 'Identity' },
  { value: 'serial_number', label: 'Serial Number', required: false, category: 'Identity' },
  { value: 'manufacturer', label: 'Manufacturer', required: false, category: 'Hardware' },
  { value: 'model', label: 'Model', required: false, category: 'Hardware' },
  { value: 'location', label: 'Location', required: false, category: 'Organization' },
  { value: 'owner', label: 'Owner', required: false, category: 'Organization' },
  { value: 'cost_center', label: 'Cost Center', required: false, category: 'Organization' },
];

// Common metadata field suggestions (stored in dynamic metadata)
const COMMON_METADATA_FIELDS = [
  { value: 'os', label: 'Operating System', category: 'Software' },
  { value: 'os_version', label: 'OS Version', category: 'Software' },
  { value: 'cpu_name', label: 'CPU Name', category: 'Hardware' },
  { value: 'cpu_count', label: 'CPU Count', category: 'Hardware' },
  { value: 'ram_mb', label: 'RAM (MB)', category: 'Hardware' },
  { value: 'disk_size_gb', label: 'Disk Size (GB)', category: 'Hardware' },
  { value: 'firmware_version', label: 'Firmware Version', category: 'Software' },
  { value: 'bios_version', label: 'BIOS Version', category: 'Hardware' },
  { value: 'mac_address', label: 'MAC Address', category: 'Network' },
  { value: 'ip_addresses', label: 'IP Addresses (List)', category: 'Network' },
  { value: 'vlan_count', label: 'VLAN Count', category: 'Network' },
  { value: 'port_count', label: 'Port Count', category: 'Network' },
  { value: 'last_seen', label: 'Last Seen', category: 'Monitoring' },
  { value: 'scan_time', label: 'Scan Time', category: 'Monitoring' },
  { value: 'uptime_seconds', label: 'Uptime (Seconds)', category: 'Monitoring' },
];

export const FieldMappingBuilder: React.FC<FieldMappingBuilderProps> = ({
  connectorType,
  mappings,
  onChange,
}) => {
  const [editingMapping, setEditingMapping] = useState<string | null>(null);
  const [customFieldName, setCustomFieldName] = useState<string>('');
  const [showCustomFieldInput, setShowCustomFieldInput] = useState<string | null>(null);

  const addMapping = () => {
    const newMapping: FieldMapping = {
      id: `mapping_${Date.now()}`,
      source_field: '',
      target_field: '',
      transformation: { type: 'direct' },
      required: false,
    };
    onChange([...mappings, newMapping]);
    setEditingMapping(newMapping.id);
  };

  const updateMapping = (id: string, updates: Partial<FieldMapping>) => {
    onChange(
      mappings.map((m) => (m.id === id ? { ...m, ...updates } : m))
    );
  };

  const deleteMapping = (id: string) => {
    onChange(mappings.filter((m) => m.id !== id));
  };

  const getTransformationIcon = (type?: string) => {
    switch (type) {
      case 'expression':
        return <Icon name="lightning" size={16} className="text-[var(--hh-warning-text)]" />;
      case 'lookup':
        return <Icon name="database" size={16} className="text-[var(--hh-accent-text)]" />;
      case 'conditional':
        return <Icon name="gear-six" size={16} className="text-[var(--hh-text-primary)]" />;
      default:
        return <Icon name="arrow-right" size={16} className="text-[var(--hh-text-muted)]" />;
    }
  };

  const getTransformationBadge = (type?: string) => {
    switch (type) {
      case 'expression':
        return <Badge variant="warning">Expression</Badge>;
      case 'lookup':
        return <Badge variant="info">Lookup</Badge>;
      case 'conditional':
        return <Badge variant="info">Conditional</Badge>;
      default:
        return <Badge variant="neutral">Direct</Badge>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Mapping List */}
      {mappings.length === 0 ? (
        <Card className="border-dashed p-8 text-center">
          <div className="mb-4 text-[var(--hh-text-muted)]">
            <Icon name="database" size={48} className="mx-auto mb-2 opacity-50" />
            <p>No field mappings configured yet</p>
            <p className="text-sm">Add your first mapping to get started</p>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {mappings.map((mapping, index) => {
            const sourceId = `${mapping.id}-source`;
            const targetId = `${mapping.id}-target`;
            const customTargetId = `${mapping.id}-custom-target`;
            const transformationId = `${mapping.id}-transformation`;
            const expressionId = `${mapping.id}-expression`;
            const lookupId = `${mapping.id}-lookup`;
            const ifConditionId = `${mapping.id}-if-condition`;
            const thenValueId = `${mapping.id}-then-value`;
            const elseValueId = `${mapping.id}-else-value`;
            const defaultValueId = `${mapping.id}-default-value`;
            const requiredId = `${mapping.id}-required`;
            const isCustomTarget =
              !!mapping.target_field &&
              mapping.target_field !== 'custom' &&
              !STANDARD_CI_FIELDS.some((f) => f.value === mapping.target_field) &&
              !COMMON_METADATA_FIELDS.some((f) => f.value === mapping.target_field);

            return (
              <Card
                key={mapping.id}
                inset="none"
                className={`p-4 transition-all ${
                  editingMapping === mapping.id ? 'ring-2 ring-[var(--hh-accent-text)]' : ''
                }`}
              >
                {editingMapping === mapping.id ? (
                  /* Edit Mode */
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <SectionHeading level={4} className="mb-0 !text-sm !font-semibold">
                        Mapping #{index + 1}
                      </SectionHeading>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setEditingMapping(null)}>
                          Done
                        </Button>
                        <IconButton
                          icon="trash"
                          variant="ghost"
                          size="sm"
                          aria-label="Delete mapping"
                          onClick={() => deleteMapping(mapping.id)}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      {/* Source Field */}
                      <Input
                        id={sourceId}
                        label="Source Field"
                        placeholder="e.g., sys_id, name, status"
                        value={mapping.source_field}
                        onChange={(e) =>
                          updateMapping(mapping.id, { source_field: e.target.value })
                        }
                        hint={`Field name from ${connectorType} source`}
                      />

                      {/* Target Field */}
                      <div className="flex flex-col gap-2">
                        <Label
                          htmlFor={showCustomFieldInput === mapping.id ? customTargetId : targetId}
                        >
                          Target Field
                        </Label>
                        {showCustomFieldInput === mapping.id ? (
                          <div className="flex gap-2">
                            <Input
                              id={customTargetId}
                              containerClassName="flex-1"
                              placeholder="Enter custom field name (e.g., cpu_cores, patch_level)"
                              value={customFieldName}
                              onChange={(e) => setCustomFieldName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && customFieldName.trim()) {
                                  updateMapping(mapping.id, { target_field: customFieldName.trim() });
                                  setCustomFieldName('');
                                  setShowCustomFieldInput(null);
                                } else if (e.key === 'Escape') {
                                  setCustomFieldName('');
                                  setShowCustomFieldInput(null);
                                }
                              }}
                              autoFocus
                            />
                            <Button
                              size="sm"
                              onClick={() => {
                                if (customFieldName.trim()) {
                                  updateMapping(mapping.id, { target_field: customFieldName.trim() });
                                  setCustomFieldName('');
                                  setShowCustomFieldInput(null);
                                }
                              }}
                            >
                              Add
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setCustomFieldName('');
                                setShowCustomFieldInput(null);
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <NativeSelect
                            id={targetId}
                            value={mapping.target_field || ''}
                            onChange={(e) => {
                              const value = e.target.value;
                              if (value === 'custom') {
                                setShowCustomFieldInput(mapping.id);
                                setCustomFieldName('');
                              } else {
                                updateMapping(mapping.id, { target_field: value });
                              }
                            }}
                          >
                            <option value="" disabled>
                              Select target field or enter custom
                            </option>
                            <optgroup label="Standard CI Fields">
                              {STANDARD_CI_FIELDS.map((field) => (
                                <option key={field.value} value={field.value}>
                                  {`${field.label} (${field.category})${field.required ? ' *' : ''}`}
                                </option>
                              ))}
                            </optgroup>
                            <optgroup label="Common Metadata Fields">
                              {COMMON_METADATA_FIELDS.map((field) => (
                                <option key={field.value} value={field.value}>
                                  {`${field.label} (${field.category})`}
                                </option>
                              ))}
                            </optgroup>
                            <optgroup label="Custom">
                              {isCustomTarget && (
                                <option value={mapping.target_field}>{mapping.target_field}</option>
                              )}
                              <option value="custom">Enter custom field name...</option>
                            </optgroup>
                          </NativeSelect>
                        )}
                        <p className="text-xs text-[var(--hh-text-muted)]">
                          {mapping.target_field && !STANDARD_CI_FIELDS.find(f => f.value === mapping.target_field) ? (
                            <span className="flex items-center gap-1">
                              <Badge variant="neutral">Metadata</Badge>
                              This field will be stored in dynamic metadata
                            </span>
                          ) : (
                            'Select a standard CI field or create a custom metadata field'
                          )}
                        </p>
                      </div>
                    </div>

                    {/* Transformation Type */}
                    <NativeSelect
                      id={transformationId}
                      label="Transformation Type"
                      value={mapping.transformation?.type || 'direct'}
                      onChange={(e) =>
                        updateMapping(mapping.id, {
                          transformation: {
                            ...mapping.transformation,
                            type: e.target.value as NonNullable<FieldMapping['transformation']>['type'],
                          },
                        })
                      }
                    >
                      <option value="direct">Direct (no transformation)</option>
                      <option value="expression">Expression (JavaScript)</option>
                      <option value="lookup">Lookup Table</option>
                      <option value="conditional">Conditional Logic</option>
                    </NativeSelect>

                    {/* Transformation-specific fields */}
                    {mapping.transformation?.type === 'expression' && (
                      <Input
                        id={expressionId}
                        label="Expression"
                        placeholder="e.g., value.toUpperCase()"
                        value={mapping.transformation.expression || ''}
                        onChange={(e) =>
                          updateMapping(mapping.id, {
                            transformation: {
                              type: 'expression',
                              ...mapping.transformation,
                              expression: e.target.value,
                            },
                          })
                        }
                        hint="JavaScript expression to transform the value"
                      />
                    )}

                    {mapping.transformation?.type === 'lookup' && (
                      <Input
                        id={lookupId}
                        label="Lookup Table Name"
                        placeholder="e.g., status_mapping"
                        value={mapping.transformation.lookup_table || ''}
                        onChange={(e) =>
                          updateMapping(mapping.id, {
                            transformation: {
                              type: 'lookup',
                              ...mapping.transformation,
                              lookup_table: e.target.value,
                            },
                          })
                        }
                        hint="Reference to a lookup table for value translation"
                      />
                    )}

                    {mapping.transformation?.type === 'conditional' && (
                      <div className="grid grid-cols-3 gap-4">
                        <Input
                          id={ifConditionId}
                          label="If Condition"
                          placeholder="value === 'active'"
                          value={mapping.transformation.if_condition || ''}
                          onChange={(e) =>
                            updateMapping(mapping.id, {
                              transformation: {
                                type: 'conditional',
                                ...mapping.transformation,
                                if_condition: e.target.value,
                              },
                            })
                          }
                        />
                        <Input
                          id={thenValueId}
                          label="Then Value"
                          placeholder="active"
                          value={mapping.transformation.then_value || ''}
                          onChange={(e) =>
                            updateMapping(mapping.id, {
                              transformation: {
                                type: 'conditional',
                                ...mapping.transformation,
                                then_value: e.target.value,
                              },
                            })
                          }
                        />
                        <Input
                          id={elseValueId}
                          label="Else Value"
                          placeholder="inactive"
                          value={mapping.transformation.else_value || ''}
                          onChange={(e) =>
                            updateMapping(mapping.id, {
                              transformation: {
                                type: 'conditional',
                                ...mapping.transformation,
                                else_value: e.target.value,
                              },
                            })
                          }
                        />
                      </div>
                    )}

                    {/* Additional Options */}
                    <div className="grid grid-cols-2 gap-4 border-t border-[var(--hh-border)] pt-2">
                      <Input
                        id={defaultValueId}
                        label="Default Value (Optional)"
                        placeholder="Value if source is empty"
                        value={mapping.default_value || ''}
                        onChange={(e) =>
                          updateMapping(mapping.id, { default_value: e.target.value })
                        }
                      />
                      <div className="flex items-end">
                        <Checkbox
                          id={requiredId}
                          label="Required field"
                          checked={mapping.required}
                          onChange={(checked) => updateMapping(mapping.id, { required: checked })}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  /* View Mode */
                  <div
                    className="flex cursor-pointer items-center justify-between"
                    onClick={() => setEditingMapping(mapping.id)}
                  >
                    <div className="flex flex-1 items-center gap-4">
                      <Badge variant="neutral">#{index + 1}</Badge>

                      <div className="flex flex-1 items-center gap-3">
                        <div className="text-sm">
                          <span className="font-medium text-[var(--hh-accent-text)]">
                            {mapping.source_field || '(empty)'}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          {getTransformationIcon(mapping.transformation?.type)}
                          {getTransformationBadge(mapping.transformation?.type)}
                        </div>

                        <div className="text-sm">
                          <span className="font-medium text-[var(--hh-success-text)]">
                            {mapping.target_field || '(empty)'}
                          </span>
                        </div>
                      </div>

                      {mapping.required && <Badge variant="danger">Required</Badge>}
                    </div>

                    <Icon name="gear-six" size={20} className="text-[var(--hh-text-muted)]" />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Add Mapping Button */}
      <Button onClick={addMapping} variant="secondary" icon="plus" fullWidth>
        Add Field Mapping
      </Button>

      {/* Helper Info */}
      <Card inset="none" className="border-dashed p-4">
        <SectionHeading level={4} className="mb-2 !text-sm !font-semibold">
          Field Mapping Tips
        </SectionHeading>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-semibold text-[var(--hh-text-primary)]">Target Field Types:</p>
            <ul className="space-y-1 text-xs text-[var(--hh-text-muted)]">
              <li>• <strong>Standard Fields:</strong> Core CI attributes (name, type, ip_address, etc.)</li>
              <li>• <strong>Metadata Fields:</strong> Dynamic attributes stored in metadata (cpu_cores, os_version, etc.)</li>
              <li>• <strong>Custom Fields:</strong> Any custom field name you define</li>
            </ul>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-[var(--hh-text-primary)]">Transformation Types:</p>
            <ul className="space-y-1 text-xs text-[var(--hh-text-muted)]">
              <li>• <strong>Direct:</strong> Copy value as-is from source to target</li>
              <li>• <strong>Expression:</strong> Transform using JavaScript (e.g., value.toUpperCase())</li>
              <li>• <strong>Lookup:</strong> Translate values using a lookup table</li>
              <li>• <strong>Conditional:</strong> Set different values based on a condition</li>
            </ul>
          </div>
        </div>
        <div className="mt-3 border-t border-[var(--hh-border)] pt-3">
          <p className="text-xs text-[var(--hh-text-muted)]">
            <Badge variant="info">💡 Tip</Badge>{' '}
            Fields not in the standard list are automatically stored in dynamic metadata and will appear in the CI detail view.
          </p>
        </div>
      </Card>
    </div>
  );
};
