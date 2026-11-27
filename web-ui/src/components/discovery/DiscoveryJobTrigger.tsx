// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Banner, Card, SectionHeading } from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { DiscoveryProvider, DiscoveryDefinitionInput } from '../../services/discovery.service';
import { useDiscovery } from '../../hooks/useDiscovery';
import { useDiscoveryDefinitions } from '../../hooks/useDiscoveryDefinitions';
import DiscoveryDefinitionForm from './DiscoveryDefinitionForm';
import { logClientError } from '../../utils/logger';

export const DiscoveryJobTrigger: React.FC = () => {
  const navigate = useNavigate();
  const { triggerJob, loading: triggerLoading } = useDiscovery();
  const { createDefinition } = useDiscoveryDefinitions();

  const handleRunAdHoc = async (data: DiscoveryDefinitionInput) => {
    // Trigger ad-hoc job with the configuration
    const job = await triggerJob({
      provider: data.provider,
      config: data.config as any,
    });

    if (job) {
      navigate('/discovery?tab=jobs');
    }
  };

  const handleSaveAndRun = async (data: DiscoveryDefinitionInput) => {
    try {
      // Create the definition first
      await createDefinition(data);

      // Then run it ad-hoc
      await handleRunAdHoc(data);
    } catch (error) {
      logClientError('Failed to save definition:', error);
    }
  };

  return (
    <Card>
      <div className="mb-6">
        <SectionHeading className="mb-1">Ad Hoc Discovery</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Run a one-time discovery job. Optionally save the configuration as a reusable definition.
        </p>
      </div>

      <Banner tone="info" icon="info" className="mb-6">
        Configure your discovery settings below. Click <strong>Run Once</strong> for a one-time job, or <strong>Save & Run</strong> to create a reusable definition.
      </Banner>

      <DiscoveryDefinitionForm
        showAdHocAction={true}
        onAdHocRun={handleRunAdHoc}
        onSubmit={handleSaveAndRun}
        onCancel={() => navigate('/discovery?tab=dashboard')}
      />
    </Card>
  );
};

export default DiscoveryJobTrigger;
