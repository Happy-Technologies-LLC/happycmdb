// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ciService, {
  CI,
  CIListParams,
  CreateCIRequest,
  UpdateCIRequest,
} from '../services/ci.service';
import { useCallback } from 'react';

export const CI_QUERY_KEYS = {
  all: ['cis'] as const,
  lists: () => [...CI_QUERY_KEYS.all, 'list'] as const,
  list: (params?: CIListParams) => [...CI_QUERY_KEYS.lists(), params] as const,
  details: () => [...CI_QUERY_KEYS.all, 'detail'] as const,
  detail: (id: string) => [...CI_QUERY_KEYS.details(), id] as const,
  relationships: (id: string) => [...CI_QUERY_KEYS.detail(id), 'relationships'] as const,
  impact: (id: string) => [...CI_QUERY_KEYS.detail(id), 'impact'] as const,
  impactEnvelope: (id: string) => [...CI_QUERY_KEYS.impact(id), 'envelope'] as const,
  relationshipEvidence: (fromId: string, toId: string, type: string) =>
    [...CI_QUERY_KEYS.all, 'relationship-evidence', fromId, toId, type] as const,
  audit: (id: string) => [...CI_QUERY_KEYS.detail(id), 'audit'] as const,
  search: (query: string) => [...CI_QUERY_KEYS.all, 'search', query] as const,
};

export function useCIs(params?: CIListParams) {
  return useQuery({
    queryKey: CI_QUERY_KEYS.list(params),
    queryFn: () => ciService.getCIs(params),
    staleTime: 30000, // 30 seconds
    gcTime: 300000, // 5 minutes
  });
}

export function useCI(id: string, enabled = true) {
  return useQuery({
    queryKey: CI_QUERY_KEYS.detail(id),
    queryFn: () => ciService.getCIById(id),
    enabled: enabled && !!id,
    staleTime: 30000,
    gcTime: 300000,
  });
}

export function useCreateCI() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateCIRequest) => ciService.createCI(data),
    onSuccess: () => {
      // Invalidate and refetch CI lists
      queryClient.invalidateQueries({ queryKey: CI_QUERY_KEYS.lists() });
    },
  });
}

export function useUpdateCI() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateCIRequest }) =>
      ciService.updateCI(id, data),
    onSuccess: (updatedCI) => {
      // Update the specific CI in cache
      queryClient.setQueryData(CI_QUERY_KEYS.detail(updatedCI.id), updatedCI);
      // Invalidate lists to refresh
      queryClient.invalidateQueries({ queryKey: CI_QUERY_KEYS.lists() });
    },
  });
}

export function useDeleteCI() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => ciService.deleteCI(id),
    onSuccess: (_, deletedId) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: CI_QUERY_KEYS.detail(deletedId) });
      // Invalidate lists
      queryClient.invalidateQueries({ queryKey: CI_QUERY_KEYS.lists() });
    },
  });
}

export function useSearchCIs(query: string, filters?: Partial<CIListParams>) {
  return useQuery({
    queryKey: CI_QUERY_KEYS.search(query),
    queryFn: () => ciService.searchCIs(query, filters),
    enabled: query.length >= 2,
    staleTime: 10000, // 10 seconds
    gcTime: 60000, // 1 minute
  });
}

export function useCIsByType(type: string) {
  return useQuery({
    queryKey: [...CI_QUERY_KEYS.lists(), 'type', type],
    queryFn: () => ciService.getCIsByType(type as any),
    staleTime: 30000,
  });
}

export function useCIsByStatus(status: string) {
  return useQuery({
    queryKey: [...CI_QUERY_KEYS.lists(), 'status', status],
    queryFn: () => ciService.getCIsByStatus(status as any),
    staleTime: 30000,
  });
}

export function useCIsByEnvironment(environment: string) {
  return useQuery({
    queryKey: [...CI_QUERY_KEYS.lists(), 'environment', environment],
    queryFn: () => ciService.getCIsByEnvironment(environment as any),
    staleTime: 30000,
  });
}

export function useCIsByTags(tags: string[]) {
  return useQuery({
    queryKey: [...CI_QUERY_KEYS.lists(), 'tags', tags],
    queryFn: () => ciService.getCIsByTags(tags),
    enabled: tags.length > 0,
    staleTime: 30000,
  });
}

export function useCIAuditHistory(id: string, enabled = true) {
  return useQuery({
    queryKey: CI_QUERY_KEYS.audit(id),
    queryFn: () => ciService.getCIAuditHistory(id),
    enabled: enabled && !!id,
    staleTime: 10000, // 10 seconds
    gcTime: 300000, // 5 minutes
  });
}

export function useCIActions() {
  const createCI = useCreateCI();
  const updateCI = useUpdateCI();
  const deleteCI = useDeleteCI();

  const handleCreate = useCallback(
    async (data: CreateCIRequest) => {
      try {
        const result = await createCI.mutateAsync(data);
        return { success: true, data: result };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    [createCI]
  );

  const handleUpdate = useCallback(
    async (id: string, data: UpdateCIRequest) => {
      try {
        const result = await updateCI.mutateAsync({ id, data });
        return { success: true, data: result };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    [updateCI]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteCI.mutateAsync(id);
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    [deleteCI]
  );

  return {
    createCI: handleCreate,
    updateCI: handleUpdate,
    deleteCI: handleDelete,
    isCreating: createCI.isPending,
    isUpdating: updateCI.isPending,
    isDeleting: deleteCI.isPending,
  };
}
