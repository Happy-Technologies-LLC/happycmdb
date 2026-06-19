// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Field Mapping Builder Component
 * Visual interface for creating source-to-target field mappings with transformations
 */

import React, { useState } from 'react';
import { Plus, Trash2, ArrowRight, Settings2, Database, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
        return <Zap className="h-4 w-4 text-warning" />;
      case 'lookup':
        return <Database className="h-4 w-4 text-sky-text" />;
      case 'conditional':
        return <Settings2 className="h-4 w-4 text-navy" />;
      default:
        return <ArrowRight className="h-4 w-4 text-ink-soft" />;
    }
  };

  const getTransformationBadge = (type?: string) => {
    switch (type) {
      case 'expression':
        return <Badge variant="outline" className="bg-warning-soft text-warning border-warning/20">Expression</Badge>;
      case 'lookup':
        return <Badge variant="outline" className="bg-sky-soft text-sky-text border-sky">Lookup</Badge>;
      case 'conditional':
        return <Badge variant="outline" className="bg-sky-soft text-navy border-sky">Conditional</Badge>;
      default:
        return <Badge variant="outline" className="bg-warm-alt text-ink-soft">Direct</Badge>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Mapping List */}
      {mappings.length === 0 ? (
        <Card className="p-8 text-center border-dashed">
          <div className="text-muted-foreground mb-4">
            <Database className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>No field mappings configured yet</p>
            <p className="text-sm">Add your first mapping to get started</p>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {mappings.map((mapping, index) => (
            <Card
              key={mapping.id}
              className={`p-4 transition-all ${
                editingMapping === mapping.id ? 'ring-2 ring-primary' : ''
              }`}
            >
              {editingMapping === mapping.id ? (
                /* Edit Mode */
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="font-semibold text-sm">Mapping #{index + 1}</h4>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingMapping(null)}
                      >
                        Done
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => deleteMapping(mapping.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Source Field */}
                    <div className="space-y-2">
                      <Label>Source Field</Label>
                      <Input
                        placeholder="e.g., sys_id, name, status"
                        value={mapping.source_field}
                        onChange={(e) =>
                          updateMapping(mapping.id, { source_field: e.target.value })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Field name from {connectorType} source
                      </p>
                    </div>

                    {/* Target Field */}
                    <div className="space-y-2">
                      <Label>Target Field</Label>
                      {showCustomFieldInput === mapping.id ? (
                        <div className="flex gap-2">
                          <Input
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
                            variant="outline"
                            onClick={() => {
                              setCustomFieldName('');
                              setShowCustomFieldInput(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Select
                          value={mapping.target_field || 'select'}
                          onValueChange={(value) => {
                            if (value === 'custom') {
                              setShowCustomFieldInput(mapping.id);
                              setCustomFieldName('');
                            } else {
                              updateMapping(mapping.id, { target_field: value });
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select target field or enter custom" />
                          </SelectTrigger>
                          <SelectContent className="max-h-96">
                            {/* Standard CI Fields */}
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/50">
                              Standard CI Fields
                            </div>
                            {STANDARD_CI_FIELDS.map((field) => (
                              <SelectItem key={field.value} value={field.value}>
                                <div className="flex items-center justify-between w-full">
                                  <span>{field.label}</span>
                                  <span className="text-xs text-muted-foreground ml-2">
                                    {field.category}
                            {field.required && <span className="text-danger ml-1">*</span>}
                                  </span>
                                </div>
                              </SelectItem>
                            ))}

                            {/* Metadata Fields */}
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/50 mt-2">
                              Common Metadata Fields
                            </div>
                            {COMMON_METADATA_FIELDS.map((field) => (
                              <SelectItem key={field.value} value={field.value}>
                                <div className="flex items-center justify-between w-full">
                                  <span>{field.label}</span>
                                  <Badge variant="outline" className="text-xs ml-2">
                                    {field.category}
                                  </Badge>
                                </div>
                              </SelectItem>
                            ))}

                            {/* Custom Field Option */}
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/50 mt-2">
                              Custom
                            </div>
                            <SelectItem value="custom">
                              <div className="flex items-center gap-2">
                                <Plus className="h-3 w-3" />
                                <span className="font-medium">Enter custom field name...</span>
                              </div>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {mapping.target_field && !STANDARD_CI_FIELDS.find(f => f.value === mapping.target_field) ? (
                          <span className="flex items-center gap-1">
                            <Badge variant="secondary" className="text-xs">Metadata</Badge>
                            This field will be stored in dynamic metadata
                          </span>
                        ) : (
                          'Select a standard CI field or create a custom metadata field'
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Transformation Type */}
                  <div className="space-y-2">
                    <Label>Transformation Type</Label>
                    <Select
                      value={mapping.transformation?.type || 'direct'}
                      onValueChange={(value: any) =>
                        updateMapping(mapping.id, {
                          transformation: {
                            ...mapping.transformation,
                            type: value,
                          },
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="direct">Direct (no transformation)</SelectItem>
                        <SelectItem value="expression">Expression (JavaScript)</SelectItem>
                        <SelectItem value="lookup">Lookup Table</SelectItem>
                        <SelectItem value="conditional">Conditional Logic</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Transformation-specific fields */}
                  {mapping.transformation?.type === 'expression' && (
                    <div className="space-y-2">
                      <Label>Expression</Label>
                      <Input
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
                      />
                      <p className="text-xs text-muted-foreground">
                        JavaScript expression to transform the value
                      </p>
                    </div>
                  )}

                  {mapping.transformation?.type === 'lookup' && (
                    <div className="space-y-2">
                      <Label>Lookup Table Name</Label>
                      <Input
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
                      />
                      <p className="text-xs text-muted-foreground">
                        Reference to a lookup table for value translation
                      </p>
                    </div>
                  )}

                  {mapping.transformation?.type === 'conditional' && (
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <Label>If Condition</Label>
                        <Input
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
                      </div>
                      <div className="space-y-2">
                        <Label>Then Value</Label>
                        <Input
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
                      </div>
                      <div className="space-y-2">
                        <Label>Else Value</Label>
                        <Input
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
                    </div>
                  )}

                  {/* Additional Options */}
                  <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                    <div className="space-y-2">
                      <Label>Default Value (Optional)</Label>
                      <Input
                        placeholder="Value if source is empty"
                        value={mapping.default_value || ''}
                        onChange={(e) =>
                          updateMapping(mapping.id, { default_value: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex items-end">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={mapping.required}
                          onChange={(e) =>
                            updateMapping(mapping.id, { required: e.target.checked })
                          }
                          className="rounded"
                        />
                        <span className="text-sm">Required field</span>
                      </label>
                    </div>
                  </div>
                </div>
              ) : (
                /* View Mode */
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => setEditingMapping(mapping.id)}
                >
                  <div className="flex items-center gap-4 flex-1">
                    <Badge variant="outline" className="font-mono text-xs">
                      #{index + 1}
                    </Badge>

                    <div className="flex items-center gap-3 flex-1">
                      <div className="text-sm">
                        <span className="font-medium text-sky-text">{mapping.source_field || '(empty)'}</span>
                      </div>

                      <div className="flex items-center gap-2">
                        {getTransformationIcon(mapping.transformation?.type)}
                        {getTransformationBadge(mapping.transformation?.type)}
                      </div>

                      <div className="text-sm">
                        <span className="font-medium text-success">{mapping.target_field || '(empty)'}</span>
                      </div>
                    </div>

                    {mapping.required && (
                      <Badge variant="destructive" className="text-xs">Required</Badge>
                    )}
                  </div>

                  <Settings2 className="h-5 w-5 text-muted-foreground" />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Add Mapping Button */}
      <Button onClick={addMapping} variant="outline" className="w-full">
        <Plus className="h-4 w-4 mr-2" />
        Add Field Mapping
      </Button>

      {/* Helper Info */}
      <Card className="p-4 bg-muted/50 border-dashed">
        <h4 className="font-semibold text-sm mb-2">Field Mapping Tips</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold text-foreground mb-1">Target Field Types:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>• <strong>Standard Fields:</strong> Core CI attributes (name, type, ip_address, etc.)</li>
              <li>• <strong>Metadata Fields:</strong> Dynamic attributes stored in metadata (cpu_cores, os_version, etc.)</li>
              <li>• <strong>Custom Fields:</strong> Any custom field name you define</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-1">Transformation Types:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>• <strong>Direct:</strong> Copy value as-is from source to target</li>
              <li>• <strong>Expression:</strong> Transform using JavaScript (e.g., value.toUpperCase())</li>
              <li>• <strong>Lookup:</strong> Translate values using a lookup table</li>
              <li>• <strong>Conditional:</strong> Set different values based on a condition</li>
            </ul>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-border/50">
          <p className="text-xs text-muted-foreground">
            <Badge variant="secondary" className="text-xs mr-1">💡 Tip</Badge>
            Fields not in the standard list are automatically stored in dynamic metadata and will appear in the CI detail view.
          </p>
        </div>
      </Card>
    </div>
  );
};
