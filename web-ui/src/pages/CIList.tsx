// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Button, PageHeader } from '@happy-technologies/design-system';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
    <div className="space-y-6">
      <PageHeader
        eyebrow="CMDB · Configuration Items"
        title="Configuration Items"
        lede="Browse and manage all configuration items in your CMDB"
        actions={
          <Button icon="plus" onClick={() => navigate('/inventory')}>
            Manage CIs
          </Button>
        }
      />

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
