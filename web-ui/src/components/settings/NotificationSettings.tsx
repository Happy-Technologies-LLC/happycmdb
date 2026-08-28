// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification settings component
 * Email and in-app notification preferences
 */

import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { apiClient } from '../../services/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface NotificationSettingsData {
  emailOnJobFailure: boolean;
  emailOnJobSuccess: boolean;
  emailOnDiscoveryCompletion: boolean;
  inAppNotifications: boolean;
  emailDigestFrequency: 'never' | 'daily' | 'weekly' | 'monthly';
}

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
        <h2 className="text-2xl font-semibold tracking-tight">Notification Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure how you receive notifications
        </p>
      </div>

      {successMessage && (
        <Alert>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-8 max-w-2xl">
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Email Notifications</h3>

          <div className="space-y-3">
            <Controller
              name="emailOnJobFailure"
              control={control}
              render={({ field }) => (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="email-job-failure"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <Label
                    htmlFor="email-job-failure"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Email me when a job fails
                  </Label>
                </div>
              )}
            />

            <Controller
              name="emailOnJobSuccess"
              control={control}
              render={({ field }) => (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="email-job-success"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <Label
                    htmlFor="email-job-success"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Email me when a job succeeds
                  </Label>
                </div>
              )}
            />

            <Controller
              name="emailOnDiscoveryCompletion"
              control={control}
              render={({ field }) => (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="email-discovery"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <Label
                    htmlFor="email-discovery"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Email me when discovery completes
                  </Label>
                </div>
              )}
            />
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-lg font-medium">In-App Notifications</h3>

          <Controller
            name="inAppNotifications"
            control={control}
            render={({ field }) => (
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="in-app-notifications"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
                <Label
                  htmlFor="in-app-notifications"
                  className="text-sm font-normal cursor-pointer"
                >
                  Enable in-app notifications
                </Label>
              </div>
            )}
          />
        </div>

        <div className="space-y-4">
          <h3 className="text-lg font-medium">Email Digest</h3>

          <div className="space-y-2">
            <Label htmlFor="digest-frequency">Digest Frequency</Label>
            <Controller
              name="emailDigestFrequency"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="digest-frequency" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="never">Never</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>

        <Button type="submit" disabled={isLoading}>
          {isLoading ? 'Saving...' : 'Save Settings'}
        </Button>
      </form>
    </div>
  );
};
