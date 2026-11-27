// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { DiscoveryProvider } from '../../services/discovery.service';
import { Badge, Banner, Button, Checkbox, Label, Textarea } from '@happy-technologies/design-system';

interface DiscoveryConfigFormProps {
  provider: DiscoveryProvider;
  initialConfig?: Record<string, any>;
  onSubmit: (config: Record<string, any>) => void;
  showActions?: boolean;
}

export interface DiscoveryConfigFormRef {
  submitForm: () => void;
  getConfig: () => Record<string, any>;
}

export const DiscoveryConfigForm = forwardRef<DiscoveryConfigFormRef, DiscoveryConfigFormProps>(({
  provider,
  initialConfig = {},
  onSubmit,
  showActions = false,
}, ref) => {
  const [config, setConfig] = useState<Record<string, any>>(initialConfig);
  const isFirstRender = useRef(true);

  useImperativeHandle(ref, () => ({
    submitForm: handleSubmit,
    getConfig: () => config,
  }));

  // Keep the parent in sync on every change, but not with initialConfig on mount.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    onSubmit(config);
  }, [config]);

  const updateConfig = (key: string, value: unknown) => setConfig({ ...config, [key]: value });

  const handleSubmit = () => onSubmit(config);

  const targetsFrom = (value: string) => value.split('\n').filter((t) => t.trim());

  // HAP-774 C-12: SSH config is targets only; the credential (and its port) is chosen in the definition form.
  const renderSSHForm = () => (
    <div className="space-y-4">
      <Textarea
        id="targets"
        label="Target Hosts *"
        placeholder="192.168.1.100&#10;server1.example.com"
        value={config.targets?.join('\n') || ''}
        onChange={(e) => updateConfig('targets', targetsFrom(e.target.value))}
        rows={5}
        required
        hint="One hostname or IP address per line (no CIDR, range or port). The SSH port is set on the credential."
      />
    </div>
  );

  const scanOption = (
    key: 'serviceDetection' | 'fullPortScan' | 'osDetection' | 'aggressive',
    label: string,
    hint: string,
    badge?: { variant: 'success' | 'danger'; text: string }
  ) => (
    <Checkbox
      id={`scan-${key}`}
      checked={config.scanOptions?.[key] || false}
      onChange={(checked) => updateConfig('scanOptions', { ...config.scanOptions, [key]: checked })}
      label={
        <>
          {label}
          {badge && (
            <Badge variant={badge.variant} className="ml-2">
              {badge.text}
            </Badge>
          )}
        </>
      }
      hint={hint}
    />
  );

  const renderNmapForm = () => (
    <div className="space-y-4">
      <Textarea
        id="nmap-targets"
        label="Target IP Ranges *"
        placeholder="192.168.1.0/24&#10;10.0.0.0/16&#10;172.16.0.1-50"
        value={config.targets?.join('\n') || ''}
        onChange={(e) => updateConfig('targets', targetsFrom(e.target.value))}
        rows={5}
        required
        hint="One target per line (CIDR, range, or single IP)"
      />

      <div role="group" aria-labelledby="scan-options-label" className="space-y-3">
        <Label id="scan-options-label">Scan Options</Label>
        {scanOption(
          'serviceDetection',
          'Service Detection (-sV)',
          'Detect service names and versions (e.g., "Apache 2.4.41", "OpenSSH 8.2")',
          { variant: 'success', text: 'Recommended' }
        )}
        {scanOption(
          'fullPortScan',
          'Full Port Scan (1-65535)',
          'Scan all 65,535 ports instead of ~1,000 common ones (slower but comprehensive)'
        )}
        {scanOption(
          'osDetection',
          'OS Detection (-O)',
          'Detect operating system (requires root privileges - currently unavailable)',
          { variant: 'danger', text: 'Requires Root' }
        )}
        {scanOption(
          'aggressive',
          'Aggressive Scan (-A)',
          'OS detection + service detection + scripts (requires root privileges - currently unavailable)',
          { variant: 'danger', text: 'Requires Root' }
        )}
      </div>
    </div>
  );

  const renderUnsupported = () => (
    <Banner tone="neutral">
      {provider.toUpperCase()} discovery is unsupported. It cannot collect or use credentials.
    </Banner>
  );

  const renderForm = () => {
    switch (provider) {
      case 'nmap':
        return renderNmapForm();
      case 'ssh':
        return renderSSHForm();
      case 'active-directory':
      case 'snmp':
        return renderUnsupported();
      default:
        return (
          <Banner tone="danger">
            Unknown provider: {provider}. Cloud/API providers (AWS, Azure, GCP, etc.) should use the Connectors page instead.
          </Banner>
        );
    }
  };

  return (
    <div className="space-y-4">
      {renderForm()}
      {showActions && (
        <div className="flex justify-end pt-4">
          <Button onClick={handleSubmit}>Save Configuration</Button>
        </div>
      )}
    </div>
  );
});

DiscoveryConfigForm.displayName = 'DiscoveryConfigForm';

export default DiscoveryConfigForm;
