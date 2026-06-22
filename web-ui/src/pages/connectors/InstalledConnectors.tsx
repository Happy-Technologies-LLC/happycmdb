// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import DataTable from '@/components/common/DataTable';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import {
  connectorService,
  InstalledConnector,
} from '@/services/connector.service';
import { useToast } from '@/contexts/ToastContext';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import type { DataTableColumn } from '@/types';

export default function InstalledConnectors() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [connectors, setConnectors] = useState<InstalledConnector[]>([]);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [connectorToDelete, setConnectorToDelete] = useState<InstalledConnector | null>(null);

  useEffect(() => {
    loadConnectors();
  }, []);

  const loadConnectors = async () => {
    try {
      setLoading(true);
      const data = await connectorService.getInstalledConnectors();
      setConnectors(data);
    } catch (error: any) {
      showToast(error.message || 'Failed to load installed connectors', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleUninstall = async () => {
    if (!connectorToDelete) return;

    try {
      setUninstalling(connectorToDelete.connectorType);
      const result = await connectorService.uninstallConnector(
        connectorToDelete.connectorType
      );

      if (result.success) {
        showToast(`${connectorToDelete.name} uninstalled successfully`, 'success');
        await loadConnectors();
      } else {
        showToast(result.message || 'Unknown error occurred', 'error');
      }
    } catch (error: any) {
      showToast(error.message || 'Failed to uninstall connector', 'error');
    } finally {
      setUninstalling(null);
      setConnectorToDelete(null);
    }
  };

  const handleUpdate = async (connector: InstalledConnector) => {
    try {
      const result = await connectorService.updateConnector(connector.connectorType);

      if (result.success) {
        showToast(`${connector.name} updated from v${result.previousVersion} to v${result.newVersion}`, 'success');
        await loadConnectors();
      } else {
        showToast(result.message || 'Unknown error occurred', 'error');
      }
    } catch (error: any) {
      showToast(error.message || 'Failed to update connector', 'error');
    }
  };

  const getSuccessRate = (connector: InstalledConnector) => {
    if (connector.totalRuns === 0) return 0;
    return Math.round((connector.successfulRuns / connector.totalRuns) * 100);
  };

  const hasUpdate = (connector: InstalledConnector) => {
    return (
      connector.latestAvailableVersion &&
      connector.installedVersion !== connector.latestAvailableVersion
    );
  };

  const columns: DataTableColumn<InstalledConnector>[] = [
    {
      field: 'name',
      headerName: 'Connector',
      flex: 2,
      renderCell: (value: unknown, row: InstalledConnector) => (
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{value as React.ReactNode}</span>
            {row.verified && <Icon name="check-circle" size={16} className="text-green-500" />}
          </div>
          <div className="text-xs text-muted-foreground">{row.connectorType}</div>
        </div>
      ),
    },
    {
      field: 'category',
      headerName: 'Category',
      flex: 1,
      renderCell: (value: unknown) => (
        <Badge variant={value === 'DISCOVERY' ? 'default' : 'secondary'}>
          {value === 'DISCOVERY' ? 'Discovery' : 'Connector'}
        </Badge>
      ),
    },
    {
      field: 'installedVersion',
      headerName: 'Version',
      flex: 1,
      renderCell: (value: unknown, row: InstalledConnector) => (
        <div>
          <div className="text-sm">v{value as React.ReactNode}</div>
          {hasUpdate(row) && (
            <div className="flex items-center gap-1 text-xs text-yellow-600">
              <Icon name="trend-up" size={12} />
              v{row.latestAvailableVersion}
            </div>
          )}
        </div>
      ),
    },
    {
      field: 'enabled',
      headerName: 'Status',
      flex: 1,
      renderCell: (value: unknown) => (
        <Badge variant={value ? 'success' : 'outline'}>
          {value ? 'Enabled' : 'Disabled'}
        </Badge>
      ),
    },
    {
      field: 'totalRuns',
      headerName: 'Usage',
      flex: 1,
      renderCell: (value: unknown, row: InstalledConnector) => (
        <div>
          <div className="text-sm">{value as React.ReactNode} runs</div>
          <div className="text-xs text-muted-foreground">
            {getSuccessRate(row)}% success
          </div>
        </div>
      ),
    },
    {
      field: 'lastRunAt',
      headerName: 'Last Run',
      flex: 1,
      renderCell: (value: unknown, row: InstalledConnector) => {
        if (!value) return <span className="text-muted-foreground">Never</span>;
        return (
          <div>
            <div className="text-sm">
              {formatDistanceToNow(new Date(value as string | number | Date), { addSuffix: true })}
            </div>
            {row.lastRunStatus && (
              <Badge
                variant={row.lastRunStatus === 'completed' ? 'success' : 'destructive'}
                className="text-xs"
              >
                {row.lastRunStatus}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      field: 'installedAt',
      headerName: 'Installed',
      flex: 1,
      renderCell: (value: unknown) => (
        <span className="text-sm">
          {formatDistanceToNow(new Date(value as string | number | Date), { addSuffix: true })}
        </span>
      ),
    },
  ];

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">Installed Connectors</h1>
          <p className="text-muted-foreground">
            Manage your installed connectors and view usage statistics
          </p>
        </div>
        <Button onClick={() => navigate('/connectors/catalog')}>
          Browse Catalog
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-lg border bg-card">
          <div className="text-2xl font-bold">{connectors.length}</div>
          <div className="text-sm text-muted-foreground">Total Installed</div>
        </div>
        <div className="p-4 rounded-lg border bg-card">
          <div className="text-2xl font-bold">
            {connectors.filter((c) => c.enabled).length}
          </div>
          <div className="text-sm text-muted-foreground">Enabled</div>
        </div>
        <div className="p-4 rounded-lg border bg-card">
          <div className="text-2xl font-bold">
            {connectors.filter((c) => hasUpdate(c)).length}
          </div>
          <div className="text-sm text-muted-foreground">Updates Available</div>
        </div>
        <div className="p-4 rounded-lg border bg-card">
          <div className="text-2xl font-bold">
            {Math.round(
              connectors.reduce((acc, c) => acc + getSuccessRate(c), 0) /
                (connectors.length || 1)
            )}
            %
          </div>
          <div className="text-sm text-muted-foreground">Avg Success Rate</div>
        </div>
      </div>

      {/* Connectors Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={connectors}
          loading={loading}
          emptyMessage="No connectors installed. Browse the catalog to install connectors."
          onView={(connector) => navigate(`/connectors/${connector.id}/configs`)}
          onEdit={(connector) =>
            hasUpdate(connector) ? handleUpdate(connector) : undefined
          }
          onDelete={(connector) => setConnectorToDelete(connector)}
          rowIdField="id"
        />
      )}

      {/* Uninstall Confirmation Dialog */}
      <AlertDialog
        open={!!connectorToDelete}
        onOpenChange={() => setConnectorToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall Connector</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to uninstall <strong>{connectorToDelete?.name}</strong>?
              This will remove all configurations and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {connectorToDelete && connectorToDelete.totalRuns > 0 && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-yellow-50 dark:bg-yellow-950">
              <Icon name="warning-circle" size={16} className="text-yellow-600 mt-0.5" />
              <div className="text-sm text-yellow-800 dark:text-yellow-200">
                This connector has {connectorToDelete.totalRuns} recorded runs. Historical
                data will be preserved.
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!uninstalling}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUninstall}
              disabled={!!uninstalling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {uninstalling ? 'Uninstalling...' : 'Uninstall'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
