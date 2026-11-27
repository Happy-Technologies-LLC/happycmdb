// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings page
 * Tabbed interface for different settings categories
 */

import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, EmptyState, PageHeader, TabPanel, Tabs } from '@happy-technologies/design-system';
import { useAuth } from '../contexts/AuthContext';
import { usePermission } from '@/hooks/usePermission';
import { GeneralSettings } from '../components/settings/GeneralSettings';
import { DiscoverySettings } from '../components/settings/DiscoverySettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { UserProfile } from '../components/settings/UserProfile';
import { ApiKeysManager } from '../components/settings/ApiKeysManager';
import { DatabaseSettings } from '../components/settings/DatabaseSettings';

const TABS_ID = 'settings-tabs';

/** What a role without `write` sees in place of a settings form: no field, no save control. */
function NotPermitted({ what }: { what: string }) {
  return (
    <EmptyState
      icon="lock-key"
      title="Not permitted"
      description={`Changing ${what} needs the write permission, which your role does not hold.`}
    />
  );
}

export const Settings: React.FC = () => {
  const { hasRole } = useAuth();
  const canWrite = usePermission('write');
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') || 'general';

  const [activeTab, setActiveTab] = useState<string>(tabParam);
  const isAdmin = hasRole(['admin']);

  const handleTabChange = (newValue: string) => {
    setActiveTab(newValue);
    setSearchParams({ tab: newValue });
  };

  const tabs = [
    { value: 'general', label: 'General', icon: 'gear-six' },
    { value: 'discovery', label: 'Discovery', icon: 'cloud' },
    { value: 'notifications', label: 'Notifications', icon: 'bell' },
    { value: 'profile', label: 'Profile', icon: 'user-circle' },
    { value: 'api-keys', label: 'API Keys', icon: 'key' },
    ...(isAdmin ? [{ value: 'database', label: 'Database', icon: 'database' }] : []),
  ];

  // Panels stay mounted (the DS TabPanel keeps aria-controls valid) but only the active one renders its content,
  // so a tab's reads are not issued until it is opened.
  const panel = (value: string, content: React.ReactNode) => (
    <TabPanel tabsId={TABS_ID} value={value} selected={activeTab === value}>
      {activeTab === value ? content : null}
    </TabPanel>
  );

  return (
    <div>
      <PageHeader
        className="mb-6"
        eyebrow="Platform · Settings"
        title="Settings"
        lede="Manage your application preferences and configurations"
      />

      <Card inset="none">
        <div className="overflow-x-auto p-3">
          <Tabs
            id={TABS_ID}
            aria-label="Settings sections"
            value={activeTab}
            onChange={handleTabChange}
            options={tabs}
            className="flex-nowrap"
          />
        </div>

        <div className="p-6">
          {panel(
            'general',
            canWrite ? <GeneralSettings /> : <NotPermitted what="general settings" />
          )}
          {panel(
            'discovery',
            canWrite ? <DiscoverySettings /> : <NotPermitted what="discovery settings" />
          )}
          {panel(
            'notifications',
            canWrite ? <NotificationSettings /> : <NotPermitted what="notification settings" />
          )}
          {panel('profile', <UserProfile />)}
          {panel('api-keys', <ApiKeysManager />)}
          {isAdmin && panel('database', <DatabaseSettings />)}
        </div>
      </Card>
    </div>
  );
};
