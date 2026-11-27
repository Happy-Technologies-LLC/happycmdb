import React from 'react';
import { Badge, Button, FieldList, SectionHeading, Separator, Tag } from '@happy-technologies/design-system';
import { RequirePermission } from '@/components/common/RequirePermission';
import type { UnifiedCredential } from '@/services/credential.service';
import { formatProtocol } from '@/lib/credential-display';

interface CredentialDetailProps {
  credential: UnifiedCredential;
  usageCount?: number;
  onEdit: () => void;
  onDelete: () => void;
  onTest?: () => void;
}

const MASKED_VALUE = '••••••••••••';

type Fields = Array<[label: string, value: React.ReactNode]>;

/** A stored value in the mono face; an absent one stays absent (FieldList skips it) rather than rendering a blank or a made-up default. */
const mono = (value: React.ReactNode) =>
  value === undefined || value === null || value === '' ? null : <span className="hh-mono">{value}</span>;

export const CredentialDetail: React.FC<CredentialDetailProps> = ({
  credential,
  usageCount,
  onEdit,
  onDelete,
  onTest,
}) => {
  const [showSecrets, setShowSecrets] = React.useState(false);

  const formatDate = (date?: string | Date) => {
    const dateObj = date ? new Date(date) : null;
    return dateObj && !Number.isNaN(dateObj.getTime()) ? dateObj.toLocaleString() : null;
  };

  const credentialFields = (): Fields => {
    const { credentials } = credential;
    const displayValue = (value: string) => (showSecrets ? value : MASKED_VALUE);

    switch (credential.protocol) {
      case 'aws_iam':
        return [
          ['Access Key ID', mono(displayValue(credentials.access_key_id))],
          ['Secret Access Key', mono(MASKED_VALUE)],
          ['Default Region', mono(credentials.region)],
        ];

      case 'azure_sp':
        return [
          ['Subscription ID', mono(credentials.subscription_id)],
          ['Client ID', mono(credentials.client_id)],
          ['Client Secret', mono(MASKED_VALUE)],
          ['Tenant ID', mono(credentials.tenant_id)],
        ];

      case 'gcp_sa':
        return [
          ['Project ID', mono(credentials.project_id)],
          ['Service Account JSON', mono(`${MASKED_VALUE} (encrypted)`)],
        ];

      case 'ssh_key':
      case 'ssh_password':
        return [
          ['Username', mono(credentials.username)],
          ['Password', credentials.password ? mono(MASKED_VALUE) : null],
          ['Private Key', credentials.private_key ? mono(`${MASKED_VALUE} (encrypted)`) : null],
          ['Passphrase', credentials.passphrase ? mono(MASKED_VALUE) : null],
        ];

      case 'api_key':
        return [
          ['API Key', mono(displayValue(credentials.api_key))],
          ['API Secret', credentials.api_secret ? mono(MASKED_VALUE) : null],
        ];

      case 'snmp_v2c':
      case 'snmp_v3':
        return [
          ['Community String', mono(MASKED_VALUE)],
          ['SNMP Version', mono(credentials.version)],
        ];

      default:
        return [];
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <SectionHeading level={3} className="mb-1">
            {credential.name}
          </SectionHeading>
          {credential.description && (
            <p className="text-[var(--hh-text-muted)]">{credential.description}</p>
          )}
        </div>
        <RequirePermission permission="write">
          <div className="flex gap-2">
            {onTest && (
              <Button variant="secondary" icon="test-tube" onClick={onTest}>
                Test
              </Button>
            )}
            <Button variant="secondary" icon="pencil-simple" onClick={onEdit}>
              Edit
            </Button>
            <Button variant="danger" icon="trash" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </RequirePermission>
      </div>

      <Separator />

      {/* Basic Info */}
      <FieldList
        className="md:grid-cols-2 lg:grid-cols-2"
        fields={[
          ['Protocol', <Badge variant="info">{formatProtocol(credential.protocol)}</Badge>],
          [
            'Usage',
            typeof usageCount === 'number'
              ? `Used by ${usageCount} discovery definition${usageCount !== 1 ? 's' : ''}`
              : '-',
          ],
        ]}
      />

      <Separator />

      {/* Credential Details */}
      <div>
        <SectionHeading
          level={3}
          right={
            <Button
              variant="ghost"
              icon={showSecrets ? 'eye-slash' : 'eye'}
              onClick={() => setShowSecrets(!showSecrets)}
            >
              {showSecrets ? 'Hide Partial Values' : 'Show Partial Values'}
            </Button>
          }
        >
          Credential Details
        </SectionHeading>
        <FieldList
          className="rounded-[var(--hh-radius-lg)] bg-[var(--hh-bg-elevated)] p-4 lg:grid-cols-2"
          fields={credentialFields()}
        />
        <p className="mt-2 text-xs text-[var(--hh-text-muted)]">
          All sensitive values are encrypted and stored securely. Full values are never displayed in
          the UI.
        </p>
      </div>

      <Separator />

      {/* Tags */}
      {credential.tags && credential.tags.length > 0 && (
        <>
          <div>
            <SectionHeading level={4} className="mb-2">
              Tags
            </SectionHeading>
            <div className="flex flex-wrap gap-2">
              {credential.tags.map((tag: string) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </div>
          </div>
          <Separator />
        </>
      )}

      {/* Metadata */}
      <FieldList
        className="md:grid-cols-2 lg:grid-cols-2"
        fields={[
          ['Created by', credential.created_by],
          ['Created', formatDate(credential.created_at)],
          ['Last updated', formatDate(credential.updated_at)],
        ]}
      />
    </div>
  );
};

export default CredentialDetail;
