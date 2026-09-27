import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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

  return (
    <div className="space-y-6 p-4 border border-border rounded-lg bg-muted/20">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Credential Affinity</h3>
        <p className="text-xs text-muted-foreground">
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
            className="flex-1"
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => handleAddItem('networks', networkInput, () => setNetworkInput(''))}
          >
            <Icon name="plus" size={16} />
          </Button>
        </div>
        {affinity.networks && affinity.networks.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {affinity.networks.map((network) => (
              <Badge key={network} variant="secondary" className="gap-1">
                {network}
                <button
                  type="button"
                  onClick={() => handleRemoveItem('networks', network)}
                  className="hover:text-destructive"
                >
                  <Icon name="x" size={12} />
                </button>
              </Badge>
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
            className="flex-1"
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() =>
              handleAddItem('hostname_patterns', hostnameInput, () => setHostnameInput(''))
            }
          >
            <Icon name="plus" size={16} />
          </Button>
        </div>
        {affinity.hostname_patterns && affinity.hostname_patterns.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {affinity.hostname_patterns.map((pattern) => (
              <Badge key={pattern} variant="secondary" className="gap-1">
                {pattern}
                <button
                  type="button"
                  onClick={() => handleRemoveItem('hostname_patterns', pattern)}
                  className="hover:text-destructive"
                >
                  <Icon name="x" size={12} />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* OS Types */}
      <div className="space-y-2">
        <Label>Operating Systems</Label>
        <div className="flex flex-wrap gap-2">
          {OS_TYPES.map((os) => (
            <Badge
              key={os}
              variant={isSelected('os_types', os) ? 'default' : 'outline'}
              className="cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => handleToggleItem('os_types', os)}
            >
              {os}
            </Badge>
          ))}
        </div>
      </div>

      {/* Device Types */}
      <div className="space-y-2">
        <Label>Device Types</Label>
        <div className="flex flex-wrap gap-2">
          {DEVICE_TYPES.map((type) => (
            <Badge
              key={type}
              variant={isSelected('device_types', type) ? 'default' : 'outline'}
              className="cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => handleToggleItem('device_types', type)}
            >
              {type}
            </Badge>
          ))}
        </div>
      </div>

      {/* Environments */}
      <div className="space-y-2">
        <Label>Environments</Label>
        <div className="flex flex-wrap gap-2">
          {ENVIRONMENTS.map((env) => (
            <Badge
              key={env}
              variant={isSelected('environments', env) ? 'default' : 'outline'}
              className="cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => handleToggleItem('environments', env)}
            >
              {env}
            </Badge>
          ))}
        </div>
      </div>

      {/* Cloud Providers */}
      <div className="space-y-2">
        <Label>Cloud Providers</Label>
        <div className="flex flex-wrap gap-2">
          {CLOUD_PROVIDERS.map((provider) => (
            <Badge
              key={provider}
              variant={isSelected('cloud_providers', provider) ? 'default' : 'outline'}
              className="cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => handleToggleItem('cloud_providers', provider)}
            >
              {provider.toUpperCase()}
            </Badge>
          ))}
        </div>
      </div>

      {/* Priority Slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="priority">Priority</Label>
          <span className="text-sm text-muted-foreground">{affinity.priority || 5}</span>
        </div>
        <input
          id="priority"
          type="range"
          min="1"
          max="10"
          value={affinity.priority || 5}
          onChange={(e) => handlePriorityChange(parseInt(e.target.value, 10))}
          className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Low (1)</span>
          <span>High (10)</span>
        </div>
      </div>
    </div>
  );
};

export default AffinityEditor;
