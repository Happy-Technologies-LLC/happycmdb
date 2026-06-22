// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import CIList from '../components/ci/CIList';

/**
 * CIList Page
 * Displays the list of Configuration Items with search and filter capabilities
 * Supports URL query parameters: ?type=server&status=active&environment=production
 */
export const CIListPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const handleView = (ci: any) => {
    navigate(`/cis/${ci.id}`);
  };

  // Extract filter values from URL query parameters
  const initialType = searchParams.get('type') || '';
  const initialStatus = searchParams.get('status') || '';
  const initialEnvironment = searchParams.get('environment') || '';
  const initialSearch = searchParams.get('search') || '';

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-5 flex-wrap">
        <div>
          <Eyebrow>CMDB · Configuration Items</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">Configuration Items</h1>
          <p className="mt-1.5 text-ink-soft">
            Browse and manage all configuration items in your CMDB
          </p>
        </div>
        <Button onClick={() => navigate('/inventory')}>
          <Icon name="plus" size={16} className="mr-2" />
          Manage CIs
        </Button>
      </div>

      <CIList
        onView={handleView}
        showActions={false}
        initialTypeFilter={initialType as any}
        initialStatusFilter={initialStatus as any}
        initialEnvironmentFilter={initialEnvironment as any}
        initialSearch={initialSearch}
      />
    </div>
  );
};

export default CIListPage;
