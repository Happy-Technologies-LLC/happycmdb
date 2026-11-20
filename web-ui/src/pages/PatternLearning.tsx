// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Button, IconButton, PageHeader, Spinner, TabPanel, Tabs } from '@happy-technologies/design-system';
import { PatternLibrary } from '@/components/ai/PatternLibrary';
import { DiscoverySessionsView } from '@/components/ai/DiscoverySessionsView';
import { CostAnalyticsDashboard } from '@/components/ai/CostAnalyticsDashboard';
import { PatternLearningOverview } from '@/components/ai/PatternLearningOverview';
import { RequirePermission } from '@/components/common/RequirePermission';
import { useDiscoverySessions } from '@/hooks/useDiscoverySessions';

type TabValue = 'overview' | 'patterns' | 'sessions' | 'analytics';

const TABS_ID = 'pattern-learning-tabs';
const TAB_OPTIONS: Array<{ value: TabValue; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'patterns', label: 'Pattern Library' },
  { value: 'sessions', label: 'Discovery Sessions' },
  { value: 'analytics', label: 'Cost Analytics' },
];

const PatternLearning: React.FC = () => {
  const [tabValue, setTabValue] = useState<TabValue>('overview');
  const { compileAndSubmitPatterns } = useDiscoverySessions();
  const [compiling, setCompiling] = useState(false);

  const handleCompilePatterns = async () => {
    setCompiling(true);
    try {
      await compileAndSubmitPatterns();
    } finally {
      setCompiling(false);
    }
  };

  // Only the selected tab mounts its view: each one loads its own data.
  const panel = (value: TabValue, view: React.ReactNode) => (
    <TabPanel tabsId={TABS_ID} value={value} selected={tabValue === value} className="space-y-6">
      {tabValue === value && view}
    </TabPanel>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AI · Pattern Learning"
        title="AI Pattern Learning"
        lede="Automatically learn and compile patterns from AI discoveries"
        actions={
          <>
            {/* POST /ai/patterns/compile: requirePermission('write') */}
            <RequirePermission permission="write">
              <Button
                variant="outline"
                size="sm"
                icon={compiling ? undefined : 'arrows-clockwise'}
                onClick={handleCompilePatterns}
                disabled={compiling}
              >
                {compiling && <Spinner size={14} aria-hidden="true" />}
                Compile Patterns
              </Button>
            </RequirePermission>
            <IconButton icon="question" variant="ghost" size="sm" aria-label="Help" />
          </>
        }
      />

      <Tabs
        id={TABS_ID}
        aria-label="Pattern learning sections"
        value={tabValue}
        onChange={setTabValue}
        options={TAB_OPTIONS}
      />

      {panel('overview', <PatternLearningOverview />)}
      {panel('patterns', <PatternLibrary />)}
      {panel('sessions', <DiscoverySessionsView />)}
      {panel('analytics', <CostAnalyticsDashboard />)}
    </div>
  );
};

export default PatternLearning;
