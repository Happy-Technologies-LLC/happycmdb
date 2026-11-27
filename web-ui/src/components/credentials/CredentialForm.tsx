import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import {
  Button,
  IconButton,
  Input,
  Label,
  SectionHeading,
  Select,
  Tag,
  Textarea,
} from '@happy-technologies/design-system';
// Secret fields stay on the HAP-1213 components (the value never reaches the DOM tree) until the design system ships a secret field.
import { SecretInput, SecretTextarea } from '@/components/ui/secret-input';
import AffinityEditor from './AffinityEditor';
import type {
  UnifiedCredential,
  UnifiedCredentialInput,
  AuthProtocol,
  CredentialScope,
  CredentialAffinity,
} from '@/services/credential.service';
import { formatProtocol, formatScope } from '@/lib/credential-display';
import { logClientError } from '@/utils/logger';

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

const SNMP_AUTH_PROTOCOLS = ['MD5', 'SHA'].map((value) => ({ value, label: value }));
const SNMP_PRIVACY_PROTOCOLS = ['DES', 'AES'].map((value) => ({ value, label: value }));
const WINRM_TRANSPORTS = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
];
const PROTOCOL_OPTIONS = AUTH_PROTOCOLS.map((p) => ({ value: p, label: formatProtocol(p) }));
const SCOPE_OPTIONS = CREDENTIAL_SCOPES.map((s) => ({ value: s, label: formatScope(s) }));

/**
 * The design-system Select closes its listbox on Escape but only preventDefaults the key, and the design-system Dialog dismisses on any document Escape.
 * Stopping the key here while the listbox is open keeps Escape from also closing the dialog and discarding what was typed.
 */
const FormSelect: React.FC<React.ComponentProps<typeof Select>> = (props) => (
  <div
    onKeyDown={(e) => {
      if (e.key === 'Escape' && (e.target as HTMLElement).getAttribute('aria-expanded') === 'true') {
        e.stopPropagation();
      }
    }}
  >
    <Select {...props} />
  </div>
);

const Field: React.FC<{ id: string; label: string; required?: boolean; children: React.ReactNode }> = ({
  id,
  label,
  required = false,
  children,
}) => (
  <div className="space-y-2">
    <Label htmlFor={id} required={required}>
      {label}
    </Label>
    {children}
  </div>
);

/** HAP-1227: whether a new secret value was typed. Reads return only a placeholder, so an edit starts empty and sends credentials only if this holds. */
export const hasSecretEntry = (credentials: Record<string, unknown> = {}): boolean =>
  Object.values(credentials).some((v) => v !== '' && v !== undefined);

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
      // HAP-1227: reads return a redaction placeholder, never the secret, so an edit starts with an empty secret section.
      credentials: {},
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

  // HAP-444 K1: the API takes a port only as a JSON integer; an empty input omits it (the protocol default).
  const handlePortChange = (value: string) => {
    const next = { ...credentialsData };
    if (value === '') delete next.port; else next.port = Number(value);
    setValue('credentials', next);
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
        logClientError('Failed to parse JSON file', error);
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
    <Field id={id} label={label} required={required}>
      <div className="relative">
        <SecretInput
          id={id}
          type={showSecrets[id] ? 'text' : 'password'}
          value={credentialsData[id] || ''}
          onChange={(e) => handleCredentialFieldChange(id, e.target.value)}
          placeholder={placeholder}
          required={required}
        />
        <IconButton
          icon={showSecrets[id] ? 'eye-slash' : 'eye'}
          variant="ghost"
          size="sm"
          shape="rounded"
          aria-label="Reveal value"
          aria-pressed={!!showSecrets[id]}
          aria-controls={id}
          className="absolute top-1/2 right-1.5 -translate-y-1/2"
          onClick={() => toggleSecretVisibility(id)}
        />
      </div>
    </Field>
  );

  const renderTextField = (
    id: string,
    label: string,
    placeholder: string,
    { required = false, type = 'text' }: { required?: boolean; type?: 'text' | 'url' } = {}
  ) => (
    <Field id={id} label={label} required={required}>
      <Input
        id={id}
        size="sm"
        type={type}
        value={credentialsData[id] || ''}
        onChange={(e) => handleCredentialFieldChange(id, e.target.value)}
        placeholder={placeholder}
        required={required}
      />
    </Field>
  );

  const renderPortField = (defaultPort: number) => (
    <Field id="port" label="Port">
      <Input
        id="port"
        size="sm"
        type="number"
        value={credentialsData.port || defaultPort}
        onChange={(e) => handlePortChange(e.target.value)}
        placeholder={String(defaultPort)}
      />
    </Field>
  );

  const renderSelectField = (
    id: string,
    label: string,
    options: Array<{ value: string; label: string }>,
    fallback: string,
    required: boolean = false
  ) => (
    <Field id={id} label={label} required={required}>
      <FormSelect
        id={id}
        size="sm"
        value={credentialsData[id] || fallback}
        onChange={(value) => handleCredentialFieldChange(id, value)}
        options={options}
      />
    </Field>
  );

  const renderCertificateField = (
    id: string,
    label: string,
    placeholder: string,
    rows: number,
    required: boolean = false
  ) => (
    <Field id={id} label={label} required={required}>
      <Textarea
        id={id}
        size="sm"
        value={credentialsData[id] || ''}
        onChange={(e) => handleCredentialFieldChange(id, e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="hh-mono"
        required={required}
      />
    </Field>
  );

  const renderCredentialFields = () => {
    switch (protocol) {
      case 'aws_iam':
        return (
          <>
            {renderSecretField('access_key_id', 'Access Key ID', 'AKIA...', true)}
            {renderSecretField('secret_access_key', 'Secret Access Key', 'Enter secret', true)}
            {renderTextField('region', 'Default Region', 'us-east-1')}
            {renderSecretField('session_token', 'Session Token', 'Optional session token')}
          </>
        );

      case 'azure_sp':
        return (
          <>
            {renderTextField('client_id', 'Client ID', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', { required: true })}
            {renderSecretField('client_secret', 'Client Secret', 'Enter client secret', true)}
            {renderTextField('tenant_id', 'Tenant ID', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', { required: true })}
            {renderTextField('subscription_id', 'Subscription ID', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}
          </>
        );

      case 'gcp_sa':
        return (
          <>
            <Field id="service_account_json" label="Service Account JSON" required>
              <div className="mb-2">
                <Input
                  id="file_upload"
                  size="sm"
                  type="file"
                  accept=".json"
                  aria-label="Upload key file"
                  onChange={handleFileUpload}
                />
              </div>
              <SecretTextarea
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
            </Field>
          </>
        );

      case 'ssh_key':
        return (
          <>
            {renderTextField('username', 'Username', 'root', { required: true })}
            <Field id="private_key" label="Private Key" required>
              <SecretTextarea
                id="private_key"
                value={credentialsData.private_key || ''}
                onChange={(e) => handleCredentialFieldChange('private_key', e.target.value)}
                placeholder="-----BEGIN RSA PRIVATE KEY-----"
                rows={6}
                className="font-mono text-xs"
                required
              />
            </Field>
            {renderSecretField('passphrase', 'Passphrase', 'Enter passphrase (if encrypted)')}
            {renderPortField(22)}
          </>
        );

      case 'ssh_password':
        return (
          <>
            {renderTextField('username', 'Username', 'root', { required: true })}
            {renderSecretField('password', 'Password', 'Enter password', true)}
            {renderPortField(22)}
          </>
        );

      case 'api_key':
        return (
          <>
            {renderSecretField('key', 'API Key', 'Enter API key', true)}
            {renderTextField('header_name', 'Header Name', 'X-API-Key')}
          </>
        );

      case 'bearer':
        return <>{renderSecretField('token', 'Bearer Token', 'Enter bearer token', true)}</>;

      case 'basic':
        return (
          <>
            {renderTextField('username', 'Username', 'Enter username', { required: true })}
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
            {renderTextField('username', 'Username', 'Enter SNMP username', { required: true })}
            {renderSelectField('auth_protocol', 'Auth Protocol', SNMP_AUTH_PROTOCOLS, 'SHA', true)}
            {renderSecretField('auth_password', 'Auth Password', 'Enter auth password', true)}
            {renderSelectField('priv_protocol', 'Privacy Protocol', SNMP_PRIVACY_PROTOCOLS, 'AES', true)}
            {renderSecretField('priv_password', 'Privacy Password', 'Enter privacy password', true)}
          </>
        );

      case 'oauth2':
        return (
          <>
            {renderTextField('client_id', 'Client ID', 'Enter client ID', { required: true })}
            {renderSecretField('client_secret', 'Client Secret', 'Enter client secret', true)}
            {renderTextField('token_url', 'Token URL', 'https://oauth.example.com/token', {
              required: true,
              type: 'url',
            })}
            {renderTextField('scopes', 'Scopes', 'read write (space-separated)')}
          </>
        );

      case 'certificate':
        return (
          <>
            {renderCertificateField('certificate', 'Certificate', '-----BEGIN CERTIFICATE-----', 6, true)}
            <Field id="private_key" label="Private Key" required>
              <SecretTextarea
                id="private_key"
                value={credentialsData.private_key || ''}
                onChange={(e) => handleCredentialFieldChange('private_key', e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----"
                rows={6}
                className="font-mono text-xs"
                required
              />
            </Field>
            {renderSecretField('passphrase', 'Passphrase', 'Enter passphrase (if encrypted)')}
            {renderCertificateField('ca_certificate', 'CA Certificate', '-----BEGIN CERTIFICATE-----', 4)}
          </>
        );

      case 'kerberos':
        return (
          <>
            {renderTextField('principal', 'Principal', 'user@REALM.COM', { required: true })}
            {renderTextField('realm', 'Realm', 'REALM.COM', { required: true })}
            <Field id="keytab" label="Keytab">
              <SecretTextarea
                id="keytab"
                value={credentialsData.keytab || ''}
                onChange={(e) => handleCredentialFieldChange('keytab', e.target.value)}
                placeholder="Keytab content (base64)"
                rows={4}
                className="font-mono text-xs"
              />
            </Field>
            {renderSecretField('password', 'Password', 'Enter password (if not using keytab)')}
          </>
        );

      case 'winrm':
        return (
          <>
            {renderTextField('username', 'Username', 'Administrator', { required: true })}
            {renderSecretField('password', 'Password', 'Enter password', true)}
            {renderPortField(5985)}
            {renderSelectField('transport', 'Transport', WINRM_TRANSPORTS, 'http')}
          </>
        );

      default:
        return null;
    }
  };

  return (
    // HAP-1227: a metadata-only edit skips the native required-secret gate; once a secret is typed, the full set is required.
    <form onSubmit={onFormSubmit} noValidate={!!credential && !hasSecretEntry(credentialsData)} className="space-y-6">
      {/* Basic Information */}
      <div className="space-y-4">
        <Field id="name" label="Name" required>
          <Controller
            name="name"
            control={control}
            rules={{ required: 'Name is required' }}
            render={({ field }) => (
              <Input
                {...field}
                id="name"
                size="sm"
                placeholder="Production AWS Credentials"
                error={errors.name?.message}
              />
            )}
          />
        </Field>

        <Field id="description" label="Description">
          <Controller
            name="description"
            control={control}
            render={({ field }) => (
              <Textarea
                {...field}
                id="description"
                size="sm"
                placeholder="Optional description of credential usage"
                rows={2}
              />
            )}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field id="protocol" label="Protocol" required>
            <Controller
              name="protocol"
              control={control}
              rules={{ required: 'Protocol is required' }}
              render={({ field }) => (
                <FormSelect
                  id="protocol"
                  size="sm"
                  value={field.value}
                  onChange={field.onChange}
                  options={PROTOCOL_OPTIONS}
                  disabled={!!credential}
                />
              )}
            />
          </Field>

          <Field id="scope" label="Scope" required>
            <Controller
              name="scope"
              control={control}
              rules={{ required: 'Scope is required' }}
              render={({ field }) => (
                <FormSelect
                  id="scope"
                  size="sm"
                  value={field.value}
                  onChange={field.onChange}
                  options={SCOPE_OPTIONS}
                />
              )}
            />
          </Field>
        </div>
      </div>

      {/* Credential-specific fields */}
      <div className="border-t border-[var(--hh-hairline)] pt-4">
        <SectionHeading level={3}>Credentials</SectionHeading>
        <div className="space-y-4">{renderCredentialFields()}</div>
      </div>

      {/* Affinity Editor */}
      <div className="border-t border-[var(--hh-hairline)] pt-4">
        <AffinityEditor affinity={affinity} onChange={handleAffinityChange} />
      </div>

      {/* Tags */}
      <Field id="tags" label="Tags">
        <Input
          id="tags"
          size="sm"
          type="text"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={handleAddTag}
          placeholder="Type a tag and press Enter"
        />
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Tag key={tag} onRemove={() => handleDeleteTag(tag)}>
                {tag}
              </Tag>
            ))}
          </div>
        )}
      </Field>

      {/* Action Buttons */}
      <div className="flex justify-end gap-2 border-t border-[var(--hh-hairline)] pt-4">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" icon="floppy-disk" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : 'Save Credential'}
        </Button>
      </div>
    </form>
  );
};

export default CredentialForm;
