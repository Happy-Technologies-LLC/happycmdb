// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings page
 * Tabbed interface for different settings categories
 */

import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '@happy-technologies/design-system';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { useAuth } from '../hooks/useAuth';
import { GeneralSettings } from '../components/settings/GeneralSettings';
import { DiscoverySettings } from '../components/settings/DiscoverySettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { UserProfile } from '../components/settings/UserProfile';
import { ApiKeysManager } from '../components/settings/ApiKeysManager';
import { DatabaseSettings } from '../components/settings/DatabaseSettings';

export const Settings: React.FC = () => {
  const { hasRole } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') || 'general';

  const [activeTab, setActiveTab] = useState<string>(tabParam);
  const isAdmin = hasRole(['admin']);

  const handleTabChange = (newValue: string) => {
    setActiveTab(newValue);
    setSearchParams({ tab: newValue });
  };

  return (
    <div>
      <div className="mb-6">
        <Eyebrow>Platform · Settings</Eyebrow>
        <h1 className="mt-3 text-[1.9rem]">Settings</h1>
        <p className="mt-1.5 text-ink-soft">
          Manage your application preferences and configurations
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <Card>
          <TabsList className="w-full justify-start overflow-x-auto flex-nowrap">
            <TabsTrigger value="general" className="gap-2">
              <Icon name="gear-six" size={16} />
              General
            </TabsTrigger>
            <TabsTrigger value="discovery" className="gap-2">
              <Icon name="cloud" size={16} />
              Discovery
            </TabsTrigger>
            <TabsTrigger value="notifications" className="gap-2">
              <Icon name="bell" size={16} />
              Notifications
            </TabsTrigger>
            <TabsTrigger value="profile" className="gap-2">
              <Icon name="user-circle" size={16} />
              Profile
            </TabsTrigger>
            <TabsTrigger value="api-keys" className="gap-2">
              <Icon name="key" size={16} />
              API Keys
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="database" className="gap-2">
                <Icon name="database" size={16} />
                Database
              </TabsTrigger>
            )}
          </TabsList>

          <div className="p-6">
            <TabsContent value="general" className="mt-0">
              <GeneralSettings />
            </TabsContent>

            <TabsContent value="discovery" className="mt-0">
              <DiscoverySettings />
            </TabsContent>

            <TabsContent value="notifications" className="mt-0">
              <NotificationSettings />
            </TabsContent>

            <TabsContent value="profile" className="mt-0">
              <UserProfile />
            </TabsContent>

            <TabsContent value="api-keys" className="mt-0">
              <ApiKeysManager />
            </TabsContent>

            {isAdmin && (
              <TabsContent value="database" className="mt-0">
                <DatabaseSettings />
              </TabsContent>
            )}
          </div>
        </Card>
      </Tabs>
    </div>
  );
};
