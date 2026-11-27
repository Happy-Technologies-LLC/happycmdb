// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Database settings component (admin only)
 * View database connection status and health
 */

import React, { useState, useEffect } from 'react';
import {
  Badge,
  Card,
  EmptyState,
  FieldList,
  Icon,
  SectionHeading,
  type BadgeVariant,
} from '@happy-technologies/design-system';
import { apiClient } from '../../services/api';
import { QueryState } from '@/components/estate/SurfaceState';
import { logClientError } from '@/utils/logger';

interface DatabaseStatus {
  name: string;
  type: 'neo4j' | 'postgresql' | 'redis';
  status: 'connected' | 'disconnected' | 'error';
  details: {
    uri?: string;
    host?: string;
    port?: number;
    database?: string;
    version?: string;
  };
}

const mono = (value: React.ReactNode) => <span className="hh-mono text-[13px]">{value}</span>;

export const DatabaseSettings: React.FC = () => {
  const [databases, setDatabases] = useState<DatabaseStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Kept as an error so QueryState can tell a refused read (403) from any other failure.
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    fetchDatabaseStatus();
  }, []);

  const fetchDatabaseStatus = async () => {
    setLoadError(null);
    setIsLoading(true);
    try {
      const response = await apiClient.get<{ databases: DatabaseStatus[] }>('/settings/database');
      setDatabases(response.data.databases);
    } catch (error: any) {
      logClientError('Failed to fetch database status:', error);
      setDatabases([]);
      setLoadError(
        error.response?.status === 403
          ? error
          : new Error(error.response?.data?.message || 'Failed to load database status')
      );
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusVariant = (status: string): BadgeVariant => {
    switch (status) {
      case 'connected':
        return 'success';
      case 'error':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected':
        return <Icon name="check-circle" size={20} className="text-[var(--hh-success-text)]" />;
      case 'disconnected':
      case 'error':
        return <Icon name="x-circle" size={20} className="text-[var(--hh-error-text)]" />;
      default:
        return <Icon name="spinner-gap" size={20} className="animate-spin" />;
    }
  };

  const hasFailed = loadError !== null;

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading className="mb-1">Database Settings</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          View database connection status and information (read-only)
        </p>
      </div>

      {(isLoading || hasFailed) && (
        <QueryState
          what="database status"
          loading={isLoading}
          error={loadError}
          onRetry={fetchDatabaseStatus}
        />
      )}

      {!isLoading && !hasFailed && databases.length === 0 && (
        <EmptyState label="No database status available." />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {databases.map((db) => {
          const fields: Array<[string, React.ReactNode]> = [
            ['URI', db.details.uri ? mono(db.details.uri) : null],
            ['Host', db.details.host ? mono(db.details.host) : null],
            ['Port', db.details.port ? mono(db.details.port) : null],
            ['Database', db.details.database ? mono(db.details.database) : null],
            ['Version', db.details.version ? mono(db.details.version) : null],
          ];
          return (
            <Card key={db.name} as="section">
              <SectionHeading
                level={3}
                className="mb-4"
                right={
                  <div className="flex items-center gap-2">
                    {getStatusIcon(db.status)}
                    <Badge variant={getStatusVariant(db.status)}>{db.status.toUpperCase()}</Badge>
                  </div>
                }
              >
                {db.name}
              </SectionHeading>
              {fields.some(([, value]) => value !== null) && (
                <FieldList className="sm:grid-cols-1 lg:grid-cols-1" fields={fields} />
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
};
