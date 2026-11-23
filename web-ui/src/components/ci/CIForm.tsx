// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import {
  Button,
  Input,
  Label,
  NativeSelect,
  SectionHeading,
  Tag,
  Textarea,
} from '@happy-technologies/design-system';
import { useForm, Controller } from 'react-hook-form';
import {
  CI,
  CIType,
  CIStatus,
  Environment,
  CreateCIRequest,
  UpdateCIRequest,
} from '../../services/ci.service';

interface CIFormProps {
  ci?: CI;
  onSubmit: (data: CreateCIRequest | UpdateCIRequest) => void | Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

const CI_TYPES: CIType[] = [
  'server',
  'virtual-machine',
  'container',
  'application',
  'service',
  'database',
  'network-device',
  'storage',
  'load-balancer',
  'cloud-resource',
];

const CI_STATUSES: CIStatus[] = ['active', 'inactive', 'maintenance', 'decommissioned'];

const ENVIRONMENTS: Environment[] = ['production', 'staging', 'development', 'test'];

export const CIForm: React.FC<CIFormProps> = ({
  ci,
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
  } = useForm<CreateCIRequest>({
    defaultValues: {
      name: ci?.name || '',
      type: ci?.type || 'server',
      status: ci?.status || 'active',
      environment: ci?.environment || 'development',
      description: ci?.description || '',
      tags: ci?.tags || [],
      attributes: ci?.attributes || {},
    },
  });

  const [tagInput, setTagInput] = React.useState('');
  const tags = watch('tags') || [];

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

  const onFormSubmit = handleSubmit(async (data) => {
    await onSubmit(data);
  });

  const formatLabel = (value: string) => {
    return value
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  return (
    <div className="p-6">
      <SectionHeading level={2}>{ci ? 'Edit Configuration Item' : 'Create Configuration Item'}</SectionHeading>

      <form onSubmit={onFormSubmit} className="space-y-6">
        <div className="grid grid-cols-1 gap-6">
          {/* Name Field */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="name" required>
              Name
            </Label>
            <Controller
              name="name"
              control={control}
              rules={{ required: 'Name is required' }}
              render={({ field }) => (
                <Input {...field} id="name" type="text" error={errors.name?.message} />
              )}
            />
          </div>

          {/* Type and Status Row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="type" required>
                Type
              </Label>
              <Controller
                name="type"
                control={control}
                rules={{ required: 'Type is required' }}
                render={({ field }) => (
                  <NativeSelect {...field} id="type" error={errors.type?.message}>
                    {CI_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {formatLabel(type)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="status" required>
                Status
              </Label>
              <Controller
                name="status"
                control={control}
                rules={{ required: 'Status is required' }}
                render={({ field }) => (
                  <NativeSelect {...field} id="status" error={errors.status?.message}>
                    {CI_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {formatLabel(status)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            </div>
          </div>

          {/* Environment Field */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="environment" required>
              Environment
            </Label>
            <Controller
              name="environment"
              control={control}
              rules={{ required: 'Environment is required' }}
              render={({ field }) => (
                <NativeSelect {...field} id="environment" error={errors.environment?.message}>
                  {ENVIRONMENTS.map((env) => (
                    <option key={env} value={env}>
                      {formatLabel(env)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            />
          </div>

          {/* Description Field */}
          <Controller
            name="description"
            control={control}
            render={({ field }) => (
              <Textarea
                {...field}
                id="description"
                label="Description"
                rows={3}
                error={errors.description?.message}
              />
            )}
          />

          {/* Tags Field */}
          <div className="space-y-2">
            <Input
              id="tags"
              type="text"
              label="Tags"
              hint="Press Enter to add a tag"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleAddTag}
              placeholder="Add tags and press Enter"
            />
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <Tag key={tag} tone="accent" onRemove={() => handleDeleteTag(tag)}>
                    {tag}
                  </Tag>
                ))}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 pt-4">
            <Button variant="secondary" size="md" icon="x" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" size="md" icon="floppy-disk" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
};

export default CIForm;
