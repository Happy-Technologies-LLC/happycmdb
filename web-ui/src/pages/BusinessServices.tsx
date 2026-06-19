// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Plus, Search, Edit, Trash2, Network, DollarSign, Users, TrendingUp } from 'lucide-react';
import { LiquidGlass } from '../components/ui/liquid-glass';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Eyebrow } from '../components/ui/eyebrow';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { apiClient } from '../lib/api-client';
import { useToast } from '../contexts/ToastContext';

interface BusinessService {
  id: string;
  name: string;
  description?: string;
  tier: number;
  criticality: 'TIER_0' | 'TIER_1' | 'TIER_2' | 'TIER_3';
  revenueImpact: number;
  userCount: number;
  owner?: string;
  status: 'active' | 'inactive' | 'planned';
  supportingCIs?: number;
  monthlyCost?: number;
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

// Mapper functions to convert between UI and API formats
const mapAPIToUI = (apiService: BusinessServiceAPI): BusinessService => {
  const tierMatch = apiService.business_criticality.match(/tier_(\d)/);
  const tier = tierMatch ? parseInt(tierMatch[1]) : 3;

  return {
    id: apiService.service_id,
    name: apiService.name,
    description: apiService.description,
    tier,
    criticality: `TIER_${tier}` as BusinessService['criticality'],
    revenueImpact: apiService.metadata?.revenue_impact || 0,
    userCount: apiService.metadata?.user_count || 0,
    owner: apiService.owned_by,
    status: apiService.operational_status as BusinessService['status'],
    supportingCIs: apiService.metadata?.supporting_cis || 0,
    monthlyCost: apiService.metadata?.monthly_cost || 0,
  };
};

const mapUIToAPI = (uiService: Partial<BusinessService> & { name: string }): Partial<BusinessServiceAPI> => {
  const tier = uiService.tier !== undefined ? uiService.tier : 3;
  const serviceId = uiService.id || `bs-${uiService.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;

  return {
    service_id: serviceId,
    name: uiService.name,
    description: uiService.description,
    service_classification: 'application',
    tbm_tower: 'application',
    business_criticality: `tier_${tier}`,
    operational_status: uiService.status || 'active',
    owned_by: uiService.owner,
    metadata: {
      revenue_impact: uiService.revenueImpact || 0,
      user_count: uiService.userCount || 0,
      supporting_cis: uiService.supportingCIs || 0,
      monthly_cost: uiService.monthlyCost || 0,
    },
  };
};

const CRITICALITY_COLORS = {
  TIER_0: 'bg-danger-soft text-danger',
  TIER_1: 'bg-warning-soft text-warning-text',
  TIER_2: 'bg-warning-soft text-warning-text',
  TIER_3: 'bg-sky-soft text-sky-text',
};

const STATUS_COLORS = {
  active: 'bg-success-soft text-success',
  inactive: 'bg-warm-alt text-ink-soft',
  planned: 'bg-sky-soft text-sky-text',
};

export const BusinessServices: React.FC = () => {
  const { showToast } = useToast();
  const [services, setServices] = useState<BusinessService[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTier, setFilterTier] = useState<string>('all');
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<BusinessService | null>(null);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    tier: '0',
    revenueImpact: '',
    userCount: '',
    owner: '',
  });

  // Load services from API
  useEffect(() => {
    loadServices();
  }, []);

  const loadServices = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get<{ services: BusinessServiceAPI[]; total: number }>(
        '/business-services'
      );
      const uiServices = response.services.map(mapAPIToUI);
      setServices(uiServices);
    } catch (error: any) {
      console.error('Failed to load business services:', error);
      showToast('Failed to load business services', 'error');
    } finally {
      setLoading(false);
    }
  };

  const filteredServices = services.filter((service) => {
    const matchesSearch = service.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      service.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesTier = filterTier === 'all' || service.tier.toString() === filterTier;
    return matchesSearch && matchesTier;
  });

  const handleCreateService = async () => {
    try {
      setSaving(true);

      const uiService: Partial<BusinessService> & { name: string } = {
        name: formData.name,
        description: formData.description,
        tier: parseInt(formData.tier),
        criticality: `TIER_${formData.tier}` as BusinessService['criticality'],
        revenueImpact: parseFloat(formData.revenueImpact) || 0,
        userCount: parseInt(formData.userCount) || 0,
        owner: formData.owner,
        status: 'active',
      };

      if (editingService) {
        // Update existing service
        uiService.id = editingService.id;
        const apiData = mapUIToAPI(uiService);
        const updatedService = await apiClient.patch<BusinessServiceAPI>(
          `/business-services/${editingService.id}`,
          apiData
        );
        setServices(services.map(s => s.id === editingService.id ? mapAPIToUI(updatedService) : s));
        showToast('Business service updated successfully', 'success');
        setEditingService(null);
      } else {
        // Create new service
        const apiData = mapUIToAPI(uiService);
        const createdService = await apiClient.post<BusinessServiceAPI>('/business-services', apiData);
        setServices([...services, mapAPIToUI(createdService)]);
        showToast('Business service created successfully', 'success');
      }

      setFormData({
        name: '',
        description: '',
        tier: '0',
        revenueImpact: '',
        userCount: '',
        owner: '',
      });
      setIsCreateDialogOpen(false);
    } catch (error: any) {
      console.error('Failed to save business service:', error);
      const message = error.response?.data?.error || 'Failed to save business service';
      showToast(message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (service: BusinessService) => {
    setEditingService(service);
    setFormData({
      name: service.name,
      description: service.description || '',
      tier: service.tier.toString(),
      revenueImpact: service.revenueImpact.toString(),
      userCount: service.userCount.toString(),
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
      console.error('Failed to delete business service:', error);
      const message = error.response?.data?.error || 'Failed to delete business service';
      showToast(message, 'error');
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('en-US').format(num);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <Eyebrow>Service Catalog</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">Business Services</h1>
          <p className="mt-1.5 text-ink-soft">
            Manage and monitor your business-critical services
          </p>
        </div>

        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => {
              setEditingService(null);
              setFormData({
                name: '',
                description: '',
                tier: '0',
                revenueImpact: '',
                userCount: '',
                owner: '',
              });
            }}>
              <Plus className="mr-2 h-4 w-4" />
              Create Service
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{editingService ? 'Edit Business Service' : 'Create Business Service'}</DialogTitle>
              <DialogDescription>
                Define a new business service and its key attributes
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Service Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Customer Portal"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Brief description of the service"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="tier">Criticality Tier</Label>
                  <Select
                    value={formData.tier}
                    onValueChange={(value) => setFormData({ ...formData, tier: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Tier 0 - Mission Critical</SelectItem>
                      <SelectItem value="1">Tier 1 - Business Critical</SelectItem>
                      <SelectItem value="2">Tier 2 - Important</SelectItem>
                      <SelectItem value="3">Tier 3 - Standard</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="owner">Service Owner</Label>
                  <Input
                    id="owner"
                    value={formData.owner}
                    onChange={(e) => setFormData({ ...formData, owner: e.target.value })}
                    placeholder="Team or person"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="revenueImpact">Annual Revenue Impact ($)</Label>
                  <Input
                    id="revenueImpact"
                    type="number"
                    value={formData.revenueImpact}
                    onChange={(e) => setFormData({ ...formData, revenueImpact: e.target.value })}
                    placeholder="0"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="userCount">User Count</Label>
                  <Input
                    id="userCount"
                    type="number"
                    value={formData.userCount}
                    onChange={(e) => setFormData({ ...formData, userCount: e.target.value })}
                    placeholder="0"
                  />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleCreateService} disabled={!formData.name || saving}>
                {saving ? 'Saving...' : editingService ? 'Update Service' : 'Create Service'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Total Services</span>
              <Network className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-3xl font-bold">{services.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {services.filter(s => s.status === 'active').length} active
            </p>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Total Revenue Impact</span>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-3xl font-bold">
              {formatCurrency(services.reduce((sum, s) => sum + s.revenueImpact, 0))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Annual</p>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Total Users</span>
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-3xl font-bold">
              {formatNumber(services.reduce((sum, s) => sum + s.userCount, 0))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Across all services</p>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Monthly IT Cost</span>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-3xl font-bold">
              {formatCurrency(services.reduce((sum, s) => sum + (s.monthlyCost || 0), 0))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">All services</p>
          </div>
        </LiquidGlass>
      </div>

      {/* Filters */}
      <LiquidGlass variant="default" rounded="xl">
        <div className="p-4">
          <div className="flex gap-4 items-center">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search services..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <Select value={filterTier} onValueChange={setFilterTier}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Filter by tier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tiers</SelectItem>
                <SelectItem value="0">Tier 0 - Mission Critical</SelectItem>
                <SelectItem value="1">Tier 1 - Business Critical</SelectItem>
                <SelectItem value="2">Tier 2 - Important</SelectItem>
                <SelectItem value="3">Tier 3 - Standard</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </LiquidGlass>

      {/* Services Table */}
      <LiquidGlass variant="default" rounded="xl">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-sm font-semibold">Service Name</th>
                <th className="text-left py-3 px-4 text-sm font-semibold">Tier</th>
                <th className="text-left py-3 px-4 text-sm font-semibold">Status</th>
                <th className="text-left py-3 px-4 text-sm font-semibold">Revenue Impact</th>
                <th className="text-left py-3 px-4 text-sm font-semibold">Users</th>
                <th className="text-left py-3 px-4 text-sm font-semibold">Monthly Cost</th>
                <th className="text-left py-3 px-4 text-sm font-semibold">Supporting CIs</th>
                <th className="text-right py-3 px-4 text-sm font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="text-center py-8 text-muted-foreground">
                    Loading business services...
                  </td>
                </tr>
              ) : filteredServices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-8 text-muted-foreground">
                    No services found
                  </td>
                </tr>
              ) : (
                filteredServices.map((service) => (
                  <tr
                    key={service.id}
                    className="border-b border-border hover:bg-accent transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div>
                        <div className="font-medium">{service.name}</div>
                        {service.description && (
                          <div className="text-xs text-muted-foreground">{service.description}</div>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <Badge className={CRITICALITY_COLORS[service.criticality]}>
                        Tier {service.tier}
                      </Badge>
                    </td>
                    <td className="py-3 px-4">
                      <Badge className={STATUS_COLORS[service.status]} variant="outline">
                        {service.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-sm">
                      {formatCurrency(service.revenueImpact)}
                    </td>
                    <td className="py-3 px-4 text-sm">
                      {formatNumber(service.userCount)}
                    </td>
                    <td className="py-3 px-4 text-sm">
                      {service.monthlyCost ? formatCurrency(service.monthlyCost) : '-'}
                    </td>
                    <td className="py-3 px-4 text-sm">
                      <span className="text-muted-foreground">{service.supportingCIs || 0}</span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex gap-2 justify-end">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleEdit(service)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDelete(service.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </LiquidGlass>
    </div>
  );
};

export default BusinessServices;
