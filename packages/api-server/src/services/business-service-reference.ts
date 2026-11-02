// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Suite Contracts v2 C1 (service reference) fields, projected from the
 * existing dim_business_services columns (HAP-1408). The projection is
 * additive: the stored columns keep their names and meanings.
 *
 * - lifecycle: C1's planned|live|retiring|retired from operational_status
 *   (valid_status CHECK: active, maintenance, inactive, decommissioned).
 *   `planned` has no stored source until the record carries its own
 *   lifecycle (HAP-1423).
 * - owner: display_name is owned_by. principal_id is null: no accountable
 *   human's identity-provider subject is stored before HAP-1423 (D15).
 */

export type C1Lifecycle = 'planned' | 'live' | 'retiring' | 'retired';

const LIFECYCLE_BY_STATUS: Record<string, C1Lifecycle> = {
  active: 'live',
  maintenance: 'live',
  inactive: 'retiring',
  decommissioned: 'retired',
};

export function c1Lifecycle(operationalStatus: string): C1Lifecycle {
  const lifecycle = LIFECYCLE_BY_STATUS[operationalStatus];
  if (!lifecycle) throw new Error('operational_status outside the valid_status constraint');
  return lifecycle;
}

/** A service row as dim_business_services stores it (the columns C1 reads). */
export interface StoredServiceRow {
  service_id: string;
  name: string;
  business_criticality: string;
  operational_status: string;
}

/** A dependency target with the dependency's type, as the reads select it. */
export interface StoredDependencyRow extends StoredServiceRow {
  dependency_type: string;
}

export interface C1ServiceDependency {
  service_id: string;
  name: string;
  criticality: string;
  lifecycle: C1Lifecycle;
  dependency_type: string;
}

export interface C1ServiceReference {
  tenant_id: string;
  owner: { principal_id: null; display_name: string | null };
  criticality: string;
  lifecycle: C1Lifecycle;
  dependencies: C1ServiceDependency[];
}

/** The C1 fields for `row`, added next to the stored columns of the service read. */
export function serviceReference(
  row: StoredServiceRow & { organization_id: string; owned_by: string | null },
  dependencies: StoredDependencyRow[]
): C1ServiceReference {
  return {
    tenant_id: row.organization_id,
    owner: { principal_id: null, display_name: row.owned_by },
    criticality: row.business_criticality,
    lifecycle: c1Lifecycle(row.operational_status),
    dependencies: dependencies.map(dependency => ({
      service_id: dependency.service_id,
      name: dependency.name,
      criticality: dependency.business_criticality,
      lifecycle: c1Lifecycle(dependency.operational_status),
      dependency_type: dependency.dependency_type,
    })),
  };
}
