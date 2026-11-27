// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification settings component
 * Email and in-app notification preferences
 */

import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Banner, Button, Checkbox, SectionHeading, Select } from '@happy-technologies/design-system';
import { apiClient } from '../../services/api';

interface NotificationSettingsData {
  emailOnJobFailure: boolean;
  emailOnJobSuccess: boolean;
  emailOnDiscoveryCompletion: boolean;
  inAppNotifications: boolean;
  emailDigestFrequency: 'never' | 'daily' | 'weekly' | 'monthly';
}

const EMAIL_TOGGLES = [
  { name: 'emailOnJobFailure', id: 'email-job-failure', label: 'Email me when a job fails' },
  { name: 'emailOnJobSuccess', id: 'email-job-success', label: 'Email me when a job succeeds' },
  { name: 'emailOnDiscoveryCompletion', id: 'email-discovery', label: 'Email me when discovery completes' },
] as const;

const DIGEST_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

export const NotificationSettings: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { control, handleSubmit, watch } = useForm<NotificationSettingsData>({
    defaultValues: {
      emailOnJobFailure: true,
      emailOnJobSuccess: false,
      emailOnDiscoveryCompletion: true,
      inAppNotifications: true,
      emailDigestFrequency: 'daily',
    },
  });

  const onSubmit = async (data: NotificationSettingsData) => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      await apiClient.put('/settings/notifications', data);
      setSuccessMessage('Notification settings saved successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (error: any) {
      setErrorMessage(error.response?.data?.message || 'Failed to save notification settings');
      setTimeout(() => setErrorMessage(null), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading className="mb-1">Notification Settings</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Configure how you receive notifications
        </p>
      </div>

      {successMessage && (
        <Banner tone="success" icon="check-circle" role="status">
          {successMessage}
        </Banner>
      )}

      {errorMessage && <Banner tone="danger" icon="warning-circle">{errorMessage}</Banner>}

      <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl space-y-8">
        <div className="space-y-4">
          <SectionHeading level={3} className="mb-0">Email Notifications</SectionHeading>

          <div className="space-y-3">
            {EMAIL_TOGGLES.map(({ name, id, label }) => (
              <Controller
                key={name}
                name={name}
                control={control}
                render={({ field }) => (
                  <Checkbox id={id} label={label} checked={field.value} onChange={field.onChange} />
                )}
              />
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <SectionHeading level={3} className="mb-0">In-App Notifications</SectionHeading>

          <Controller
            name="inAppNotifications"
            control={control}
            render={({ field }) => (
              <Checkbox
                id="in-app-notifications"
                label="Enable in-app notifications"
                checked={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </div>

        <div className="space-y-4">
          <SectionHeading level={3} className="mb-0">Email Digest</SectionHeading>

          <Controller
            name="emailDigestFrequency"
            control={control}
            render={({ field }) => (
              <Select
                id="digest-frequency"
                size="sm"
                label="Digest Frequency"
                value={field.value}
                onChange={(value) => field.onChange(value as NotificationSettingsData['emailDigestFrequency'])}
                options={DIGEST_OPTIONS}
              />
            )}
          />
        </div>

        <Button type="submit" disabled={isLoading}>
          {isLoading ? 'Saving...' : 'Save Settings'}
        </Button>
      </form>
    </div>
  );
};
