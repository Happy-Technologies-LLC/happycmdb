// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * General settings component
 * Language, timezone, and date format preferences
 */

import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Banner, Button, SectionHeading, Select } from '@happy-technologies/design-system';
import { apiClient } from '../../services/api';

interface GeneralSettingsData {
  language: string;
  timezone: string;
  dateFormat: string;
  defaultPage: string;
}

const timezones = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
];
const timezoneOptions = timezones.map((value) => ({ value, label: value }));

const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
];
const dateFormatOptions = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY'].map((value) => ({
  value,
  label: value,
}));
const defaultPageOptions = [
  { value: '/dashboard', label: 'Dashboard' },
  { value: '/cis', label: 'Configuration Items' },
  { value: '/?view=graph', label: 'Estate graph' },
  { value: '/discovery', label: 'Discovery' },
  { value: '/jobs', label: 'Jobs' },
];

export const GeneralSettings: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { control, handleSubmit } = useForm<GeneralSettingsData>({
    defaultValues: {
      language: 'en',
      timezone: 'UTC',
      dateFormat: 'MM/DD/YYYY',
      defaultPage: '/dashboard',
    },
  });

  const onSubmit = async (data: GeneralSettingsData) => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      await apiClient.put('/settings', data);
      setSuccessMessage('Settings saved successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (error: any) {
      setErrorMessage(error.response?.data?.message || 'Failed to save settings');
      setTimeout(() => setErrorMessage(null), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading className="mb-1">General Settings</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Customize your application preferences
        </p>
      </div>

      {successMessage && (
        <Banner tone="success" icon="check-circle" role="status">
          {successMessage}
        </Banner>
      )}

      {errorMessage && <Banner tone="danger" icon="warning-circle">{errorMessage}</Banner>}

      <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl space-y-6">
        <div className="space-y-4">
          <Controller
            name="language"
            control={control}
            render={({ field }) => (
              <Select
                id="language"
                size="sm"
                label="Language"
                value={field.value}
                onChange={field.onChange}
                options={languageOptions}
              />
            )}
          />

          <Controller
            name="timezone"
            control={control}
            render={({ field }) => (
              <Select
                id="timezone"
                size="sm"
                label="Timezone"
                value={field.value}
                onChange={field.onChange}
                options={timezoneOptions}
              />
            )}
          />

          <Controller
            name="dateFormat"
            control={control}
            render={({ field }) => (
              <Select
                id="date-format"
                size="sm"
                label="Date Format"
                value={field.value}
                onChange={field.onChange}
                options={dateFormatOptions}
              />
            )}
          />

          <Controller
            name="defaultPage"
            control={control}
            render={({ field }) => (
              <Select
                id="default-page"
                size="sm"
                label="Default Page"
                value={field.value}
                onChange={field.onChange}
                options={defaultPageOptions}
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
