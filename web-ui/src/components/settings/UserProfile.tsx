// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * User profile component
 * Profile information and password management
 */

import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Avatar,
  Banner,
  Button,
  ConfirmDialog,
  FieldHint,
  FileUpload,
  Input,
  Label,
  SectionHeading,
  Separator,
} from '@happy-technologies/design-system';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../services/api';
import { SecretInput } from '@/components/ui/secret-input';

const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(6, 'Password must be at least 6 characters'),
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
  confirmPassword: z.string().min(6, 'Password must be at least 6 characters'),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ['confirmPassword'],
});

type ProfileFormData = z.infer<typeof profileSchema>;
type PasswordFormData = z.infer<typeof passwordSchema>;

const SESSION_ENDED_MESSAGE = 'Your session ended; please sign in again';

export const UserProfile: React.FC = () => {
  const { user, refreshUser, logout } = useAuth();
  const [avatar, setAvatar] = useState<string | null>(user?.avatar ?? null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [revokeOthersPassword, setRevokeOthersPassword] = useState('');

  // Keep the avatar preview in sync with the authenticated user's persisted
  // value - covers the initial mount (user may load after this component
  // does) and any later refreshUser() that pulls in a server-side change.
  useEffect(() => {
    setAvatar(user?.avatar ?? null);
  }, [user?.avatar]);

  const profileForm = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: user?.full_name || '',
      email: user?.email || '',
    },
  });

  const passwordForm = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const handleAvatarFile = (file: File) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      setAvatar(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const onProfileSubmit = async (data: ProfileFormData) => {
    try {
      await api.updateProfile({
        name: data.name,
        avatar: avatar || undefined,
      });
      if ((await refreshUser()) === 'session-ended') {
        setErrorMessage(SESSION_ENDED_MESSAGE);
        return;
      }
      setSuccessMessage('Profile updated successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (error: any) {
      setErrorMessage(error.response?.data?.message || 'Failed to update profile');
      setTimeout(() => setErrorMessage(null), 3000);
    }
  };

  const onPasswordSubmit = async (data: PasswordFormData) => {
    try {
      await api.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
      passwordForm.reset();
      setSuccessMessage('Password changed. All other sessions and all your API keys have been revoked; this device stays signed in.');
    } catch (error: any) {
      setErrorMessage(error.response?.status === 429
        ? 'Too many password attempts. You can still sign out other sessions below with your current password.'
        : error.response?.data?.message || 'Failed to change password');
      setTimeout(() => setErrorMessage(null), 3000);
    }
  };

  const onRevokeOthersSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.revokeOtherSessions(revokeOthersPassword);
      setRevokeOthersPassword('');
      setSuccessMessage('All other sessions and all your API keys have been revoked; this device stays signed in. Your password is unchanged.');
    } catch (error: any) {
      setErrorMessage(error.response?.data?.message || 'Failed to sign out other sessions');
      setTimeout(() => setErrorMessage(null), 3000);
    }
  };

  const handleDeleteAccount = async () => {
    try {
      await api.deleteAccount();
      setDeleteDialogOpen(false);
      await logout();
    } catch (error: any) {
      setErrorMessage(error.response?.data?.message || 'Failed to delete account');
      setTimeout(() => setErrorMessage(null), 3000);
    }
  };

  const passwordFields = [
    { name: 'currentPassword', id: 'current-password', label: 'Current Password', autoComplete: 'current-password' },
    { name: 'newPassword', id: 'new-password', label: 'New Password', autoComplete: 'new-password' },
    { name: 'confirmPassword', id: 'confirm-password', label: 'Confirm New Password', autoComplete: 'new-password' },
  ] as const;

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading className="mb-1">User Profile</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Manage your profile information and account settings
        </p>
      </div>

      {successMessage && (
        <Banner tone="success" icon="check-circle" role="status">
          {successMessage}
        </Banner>
      )}

      {errorMessage && <Banner tone="danger" icon="warning-circle">{errorMessage}</Banner>}

      {/* Profile Information */}
      <form onSubmit={profileForm.handleSubmit(onProfileSubmit)} className="max-w-2xl space-y-6">
        <div>
          <SectionHeading level={3} className="mb-4">Profile Information</SectionHeading>

          <div className="mb-6 flex items-center gap-4">
            <Avatar size="lg" name={user?.full_name} src={avatar || undefined} />
            <FileUpload
              accept="image/*"
              label="Upload a profile photo"
              containerClassName="flex-1"
              onFiles={([file]) => handleAvatarFile(file)}
            />
          </div>

          <div className="space-y-4">
            <Controller
              name="name"
              control={profileForm.control}
              render={({ field, fieldState }) => (
                <Input
                  id="profile-name"
                  size="sm"
                  label="Name"
                  error={fieldState.error?.message}
                  {...field}
                />
              )}
            />

            <Controller
              name="email"
              control={profileForm.control}
              render={({ field }) => (
                <Input
                  id="profile-email"
                  size="sm"
                  label="Email"
                  hint="Email cannot be changed"
                  disabled
                  {...field}
                />
              )}
            />
          </div>

          <Button type="submit" className="mt-4">
            Update Profile
          </Button>
        </div>
      </form>

      <Separator />

      {/* Change Password */}
      <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="max-w-2xl space-y-6">
        <div>
          <SectionHeading level={3} className="mb-4">Change Password</SectionHeading>

          <div className="space-y-4">
            {passwordFields.map(({ name, id, label, autoComplete }) => (
              <Controller
                key={name}
                name={name}
                control={passwordForm.control}
                render={({ field, fieldState }) => (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={id}>{label}</Label>
                    <SecretInput
                      id={id}
                      autoComplete={autoComplete}
                      aria-invalid={fieldState.error ? true : undefined}
                      aria-describedby={fieldState.error ? `${id}-hint` : undefined}
                      {...field}
                      className={fieldState.error ? 'border-destructive' : ''}
                    />
                    <FieldHint id={`${id}-hint`} error={fieldState.error?.message} />
                  </div>
                )}
              />
            ))}
          </div>

          <Button type="submit" className="mt-4">
            Change Password
          </Button>
        </div>
      </form>

      <Separator />

      {/* HAP-1716: sign out other sessions */}
      <form onSubmit={onRevokeOthersSubmit} className="max-w-2xl space-y-4">
        <SectionHeading level={3} className="mb-0">Sign out other sessions</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Ends every other session and all your API keys. Your password stays the same and this device stays signed in.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="revoke-others-password">Current password to confirm</Label>
          <SecretInput
            id="revoke-others-password"
            autoComplete="current-password"
            value={revokeOthersPassword}
            onChange={(event) => setRevokeOthersPassword(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={revokeOthersPassword === ''}>
          Sign out other sessions
        </Button>
      </form>

      <Separator />

      {/* Delete Account */}
      <div className="max-w-2xl">
        <SectionHeading level={3} className="mb-2">Danger Zone</SectionHeading>
        <p className="mb-4 text-sm text-[var(--hh-text-muted)]">
          Once you delete your account, there is no going back. Please be certain.
        </p>
        <Button variant="danger" onClick={() => setDeleteDialogOpen(true)}>
          Delete Account
        </Button>
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete Account"
        body="Are you sure you want to delete your account? This action cannot be undone and all your data will be permanently removed."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={handleDeleteAccount}
        onCancel={() => setDeleteDialogOpen(false)}
      />
    </div>
  );
};
