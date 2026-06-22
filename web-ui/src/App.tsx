// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useAuth } from './contexts/AuthContext';
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

// Inventory (Analytics & Jobs pages are not routed: their backend endpoints are incomplete)
const Inventory = React.lazy(() => import('./pages/Inventory'));

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
  return (
    <ErrorBoundary>
      <ToastProvider>
        <div className="min-h-screen">
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

              {/* Protected Routes */}
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <Dashboard />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/cis"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <CIList />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/cis/:ciId"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <CIDetail />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/discovery"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <Discovery />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/agents"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <Agents />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/credentials"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <Credentials />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/credential-sets"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <CredentialSets />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/inventory"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <Inventory />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />

              {/* v2.0 Features */}
              <Route
                path="/connectors"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <Connectors />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/connectors/catalog"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <ConnectorCatalog />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/cmdb-health"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <HealthDashboard />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/anomalies"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <AnomalyDetectionView />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/ai/patterns"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <PatternLearning />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />

              {/* v3.0 Phase 4 - Multi-Stakeholder Dashboards */}
              <Route
                path="/dashboards/executive"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <ExecutiveDashboard />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboards/cio"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <CIODashboard />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboards/itsm"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <ITSMDashboard />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboards/finops"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <FinOpsDashboard />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboards/business-service"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <BusinessServiceDashboard />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />

              {/* v3.0 Business Service Management & Financial Management */}
              <Route
                path="/business-services"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <BusinessServices />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/financial-management"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <FinancialManagement />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/settings"
                element={
                  <ProtectedRoute>
                    <MainLayout>
                      <Settings />
                    </MainLayout>
                  </ProtectedRoute>
                }
              />

              {/* Fallback Route */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </React.Suspense>
        </div>
        <Toaster position="bottom-right" richColors />
      </ToastProvider>
    </ErrorBoundary>
  );
};

export default App;
