// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * User profile component
 * Profile information and password management
 */

import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Icon } from '@happy-technologies/design-system';
import { useAuth } from '../../hooks/useAuth';
import { updateProfile, changePassword, deleteAccount } from '../../services/auth.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';

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

export const UserProfile: React.FC = () => {
  const { user, refreshUser, logout } = useAuth();
  const [avatar, setAvatar] = useState<string | null>(user?.avatar || null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const profileForm = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: user?.name || '',
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

  const handleAvatarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setAvatar(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const onProfileSubmit = async (data: ProfileFormData) => {
    try {
      await updateProfile({
        name: data.name,
        avatar: avatar || undefined,
      });
      await refreshUser();
      setSuccessMessage('Profile updated successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (error: any) {
      setErrorMessage(error.response?.data?.message || 'Failed to update profile');
      setTimeout(() => setErrorMessage(null), 3000);
    }
  };

  const onPasswordSubmit = async (data: PasswordFormData) => {
    try {
      await changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
      passwordForm.reset();
      setSuccessMessage('Password changed successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (error: any) {
      setErrorMessage(error.response?.data?.message || 'Failed to change password');
      setTimeout(() => setErrorMessage(null), 3000);
    }
  };

  const handleDeleteAccount = async () => {
    try {
      await deleteAccount();
      setDeleteDialogOpen(false);
      await logout();
    } catch (error: any) {
      setErrorMessage(error.response?.data?.message || 'Failed to delete account');
      setTimeout(() => setErrorMessage(null), 3000);
    }
  };

  const getInitials = (name: string): string => {
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">User Profile</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your profile information and account settings
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

      {/* Profile Information */}
      <form onSubmit={profileForm.handleSubmit(onProfileSubmit)} className="space-y-6 max-w-2xl">
        <div>
          <h3 className="text-lg font-medium mb-4">Profile Information</h3>

          <div className="flex items-center gap-4 mb-6">
            <Avatar className="h-24 w-24">
              <AvatarImage src={avatar || undefined} alt={user?.name} />
              <AvatarFallback className="text-lg">
                {user?.name && getInitials(user.name)}
              </AvatarFallback>
            </Avatar>
            <label htmlFor="avatar-upload" className="cursor-pointer">
              <Button type="button" variant="outline" size="icon" asChild>
                <span>
                  <Icon name="camera" size={16} />
                </span>
              </Button>
              <input
                id="avatar-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </label>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="profile-name">Name</Label>
              <Controller
                name="name"
                control={profileForm.control}
                render={({ field, fieldState }) => (
                  <div>
                    <Input
                      id="profile-name"
                      {...field}
                      className={fieldState.error ? 'border-destructive' : ''}
                    />
                    {fieldState.error && (
                      <p className="text-sm text-destructive mt-1">{fieldState.error.message}</p>
                    )}
                  </div>
                )}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="profile-email">Email</Label>
              <Controller
                name="email"
                control={profileForm.control}
                render={({ field, fieldState }) => (
                  <div>
                    <Input
                      id="profile-email"
                      {...field}
                      disabled
                      className="bg-muted"
                    />
                    <p className="text-sm text-muted-foreground mt-1">Email cannot be changed</p>
                  </div>
                )}
              />
            </div>
          </div>

          <Button type="submit" className="mt-4">
            Update Profile
          </Button>
        </div>
      </form>

      <Separator />

      {/* Change Password */}
      <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="space-y-6 max-w-2xl">
        <div>
          <h3 className="text-lg font-medium mb-4">Change Password</h3>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current Password</Label>
              <Controller
                name="currentPassword"
                control={passwordForm.control}
                render={({ field, fieldState }) => (
                  <div>
                    <Input
                      id="current-password"
                      type="password"
                      {...field}
                      className={fieldState.error ? 'border-destructive' : ''}
                    />
                    {fieldState.error && (
                      <p className="text-sm text-destructive mt-1">{fieldState.error.message}</p>
                    )}
                  </div>
                )}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Controller
                name="newPassword"
                control={passwordForm.control}
                render={({ field, fieldState }) => (
                  <div>
                    <Input
                      id="new-password"
                      type="password"
                      {...field}
                      className={fieldState.error ? 'border-destructive' : ''}
                    />
                    {fieldState.error && (
                      <p className="text-sm text-destructive mt-1">{fieldState.error.message}</p>
                    )}
                  </div>
                )}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm New Password</Label>
              <Controller
                name="confirmPassword"
                control={passwordForm.control}
                render={({ field, fieldState }) => (
                  <div>
                    <Input
                      id="confirm-password"
                      type="password"
                      {...field}
                      className={fieldState.error ? 'border-destructive' : ''}
                    />
                    {fieldState.error && (
                      <p className="text-sm text-destructive mt-1">{fieldState.error.message}</p>
                    )}
                  </div>
                )}
              />
            </div>
          </div>

          <Button type="submit" className="mt-4">
            Change Password
          </Button>
        </div>
      </form>

      <Separator />

      {/* Delete Account */}
      <div className="max-w-2xl">
        <h3 className="text-lg font-medium mb-2 text-destructive">Danger Zone</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Once you delete your account, there is no going back. Please be certain.
        </p>
        <Button
          variant="destructive"
          onClick={() => setDeleteDialogOpen(true)}
        >
          Delete Account
        </Button>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Account</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete your account? This action cannot be undone and all your data will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteAccount}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
