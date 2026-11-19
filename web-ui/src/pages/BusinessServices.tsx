// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  MetricCard,
  PageHeader,
  SectionHeading,
  Select,
  type BadgeVariant,
  type Column,
} from '@happy-technologies/design-system';
import { apiClient } from '../lib/api-client';
import { EMPTY_VALUE, isKnown } from '../lib/dashboardValue';
import { useToast } from '../contexts/ToastContext';
import { logClientError } from '../utils/logger';
import { RequirePermission } from '../components/common/RequirePermission';
import { QueryState } from '../components/estate/SurfaceState';
import { ServiceOfferingsDialog } from '../components/business-services/ServiceOfferingsDialog';

/** Canonical business criticality accepted by /api/v1/business-services. */
type Criticality = 'critical' | 'high' | 'medium' | 'low';

const CRITICALITY_OPTIONS: { value: Criticality; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const isCriticality = (value: unknown): value is Criticality =>
  CRITICALITY_OPTIONS.some((option) => option.value === value);

interface BusinessService {
  id: string;
  name: string;
  description?: string;
  /** Canonical API value; null when the stored value is missing or not canonical. */
  criticality: Criticality | null;
  /** The figures below are null when the API row carries no value for them; null is shown as unknown, never as 0. */
  revenueImpact: number | null;
  userCount: number | null;
  owner?: string;
  status: 'active' | 'inactive' | 'planned';
  supportingCIs: number | null;
  monthlyCost: number | null;
}

// Backend API interface
interface BusinessServiceAPI {
  service_id: string;
  name: string;
  description?: string;
  service_classification: string;
  tbm_tower: string;
  business_criticality: string;
  operational_status: string;
  owned_by?: string;
  managed_by?: string;
  support_group?: string;
  service_level_requirement?: string;
  category?: string;
  tags?: string[];
  related_ci_types?: string[];
  cost_allocation?: any;
  metadata?: any;
  created_at?: string;
  updated_at?: string;
}

/** Standard {success, data} envelope every business-services endpoint responds with. */
interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  message?: string;
}

/** The C1 list envelope of GET /business-services (HAP-1425): one page, and the cursor of the next (null after the last). */
interface ListPage<T> {
  success: boolean;
  items: T[];
  next_cursor: string | null;
  as_of: string;
}

/** A stored metadata figure as a number; null when it is absent or not numeric. */
const figure = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Sum of the figures that are known; null when none is (never 0). */
const sumKnown = (values: Array<number | null>): number | null => {
  const known = values.filter(isKnown);
  return known.length === 0 ? null : known.reduce((sum, v) => sum + v, 0);
};

// Mapper functions to convert between UI and API formats
const mapAPIToUI = (apiService: BusinessServiceAPI): BusinessService => {
  return {
    id: apiService.service_id,
    name: apiService.name,
    description: apiService.description,
    criticality: isCriticality(apiService.business_criticality) ? apiService.business_criticality : null,
    revenueImpact: figure(apiService.metadata?.revenue_impact),
    userCount: figure(apiService.metadata?.user_count),
    owner: apiService.owned_by,
    status: apiService.operational_status as BusinessService['status'],
    supportingCIs: figure(apiService.metadata?.supporting_cis),
    // A stored 0 is the form's default for "not entered": it is unknown here, as it always was in the list.
    monthlyCost: figure(apiService.metadata?.monthly_cost) || null,
  };
};

const mapUIToAPI = (
  uiService: Partial<BusinessService> & { name: string; criticality: Criticality }
): Partial<BusinessServiceAPI> => {
  return {
    name: uiService.name,
    description: uiService.description,
    service_classification: 'application',
    tbm_tower: 'application',
    business_criticality: uiService.criticality,
    operational_status: uiService.status || 'active',
    // Joi owned_by is optional but rejects ''; omit a blank owner.
    owned_by: uiService.owner || undefined,
    metadata: {
      revenue_impact: uiService.revenueImpact || 0,
      user_count: uiService.userCount || 0,
      supporting_cis: uiService.supportingCIs || 0,
      monthly_cost: uiService.monthlyCost || 0,
    },
  };
};

const CRITICALITY_VARIANTS: Record<Criticality, BadgeVariant> = {
  critical: 'danger',
  high: 'warning',
  medium: 'warning',
  low: 'info',
};

const STATUS_VARIANTS: Record<BusinessService['status'], BadgeVariant> = {
  active: 'success',
  inactive: 'neutral',
  planned: 'info',
};

const EMPTY_FORM = {
  name: '',
  description: '',
  criticality: '' as Criticality | '',
  revenueImpact: '',
  userCount: '',
  owner: '',
};

const formatCurrency = (amount: number | null) => {
  if (!isKnown(amount)) return EMPTY_VALUE;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
};

const formatNumber = (num: number | null) => {
  if (!isKnown(num)) return EMPTY_VALUE;
  return new Intl.NumberFormat('en-US').format(num);
};

export const BusinessServices: React.FC = () => {
  const { showToast } = useToast();
  const [services, setServices] = useState<BusinessService[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCriticality, setFilterCriticality] = useState<string>('all');
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<BusinessService | null>(null);
  const [saving, setSaving] = useState(false);
  const [offeringsFor, setOfferingsFor] = useState<BusinessService | null>(null);

  const [formData, setFormData] = useState(EMPTY_FORM);

  // Load services from API
  useEffect(() => {
    loadServices();
  }, []);

  const loadServices = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const loaded: BusinessServiceAPI[] = [];
      let cursor: string | null = null;
      do {
        const page: ListPage<BusinessServiceAPI> = await apiClient.get<ListPage<BusinessServiceAPI>>(
          '/business-services', { params: { limit: 100, ...(cursor ? { cursor } : {}) } }
        );
        loaded.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      setServices(loaded.map(mapAPIToUI));
    } catch (error: any) {
      logClientError('Failed to load business services:', error);
      setLoadError(error);
      showToast('Failed to load business services', 'error');
    } finally {
      setLoading(false);
    }
  };

  const filteredServices = services.filter((service) => {
    const matchesSearch = service.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      service.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCriticality = filterCriticality === 'all' || service.criticality === filterCriticality;
    return matchesSearch && matchesCriticality;
  });

  const handleCreateService = async () => {
    // Criticality must be an explicit canonical selection; never inferred.
    if (!formData.criticality) return;
    try {
      setSaving(true);

      const uiService: Partial<BusinessService> & { name: string; criticality: Criticality } = {
        name: formData.name,
        description: formData.description,
        criticality: formData.criticality,
        revenueImpact: parseFloat(formData.revenueImpact) || 0,
        userCount: parseInt(formData.userCount) || 0,
        owner: formData.owner,
        status: 'active',
      };

      if (editingService) {
        // Update existing service
        uiService.id = editingService.id;
        const apiData = mapUIToAPI(uiService);
        const updatedService = await apiClient.patch<ApiResponse<BusinessServiceAPI>>(
          `/business-services/${editingService.id}`,
          apiData
        );
        setServices(services.map(s => s.id === editingService.id ? mapAPIToUI(updatedService.data) : s));
        showToast('Business service updated successfully', 'success');
        setEditingService(null);
      } else {
        // Create new service
        const apiData = mapUIToAPI(uiService);
        const createdService = await apiClient.post<ApiResponse<BusinessServiceAPI>>('/business-services', apiData);
        setServices([...services, mapAPIToUI(createdService.data)]);
        showToast('Business service created successfully', 'success');
      }

      setFormData(EMPTY_FORM);
      setIsCreateDialogOpen(false);
    } catch (error: any) {
      logClientError('Failed to save business service:', error);
      const message = error.response?.data?.error || 'Failed to save business service';
      showToast(message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = () => {
    setEditingService(null);
    setFormData(EMPTY_FORM);
    setIsCreateDialogOpen(true);
  };

  const handleEdit = (service: BusinessService) => {
    setEditingService(service);
    setFormData({
      name: service.name,
      description: service.description || '',
      criticality: service.criticality ?? '',
      revenueImpact: service.revenueImpact?.toString() ?? '',
      userCount: service.userCount?.toString() ?? '',
      owner: service.owner || '',
    });
    setIsCreateDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this business service?')) {
      return;
    }

    try {
      await apiClient.delete(`/business-services/${id}`);
      setServices(services.filter(s => s.id !== id));
      showToast('Business service deleted successfully', 'success');
    } catch (error: any) {
      logClientError('Failed to delete business service:', error);
      const message = error.response?.data?.error || 'Failed to delete business service';
      showToast(message, 'error');
    }
  };

  const loaded = !loading && loadError === null;
  // Until the list is read there is nothing to total: an unread list is unknown, not 0.
  const total = (read: (s: BusinessService) => number | null) => (loaded ? sumKnown(services.map(read)) : null);

  const columns: Array<Column<BusinessService>> = [
    {
      header: 'Service Name',
      render: (service) => (
        <div>
          <div className="font-medium">{service.name}</div>
          {service.description && (
            <div className="text-xs text-[var(--hh-text-muted)]">{service.description}</div>
          )}
        </div>
      ),
    },
    {
      header: 'Criticality',
      render: (service) => (
        <Badge variant={service.criticality ? CRITICALITY_VARIANTS[service.criticality] : 'neutral'}>
          {CRITICALITY_OPTIONS.find((option) => option.value === service.criticality)?.label ?? 'Unknown'}
        </Badge>
      ),
    },
    {
      header: 'Status',
      render: (service) => <Badge variant={STATUS_VARIANTS[service.status] ?? 'neutral'}>{service.status}</Badge>,
    },
    { header: 'Revenue Impact', render: (service) => formatCurrency(service.revenueImpact) },
    { header: 'Users', render: (service) => formatNumber(service.userCount) },
    { header: 'Monthly Cost', render: (service) => formatCurrency(service.monthlyCost) },
    {
      header: 'Supporting CIs',
      render: (service) => (
        <span className="text-[var(--hh-text-muted)]">{formatNumber(service.supportingCIs)}</span>
      ),
    },
    {
      header: 'Actions',
      className: 'text-right',
      render: (service) => (
        <div className="flex justify-end gap-2">
          <RequirePermission permission="write">
            <IconButton
              icon="pencil-simple"
              variant="ghost"
              size="sm"
              aria-label={`Edit ${service.name}`}
              onClick={() => handleEdit(service)}
            />
          </RequirePermission>
          <IconButton
            icon="package"
            variant="ghost"
            size="sm"
            aria-label={`Offerings for ${service.name}`}
            onClick={() => setOfferingsFor(service)}
          />
          <RequirePermission permission="write">
            <IconButton
              icon="trash"
              variant="ghost"
              size="sm"
              aria-label={`Delete ${service.name}`}
              onClick={() => handleDelete(service.id)}
            />
          </RequirePermission>
        </div>
      ),
    },
  ];

  return (
    <div className="container mx-auto p-6 space-y-6">
      <PageHeader
        eyebrow="Service Catalog"
        title="Business Services"
        lede="Manage and monitor your business-critical services"
        actions={
          // POST/PATCH /business-services require 'write'; the dialog opens only from here or the gated edit button
          <RequirePermission permission="write">
            <Button icon="plus" onClick={handleCreate}>
              Create Service
            </Button>
          </RequirePermission>
        }
      />

      <Dialog
        open={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
        aria-label={editingService ? 'Edit Business Service' : 'Create Business Service'}
        className="max-w-2xl overflow-visible!"
      >
        <div className="grid gap-4 p-6">
          <div className="pr-8">
            <SectionHeading className="mb-1">
              {editingService ? 'Edit Business Service' : 'Create Business Service'}
            </SectionHeading>
            <p className="text-sm text-[var(--hh-text-muted)]">Define a new business service and its key attributes</p>
          </div>

          <Input
            label="Service Name"
            data-autofocus
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="e.g., Customer Portal"
          />

          <Input
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Brief description of the service"
          />

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Criticality"
              value={formData.criticality}
              onChange={(value) => setFormData({ ...formData, criticality: value as Criticality | '' })}
              options={[{ value: '', label: 'Select criticality' }, ...CRITICALITY_OPTIONS]}
            />

            <Input
              label="Service Owner"
              value={formData.owner}
              onChange={(e) => setFormData({ ...formData, owner: e.target.value })}
              placeholder="Team or person"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Annual Revenue Impact ($)"
              type="number"
              value={formData.revenueImpact}
              onChange={(e) => setFormData({ ...formData, revenueImpact: e.target.value })}
              placeholder="0"
            />

            <Input
              label="User Count"
              type="number"
              value={formData.userCount}
              onChange={(e) => setFormData({ ...formData, userCount: e.target.value })}
              placeholder="0"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleCreateService} disabled={!formData.name || !formData.criticality || saving}>
              {saving ? 'Saving...' : editingService ? 'Update Service' : 'Create Service'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard
          icon="graph"
          label="Total Services"
          value={loaded ? services.length : EMPTY_VALUE}
          sub={loaded ? `${services.filter(s => s.status === 'active').length} active` : undefined}
        />
        <MetricCard
          icon="currency-dollar"
          label="Total Revenue Impact"
          value={formatCurrency(total((s) => s.revenueImpact))}
          sub="Annual"
        />
        <MetricCard
          icon="users"
          label="Total Users"
          value={formatNumber(total((s) => s.userCount))}
          sub="Across all services"
        />
        <MetricCard
          icon="trend-up"
          label="Monthly IT Cost"
          value={formatCurrency(total((s) => s.monthlyCost))}
          sub="All services"
        />
      </div>

      {!loaded ? (
        <Card>
          <QueryState what="business services" loading={loading} error={loadError} onRetry={loadServices} />
        </Card>
      ) : (
        <>
          {/* Filters */}
          <Card inset="none" className="p-4">
            <div className="flex gap-4 items-center">
              <div className="flex-1">
                <Input
                  icon="magnifying-glass"
                  aria-label="Search services"
                  placeholder="Search services..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              <Select
                aria-label="Filter by criticality"
                containerClassName="w-[200px]"
                value={filterCriticality}
                onChange={setFilterCriticality}
                options={[{ value: 'all', label: 'All criticalities' }, ...CRITICALITY_OPTIONS]}
              />
            </div>
          </Card>

          {/* Services Table */}
          {services.length === 0 ? (
            <Card>
              <EmptyState
                icon="graph"
                title="No services found"
                description="No business services have been created yet."
                action={
                  <RequirePermission permission="write">
                    <Button variant="secondary" onClick={handleCreate}>
                      Create your first service
                    </Button>
                  </RequirePermission>
                }
              />
            </Card>
          ) : (
            <DataTable
              rows={filteredServices}
              columns={columns}
              rowKey={(service) => service.id}
              emptyLabel="No services found"
            />
          )}
        </>
      )}
      <ServiceOfferingsDialog service={offeringsFor} onClose={() => setOfferingsFor(null)} />
    </div>
  );
};

export default BusinessServices;
