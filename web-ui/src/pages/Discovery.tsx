// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  ConfirmDialog,
  IconButton,
  PageHeader,
  TabPanel,
  Tabs,
} from '@happy-technologies/design-system';
import DiscoveryDashboard from '../components/discovery/DiscoveryDashboard';
import DiscoveryJobList from '../components/discovery/DiscoveryJobList';
import DiscoveryJobTrigger from '../components/discovery/DiscoveryJobTrigger';
import DiscoveryDefinitionList from '../components/discovery/DiscoveryDefinitionList';
import { useDiscoveryDefinitions } from '../hooks/useDiscoveryDefinitions';
import { isReadMethod, onForbidden } from '@/lib/forbidden';

type DiscoveryTab = 'dashboard' | 'definitions' | 'adhoc' | 'jobs';

const TABS: Array<{ value: DiscoveryTab; label: string }> = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'definitions', label: 'Definitions' },
  { value: 'adhoc', label: 'Ad Hoc' },
  { value: 'jobs', label: 'Jobs' },
];

const TABS_ID = 'discovery-tabs';

export const Discovery: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tabValue, setTabValue] = useState<DiscoveryTab>('dashboard');
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const navigate = useNavigate();

  const {
    definitions,
    loading,
    error,
    loadDefinitions,
    createDefinition,
    updateDefinition,
    deleteDefinition,
    runDefinition,
    enableSchedule,
    disableSchedule,
  } = useDiscoveryDefinitions();

  // The hook loads in an effect, so `loading` is false on the first render and again after each load. Until one
  // load has finished the list must read "loading", not "no definitions".
  const [loadStarted, setLoadStarted] = useState(false);
  const [loadSettled, setLoadSettled] = useState(false);
  useEffect(() => {
    if (loading) setLoadStarted(true);
    else if (loadStarted) setLoadSettled(true);
  }, [loading, loadStarted]);

  // The hook reports a failed read as a message only. A primary read the server refused (403) also reaches the
  // global ForbiddenHost; remember its reason so a refused read shows "not permitted", not a generic failure.
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(
    () =>
      onForbidden((event) => {
        if (isReadMethod(event.method) && !event.sideRead) setRefusal(event.reason);
      }),
    [],
  );
  useEffect(() => {
    if (loading) setRefusal(null);
  }, [loading]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && TABS.some((t) => t.value === tab)) {
      setTabValue(tab as DiscoveryTab);
    }
  }, [searchParams]);

  const handleTabChange = (newValue: DiscoveryTab) => {
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
      <PageHeader
        eyebrow="Infrastructure · Discovery"
        title="Discovery"
        lede="Discover and catalog CIs from cloud providers, servers, and network devices"
        actions={
          <IconButton
            icon="question"
            variant="ghost"
            shape="rounded"
            aria-label="Help"
            onClick={() => setShowHelpDialog(true)}
          />
        }
      />

      <ConfirmDialog
        open={showHelpDialog}
        title="Need to integrate with ITSM or monitoring platforms?"
        body={
          <div className="space-y-3">
            <p>
              For bi-directional sync with ServiceNow, Jira, Datadog, or other external systems, use the
              <strong> Connector Marketplace </strong> instead.
            </p>
            <p>
              Discovery is for one-way infrastructure scanning from cloud providers, servers, and network devices.
            </p>
          </div>
        }
        confirmLabel="Go to Connectors"
        cancelLabel="Close"
        onConfirm={() => {
          setShowHelpDialog(false);
          navigate('/connectors');
        }}
        onCancel={() => setShowHelpDialog(false)}
      />

      <div className="space-y-6">
        <Tabs id={TABS_ID} value={tabValue} onChange={handleTabChange} options={TABS} aria-label="Discovery sections" />

        {/* Only the selected panel is mounted: each tab loads its own data when it opens. */}
        {tabValue === 'dashboard' && (
          <TabPanel tabsId={TABS_ID} value="dashboard" selected>
            <DiscoveryDashboard key={`dashboard-${tabValue}`} />
          </TabPanel>
        )}

        {tabValue === 'definitions' && (
          <TabPanel tabsId={TABS_ID} value="definitions" selected>
            <DiscoveryDefinitionList
              key={`definitions-${tabValue}`}
              definitions={definitions}
              loading={loading || !loadSettled}
              error={error}
              forbiddenReason={refusal}
              onRetry={loadDefinitions}
              onCreateDefinition={createDefinition}
              onUpdateDefinition={updateDefinition}
              onDeleteDefinition={deleteDefinition}
              onRunDefinition={handleRunDefinition}
              onToggleSchedule={handleToggleSchedule}
            />
          </TabPanel>
        )}

        {tabValue === 'adhoc' && (
          <TabPanel tabsId={TABS_ID} value="adhoc" selected>
            <DiscoveryJobTrigger key={`adhoc-${tabValue}`} />
          </TabPanel>
        )}

        {tabValue === 'jobs' && (
          <TabPanel tabsId={TABS_ID} value="jobs" selected>
            <DiscoveryJobList key={`jobs-${tabValue}`} />
          </TabPanel>
        )}
      </div>
    </div>
  );
};

export default Discovery;
