// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Button, Dialog, IconButton, PageHeader, SectionHeading, TabPanel, Tabs } from '@happy-technologies/design-system';
import ConnectorDashboard from '../components/connectors/ConnectorDashboard';
import ConnectorDefinitionList from '../components/connectors/ConnectorDefinitionList';
import ConnectorJobList from '../components/connectors/ConnectorJobList';

const TABS_ID = 'connectors-tabs';
const TAB_OPTIONS = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'definitions', label: 'Definitions' },
  { value: 'jobs', label: 'Jobs' },
];

export const Connectors: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tabValue, setTabValue] = useState('dashboard');
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && ['dashboard', 'definitions', 'jobs'].includes(tab)) {
      setTabValue(tab);
    }
  }, [searchParams]);

  const handleTabChange = (newValue: string) => {
    setTabValue(newValue);
    setSearchParams({ tab: newValue });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Integrations · Connectors"
        title="Integration Connectors"
        lede="Deploy bi-directional integrations with ITSM, ticketing, and monitoring systems"
        actions={
          <IconButton
            icon="question"
            variant="ghost"
            aria-label="Help"
            title="Help"
            onClick={() => setShowHelpDialog(true)}
          />
        }
      />

      <Dialog
        open={showHelpDialog}
        onClose={() => setShowHelpDialog(false)}
        aria-label="Looking for Cloud Infrastructure Discovery?"
      >
        <div className="space-y-3 p-6 pr-12">
          <SectionHeading level={2}>Looking for Cloud Infrastructure Discovery?</SectionHeading>
          <p className="text-sm">
            For discovering CIs from AWS, Azure, GCP, Kubernetes, SSH, and network devices, use the
            <strong> Discovery </strong> feature instead.
          </p>
          <p className="text-sm">
            Connectors are for bi-directional synchronization with external ITSM and monitoring platforms
            like ServiceNow, Jira, Datadog, and Splunk.
          </p>
          <Button
            iconRight="arrow-right"
            onClick={() => {
              setShowHelpDialog(false);
              navigate('/discovery');
            }}
          >
            Go to Discovery
          </Button>
        </div>
      </Dialog>

      <Tabs id={TABS_ID} aria-label="Connector views" value={tabValue} onChange={handleTabChange} options={TAB_OPTIONS} />

      {/* Only the selected panel mounts its screen: each one refetches when its tab opens. */}
      <TabPanel tabsId={TABS_ID} value="dashboard" selected={tabValue === 'dashboard'}>
        {tabValue === 'dashboard' && <ConnectorDashboard key={`dashboard-${tabValue}`} />}
      </TabPanel>
      <TabPanel tabsId={TABS_ID} value="definitions" selected={tabValue === 'definitions'}>
        {tabValue === 'definitions' && <ConnectorDefinitionList key={`definitions-${tabValue}`} />}
      </TabPanel>
      <TabPanel tabsId={TABS_ID} value="jobs" selected={tabValue === 'jobs'}>
        {tabValue === 'jobs' && <ConnectorJobList key={`jobs-${tabValue}`} />}
      </TabPanel>
    </div>
  );
};

export default Connectors;
