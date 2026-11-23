// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { ErrorBanner } from '@happy-technologies/design-system';
import { useParams, useNavigate } from 'react-router-dom';
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
        <ErrorBanner message="Invalid CI ID" />
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
