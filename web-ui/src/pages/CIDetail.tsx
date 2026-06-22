// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useParams, useNavigate } from 'react-router-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import CIDetail from '../components/ci/CIDetail';

/**
 * CIDetail Page
 * Displays detailed information about a specific Configuration Item
 */
export const CIDetailPage: React.FC = () => {
  const { ciId } = useParams<{ ciId: string }>();
  const navigate = useNavigate();

  const handleBack = () => {
    navigate('/cis');
  };

  const handleEdit = () => {
    // Navigate to inventory page for editing
    navigate('/inventory');
  };

  const handleDelete = () => {
    // Navigate to inventory page for deletion
    navigate('/inventory');
  };

  if (!ciId) {
    return (
      <div>
        <Alert variant="destructive">
          <Icon name="warning-circle" size={16} />
          <AlertDescription>Invalid CI ID</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div>
      <CIDetail
        ciId={ciId}
        onBack={handleBack}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    </div>
  );
};

export default CIDetailPage;
