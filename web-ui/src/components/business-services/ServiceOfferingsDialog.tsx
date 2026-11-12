// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { apiClient } from '../../lib/api-client';
import { useToast } from '../../contexts/ToastContext';
import { logClientError } from '../../utils/logger';
import { RequirePermission } from '@/components/common/RequirePermission';

// HAP-1424 (PoR S3): offerings under one business service, as served by the C1
// offering read. The tenant and ids are the server's; the UI never sends them.
type Audience = 'internal' | 'customer';
type Lifecycle = 'planned' | 'live' | 'retiring' | 'retired';

interface ServiceLevel {
  availability_target?: number;
  response_target_hours?: number;
  support_hours?: string;
}

export interface ServiceOffering {
  offering_id: string;
  service_id: string;
  name: string;
  description: string | null;
  audience: Audience;
  lifecycle: Lifecycle;
  service_level: ServiceLevel;
  version: number;
  updated_at: string;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

const LIFECYCLES: { value: Lifecycle; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'live', label: 'Live' },
  { value: 'retiring', label: 'Retiring' },
  { value: 'retired', label: 'Retired' },
];

const EMPTY_FORM = {
  name: '',
  description: '',
  audience: 'internal' as Audience,
  lifecycle: 'planned' as Lifecycle,
  availabilityTarget: '',
  responseTargetHours: '',
  supportHours: '',
};

type OfferingForm = typeof EMPTY_FORM;

const toForm = (offering: ServiceOffering): OfferingForm => ({
  name: offering.name,
  description: offering.description ?? '',
  audience: offering.audience,
  lifecycle: offering.lifecycle,
  availabilityTarget: offering.service_level.availability_target?.toString() ?? '',
  responseTargetHours: offering.service_level.response_target_hours?.toString() ?? '',
  supportHours: offering.service_level.support_hours ?? '',
});

/** Only the members the user filled in; the server replaces the stored object. */
const serviceLevelOf = (form: OfferingForm): ServiceLevel => ({
  ...(form.availabilityTarget.trim() && { availability_target: Number(form.availabilityTarget) }),
  ...(form.responseTargetHours.trim() && { response_target_hours: Number(form.responseTargetHours) }),
  ...(form.supportHours.trim() && { support_hours: form.supportHours.trim() }),
});

/** The API's `{error}` text from an axios failure, if any. */
const serverError = (error: unknown): string | undefined => {
  const data = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
};

interface ServiceOfferingsDialogProps {
  service: { id: string; name: string } | null;
  onClose: () => void;
}

export const ServiceOfferingsDialog: React.FC<ServiceOfferingsDialogProps> = ({ service, onClose }) => {
  const { showToast } = useToast();
  const [offerings, setOfferings] = useState<ServiceOffering[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<ServiceOffering | null>(null);
  const [form, setForm] = useState<OfferingForm>(EMPTY_FORM);

  const serviceId = service?.id;

  useEffect(() => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOfferings([]);
    if (!serviceId) return;
    let current = true;
    setLoading(true);
    apiClient
      .get<Envelope<ServiceOffering[]>>(`/business-services/${encodeURIComponent(serviceId)}/offerings`)
      .then(response => { if (current) setOfferings(response.data); })
      .catch(error => {
        logClientError('Failed to load service offerings:', error);
        if (current) showToast('Failed to load service offerings', 'error');
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [serviceId, showToast]);

  const startEdit = (offering: ServiceOffering) => {
    setEditing(offering);
    setForm(toForm(offering));
  };

  const resetForm = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const handleSave = async () => {
    if (!serviceId) return;
    const body = {
      name: form.name,
      description: form.description,
      audience: form.audience,
      lifecycle: form.lifecycle,
      service_level: serviceLevelOf(form),
    };
    try {
      setSaving(true);
      if (editing) {
        const updated = await apiClient.patch<Envelope<ServiceOffering>>(
          `/service-offerings/${encodeURIComponent(editing.offering_id)}`,
          body,
          { headers: { 'If-Match': `"${editing.version}"` } },
        );
        setOfferings(list => list.map(o => (o.offering_id === updated.data.offering_id ? updated.data : o)));
        showToast('Offering updated', 'success');
      } else {
        const created = await apiClient.post<Envelope<ServiceOffering>>(
          `/business-services/${encodeURIComponent(serviceId)}/offerings`,
          body,
        );
        setOfferings(list => [...list, created.data]);
        showToast('Offering added', 'success');
      }
      resetForm();
    } catch (error: unknown) {
      logClientError('Failed to save service offering:', error);
      showToast(serverError(error) ?? 'Failed to save service offering', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Lifecycle moves only forward; the server refuses a backward move with 409.
  const lifecycleFloor = editing ? LIFECYCLES.findIndex(l => l.value === editing.lifecycle) : 0;
  const set = (key: keyof OfferingForm) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [key]: event.target.value }));

  return (
    <Dialog open={service !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Offerings: {service?.name}</DialogTitle>
          <DialogDescription>
            What this service offers and at which service level. Retire an offering by moving it to Retired.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading offerings...</p>
        ) : offerings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No offerings yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {offerings.map(offering => (
              <li key={offering.offering_id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{offering.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {offering.audience}
                    {offering.service_level.availability_target !== undefined &&
                      ` · ${offering.service_level.availability_target}% availability`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{offering.lifecycle}</Badge>
                  {/* PATCH /service-offerings/:id requires 'write' */}
                  <RequirePermission permission="write">
                    <Button size="sm" variant="ghost" aria-label={`Edit ${offering.name}`} onClick={() => startEdit(offering)}>
                      Edit
                    </Button>
                  </RequirePermission>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* POST /business-services/:id/offerings requires 'write' */}
        <RequirePermission permission="write">
          <div className="grid gap-3 pt-2">
            <div className="grid gap-2">
              <Label htmlFor="offering-name">Offering name</Label>
              <Input id="offering-name" value={form.name} onChange={set('name')} placeholder="e.g. Standard access request" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="offering-description">Description</Label>
              <Input id="offering-description" value={form.description} onChange={set('description')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="offering-audience">Audience</Label>
                <Select value={form.audience} onValueChange={value => setForm(f => ({ ...f, audience: value as Audience }))}>
                  <SelectTrigger id="offering-audience" aria-label="Audience">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="internal">Internal</SelectItem>
                    <SelectItem value="customer">Customer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="offering-lifecycle">Lifecycle</Label>
                <Select value={form.lifecycle} onValueChange={value => setForm(f => ({ ...f, lifecycle: value as Lifecycle }))}>
                  <SelectTrigger id="offering-lifecycle" aria-label="Lifecycle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LIFECYCLES.map((option, index) => (
                      <SelectItem key={option.value} value={option.value} disabled={index < lifecycleFloor}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="offering-availability">Availability target (%)</Label>
                <Input id="offering-availability" type="number" min={0} max={100} step="0.01"
                  value={form.availabilityTarget} onChange={set('availabilityTarget')} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="offering-response">Response target (hours)</Label>
                <Input id="offering-response" type="number" min={0} max={8760}
                  value={form.responseTargetHours} onChange={set('responseTargetHours')} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="offering-support">Support hours</Label>
                <Input id="offering-support" value={form.supportHours} onChange={set('supportHours')} placeholder="e.g. 24x7" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              {editing && (
                <Button variant="outline" onClick={resetForm} disabled={saving}>
                  Cancel edit
                </Button>
              )}
              <Button onClick={handleSave} disabled={saving || form.name.trim().length < 3}>
                {editing ? 'Save offering' : 'Add offering'}
              </Button>
            </div>
          </div>
        </RequirePermission>
      </DialogContent>
    </Dialog>
  );
};
