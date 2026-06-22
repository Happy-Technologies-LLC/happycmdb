// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@happy-technologies/design-system';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import DiscoveryDashboard from '../components/discovery/DiscoveryDashboard';
import DiscoveryJobList from '../components/discovery/DiscoveryJobList';
import DiscoveryJobTrigger from '../components/discovery/DiscoveryJobTrigger';
import DiscoveryDefinitionList from '../components/discovery/DiscoveryDefinitionList';
import { useDiscoveryDefinitions } from '../hooks/useDiscoveryDefinitions';

export const Discovery: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tabValue, setTabValue] = useState('dashboard');
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const navigate = useNavigate();

  const {
    definitions,
    loading,
    loadDefinitions,
    createDefinition,
    updateDefinition,
    deleteDefinition,
    runDefinition,
    enableSchedule,
    disableSchedule,
  } = useDiscoveryDefinitions();

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && ['dashboard', 'definitions', 'adhoc', 'jobs'].includes(tab)) {
      setTabValue(tab);
    }
  }, [searchParams]);

  const handleTabChange = (newValue: string) => {
    setTabValue(newValue);
    setSearchParams({ tab: newValue });

    // Refresh data when switching to specific tabs
    if (newValue === 'definitions') {
      loadDefinitions();
    }
  };

  const handleToggleSchedule = async (id: string, enabled: boolean): Promise<void> => {
    if (enabled) {
      await enableSchedule(id);
    } else {
      await disableSchedule(id);
    }
  };

  const handleRunDefinition = async (id: string): Promise<void> => {
    await runDefinition(id);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <Eyebrow>Infrastructure · Discovery</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">Discovery</h1>
          <p className="mt-1.5 text-ink-soft">
            Discover and catalog CIs from cloud providers, servers, and network devices
          </p>
        </div>
        <button
          onClick={() => setShowHelpDialog(true)}
          className="p-2 hover:bg-muted rounded-lg transition-colors"
          title="Help"
        >
          <Icon name="question" size={24} className="text-muted-foreground" />
        </button>
      </div>

      {/* Help Dialog */}
      <Dialog open={showHelpDialog} onOpenChange={setShowHelpDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Need to integrate with ITSM or monitoring platforms?</DialogTitle>
            <DialogDescription className="space-y-3 pt-2">
              <p>
                For bi-directional sync with ServiceNow, Jira, Datadog, or other external systems, use the
                <strong> Connector Marketplace </strong> instead.
              </p>
              <p>
                Discovery is for one-way infrastructure scanning from cloud providers, servers, and network devices.
              </p>
              <Button
                onClick={() => {
                  setShowHelpDialog(false);
                  navigate('/connectors');
                }}
                size="sm"
                className="mt-4"
              >
                Go to Connectors
                <Icon name="arrow-right" size={16} className="ml-2" />
              </Button>
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <Tabs value={tabValue} onValueChange={handleTabChange} className="w-full">
        <LiquidGlass size="sm" rounded="xl" className="mb-6 overflow-hidden">
          <TabsList className="w-full grid grid-cols-4 bg-transparent">
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="definitions">Definitions</TabsTrigger>
            <TabsTrigger value="adhoc">Ad Hoc</TabsTrigger>
            <TabsTrigger value="jobs">Jobs</TabsTrigger>
          </TabsList>
        </LiquidGlass>

        <TabsContent value="dashboard" className="mt-0">
          <DiscoveryDashboard key={`dashboard-${tabValue}`} />
        </TabsContent>

        <TabsContent value="definitions" className="mt-0">
          <DiscoveryDefinitionList
            key={`definitions-${tabValue}`}
            definitions={definitions}
            loading={loading}
            onCreateDefinition={createDefinition}
            onUpdateDefinition={updateDefinition}
            onDeleteDefinition={deleteDefinition}
            onRunDefinition={handleRunDefinition}
            onToggleSchedule={handleToggleSchedule}
          />
        </TabsContent>

        <TabsContent value="adhoc" className="mt-0">
          <DiscoveryJobTrigger key={`adhoc-${tabValue}`} />
        </TabsContent>

        <TabsContent value="jobs" className="mt-0">
          <DiscoveryJobList key={`jobs-${tabValue}`} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Discovery;
