import React, { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Icon } from '@happy-technologies/design-system';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  credentialService,
  type CredentialSetSummary,
  type CredentialSetInput,
  type CredentialSetUpdateInput,
  type CredentialSetStrategy,
  type UnifiedCredentialSummary,
} from '@/services/credential.service';

interface CredentialSetFormProps {
  set?: CredentialSetSummary;
  onSubmit: (data: CredentialSetInput | CredentialSetUpdateInput) => void | Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

const STRATEGIES: CredentialSetStrategy[] = ['sequential', 'parallel', 'adaptive'];

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
  const [loading, setLoading] = useState(false);

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
      const response = await credentialService.listCredentials({ limit: 1000 });
      setAvailableCredentials(response.data);

      // If editing, load the credentials in order
      if (set) {
        setSelectedCredentials(set.credentials);
      }
    } catch (error) {
      console.error('Failed to load credentials:', error);
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
                  placeholder="Production SSH Credentials"
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
                  placeholder="Optional description of credential set usage"
                  rows={2}
                />
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="strategy">
                Strategy <span className="text-destructive">*</span>
              </Label>
              <Controller
                name="strategy"
                control={control}
                rules={{ required: 'Strategy is required' }}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select strategy" />
                    </SelectTrigger>
                    <SelectContent>
                      {STRATEGIES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {formatLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">
                {watch('strategy') === 'sequential' &&
                  'Try credentials one at a time in order'}
                {watch('strategy') === 'parallel' && 'Try all credentials simultaneously'}
                {watch('strategy') === 'adaptive' && 'Learn from past successes and adapt order'}
              </p>
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
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
                <span className="text-sm text-muted-foreground">
                  Stop trying after first success
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Credential Selection */}
        <div className="border-t pt-4">
          <h3 className="text-lg font-medium mb-4">Credentials</h3>

          {/* Selected Credentials (Ordered) */}
          {selectedCredentials.length > 0 && (
            <div className="space-y-2 mb-4">
              <Label>Selected Credentials (in order)</Label>
              <div className="space-y-2">
                {selectedCredentials.map((cred, index) => (
                  <div
                    key={cred.id}
                    className="flex items-center gap-2 p-3 border border-border rounded-lg bg-muted/20"
                  >
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => handleMoveCredential(index, 'up')}
                        disabled={index === 0}
                        className="p-0.5 hover:bg-muted rounded disabled:opacity-30"
                      >
                        <Icon name="dots-six-vertical" size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveCredential(index, 'down')}
                        disabled={index === selectedCredentials.length - 1}
                        className="p-0.5 hover:bg-muted rounded disabled:opacity-30"
                      >
                        <Icon name="dots-six-vertical" size={12} />
                      </button>
                    </div>
                    <span className="text-xs text-muted-foreground font-mono w-6">
                      #{index + 1}
                    </span>
                    <div className="flex-1">
                      <div className="text-sm font-medium">{cred.name}</div>
                      {cred.description && (
                        <div className="text-xs text-muted-foreground truncate max-w-[300px]">
                          {cred.description}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Badge variant="outline">{formatLabel(cred.protocol)}</Badge>
                      <Badge variant="outline">{formatLabel(cred.scope)}</Badge>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveCredential(cred.id)}
                      className="p-1.5 hover:bg-destructive/10 rounded transition-colors"
                      title="Remove"
                    >
                      <Icon name="trash" size={16} className="text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Available Credentials */}
          <div className="space-y-2">
            <Label>Available Credentials</Label>
            {loading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
              </div>
            ) : unselectedCredentials.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground border border-dashed border-border rounded-lg">
                {credentialIds.length > 0
                  ? 'All credentials have been added'
                  : 'No credentials available. Create credentials first.'}
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-2 border border-border rounded-lg p-2">
                {unselectedCredentials.map((cred) => (
                  <button
                    key={cred.id}
                    type="button"
                    onClick={() => handleAddCredential(cred.id)}
                    className="w-full flex items-center gap-2 p-2 hover:bg-muted rounded transition-colors text-left"
                  >
                    <div className="flex-1">
                      <div className="text-sm font-medium">{cred.name}</div>
                      {cred.description && (
                        <div className="text-xs text-muted-foreground truncate">
                          {cred.description}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Badge variant="outline" className="text-xs">
                        {formatLabel(cred.protocol)}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {formatLabel(cred.scope)}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {credentialIds.length === 0 && (
            <p className="text-sm text-destructive mt-2">
              Please select at least one credential
            </p>
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
          <Button type="submit" disabled={isSubmitting || credentialIds.length === 0}>
            <Icon name="floppy-disk" size={16} className="mr-2" />
            {isSubmitting ? 'Saving...' : 'Save Set'}
          </Button>
        </div>
      </form>
    </Card>
  );
};

export default CredentialSetForm;
