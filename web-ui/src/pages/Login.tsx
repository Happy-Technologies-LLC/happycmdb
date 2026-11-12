// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Login page
 * The sign-in card on the design-system theme.
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { Card, FullPageState, Icon, PageHeader, ProductLockup } from '@happy-technologies/design-system';
import { LoginForm } from '../components/auth/LoginForm';
import { useAuth } from '../contexts/AuthContext';

const Login: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <FullPageState loading title="Loading..." />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="hh-page flex min-h-screen items-center justify-center p-6">
      <div className="flex w-full max-w-[420px] flex-col gap-6">
        <ProductLockup
          name="HappyCMDB"
          logo={<Icon name="cube" size={32} className="text-[var(--hh-accent)]" />}
          className="justify-center"
        />
        <Card as="section" aria-label="Sign in" className="flex flex-col gap-6">
          <PageHeader eyebrow="Sign in" title="Welcome back" lede="Sign in to your account to continue" />
          <LoginForm />
        </Card>
        <p className="text-center text-sm text-[var(--hh-text-body)]">Need an account? Ask your administrator.</p>
      </div>
    </main>
  );
};

export default Login;
