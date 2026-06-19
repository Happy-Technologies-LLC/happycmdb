// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Login page
 * Full-page layout with branding and login form
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { LoginForm } from '../components/auth/LoginForm';
import { useAuth } from '../contexts/AuthContext';

const Login: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Left side - Branding with solid gradient (no particles) */}
      <div className="lg:flex-1 flex flex-col justify-center items-center bg-gradient-to-br from-sky to-navy text-white p-8 lg:p-12 min-h-[300px] lg:min-h-screen relative z-20">
        <div className="text-center max-w-lg w-full">
          <div className="mb-8">
            <img
              src="/assets/logo.svg"
              alt="HappyCMDB Logo"
              className="w-[180px] md:w-[220px] lg:w-[250px] h-auto mx-auto"
            />
          </div>
          <h1 className="text-3xl md:text-5xl lg:text-6xl font-bold mb-4 tracking-tight">
            HappyCMDB
          </h1>
          <h2 className="text-lg md:text-xl lg:text-2xl font-light opacity-90 mb-6">
            Open-source CMDB for modern infrastructure
          </h2>
          <p className="text-sm md:text-base opacity-80 leading-relaxed max-w-md mx-auto">
            Discover, track, and manage your configuration items across multi-cloud environments with intelligent automation
          </p>
        </div>
      </div>

      {/* Right side - Login form with particles visible behind */}
      <div className="lg:flex-1 flex justify-center items-center p-6 md:p-8 lg:p-12 bg-background/25 min-h-screen relative">
        <div className="w-full max-w-[420px] relative z-10">
          <LiquidGlass variant="default" rounded="2xl" size="lg">
            <div className="space-y-1 pb-4">
              <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
              <p className="text-sm text-muted-foreground">
                Sign in to your account to continue
              </p>
            </div>
            <div className="pt-4">
              <LoginForm />
            </div>
          </LiquidGlass>

          {/* Footer text */}
          <p className="text-center text-sm text-muted-foreground mt-6">
            Don't have an account?{' '}
            <Button variant="link" className="px-0 font-normal h-auto text-sm">
              Contact your administrator
            </Button>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
