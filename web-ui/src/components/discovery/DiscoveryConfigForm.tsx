// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import {
  DiscoveryProvider,
  SSHConfig,
  NmapConfig,
} from '../../services/discovery.service';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { Textarea } from '../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

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

  // Call onSubmit whenever config changes to keep parent in sync
  // BUT skip the first render to avoid overwriting with initialConfig
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      console.log('DiscoveryConfigForm: Initial mount, skipping onSubmit. InitialConfig:', initialConfig);
      return;
    }

    console.log('DiscoveryConfigForm: Config changed, calling onSubmit with:', config);
    onSubmit(config);
  }, [config]);

  const updateConfig = (key: string, value: any) => {
    const newConfig = { ...config, [key]: value };
    console.log('DiscoveryConfigForm: updateConfig called with', key, value, 'new config:', newConfig);
    setConfig(newConfig);
  };

  const handleSubmit = () => {
    console.log('DiscoveryConfigForm: handleSubmit called with config:', config);
    onSubmit(config);
  };

  const renderAWSForm = () => {
    const awsRegions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'];
    const resourceTypes = ['ec2', 'rds', 's3', 'ecs', 'lambda'];
    const selectedRegions = config.regions || [];
    const selectedTypes = config.resourceTypes || [];

    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>AWS Regions *</Label>
          <div className="flex flex-wrap gap-2">
            {awsRegions.map((region) => (
              <Badge
                key={region}
                variant={selectedRegions.includes(region) ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => {
                  const newRegions = selectedRegions.includes(region)
                    ? selectedRegions.filter((r: string) => r !== region)
                    : [...selectedRegions, region];
                  updateConfig('regions', newRegions);
                }}
              >
                {region}
              </Badge>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Resource Types *</Label>
          <div className="flex flex-wrap gap-4">
            {resourceTypes.map((type) => (
              <div key={type} className="flex items-center space-x-2">
                <Checkbox
                  id={type}
                  checked={selectedTypes.includes(type)}
                  onCheckedChange={(checked: boolean) => {
                    const newTypes = checked
                      ? [...selectedTypes, type]
                      : selectedTypes.filter((t: string) => t !== type);
                    updateConfig('resourceTypes', newTypes);
                  }}
                />
                <Label htmlFor={type} className="cursor-pointer">
                  {type.toUpperCase()}
                </Label>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="access-key">Access Key ID (optional)</Label>
          <Input
            id="access-key"
            placeholder="AKIAIOSFODNN7EXAMPLE"
            value={config.credentials?.accessKeyId || ''}
            onChange={(e) =>
              updateConfig('credentials', {
                ...config.credentials,
                accessKeyId: e.target.value,
              })
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="secret-key">Secret Access Key (optional)</Label>
          <Input
            id="secret-key"
            type="password"
            placeholder="••••••••"
            value={config.credentials?.secretAccessKey || ''}
            onChange={(e) =>
              updateConfig('credentials', {
                ...config.credentials,
                secretAccessKey: e.target.value,
              })
            }
          />
          <p className="text-sm text-muted-foreground">
            Leave empty to use environment variables or instance profile
          </p>
        </div>
      </div>
    );
  };

  const renderAzureForm = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="subscription-id">Subscription ID *</Label>
        <Input
          id="subscription-id"
          placeholder="12345678-1234-1234-1234-123456789012"
          value={config.subscriptionId || ''}
          onChange={(e) => updateConfig('subscriptionId', e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-groups">Resource Groups (comma-separated, optional)</Label>
        <Input
          id="resource-groups"
          placeholder="rg-production, rg-staging"
          value={config.resourceGroups?.join(', ') || ''}
          onChange={(e) =>
            updateConfig(
              'resourceGroups',
              e.target.value.split(',').map((r) => r.trim()).filter(Boolean)
            )
          }
        />
        <p className="text-sm text-muted-foreground">
          Leave empty to discover all resource groups
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="tenant-id">Tenant ID (optional)</Label>
        <Input
          id="tenant-id"
          placeholder="12345678-1234-1234-1234-123456789012"
          value={config.credentials?.tenantId || ''}
          onChange={(e) =>
            updateConfig('credentials', {
              ...config.credentials,
              tenantId: e.target.value,
            })
          }
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="client-id">Client ID (optional)</Label>
        <Input
          id="client-id"
          placeholder="12345678-1234-1234-1234-123456789012"
          value={config.credentials?.clientId || ''}
          onChange={(e) =>
            updateConfig('credentials', {
              ...config.credentials,
              clientId: e.target.value,
            })
          }
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="client-secret">Client Secret (optional)</Label>
        <Input
          id="client-secret"
          type="password"
          placeholder="••••••••"
          value={config.credentials?.clientSecret || ''}
          onChange={(e) =>
            updateConfig('credentials', {
              ...config.credentials,
              clientSecret: e.target.value,
            })
          }
        />
      </div>
    </div>
  );

  const renderGCPForm = () => {
    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const json = event.target?.result as string;
            // Validate it's valid JSON
            JSON.parse(json);
            updateConfig('credentials', {
              service_account_json: json,
            });
          } catch (error) {
            alert('Invalid JSON file. Please upload a valid service account key file.');
          }
        };
        reader.readAsText(file);
      }
    };

    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="project-id">Project ID *</Label>
          <Input
            id="project-id"
            placeholder="my-project-12345"
            value={config.projectId || ''}
            onChange={(e) => updateConfig('projectId', e.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="zones">Zones (comma-separated, optional)</Label>
          <Input
            id="zones"
            placeholder="us-central1-a, us-east1-b"
            value={config.zones?.join(', ') || ''}
            onChange={(e) =>
              updateConfig(
                'zones',
                e.target.value.split(',').map((z) => z.trim()).filter(Boolean)
              )
            }
          />
          <p className="text-sm text-muted-foreground">
            Leave empty to discover all zones
          </p>
        </div>

        <div className="space-y-2">
          <Label>Service Account Credentials (optional)</Label>
          <p className="text-sm text-muted-foreground mb-2">
            Upload a service account key file or paste the JSON directly
          </p>

          <div className="flex gap-2 mb-2">
            <Input
              type="file"
              accept=".json"
              onChange={handleFileUpload}
              className="flex-1"
            />
          </div>

          <Textarea
            id="service-account-json"
            placeholder='Paste service account JSON here or upload file above&#10;{&#10;  "type": "service_account",&#10;  "project_id": "...",&#10;  "private_key_id": "...",&#10;  ...&#10;}'
            value={config.credentials?.service_account_json || ''}
            onChange={(e) =>
              updateConfig('credentials', {
                service_account_json: e.target.value,
              })
            }
            rows={8}
            className="font-mono text-xs"
          />
          <p className="text-sm text-muted-foreground">
            Leave empty to use application default credentials
          </p>
        </div>
      </div>
    );
  };

  const renderSSHForm = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="targets">Target Hosts *</Label>
        <Textarea
          id="targets"
          placeholder="192.168.1.100:22&#10;server1.example.com:22&#10;10.0.0.50:2222"
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
          One host per line in format host:port
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="username">Username *</Label>
        <Input
          id="username"
          placeholder="ubuntu"
          value={config.credentials?.username || ''}
          onChange={(e) =>
            updateConfig('credentials', {
              ...config.credentials,
              username: e.target.value,
            })
          }
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password (optional)</Label>
        <Input
          id="password"
          type="password"
          placeholder="••••••••"
          value={config.credentials?.password || ''}
          onChange={(e) =>
            updateConfig('credentials', {
              ...config.credentials,
              password: e.target.value,
            })
          }
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="private-key">Private Key Path (optional)</Label>
        <Input
          id="private-key"
          placeholder="/path/to/private_key"
          value={config.credentials?.privateKey || ''}
          onChange={(e) =>
            updateConfig('credentials', {
              ...config.credentials,
              privateKey: e.target.value,
            })
          }
        />
        <p className="text-sm text-muted-foreground">
          Provide either password or private key for authentication
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
        <Label htmlFor="ports">Port Range (optional)</Label>
        <Input
          id="ports"
          placeholder="1-1000 or 22,80,443"
          value={config.scanOptions?.ports || ''}
          onChange={(e) =>
            updateConfig('scanOptions', {
              ...config.scanOptions,
              ports: e.target.value,
            })
          }
        />
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

  const renderActiveDirectoryForm = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="domain">Domain *</Label>
        <Input
          id="domain"
          placeholder="dc.example.com"
          value={config.domain || ''}
          onChange={(e) => updateConfig('domain', e.target.value)}
          required
        />
        <p className="text-sm text-muted-foreground">
          Active Directory domain controller hostname or IP
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="base-dn">Base DN *</Label>
        <Input
          id="base-dn"
          placeholder="DC=example,DC=com"
          value={config.base_dn || ''}
          onChange={(e) => updateConfig('base_dn', e.target.value)}
          required
        />
        <p className="text-sm text-muted-foreground">
          LDAP base distinguished name for search root
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="ad-username">Username *</Label>
        <Input
          id="ad-username"
          placeholder="administrator@example.com"
          value={config.credentials?.username || ''}
          onChange={(e) =>
            updateConfig('credentials', {
              ...config.credentials,
              username: e.target.value,
            })
          }
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="ad-password">Password *</Label>
        <Input
          id="ad-password"
          type="password"
          placeholder="••••••••"
          value={config.credentials?.password || ''}
          onChange={(e) =>
            updateConfig('credentials', {
              ...config.credentials,
              password: e.target.value,
            })
          }
          required
        />
      </div>

      <div className="space-y-2">
        <Label>Discovery Options</Label>
        <div className="space-y-3">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="use-ssl"
              checked={config.use_ssl || false}
              onCheckedChange={(checked: boolean) => updateConfig('use_ssl', checked)}
            />
            <Label htmlFor="use-ssl" className="cursor-pointer">
              Use SSL/TLS (LDAPS)
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="discover-computers"
              checked={config.computers?.enabled !== false}
              onCheckedChange={(checked: boolean) =>
                updateConfig('computers', {
                  ...config.computers,
                  enabled: checked,
                })
              }
            />
            <Label htmlFor="discover-computers" className="cursor-pointer">
              Discover Computers
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="discover-users"
              checked={config.users?.enabled !== false}
              onCheckedChange={(checked: boolean) =>
                updateConfig('users', {
                  ...config.users,
                  enabled: checked,
                })
              }
            />
            <Label htmlFor="discover-users" className="cursor-pointer">
              Discover Users
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="discover-groups"
              checked={config.groups?.enabled !== false}
              onCheckedChange={(checked: boolean) =>
                updateConfig('groups', {
                  ...config.groups,
                  enabled: checked,
                })
              }
            />
            <Label htmlFor="discover-groups" className="cursor-pointer">
              Discover Groups
            </Label>
          </div>
        </div>
      </div>
    </div>
  );

  const renderSNMPForm = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="snmp-targets">Target Devices *</Label>
        <Textarea
          id="snmp-targets"
          placeholder="192.168.1.1:161&#10;switch.example.com:161&#10;10.0.0.254:161"
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
          One device per line in format host:port (default port: 161)
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="snmp-version">SNMP Version *</Label>
        <Select
          value={config.version || 'v2c'}
          onValueChange={(value) => updateConfig('version', value)}
        >
          <SelectTrigger id="snmp-version">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="v1">SNMP v1</SelectItem>
            <SelectItem value="v2c">SNMP v2c (Recommended)</SelectItem>
            <SelectItem value="v3">SNMP v3 (Secure)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {(config.version === 'v1' || config.version === 'v2c' || !config.version) && (
        <div className="space-y-2">
          <Label htmlFor="community-string">Community String *</Label>
          <Input
            id="community-string"
            type="password"
            placeholder="public"
            value={config.credentials?.community || ''}
            onChange={(e) =>
              updateConfig('credentials', {
                ...config.credentials,
                community: e.target.value,
              })
            }
            required
          />
          <p className="text-sm text-muted-foreground">
            Default is usually "public" for read-only access
          </p>
        </div>
      )}

      {config.version === 'v3' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="snmp-username">Username *</Label>
            <Input
              id="snmp-username"
              placeholder="snmpuser"
              value={config.credentials?.username || ''}
              onChange={(e) =>
                updateConfig('credentials', {
                  ...config.credentials,
                  username: e.target.value,
                })
              }
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="auth-protocol">Authentication Protocol</Label>
            <Select
              value={config.credentials?.authProtocol || 'MD5'}
              onValueChange={(value) =>
                updateConfig('credentials', {
                  ...config.credentials,
                  authProtocol: value,
                })
              }
            >
              <SelectTrigger id="auth-protocol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MD5">MD5</SelectItem>
                <SelectItem value="SHA">SHA</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auth-password">Authentication Password</Label>
            <Input
              id="auth-password"
              type="password"
              placeholder="••••••••"
              value={config.credentials?.authPassword || ''}
              onChange={(e) =>
                updateConfig('credentials', {
                  ...config.credentials,
                  authPassword: e.target.value,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="priv-protocol">Privacy Protocol</Label>
            <Select
              value={config.credentials?.privProtocol || 'DES'}
              onValueChange={(value) =>
                updateConfig('credentials', {
                  ...config.credentials,
                  privProtocol: value,
                })
              }
            >
              <SelectTrigger id="priv-protocol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DES">DES</SelectItem>
                <SelectItem value="AES">AES</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="priv-password">Privacy Password</Label>
            <Input
              id="priv-password"
              type="password"
              placeholder="••••••••"
              value={config.credentials?.privPassword || ''}
              onChange={(e) =>
                updateConfig('credentials', {
                  ...config.credentials,
                  privPassword: e.target.value,
                })
              }
            />
          </div>
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor="timeout">Timeout (seconds)</Label>
        <Input
          id="timeout"
          type="number"
          placeholder="5"
          value={config.timeout || 5}
          onChange={(e) => updateConfig('timeout', parseInt(e.target.value))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="retries">Retries</Label>
        <Input
          id="retries"
          type="number"
          placeholder="3"
          value={config.retries || 3}
          onChange={(e) => updateConfig('retries', parseInt(e.target.value))}
        />
      </div>
    </div>
  );

  const renderDefaultForm = () => (
    <div className="space-y-4">
      <div className="p-4 border rounded-lg bg-muted/50">
        <p className="text-sm text-muted-foreground">
          Configuration for {provider.toUpperCase()} provider will be available soon.
          For now, you can use the API or configuration files to set up this discovery method.
        </p>
      </div>
    </div>
  );

  const renderForm = () => {
    switch (provider) {
      case 'nmap':
        return renderNmapForm();
      case 'ssh':
        return renderSSHForm();
      case 'active-directory':
        return renderActiveDirectoryForm();
      case 'snmp':
        return renderSNMPForm();
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
