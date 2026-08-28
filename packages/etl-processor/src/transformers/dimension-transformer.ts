// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dimension Transformer
 *
 * Transforms CI data into dimensional model structures for the data mart.
 * Supports:
 * - Type 2 Slowly Changing Dimensions (SCD)
 * - Fact table transformations
 * - Date dimension mappings
 * - Location dimension mappings
 */

import { CI, CIType, CIStatus, Environment } from '@cmdb/common';

/**
 * CI Dimension (Type 2 SCD)
 */
export interface CIDimension {
  ci_key?: number;              // Surrogate key (auto-generated)
  _ci_id: string;                // Natural key
  _ci_name: string;
  _ci_type: CIType;
  environment?: Environment;
  _status: CIStatus;
  external_id?: string;
  _effective_date: Date;         // When this version became effective
  end_date?: Date;              // When this version expired (null = current)
  _is_current: boolean;          // Flag for current version
  created_at?: Date;
  updated_at?: Date;
}

/**
 * Location Dimension
 */
export interface LocationDimension {
  location_key?: number;        // Surrogate key
  _region: string;
  availability_zone?: string;
  data_center?: string;
  cloud_provider?: string;
  country?: string;
}

/**
 * Date Dimension (for temporal analysis)
 */
export interface DateDimension {
  _date_key: number;             // Format: YYYYMMDD
  _full_date: Date;
  _year: number;
  _quarter: number;
  _month: number;
  _month_name: string;
  _week: number;
  _day_of_month: number;
  _day_of_week: number;
  _day_name: string;
  _is_weekend: boolean;
  is_holiday?: boolean;
}

/**
 * Discovery Fact
 */
export interface DiscoveryFact {
  _ci_key: number;               // FK to dim_ci
  location_key?: number;        // FK to dim_location
  _date_key: number;             // FK to dim_date
  _discovered_at: Date;
  _discovery_method: string;
  _discovery_source: string;
  discovery_duration_ms?: number;
}

/**
 * Relationship Fact
 */
export interface RelationshipFact {
  _from_ci_key: number;          // FK to dim_ci
  _to_ci_key: number;            // FK to dim_ci
  _relationship_type: string;
  relationship_key?: number;
  _effective_date: Date;
  end_date?: Date;
  _is_current: boolean;
}

/**
 * Change Fact
 */
export interface ChangeFact {
  change_key?: number;          // Surrogate key
  _ci_key: number;               // FK to dim_ci
  _date_key: number;             // FK to dim_date
  _change_type: string;
  _field_name: string;
  old_value?: string;
  new_value?: string;
  _changed_at: Date;
  _changed_by: string;
}

/**
 * Main dimension transformer class
 */
export class DimensionTransformer {

  /**
   * Transform CI to dimension record
   */
  toDimension(ci: CI): CIDimension {
    return {
      _ci_id: ci._id,
      _ci_name: ci.name,
      _ci_type: ci._type,
      environment: ci.environment,
      _status: ci._status,
      external_id: ci.external_id,
      _effective_date: new Date(),
      end_date: undefined,
      _is_current: true,
      created_at: new Date(ci._created_at),
      updated_at: new Date(ci._updated_at)
    };
  }

  /**
   * Transform CI to discovery fact
   */
  toDiscoveryFact(ci: CI, ciKey?: number): Partial<DiscoveryFact> {
    const discoveredAt = new Date(ci._discovered_at);

    return {
      _ci_key: ciKey,
      _date_key: this.generateDateKey(discoveredAt),
      _discovered_at: discoveredAt,
      _discovery_method: this.inferDiscoveryMethod(ci),
      _discovery_source: this.inferDiscoverySource(ci)
    };
  }

  /**
   * Create location dimension from CI metadata
   */
  toLocationDimension(ci: CI): LocationDimension | null {
    const metadata = ci._metadata || {};

    // Extract location information from metadata
    const region = metadata['region'] || metadata['aws_region'] || metadata['azure_region'];
    const az = metadata['availability_zone'] || metadata['az'];
    const provider = metadata['cloud_provider'] || this.inferProvider(metadata);

    if (!region && !provider) {
      return null; // Not enough location data
    }

    return {
      _region: region || 'unknown',
      availability_zone: az,
      data_center: metadata['datacenter'] || metadata['data_center'],
      cloud_provider: provider,
      country: metadata['country']
    };
  }

  /**
   * Generate date dimension record
   */
  toDateDimension(date: Date): DateDimension {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const dayOfWeek = date.getUTCDay();

    // Calculate quarter
    const quarter = Math.ceil(month / 3);

    // Calculate week number (ISO week)
    const weekNumber = this.getWeekNumber(date);

    return {
      _date_key: this.generateDateKey(date),
      _full_date: date,
      _year: year,
      _quarter: quarter,
      _month: month,
      _month_name: monthNames[month - 1]!,
      _week: weekNumber,
      _day_of_month: day,
      _day_of_week: dayOfWeek,
      _day_name: dayNames[dayOfWeek]!,
      _is_weekend: dayOfWeek === 0 || dayOfWeek === 6
    };
  }

  /**
   * Transform relationship to fact
   */
  toRelationshipFact(
    _fromCiKey: number,
    _toCiKey: number,
    _relationshipType: string
  ): RelationshipFact {
    return {
      _from_ci_key: _fromCiKey,
      _to_ci_key: _toCiKey,
      _relationship_type: _relationshipType,
      _effective_date: new Date(),
      end_date: undefined,
      _is_current: true
    };
  }

  /**
   * Transform change event to fact
   */
  toChangeFact(
    _ciKey: number,
    _changeType: string,
    _fieldName: string,
    _oldValue: any,
    _newValue: any,
    _changedBy: string = 'system'
  ): ChangeFact {
    const changedAt = new Date();

    return {
      _ci_key: _ciKey,
      _date_key: this.generateDateKey(changedAt),
      _change_type: _changeType,
      _field_name: _fieldName,
      old_value: this.serializeValue(_oldValue),
      new_value: this.serializeValue(_newValue),
      _changed_at: changedAt,
      _changed_by: _changedBy
    };
  }

  /**
   * Generate surrogate key from natural key (for testing/mocking)
   */
  generateSurrogateKey(naturalKey: string): number {
    // Simple hash function for demonstration
    // In production, this would be auto-generated by database
    let hash = 0;
    for (let i = 0; i < naturalKey.length; i++) {
      const char = naturalKey.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Generate date key (YYYYMMDD format)
   */
  generateDateKey(date: Date): number {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return parseInt(`${year}${month}${day}`, 10);
  }

  /**
   * Parse date key back to Date
   */
  parseDateKey(dateKey: number): Date {
    const str = dateKey.toString();
    const year = parseInt(str.substring(0, 4));
    const month = parseInt(str.substring(4, 6)) - 1;
    const day = parseInt(str.substring(6, 8));
    return new Date(Date.UTC(year, month, day));
  }

  /**
   * Create Type 2 SCD update (close old record, create new)
   */
  createSCDUpdate(
    _currentDimension: CIDimension,
    _updates: Partial<CIDimension>
  ): { close: Partial<CIDimension>; insert: CIDimension } {
    const now = new Date();

    // Record to close current version
    const close: Partial<CIDimension> = {
      ci_key: _currentDimension.ci_key,
      end_date: now,
      _is_current: false
    };

    // New version to insert
    const insert: CIDimension = {
      ..._currentDimension,
      ..._updates,
      ci_key: undefined, // Will be auto-generated
      _effective_date: now,
      end_date: undefined,
      _is_current: true,
      updated_at: now
    };

    return { close, insert };
  }

  /**
   * Infer discovery method from CI data
   */
  private inferDiscoveryMethod(ci: CI): string {
    const metadata = ci._metadata || {};

    if (metadata['discovery_method']) {
      return metadata['discovery_method'];
    }

    // Infer based on CI type and metadata
    if (metadata['aws_instance_id']) return 'aws-discovery';
    if (metadata['azure_vm_id']) return 'azure-discovery';
    if (metadata['gcp_instance_id']) return 'gcp-discovery';

    return 'manual';
  }

  /**
   * Infer discovery source from CI data
   */
  private inferDiscoverySource(ci: CI): string {
    const metadata = ci._metadata || {};

    if (metadata['discovery_source']) {
      return metadata['discovery_source'];
    }

    if (metadata['aws_account_id']) return `aws:${metadata['aws_account_id']}`;
    if (metadata['azure_subscription_id']) return `azure:${metadata['azure_subscription_id']}`;
    if (metadata['gcp_project_id']) return `gcp:${metadata['gcp_project_id']}`;

    return 'unknown';
  }

  /**
   * Infer cloud provider from metadata
   */
  private inferProvider(metadata: Record<string, any>): string | undefined {
    if (metadata['aws_account_id'] || metadata['aws_region']) return 'aws';
    if (metadata['azure_subscription_id'] || metadata['azure_region']) return 'azure';
    if (metadata['gcp_project_id'] || metadata['gcp_zone']) return 'gcp';
    return undefined;
  }

  /**
   * Get ISO week number
   */
  private getWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  /**
   * Serialize value for storage (handle complex types)
   */
  private serializeValue(value: any): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  }
}
