// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Login form component
 * Username/password form with validation using React Hook Form and Zod, on the design-system field components.
 * The password lives in the input's value property only (HAP-1213 / HAP-1893): see useUnmirroredValue.
 */

import React, { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Banner, Button, FieldHint, IconButton, Input, Label } from '@happy-technologies/design-system';
import { useAuth } from '../../contexts/AuthContext';
import { useUnmirroredValue } from '@/components/ui/secret-input';

const loginSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

type LoginFormData = z.infer<typeof loginSchema>;

interface PasswordFieldProps {
  value: string;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
  onBlur: () => void;
  name: string;
  fieldRef: React.Ref<HTMLInputElement>;
  error?: string;
  disabled: boolean;
}

// The DS Input would mirror `value` into the DOM; useUnmirroredValue writes the property only.
const PasswordField: React.FC<PasswordFieldProps> = ({ value, onChange, onBlur, name, fieldRef, error, disabled }) => {
  const [shown, setShown] = useState(false);
  const { ref, handleChange } = useUnmirroredValue<HTMLInputElement>(value, fieldRef as React.ForwardedRef<HTMLInputElement>, onChange);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="login-password">Password</Label>
      <div className="relative">
        <Input
          ref={ref}
          id="login-password"
          name={name}
          type={shown ? 'text' : 'password'}
          autoComplete="current-password"
          placeholder="Enter your password"
          disabled={disabled}
          onChange={handleChange}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'login-password-error' : undefined}
          className="pr-12"
        />
        <IconButton
          icon={shown ? 'eye-slash' : 'eye'}
          aria-label={shown ? 'Hide password' : 'Show password'}
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => setShown((s) => !s)}
          className="absolute top-1/2 right-2 -translate-y-1/2"
        />
      </div>
      <FieldHint id="login-password-error" error={error} />
    </div>
  );
};

export const LoginForm: React.FC = () => {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });
  const { errors } = form.formState;

  const onSubmit = async (data: LoginFormData) => {
    setError(null);
    setIsSubmitting(true);

    try {
      await login({
        username: data.username,
        password: data.password,
      });
    } catch (err: any) {
      const errorMessage = err.response?.data?._message || err.response?.data?.message || 'Invalid username or password';
      setError(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex w-full flex-col gap-4" noValidate>
      {error && (
        <Banner tone="danger" icon="warning-circle">
          {error}
        </Banner>
      )}

      <Input
        {...form.register('username')}
        label="Username"
        autoComplete="username"
        autoFocus
        disabled={isSubmitting}
        placeholder="Enter your username"
        error={errors.username?.message}
      />

      <Controller
        control={form.control}
        name="password"
        render={({ field }) => (
          <PasswordField
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            name={field.name}
            fieldRef={field.ref}
            error={errors.password?.message}
            disabled={isSubmitting}
          />
        )}
      />

      <Button type="submit" size="lg" fullWidth disabled={isSubmitting}>
        {isSubmitting ? 'Signing in...' : 'Sign In'}
      </Button>
    </form>
  );
};
