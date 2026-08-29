// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Database settings component (admin only)
 * View database connection status and health
 */

import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { apiClient } from '../../services/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

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

export const DatabaseSettings: React.FC = () => {
  const [databases, setDatabases] = useState<DatabaseStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchDatabaseStatus();
  }, []);

  const fetchDatabaseStatus = async () => {
    setErrorMessage(null);
    try {
      const response = await apiClient.get<{ databases: DatabaseStatus[] }>('/settings/database');
      setDatabases(response.data.databases);
    } catch (error: any) {
      console.error('Failed to fetch database status:', error);
      setDatabases([]);
      setErrorMessage(
        error.response?.data?.message || 'Failed to load database status'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusVariant = (status: string): 'default' | 'destructive' | 'secondary' => {
    switch (status) {
      case 'connected':
        return 'default';
      case 'disconnected':
        return 'secondary';
      case 'error':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected':
        return <Icon name="check-circle" size={20} className="text-green-600" />;
      case 'disconnected':
      case 'error':
        return <Icon name="x-circle" size={20} className="text-destructive" />;
      default:
        return <Icon name="spinner-gap" size={20} className="animate-spin" />;
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Icon name="spinner-gap" size={32} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Database Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          View database connection status and information (read-only)
        </p>
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {!errorMessage && databases.length === 0 && (
        <p className="text-sm text-muted-foreground">No database status available.</p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {databases.map((db) => (
          <Card key={db.name}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="text-lg">{db.name}</span>
                <div className="flex items-center gap-2">
                  {getStatusIcon(db.status)}
                  <Badge variant={getStatusVariant(db.status)}>
                    {db.status.toUpperCase()}
                  </Badge>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {db.details.uri && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      URI
                    </div>
                    <div className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {db.details.uri}
                    </div>
                  </div>
                )}

                {db.details.host && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Host
                    </div>
                    <div className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {db.details.host}
                    </div>
                  </div>
                )}

                {db.details.port && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Port
                    </div>
                    <div className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {db.details.port}
                    </div>
                  </div>
                )}

                {db.details.database && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Database
                    </div>
                    <div className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {db.details.database}
                    </div>
                  </div>
                )}

                {db.details.version && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Version
                    </div>
                    <div className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {db.details.version}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};
