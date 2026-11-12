// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useAuth } from './contexts/AuthContext';
import { useTheme } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import ErrorBoundary from './components/common/ErrorBoundary';
import LoadingSpinner from './components/common/LoadingSpinner';
import MainLayout from './components/layout/MainLayout';

// Lazy loaded page components
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const CIList = React.lazy(() => import('./pages/CIList'));
const CIDetail = React.lazy(() => import('./pages/CIDetail'));
const Discovery = React.lazy(() => import('./pages/Discovery'));
const Agents = React.lazy(() => import('./pages/Agents'));
const Credentials = React.lazy(() => import('./pages/Credentials'));
const CredentialSets = React.lazy(() => import('./pages/CredentialSets'));
const Connectors = React.lazy(() => import('./pages/Connectors'));
const ConnectorCatalog = React.lazy(() => import('./pages/ConnectorCatalog'));
const PatternLearning = React.lazy(() => import('./pages/PatternLearning'));
const Login = React.lazy(() => import('./pages/Login'));

// v3.0 Phase 4 - Multi-Stakeholder Dashboards
const ExecutiveDashboard = React.lazy(() => import('./pages/dashboards/ExecutiveDashboard'));
const CIODashboard = React.lazy(() => import('./pages/dashboards/CIODashboard'));
const ITSMDashboard = React.lazy(() => import('./pages/dashboards/ITSMDashboard'));
const FinOpsDashboard = React.lazy(() => import('./pages/dashboards/FinOpsDashboard'));
const BusinessServiceDashboard = React.lazy(() => import('./pages/dashboards/BusinessServiceDashboard'));

// v3.0 Business Service Management & Financial Management
const BusinessServices = React.lazy(() => import('./pages/BusinessServices'));
const FinancialManagement = React.lazy(() => import('./pages/FinancialManagement'));

// Inventory
const Inventory = React.lazy(() => import('./pages/Inventory'));

// Jobs & Analytics
const Jobs = React.lazy(() => import('./pages/Jobs'));
const Analytics = React.lazy(() => import('./pages/Analytics'));

// Settings
const Settings = React.lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));

// v2.0 Components
import { HealthDashboard } from './components/health/HealthDashboard';
import { AnomalyDetectionView } from './components/anomalies/AnomalyDetectionView';

// Protected Route Component
interface ProtectedRouteProps {
  children: React.ReactElement;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

// Public Route Component (redirect to dashboard if authenticated)
const PublicRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return children;
};

const App: React.FC = () => {
  const { theme } = useTheme();
  return (
    <ErrorBoundary>
      <ToastProvider>
        <React.Suspense fallback={<LoadingSpinner />}>
          <Routes>
            {/* Public Routes */}
            <Route
              path="/login"
              element={
                <PublicRoute>
                  <Login />
                </PublicRoute>
              }
            />

            {/* Protected Routes: one signed-in frame (rail, topbar) around every screen */}
            <Route
              element={
                <ProtectedRoute>
                  <MainLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Dashboard />} />
              <Route path="/cis" element={<CIList />} />
              <Route path="/cis/:ciId" element={<CIDetail />} />
              <Route path="/discovery" element={<Discovery />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/credentials" element={<Credentials />} />
              <Route path="/credential-sets" element={<CredentialSets />} />
              <Route path="/inventory" element={<Inventory />} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/analytics" element={<Analytics />} />

              {/* v2.0 Features */}
              <Route path="/connectors" element={<Connectors />} />
              <Route path="/connectors/catalog" element={<ConnectorCatalog />} />
              <Route path="/cmdb-health" element={<HealthDashboard />} />
              <Route path="/anomalies" element={<AnomalyDetectionView />} />
              <Route path="/ai/patterns" element={<PatternLearning />} />

              {/* v3.0 Phase 4 - Multi-Stakeholder Dashboards */}
              <Route path="/dashboards/executive" element={<ExecutiveDashboard />} />
              <Route path="/dashboards/cio" element={<CIODashboard />} />
              <Route path="/dashboards/itsm" element={<ITSMDashboard />} />
              <Route path="/dashboards/finops" element={<FinOpsDashboard />} />
              <Route path="/dashboards/business-service" element={<BusinessServiceDashboard />} />

              {/* v3.0 Business Service Management & Financial Management */}
              <Route path="/business-services" element={<BusinessServices />} />
              <Route path="/financial-management" element={<FinancialManagement />} />
              <Route path="/settings" element={<Settings />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </React.Suspense>
        <Toaster position="bottom-right" richColors theme={theme} />
      </ToastProvider>
    </ErrorBoundary>
  );
};

export default App;
