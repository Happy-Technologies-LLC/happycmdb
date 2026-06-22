// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { DiscoveryProvider, DiscoveryDefinitionInput } from '../../services/discovery.service';
import { useDiscovery } from '../../hooks/useDiscovery';
import { useDiscoveryDefinitions } from '../../hooks/useDiscoveryDefinitions';
import { Button } from '../ui/button';
import { LiquidGlass } from '../ui/liquid-glass';
import { Alert, AlertDescription } from '../ui/alert';
import DiscoveryDefinitionForm from './DiscoveryDefinitionForm';

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
      console.error('Failed to save definition:', error);
    }
  };

  return (
    <LiquidGlass size="sm" rounded="xl" className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold">Ad Hoc Discovery</h2>
        <p className="text-sm text-muted-foreground">
          Run a one-time discovery job. Optionally save the configuration as a reusable definition.
        </p>
      </div>

      <Alert className="mb-6">
        <Icon name="info" size={16} />
        <AlertDescription>
          Configure your discovery settings below. Click <strong>Run Once</strong> for a one-time job, or <strong>Save & Run</strong> to create a reusable definition.
        </AlertDescription>
      </Alert>

      <DiscoveryDefinitionForm
        showAdHocAction={true}
        onAdHocRun={handleRunAdHoc}
        onSubmit={handleSaveAndRun}
        onCancel={() => navigate('/discovery?tab=dashboard')}
      />
    </LiquidGlass>
  );
};

export default DiscoveryJobTrigger;
