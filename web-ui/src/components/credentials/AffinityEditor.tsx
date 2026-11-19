import React, { useState } from 'react';
import { Card, Chip, IconButton, Input, Label, SectionHeading, Tag } from '@happy-technologies/design-system';
import { CredentialAffinity } from '@/services/credential.service';

interface AffinityEditorProps {
  affinity: CredentialAffinity;
  onChange: (affinity: CredentialAffinity) => void;
}

const OS_TYPES = [
  'linux',
  'windows',
  'macos',
  'cisco-ios',
  'cisco-nxos',
  'juniper-junos',
  'arista-eos',
  'palo-alto',
  'fortinet',
  'ubuntu',
  'centos',
  'rhel',
  'debian',
];

const DEVICE_TYPES = [
  'server',
  'router',
  'switch',
  'firewall',
  'load-balancer',
  'storage',
  'network-device',
  'virtual-machine',
  'container',
];

const ENVIRONMENTS = ['production', 'staging', 'development', 'test', 'qa', 'uat'];

const CLOUD_PROVIDERS = ['aws', 'azure', 'gcp', 'alibaba', 'oracle', 'ibm'];

export const AffinityEditor: React.FC<AffinityEditorProps> = ({ affinity, onChange }) => {
  const [networkInput, setNetworkInput] = useState('');
  const [hostnameInput, setHostnameInput] = useState('');

  const handleAddItem = (
    field: keyof CredentialAffinity,
    value: string,
    clearInput?: () => void
  ) => {
    if (!value.trim()) return;

    const currentArray = (affinity[field] as string[]) || [];
    if (!currentArray.includes(value.trim())) {
      onChange({
        ...affinity,
        [field]: [...currentArray, value.trim()],
      });
      if (clearInput) clearInput();
    }
  };

  const handleRemoveItem = (field: keyof CredentialAffinity, value: string) => {
    const currentArray = (affinity[field] as string[]) || [];
    onChange({
      ...affinity,
      [field]: currentArray.filter((item) => item !== value),
    });
  };

  const handleToggleItem = (field: keyof CredentialAffinity, value: string) => {
    const currentArray = (affinity[field] as string[]) || [];
    if (currentArray.includes(value)) {
      handleRemoveItem(field, value);
    } else {
      onChange({
        ...affinity,
        [field]: [...currentArray, value],
      });
    }
  };

  const handlePriorityChange = (priority: number) => {
    onChange({
      ...affinity,
      priority,
    });
  };

  const isSelected = (field: keyof CredentialAffinity, value: string): boolean => {
    const currentArray = (affinity[field] as string[]) || [];
    return currentArray.includes(value);
  };

  const chipGroup = (
    field: keyof CredentialAffinity,
    label: string,
    values: string[],
    display: (value: string) => string = (value) => value
  ) => (
    <div className="space-y-2" role="group" aria-label={label}>
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => (
          <Chip
            key={value}
            active={isSelected(field, value)}
            onClick={() => handleToggleItem(field, value)}
          >
            {display(value)}
          </Chip>
        ))}
      </div>
    </div>
  );

  return (
    <Card className="space-y-6">
      <div className="space-y-1">
        <SectionHeading level={3}>
          Credential Affinity
        </SectionHeading>
        <p className="text-xs text-[var(--hh-text-muted)]">
          Define where this credential should be prioritized for use
        </p>
      </div>

      {/* Network CIDRs */}
      <div className="space-y-2">
        <Label htmlFor="networks">Network CIDRs</Label>
        <div className="flex gap-2">
          <Input
            id="networks"
            type="text"
            value={networkInput}
            onChange={(e) => setNetworkInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddItem('networks', networkInput, () => setNetworkInput(''));
              }
            }}
            placeholder="10.0.0.0/8 or 192.168.1.0/24"
            containerClassName="flex-1"
          />
          <IconButton
            icon="plus"
            variant="outline"
            shape="rounded"
            aria-label="Add network CIDR"
            onClick={() => handleAddItem('networks', networkInput, () => setNetworkInput(''))}
          />
        </div>
        {affinity.networks && affinity.networks.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {affinity.networks.map((network) => (
              <Tag key={network} onRemove={() => handleRemoveItem('networks', network)}>
                {network}
              </Tag>
            ))}
          </div>
        )}
      </div>

      {/* Hostname Patterns */}
      <div className="space-y-2">
        <Label htmlFor="hostname_patterns">Hostname Patterns</Label>
        <div className="flex gap-2">
          <Input
            id="hostname_patterns"
            type="text"
            value={hostnameInput}
            onChange={(e) => setHostnameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddItem('hostname_patterns', hostnameInput, () => setHostnameInput(''));
              }
            }}
            placeholder="*.prod.example.com or db-*"
            containerClassName="flex-1"
          />
          <IconButton
            icon="plus"
            variant="outline"
            shape="rounded"
            aria-label="Add hostname pattern"
            onClick={() =>
              handleAddItem('hostname_patterns', hostnameInput, () => setHostnameInput(''))
            }
          />
        </div>
        {affinity.hostname_patterns && affinity.hostname_patterns.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {affinity.hostname_patterns.map((pattern) => (
              <Tag key={pattern} onRemove={() => handleRemoveItem('hostname_patterns', pattern)}>
                {pattern}
              </Tag>
            ))}
          </div>
        )}
      </div>

      {chipGroup('os_types', 'Operating Systems', OS_TYPES)}
      {chipGroup('device_types', 'Device Types', DEVICE_TYPES)}
      {chipGroup('environments', 'Environments', ENVIRONMENTS)}
      {chipGroup('cloud_providers', 'Cloud Providers', CLOUD_PROVIDERS, (provider) =>
        provider.toUpperCase()
      )}

      {/* Priority Slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="priority">Priority</Label>
          <span className="text-sm text-[var(--hh-text-muted)]">{affinity.priority || 5}</span>
        </div>
        {/* The design system 1.1.x ships no slider; the native range input stays (listed in the PR). */}
        <input
          id="priority"
          type="range"
          min="1"
          max="10"
          value={affinity.priority || 5}
          onChange={(e) => handlePriorityChange(parseInt(e.target.value, 10))}
          className="h-2 w-full cursor-pointer accent-[var(--hh-accent-text)]"
        />
        <div className="flex justify-between text-xs text-[var(--hh-text-muted)]">
          <span>Low (1)</span>
          <span>High (10)</span>
        </div>
      </div>
    </Card>
  );
};

export default AffinityEditor;
