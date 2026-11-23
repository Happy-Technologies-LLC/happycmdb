// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  ListRow,
  SectionHeading,
  Select,
  type BadgeVariant,
} from '@happy-technologies/design-system';
import { apiClient } from '../../lib/api-client';
import { useToast } from '../../contexts/ToastContext';
import { logClientError } from '../../utils/logger';
import { RequirePermission } from '@/components/common/RequirePermission';
import { QueryState } from '@/components/estate/SurfaceState';

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

const AUDIENCES: { value: Audience; label: string }[] = [
  { value: 'internal', label: 'Internal' },
  { value: 'customer', label: 'Customer' },
];

const LIFECYCLE_VARIANTS: Record<Lifecycle, BadgeVariant> = {
  planned: 'info',
  live: 'success',
  retiring: 'warning',
  retired: 'neutral',
};

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
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  const serviceId = service?.id;

  useEffect(() => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOfferings([]);
    setLoadError(null);
    if (!serviceId) return;
    let current = true;
    setLoading(true);
    apiClient
      .get<Envelope<ServiceOffering[]>>(`/business-services/${encodeURIComponent(serviceId)}/offerings`)
      .then(response => { if (current) setOfferings(response.data); })
      .catch(error => {
        logClientError('Failed to load service offerings:', error);
        if (current) {
          setLoadError(error);
          showToast('Failed to load service offerings', 'error');
        }
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [serviceId, showToast, attempt]);

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

  // Lifecycle moves only forward; the server refuses a backward move with 409, so a backward step is not offered.
  const lifecycleFloor = editing ? LIFECYCLES.findIndex(l => l.value === editing.lifecycle) : 0;
  const set = (key: keyof OfferingForm) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [key]: event.target.value }));

  return (
    <Dialog
      open={service !== null}
      onClose={onClose}
      aria-label={`Offerings: ${service?.name}`}
      className="max-w-2xl overflow-visible!"
    >
      <div className="grid gap-4 p-6">
        <div className="pr-8">
          <SectionHeading className="mb-1">Offerings: {service?.name}</SectionHeading>
          <p className="text-sm text-[var(--hh-text-muted)]">
            What this service offers and at which service level. Retire an offering by moving it to Retired.
          </p>
        </div>

        {loading || loadError !== null ? (
          <QueryState what="offerings" loading={loading} error={loadError} onRetry={() => setAttempt(n => n + 1)} />
        ) : offerings.length === 0 ? (
          <EmptyState label="No offerings yet." />
        ) : (
          <ul className="max-h-64 overflow-y-auto">
            {offerings.map(offering => (
              <ListRow
                key={offering.offering_id}
                as="li"
                title={offering.name}
                description={
                  <>
                    {offering.audience}
                    {offering.service_level.availability_target !== undefined &&
                      ` · ${offering.service_level.availability_target}% availability`}
                  </>
                }
                actions={
                  <>
                    <Badge variant={LIFECYCLE_VARIANTS[offering.lifecycle] ?? 'neutral'}>{offering.lifecycle}</Badge>
                    {/* PATCH /service-offerings/:id requires 'write' */}
                    <RequirePermission permission="write">
                      <Button size="sm" variant="ghost" aria-label={`Edit ${offering.name}`} onClick={() => startEdit(offering)}>
                        Edit
                      </Button>
                    </RequirePermission>
                  </>
                }
              />
            ))}
          </ul>
        )}

        {/* POST /business-services/:id/offerings requires 'write' */}
        <RequirePermission permission="write">
          <div className="grid gap-3 pt-2">
            <Input label="Offering name" value={form.name} onChange={set('name')} placeholder="e.g. Standard access request" />
            <Input label="Description" value={form.description} onChange={set('description')} />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Audience"
                value={form.audience}
                onChange={value => setForm(f => ({ ...f, audience: value as Audience }))}
                options={AUDIENCES}
              />
              <Select
                label="Lifecycle"
                value={form.lifecycle}
                onChange={value => setForm(f => ({ ...f, lifecycle: value as Lifecycle }))}
                options={LIFECYCLES.filter((_, index) => index >= lifecycleFloor)}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Input label="Availability target (%)" type="number" min={0} max={100} step="0.01"
                value={form.availabilityTarget} onChange={set('availabilityTarget')} />
              <Input label="Response target (hours)" type="number" min={0} max={8760}
                value={form.responseTargetHours} onChange={set('responseTargetHours')} />
              <Input label="Support hours" value={form.supportHours} onChange={set('supportHours')} placeholder="e.g. 24x7" />
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
      </div>
    </Dialog>
  );
};
