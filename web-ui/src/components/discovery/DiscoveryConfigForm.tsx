// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { DiscoveryProvider } from '../../services/discovery.service';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { Textarea } from '../ui/textarea';

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

  // HAP-774 C-12: SSH config is targets only; the credential (and its port) is chosen in the definition form.
  const renderSSHForm = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="targets">Target Hosts *</Label>
        <Textarea
          id="targets"
          placeholder="192.168.1.100&#10;server1.example.com"
          value={config.targets?.join('\n') || ''}
          onChange={(e) =>
            updateConfig(
              'targets',
              e.target.value.split('\n').filter((t) => t.trim())
            )
          }
          rows={5}
          required
        />
        <p className="text-sm text-muted-foreground">
          One hostname or IP address per line (no CIDR, range or port). The SSH port is set on the credential.
        </p>
      </div>
    </div>
  );

  const renderNmapForm = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="nmap-targets">Target IP Ranges *</Label>
        <Textarea
          id="nmap-targets"
          placeholder="192.168.1.0/24&#10;10.0.0.0/16&#10;172.16.0.1-50"
          value={config.targets?.join('\n') || ''}
          onChange={(e) =>
            updateConfig(
              'targets',
              e.target.value.split('\n').filter((t) => t.trim())
            )
          }
          rows={5}
          required
        />
        <p className="text-sm text-muted-foreground">
          One target per line (CIDR, range, or single IP)
        </p>
      </div>

      <div className="space-y-2">
        <Label>Scan Options</Label>
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="service-detection"
                checked={config.scanOptions?.serviceDetection || false}
                onCheckedChange={(checked: boolean) =>
                  updateConfig('scanOptions', {
                    ...config.scanOptions,
                    serviceDetection: checked,
                  })
                }
              />
              <Label htmlFor="service-detection" className="cursor-pointer">
                Service Detection (-sV)
              </Label>
              <Badge variant="success" className="ml-2 text-xs">
                Recommended
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground ml-6">
              Detect service names and versions (e.g., "Apache 2.4.41", "OpenSSH 8.2")
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="full-port-scan"
                checked={config.scanOptions?.fullPortScan || false}
                onCheckedChange={(checked: boolean) =>
                  updateConfig('scanOptions', {
                    ...config.scanOptions,
                    fullPortScan: checked,
                  })
                }
              />
              <Label htmlFor="full-port-scan" className="cursor-pointer">
                Full Port Scan (1-65535)
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6">
              Scan all 65,535 ports instead of ~1,000 common ones (slower but comprehensive)
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="os-detection"
                checked={config.scanOptions?.osDetection || false}
                onCheckedChange={(checked: boolean) =>
                  updateConfig('scanOptions', {
                    ...config.scanOptions,
                    osDetection: checked,
                  })
                }
              />
              <Label htmlFor="os-detection" className="cursor-pointer">
                OS Detection (-O)
              </Label>
              <Badge variant="destructive" className="ml-2 text-xs">
                Requires Root
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground ml-6">
              Detect operating system (requires root privileges - currently unavailable)
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="aggressive"
                checked={config.scanOptions?.aggressive || false}
                onCheckedChange={(checked: boolean) =>
                  updateConfig('scanOptions', {
                    ...config.scanOptions,
                    aggressive: checked,
                  })
                }
              />
              <Label htmlFor="aggressive" className="cursor-pointer">
                Aggressive Scan (-A)
              </Label>
              <Badge variant="destructive" className="ml-2 text-xs">
                Requires Root
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground ml-6">
              OS detection + service detection + scripts (requires root privileges - currently unavailable)
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  const renderUnsupported = () => (
    <div className="p-4 border rounded-lg bg-muted/50">
      <p className="text-sm text-muted-foreground">
        {provider.toUpperCase()} discovery is unsupported. It cannot collect or use credentials.
      </p>
    </div>
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
        return <p className="text-destructive">Unknown provider: {provider}. Cloud/API providers (AWS, Azure, GCP, etc.) should use the Connectors page instead.</p>;
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
