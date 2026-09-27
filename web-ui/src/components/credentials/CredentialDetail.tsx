import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
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

export const CredentialDetail: React.FC<CredentialDetailProps> = ({
  credential,
  usageCount = 0,
  onEdit,
  onDelete,
  onTest,
}) => {
  const [showSecrets, setShowSecrets] = React.useState(false);


  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleString();
  };

  const renderCredentialFields = () => {
    const { credentials } = credential;
    const displayValue = (value: string) => (showSecrets ? value : MASKED_VALUE);

    switch (credential.protocol) {
      case 'aws_iam':
        return (
          <>
            <div>
              <p className="text-sm text-muted-foreground">Access Key ID</p>
              <p className="font-mono text-sm">{displayValue(credentials.access_key_id)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Secret Access Key</p>
              <p className="font-mono text-sm">{MASKED_VALUE}</p>
            </div>
            {credentials.region && (
              <div>
                <p className="text-sm text-muted-foreground">Default Region</p>
                <p className="font-mono text-sm">{credentials.region}</p>
              </div>
            )}
          </>
        );

      case 'azure_sp':
        return (
          <>
            <div>
              <p className="text-sm text-muted-foreground">Subscription ID</p>
              <p className="font-mono text-sm">{credentials.subscription_id}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Client ID</p>
              <p className="font-mono text-sm">{credentials.client_id}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Client Secret</p>
              <p className="font-mono text-sm">{MASKED_VALUE}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tenant ID</p>
              <p className="font-mono text-sm">{credentials.tenant_id}</p>
            </div>
          </>
        );

      case 'gcp_sa':
        return (
          <>
            <div>
              <p className="text-sm text-muted-foreground">Project ID</p>
              <p className="font-mono text-sm">{credentials.project_id}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Service Account JSON</p>
              <p className="font-mono text-sm">{MASKED_VALUE} (encrypted)</p>
            </div>
          </>
        );

      case 'ssh_key':
      case 'ssh_password':
        return (
          <>
            <div>
              <p className="text-sm text-muted-foreground">Username</p>
              <p className="font-mono text-sm">{credentials.username}</p>
            </div>
            {credentials.password && (
              <div>
                <p className="text-sm text-muted-foreground">Password</p>
                <p className="font-mono text-sm">{MASKED_VALUE}</p>
              </div>
            )}
            {credentials.private_key && (
              <div>
                <p className="text-sm text-muted-foreground">Private Key</p>
                <p className="font-mono text-sm">{MASKED_VALUE} (encrypted)</p>
              </div>
            )}
            {credentials.passphrase && (
              <div>
                <p className="text-sm text-muted-foreground">Passphrase</p>
                <p className="font-mono text-sm">{MASKED_VALUE}</p>
              </div>
            )}
          </>
        );

      case 'api_key':
        return (
          <>
            <div>
              <p className="text-sm text-muted-foreground">API Key</p>
              <p className="font-mono text-sm">{displayValue(credentials.api_key)}</p>
            </div>
            {credentials.api_secret && (
              <div>
                <p className="text-sm text-muted-foreground">API Secret</p>
                <p className="font-mono text-sm">{MASKED_VALUE}</p>
              </div>
            )}
          </>
        );

      case 'snmp_v2c':
      case 'snmp_v3':
        return (
          <>
            <div>
              <p className="text-sm text-muted-foreground">Community String</p>
              <p className="font-mono text-sm">{MASKED_VALUE}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">SNMP Version</p>
              <p className="font-mono text-sm">{credentials.version}</p>
            </div>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <Card className="p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex-1">
          <h2 className="text-2xl font-semibold mb-1">{credential.name}</h2>
          {credential.description && (
            <p className="text-muted-foreground">{credential.description}</p>
          )}
        </div>
        <div className="flex gap-2">
          {onTest && (
            <Button variant="outline" size="sm" onClick={onTest}>
              <Icon name="test-tube" size={16} className="mr-2" />
              Test
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Icon name="pencil-simple" size={16} className="mr-2" />
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete}>
            <Icon name="trash" size={16} className="mr-2" />
            Delete
          </Button>
        </div>
      </div>

      <Separator className="mb-6" />

      {/* Basic Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div>
          <p className="text-sm text-muted-foreground mb-1">Protocol</p>
          <Badge variant="secondary" className="text-sm">
            {formatProtocol(credential.protocol)}
          </Badge>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-1">Usage</p>
          <p className="text-sm">
            Used by <span className="font-semibold">{usageCount}</span> discovery definition
            {usageCount !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <Separator className="mb-6" />

      {/* Credential Details */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium">Credential Details</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSecrets(!showSecrets)}
          >
            {showSecrets ? (
              <>
                <Icon name="eye-slash" size={16} className="mr-2" />
                Hide Partial Values
              </>
            ) : (
              <>
                <Icon name="eye" size={16} className="mr-2" />
                Show Partial Values
              </>
            )}
          </Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
          {renderCredentialFields()}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          All sensitive values are encrypted and stored securely. Full values are never displayed in
          the UI.
        </p>
      </div>

      <Separator className="mb-6" />

      {/* Tags */}
      {credential.tags && credential.tags.length > 0 && (
        <>
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="tag" size={16} className="text-muted-foreground" />
              <h3 className="text-sm font-medium">Tags</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {credential.tags.map((tag: string) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
          <Separator className="mb-6" />
        </>
      )}

      {/* Metadata */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon name="user" size={16} />
          <span>
            Created by: <span className="font-medium">{credential.created_by}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon name="calendar" size={16} />
          <span>
            Created: <span className="font-medium">{formatDate(credential.created_at)}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground col-span-1 md:col-span-2">
          <Icon name="calendar" size={16} />
          <span>
            Last updated: <span className="font-medium">{formatDate(credential.updated_at)}</span>
          </span>
        </div>
      </div>
    </Card>
  );
};

export default CredentialDetail;
