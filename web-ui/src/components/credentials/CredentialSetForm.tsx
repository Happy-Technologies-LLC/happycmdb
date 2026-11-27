import React, { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FieldHint,
  IconButton,
  Input,
  Label,
  ListRow,
  Select,
  SectionHeading,
  Switch,
  Tag,
  Textarea,
} from '@happy-technologies/design-system';
import {
  credentialService,
  type CredentialSetSummary,
  type CredentialSetInput,
  type CredentialSetUpdateInput,
  type CredentialSetStrategy,
  type UnifiedCredentialSummary,
} from '@/services/credential.service';
import { QueryState } from '@/components/estate/SurfaceState';
import { logClientError } from '@/utils/logger';

interface CredentialSetFormProps {
  set?: CredentialSetSummary;
  onSubmit: (data: CredentialSetInput | CredentialSetUpdateInput) => void | Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

const STRATEGIES: CredentialSetStrategy[] = ['sequential', 'parallel', 'adaptive'];

const STRATEGY_HINTS: Record<CredentialSetStrategy, string> = {
  sequential: 'Try credentials one at a time in order',
  parallel: 'Try all credentials simultaneously',
  adaptive: 'Learn from past successes and adapt order',
};

export const CredentialSetForm: React.FC<CredentialSetFormProps> = ({
  set,
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
  } = useForm<CredentialSetInput>({
    defaultValues: {
      name: set?.name || '',
      description: set?.description || '',
      credential_ids: set?.credentials.map((c) => c.id) || [],
      strategy: set?.strategy || 'sequential',
      stop_on_success: set?.stop_on_success ?? true,
      tags: set?.tags || [],
    },
  });

  const [tagInput, setTagInput] = useState('');
  const [availableCredentials, setAvailableCredentials] = useState<UnifiedCredentialSummary[]>([]);
  const [selectedCredentials, setSelectedCredentials] = useState<UnifiedCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<{ cause: unknown } | null>(null);

  const tags = watch('tags') || [];
  const credentialIds = watch('credential_ids') || [];

  useEffect(() => {
    loadAvailableCredentials();
  }, []);

  useEffect(() => {
    // Update selected credentials when credential_ids change
    const selected = credentialIds
      .map((id) => availableCredentials.find((c) => c.id === id))
      .filter(Boolean) as UnifiedCredentialSummary[];
    setSelectedCredentials(selected);
  }, [credentialIds, availableCredentials]);

  const loadAvailableCredentials = async () => {
    try {
      setLoading(true);
      setLoadFailure(null);
      const response = await credentialService.listCredentials({ limit: 1000 });
      setAvailableCredentials(response.data);

      // If editing, load the credentials in order
      if (set) {
        setSelectedCredentials(set.credentials);
      }
    } catch (error) {
      logClientError('Failed to load credentials:', error);
      setLoadFailure({ cause: error });
    } finally {
      setLoading(false);
    }
  };

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

  const handleAddCredential = (credentialId: string) => {
    if (!credentialIds.includes(credentialId)) {
      const newIds = [...credentialIds, credentialId];
      setValue('credential_ids', newIds);
    }
  };

  const handleRemoveCredential = (credentialId: string) => {
    const newIds = credentialIds.filter((id) => id !== credentialId);
    setValue('credential_ids', newIds);
  };

  const handleMoveCredential = (index: number, direction: 'up' | 'down') => {
    const newIds = [...credentialIds];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;

    if (targetIndex >= 0 && targetIndex < newIds.length) {
      [newIds[index], newIds[targetIndex]] = [newIds[targetIndex], newIds[index]];
      setValue('credential_ids', newIds);
    }
  };

  const onFormSubmit = handleSubmit(async (data) => {
    await onSubmit(data);
  });

  const formatLabel = (value: string) => {
    return value
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const unselectedCredentials = availableCredentials.filter(
    (cred) => !credentialIds.includes(cred.id)
  );

  return (
    <Card>
      <form onSubmit={onFormSubmit} className="space-y-6">
        {/* Basic Information */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" required>
              Name
            </Label>
            <Controller
              name="name"
              control={control}
              rules={{ required: 'Name is required' }}
              render={({ field }) => (
                <Input
                  {...field}
                  id="name"
                  placeholder="Production SSH Credentials"
                  error={errors.name?.message}
                />
              )}
            />
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
                  placeholder="Optional description of credential set usage"
                  rows={2}
                />
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="strategy" required>
                Strategy
              </Label>
              <Controller
                name="strategy"
                control={control}
                rules={{ required: 'Strategy is required' }}
                render={({ field }) => (
                  <Select
                    id="strategy"
                    value={field.value ?? ''}
                    onChange={(value) => field.onChange(value)}
                    options={STRATEGIES.map((s) => ({ value: s, label: formatLabel(s) }))}
                    hint={field.value ? STRATEGY_HINTS[field.value] : undefined}
                  />
                )}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="stop_on_success">Stop on Success</Label>
              <div className="flex items-center space-x-2">
                <Controller
                  name="stop_on_success"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      id="stop_on_success"
                      aria-label="Stop on Success"
                      checked={Boolean(field.value)}
                      onChange={field.onChange}
                    />
                  )}
                />
                <span className="text-sm text-[var(--hh-text-muted)]">
                  Stop trying after first success
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Credential Selection */}
        <div className="border-t border-[var(--hh-hairline)] pt-4">
          <SectionHeading level={3}>Credentials</SectionHeading>

          {/* Selected Credentials (Ordered) */}
          {selectedCredentials.length > 0 && (
            <div className="mb-4 space-y-2">
              <Label>Selected Credentials (in order)</Label>
              <div className="space-y-2">
                {selectedCredentials.map((cred, index) => (
                  <ListRow
                    key={cred.id}
                    leading={
                      <span className="hh-mono w-6 text-xs text-[var(--hh-text-muted)]">
                        #{index + 1}
                      </span>
                    }
                    title={cred.name}
                    description={cred.description}
                    actions={
                      <>
                        <IconButton
                          icon="caret-up"
                          variant="ghost"
                          size="sm"
                          shape="rounded"
                          aria-label="Move up"
                          onClick={() => handleMoveCredential(index, 'up')}
                          disabled={index === 0}
                        />
                        <IconButton
                          icon="caret-down"
                          variant="ghost"
                          size="sm"
                          shape="rounded"
                          aria-label="Move down"
                          onClick={() => handleMoveCredential(index, 'down')}
                          disabled={index === selectedCredentials.length - 1}
                        />
                        <Badge>{formatLabel(cred.protocol)}</Badge>
                        <Badge>{formatLabel(cred.scope)}</Badge>
                        <IconButton
                          icon="trash"
                          variant="ghost"
                          size="sm"
                          shape="rounded"
                          aria-label="Remove"
                          title="Remove"
                          onClick={() => handleRemoveCredential(cred.id)}
                        />
                      </>
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {/* Available Credentials */}
          <div className="space-y-2">
            <Label>Available Credentials</Label>
            {loading || loadFailure ? (
              <QueryState
                what="available credentials"
                loading={loading}
                error={loadFailure?.cause}
                onRetry={loadAvailableCredentials}
              />
            ) : unselectedCredentials.length === 0 ? (
              <EmptyState
                label={
                  credentialIds.length > 0
                    ? 'All credentials have been added'
                    : 'No credentials available. Create credentials first.'
                }
              />
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-[var(--hh-radius-md)] p-1">
                {unselectedCredentials.map((cred) => (
                  <ListRow
                    key={cred.id}
                    title={cred.name}
                    description={cred.description}
                    onClick={() => handleAddCredential(cred.id)}
                    actions={
                      <>
                        <Badge>{formatLabel(cred.protocol)}</Badge>
                        <Badge>{formatLabel(cred.scope)}</Badge>
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {credentialIds.length === 0 && (
            <FieldHint error="Please select at least one credential" className="mt-2" />
          )}
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
            <div className="mt-2 flex flex-wrap gap-2">
              {tags.map((tag) => (
                <Tag key={tag} onRemove={() => handleDeleteTag(tag)}>
                  {tag}
                </Tag>
              ))}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-2 border-t border-[var(--hh-hairline)] pt-4">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            icon="floppy-disk"
            disabled={isSubmitting || credentialIds.length === 0}
          >
            {isSubmitting ? 'Saving...' : 'Save Set'}
          </Button>
        </div>
      </form>
    </Card>
  );
};

export default CredentialSetForm;
