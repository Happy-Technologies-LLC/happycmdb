import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Icon } from '@happy-technologies/design-system';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import AffinityEditor from './AffinityEditor';
import type {
  UnifiedCredential,
  UnifiedCredentialInput,
  AuthProtocol,
  CredentialScope,
  CredentialAffinity,
} from '@/services/credential.service';
import { formatProtocol, formatScope } from '@/lib/credential-display';

interface CredentialFormProps {
  credential?: UnifiedCredential;
  onSubmit: (data: UnifiedCredentialInput) => void | Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

const AUTH_PROTOCOLS: AuthProtocol[] = [
  'oauth2',
  'api_key',
  'basic',
  'bearer',
  'aws_iam',
  'azure_sp',
  'gcp_sa',
  'ssh_key',
  'ssh_password',
  'certificate',
  'kerberos',
  'snmp_v2c',
  'snmp_v3',
  'winrm',
];

const CREDENTIAL_SCOPES: CredentialScope[] = [
  'cloud_provider',
  'ssh',
  'api',
  'network',
  'database',
  'container',
  'universal',
];

export const CredentialForm: React.FC<CredentialFormProps> = ({
  credential,
  onSubmit,
  onCancel,
  isSubmitting = false,
}) => {
  const {
    control,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
  } = useForm<UnifiedCredentialInput>({
    defaultValues: {
      name: credential?.name || '',
      description: credential?.description || '',
      protocol: credential?.protocol || 'aws_iam',
      scope: credential?.scope || 'universal',
      credentials: credential?.credentials || {},
      affinity: credential?.affinity || { priority: 5 },
      tags: credential?.tags || [],
    },
  });

  const [tagInput, setTagInput] = useState('');
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  const protocol = watch('protocol');
  const scope = watch('scope');
  const tags = watch('tags') || [];
  const credentialsData = watch('credentials') || {};
  const affinity = watch('affinity') || { priority: 5 };

  const handleAddTag = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      if (!tags.includes(tagInput.trim())) {
        setValue('tags', [...tags, tagInput.trim()]);
      }
      setTagInput('');
    }
  };

  const handleDeleteTag = (tagToDelete: string) => {
    setValue(
      'tags',
      tags.filter((tag) => tag !== tagToDelete)
    );
  };

  const toggleSecretVisibility = (field: string) => {
    setShowSecrets((prev) => ({
      ...prev,
      [field]: !prev[field],
    }));
  };

  const handleCredentialFieldChange = (field: string, value: string) => {
    setValue('credentials', {
      ...credentialsData,
      [field]: value,
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const text = await file.text();
      try {
        const json = JSON.parse(text);
        setValue('credentials', {
          ...credentialsData,
          ...json,
        });
      } catch (error) {
        console.error('Failed to parse JSON file:', error);
      }
    }
  };

  const handleAffinityChange = (newAffinity: CredentialAffinity) => {
    setValue('affinity', newAffinity);
  };

  const onFormSubmit = handleSubmit(async (data) => {
    await onSubmit(data);
  });

  const renderSecretField = (
    id: string,
    label: string,
    placeholder: string,
    required: boolean = false
  ) => (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={showSecrets[id] ? 'text' : 'password'}
          value={credentialsData[id] || ''}
          onChange={(e) => handleCredentialFieldChange(id, e.target.value)}
          placeholder={placeholder}
          required={required}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0 h-full"
          onClick={() => toggleSecretVisibility(id)}
        >
          {showSecrets[id] ? <Icon name="eye-slash" size={16} /> : <Icon name="eye" size={16} />}
        </Button>
      </div>
    </div>
  );

  const renderCredentialFields = () => {
    switch (protocol) {
      case 'aws_iam':
        return (
          <>
            {renderSecretField('access_key_id', 'Access Key ID', 'AKIA...', true)}
            {renderSecretField('secret_access_key', 'Secret Access Key', 'Enter secret', true)}
            <div className="space-y-2">
              <Label htmlFor="region">Default Region</Label>
              <Input
                id="region"
                type="text"
                value={credentialsData.region || ''}
                onChange={(e) => handleCredentialFieldChange('region', e.target.value)}
                placeholder="us-east-1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="session_token">Session Token</Label>
              <Input
                id="session_token"
                type="text"
                value={credentialsData.session_token || ''}
                onChange={(e) => handleCredentialFieldChange('session_token', e.target.value)}
                placeholder="Optional session token"
              />
            </div>
          </>
        );

      case 'azure_sp':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="client_id">
                Client ID <span className="text-destructive">*</span>
              </Label>
              <Input
                id="client_id"
                type="text"
                value={credentialsData.client_id || ''}
                onChange={(e) => handleCredentialFieldChange('client_id', e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                required
              />
            </div>
            {renderSecretField('client_secret', 'Client Secret', 'Enter client secret', true)}
            <div className="space-y-2">
              <Label htmlFor="tenant_id">
                Tenant ID <span className="text-destructive">*</span>
              </Label>
              <Input
                id="tenant_id"
                type="text"
                value={credentialsData.tenant_id || ''}
                onChange={(e) => handleCredentialFieldChange('tenant_id', e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subscription_id">Subscription ID</Label>
              <Input
                id="subscription_id"
                type="text"
                value={credentialsData.subscription_id || ''}
                onChange={(e) => handleCredentialFieldChange('subscription_id', e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            </div>
          </>
        );

      case 'gcp_sa':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="service_account_json">
                Service Account JSON <span className="text-destructive">*</span>
              </Label>
              <div className="flex gap-2 mb-2">
                <Input
                  id="file_upload"
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  className="flex-1"
                />
                <Button type="button" variant="outline" size="icon">
                  <Icon name="upload-simple" size={16} />
                </Button>
              </div>
              <Textarea
                id="service_account_json"
                value={JSON.stringify(credentialsData, null, 2) || ''}
                onChange={(e) => {
                  try {
                    const json = JSON.parse(e.target.value);
                    setValue('credentials', json);
                  } catch {
                    // Invalid JSON, ignore
                  }
                }}
                placeholder='{"type": "service_account", "project_id": "...", ...}'
                rows={8}
                className="font-mono text-xs"
                required
              />
            </div>
          </>
        );

      case 'ssh_key':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="username">
                Username <span className="text-destructive">*</span>
              </Label>
              <Input
                id="username"
                type="text"
                value={credentialsData.username || ''}
                onChange={(e) => handleCredentialFieldChange('username', e.target.value)}
                placeholder="root"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="private_key">
                Private Key <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="private_key"
                value={credentialsData.private_key || ''}
                onChange={(e) => handleCredentialFieldChange('private_key', e.target.value)}
                placeholder="-----BEGIN RSA PRIVATE KEY-----"
                rows={6}
                className="font-mono text-xs"
                required
              />
            </div>
            {renderSecretField('passphrase', 'Passphrase', 'Enter passphrase (if encrypted)')}
            <div className="space-y-2">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                value={credentialsData.port || 22}
                onChange={(e) => handleCredentialFieldChange('port', e.target.value)}
                placeholder="22"
              />
            </div>
          </>
        );

      case 'ssh_password':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="username">
                Username <span className="text-destructive">*</span>
              </Label>
              <Input
                id="username"
                type="text"
                value={credentialsData.username || ''}
                onChange={(e) => handleCredentialFieldChange('username', e.target.value)}
                placeholder="root"
                required
              />
            </div>
            {renderSecretField('password', 'Password', 'Enter password', true)}
            <div className="space-y-2">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                value={credentialsData.port || 22}
                onChange={(e) => handleCredentialFieldChange('port', e.target.value)}
                placeholder="22"
              />
            </div>
          </>
        );

      case 'api_key':
        return (
          <>
            {renderSecretField('key', 'API Key', 'Enter API key', true)}
            <div className="space-y-2">
              <Label htmlFor="header_name">Header Name</Label>
              <Input
                id="header_name"
                type="text"
                value={credentialsData.header_name || ''}
                onChange={(e) => handleCredentialFieldChange('header_name', e.target.value)}
                placeholder="X-API-Key"
              />
            </div>
          </>
        );

      case 'bearer':
        return <>{renderSecretField('token', 'Bearer Token', 'Enter bearer token', true)}</>;

      case 'basic':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="username">
                Username <span className="text-destructive">*</span>
              </Label>
              <Input
                id="username"
                type="text"
                value={credentialsData.username || ''}
                onChange={(e) => handleCredentialFieldChange('username', e.target.value)}
                placeholder="Enter username"
                required
              />
            </div>
            {renderSecretField('password', 'Password', 'Enter password', true)}
          </>
        );

      case 'snmp_v2c':
        return (
          <>
            {renderSecretField(
              'community_string',
              'Community String',
              'public or private',
              true
            )}
          </>
        );

      case 'snmp_v3':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="username">
                Username <span className="text-destructive">*</span>
              </Label>
              <Input
                id="username"
                type="text"
                value={credentialsData.username || ''}
                onChange={(e) => handleCredentialFieldChange('username', e.target.value)}
                placeholder="Enter SNMP username"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="auth_protocol">
                Auth Protocol <span className="text-destructive">*</span>
              </Label>
              <Select
                value={credentialsData.auth_protocol || 'SHA'}
                onValueChange={(value) => handleCredentialFieldChange('auth_protocol', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select auth protocol" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MD5">MD5</SelectItem>
                  <SelectItem value="SHA">SHA</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {renderSecretField('auth_password', 'Auth Password', 'Enter auth password', true)}
            <div className="space-y-2">
              <Label htmlFor="priv_protocol">
                Privacy Protocol <span className="text-destructive">*</span>
              </Label>
              <Select
                value={credentialsData.priv_protocol || 'AES'}
                onValueChange={(value) => handleCredentialFieldChange('priv_protocol', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select privacy protocol" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DES">DES</SelectItem>
                  <SelectItem value="AES">AES</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {renderSecretField('priv_password', 'Privacy Password', 'Enter privacy password', true)}
          </>
        );

      case 'oauth2':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="client_id">
                Client ID <span className="text-destructive">*</span>
              </Label>
              <Input
                id="client_id"
                type="text"
                value={credentialsData.client_id || ''}
                onChange={(e) => handleCredentialFieldChange('client_id', e.target.value)}
                placeholder="Enter client ID"
                required
              />
            </div>
            {renderSecretField('client_secret', 'Client Secret', 'Enter client secret', true)}
            <div className="space-y-2">
              <Label htmlFor="token_url">
                Token URL <span className="text-destructive">*</span>
              </Label>
              <Input
                id="token_url"
                type="url"
                value={credentialsData.token_url || ''}
                onChange={(e) => handleCredentialFieldChange('token_url', e.target.value)}
                placeholder="https://oauth.example.com/token"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scopes">Scopes</Label>
              <Input
                id="scopes"
                type="text"
                value={credentialsData.scopes || ''}
                onChange={(e) => handleCredentialFieldChange('scopes', e.target.value)}
                placeholder="read write (space-separated)"
              />
            </div>
          </>
        );

      case 'certificate':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="certificate">
                Certificate <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="certificate"
                value={credentialsData.certificate || ''}
                onChange={(e) => handleCredentialFieldChange('certificate', e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----"
                rows={6}
                className="font-mono text-xs"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="private_key">
                Private Key <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="private_key"
                value={credentialsData.private_key || ''}
                onChange={(e) => handleCredentialFieldChange('private_key', e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----"
                rows={6}
                className="font-mono text-xs"
                required
              />
            </div>
            {renderSecretField('passphrase', 'Passphrase', 'Enter passphrase (if encrypted)')}
            <div className="space-y-2">
              <Label htmlFor="ca_certificate">CA Certificate</Label>
              <Textarea
                id="ca_certificate"
                value={credentialsData.ca_certificate || ''}
                onChange={(e) => handleCredentialFieldChange('ca_certificate', e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----"
                rows={4}
                className="font-mono text-xs"
              />
            </div>
          </>
        );

      case 'kerberos':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="principal">
                Principal <span className="text-destructive">*</span>
              </Label>
              <Input
                id="principal"
                type="text"
                value={credentialsData.principal || ''}
                onChange={(e) => handleCredentialFieldChange('principal', e.target.value)}
                placeholder="user@REALM.COM"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="realm">
                Realm <span className="text-destructive">*</span>
              </Label>
              <Input
                id="realm"
                type="text"
                value={credentialsData.realm || ''}
                onChange={(e) => handleCredentialFieldChange('realm', e.target.value)}
                placeholder="REALM.COM"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="keytab">Keytab</Label>
              <Textarea
                id="keytab"
                value={credentialsData.keytab || ''}
                onChange={(e) => handleCredentialFieldChange('keytab', e.target.value)}
                placeholder="Keytab content (base64)"
                rows={4}
                className="font-mono text-xs"
              />
            </div>
            {renderSecretField('password', 'Password', 'Enter password (if not using keytab)')}
          </>
        );

      case 'winrm':
        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="username">
                Username <span className="text-destructive">*</span>
              </Label>
              <Input
                id="username"
                type="text"
                value={credentialsData.username || ''}
                onChange={(e) => handleCredentialFieldChange('username', e.target.value)}
                placeholder="Administrator"
                required
              />
            </div>
            {renderSecretField('password', 'Password', 'Enter password', true)}
            <div className="space-y-2">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                value={credentialsData.port || 5985}
                onChange={(e) => handleCredentialFieldChange('port', e.target.value)}
                placeholder="5985"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="transport">Transport</Label>
              <Select
                value={credentialsData.transport || 'http'}
                onValueChange={(value) => handleCredentialFieldChange('transport', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select transport" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="https">HTTPS</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <Card className="p-6">
      <form onSubmit={onFormSubmit} className="space-y-6">
        {/* Basic Information */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Controller
              name="name"
              control={control}
              rules={{ required: 'Name is required' }}
              render={({ field }) => (
                <Input
                  {...field}
                  id="name"
                  placeholder="Production AWS Credentials"
                  className={errors.name ? 'border-destructive' : ''}
                />
              )}
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Controller
              name="description"
              control={control}
              render={({ field }) => (
                <Textarea
                  {...field}
                  id="description"
                  placeholder="Optional description of credential usage"
                  rows={2}
                />
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="protocol">
                Protocol <span className="text-destructive">*</span>
              </Label>
              <Controller
                name="protocol"
                control={control}
                rules={{ required: 'Protocol is required' }}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={!!credential}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select protocol" />
                    </SelectTrigger>
                    <SelectContent>
                      {AUTH_PROTOCOLS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {formatProtocol(p)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="scope">
                Scope <span className="text-destructive">*</span>
              </Label>
              <Controller
                name="scope"
                control={control}
                rules={{ required: 'Scope is required' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select scope" />
                    </SelectTrigger>
                    <SelectContent>
                      {CREDENTIAL_SCOPES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {formatScope(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
        </div>

        {/* Credential-specific fields */}
        <div className="border-t pt-4">
          <h3 className="text-lg font-medium mb-4">Credentials</h3>
          <div className="space-y-4">{renderCredentialFields()}</div>
        </div>

        {/* Affinity Editor */}
        <div className="border-t pt-4">
          <AffinityEditor affinity={affinity} onChange={handleAffinityChange} />
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <Label htmlFor="tags">Tags</Label>
          <Input
            id="tags"
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleAddTag}
            placeholder="Type a tag and press Enter"
          />
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-sm"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => handleDeleteTag(tag)}
                    className="hover:text-destructive"
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            <Icon name="floppy-disk" size={16} className="mr-2" />
            {isSubmitting ? 'Saving...' : 'Save Credential'}
          </Button>
        </div>
      </form>
    </Card>
  );
};

export default CredentialForm;
