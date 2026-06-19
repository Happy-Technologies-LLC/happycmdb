// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Save, X } from 'lucide-react';
import { useForm, Controller } from 'react-hook-form';
import {
  CI,
  CIType,
  CIStatus,
  Environment,
  CreateCIRequest,
  UpdateCIRequest,
} from '../../services/ci.service';
import { cn } from '../../utils/cn';

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
    <div className="bg-card rounded-lg border border-border p-6">
      <h2 className="text-xl font-semibold mb-6">
        {ci ? 'Edit Configuration Item' : 'Create Configuration Item'}
      </h2>

      <form onSubmit={onFormSubmit} className="space-y-6">
        <div className="grid grid-cols-1 gap-6">
          {/* Name Field */}
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-foreground mb-1">
              Name <span className="text-danger">*</span>
            </label>
            <Controller
              name="name"
              control={control}
              rules={{ required: 'Name is required' }}
              render={({ field }) => (
                <>
                  <input
                    {...field}
                    id="name"
                    type="text"
                    className={cn(
                      'w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-sky/30 focus:border-sky',
                      errors.name ? 'border-danger' : 'border-line'
                    )}
                  />
                  {errors.name && (
                    <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>
                  )}
                </>
              )}
            />
          </div>

          {/* Type and Status Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="type" className="block text-sm font-medium text-foreground mb-1">
                Type <span className="text-danger">*</span>
              </label>
              <Controller
                name="type"
                control={control}
                rules={{ required: 'Type is required' }}
                render={({ field }) => (
                  <>
                    <select
                      {...field}
                      id="type"
                      className={cn(
                        'w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-sky/30 focus:border-sky',
                        errors.type ? 'border-danger' : 'border-line'
                      )}
                    >
                      {CI_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {formatLabel(type)}
                        </option>
                      ))}
                    </select>
                    {errors.type && (
                      <p className="mt-1 text-sm text-destructive">{errors.type.message}</p>
                    )}
                  </>
                )}
              />
            </div>

            <div>
              <label htmlFor="status" className="block text-sm font-medium text-foreground mb-1">
                Status <span className="text-danger">*</span>
              </label>
              <Controller
                name="status"
                control={control}
                rules={{ required: 'Status is required' }}
                render={({ field }) => (
                  <>
                    <select
                      {...field}
                      id="status"
                      className={cn(
                        'w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-sky/30 focus:border-sky',
                        errors.status ? 'border-danger' : 'border-line'
                      )}
                    >
                      {CI_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {formatLabel(status)}
                        </option>
                      ))}
                    </select>
                    {errors.status && (
                      <p className="mt-1 text-sm text-destructive">{errors.status.message}</p>
                    )}
                  </>
                )}
              />
            </div>
          </div>

          {/* Environment Field */}
          <div>
            <label htmlFor="environment" className="block text-sm font-medium text-foreground mb-1">
              Environment <span className="text-danger">*</span>
            </label>
            <Controller
              name="environment"
              control={control}
              rules={{ required: 'Environment is required' }}
              render={({ field }) => (
                <>
                  <select
                    {...field}
                    id="environment"
                    className={cn(
                      'w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-sky/30 focus:border-sky',
                      errors.environment ? 'border-danger' : 'border-line'
                    )}
                  >
                    {ENVIRONMENTS.map((env) => (
                      <option key={env} value={env}>
                        {formatLabel(env)}
                      </option>
                    ))}
                  </select>
                  {errors.environment && (
                    <p className="mt-1 text-sm text-destructive">{errors.environment.message}</p>
                  )}
                </>
              )}
            />
          </div>

          {/* Description Field */}
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-foreground mb-1">
              Description
            </label>
            <Controller
              name="description"
              control={control}
              render={({ field }) => (
                <>
                  <textarea
                    {...field}
                    id="description"
                    rows={3}
                    className={cn(
                      'w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-sky/30 focus:border-sky',
                      errors.description ? 'border-danger' : 'border-line'
                    )}
                  />
                  {errors.description && (
                    <p className="mt-1 text-sm text-destructive">{errors.description.message}</p>
                  )}
                </>
              )}
            />
          </div>

          {/* Tags Field */}
          <div>
            <label htmlFor="tags" className="block text-sm font-medium text-foreground mb-1">
              Tags
            </label>
            <div className="space-y-2">
              <input
                id="tags"
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleAddTag}
                placeholder="Add tags and press Enter"
                className="w-full px-3 py-2 border border-line rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-sky/30 focus:border-sky"
              />
              <p className="text-sm text-muted-foreground">Press Enter to add a tag</p>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-3 py-1 bg-sky-soft text-sky-text rounded-full text-sm"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => handleDeleteTag(tag)}
                        className="hover:bg-sky rounded-full p-0.5"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-4 py-2 border border-line rounded-md shadow-sm text-sm font-medium text-ink bg-white hover:bg-warm focus:outline-none focus:ring-2 focus:ring-sky/30 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X className="w-4 h-4" />
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-sky hover:bg-sky/90 focus:outline-none focus:ring-2 focus:ring-sky/30 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="w-4 h-4" />
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

export default CIForm;
