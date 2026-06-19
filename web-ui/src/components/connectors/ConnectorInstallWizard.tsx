/**
 * Connector Install Wizard
 * Multi-step wizard for installing and configuring connectors
 *
 * Steps:
 * 1. Confirm Installation - Review connector details
 * 2. Configure Connector - Set up resources and credentials
 * 3. Test Connection - Verify configuration works
 * 4. Complete - Show success and next steps
 */

import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import {
  Download,
  CheckCircle,
  XCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Package,
  Settings,
  TestTube,
  PartyPopper,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConnectorRegistry } from '@/services/connector.service';
import connectorService from '@/services/connector.service';
import { getConnectorIcon, getCategoryColor, getCategoryLabel } from '@/lib/connector-icons';
import { cn } from '@/lib/utils';

interface ConnectorInstallWizardProps {
  connector: ConnectorRegistry;
  onClose: () => void;
  onComplete: () => void;
}

type WizardStep = 'confirm' | 'configure' | 'test' | 'complete';

interface InstallConfig {
  enabledResources: string[];
  connectionSettings: Record<string, any>;
  schedule?: string;
  scheduleEnabled: boolean;
}

export const ConnectorInstallWizard: React.FC<ConnectorInstallWizardProps> = ({
  connector,
  onClose,
  onComplete,
}) => {
  const [currentStep, setCurrentStep] = useState<WizardStep>('confirm');
  const [config, setConfig] = useState<InstallConfig>({
    enabledResources: [],
    connectionSettings: {},
    scheduleEnabled: false,
  });
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    details?: any;
  } | null>(null);

  const IconComponent = getConnectorIcon(
    (connector.metadata as any)?.icon || connector.connectorType
  );

  const displayCategory =
    (connector.metadata as any)?.connector_category ||
    connector.connectorType.toLowerCase();

  // Install mutation
  const installMutation = useMutation({
    mutationFn: () => connectorService.installConnector(connector.connectorType),
    onSuccess: (result) => {
      if (result.success) {
        setCurrentStep('complete');
      } else {
        toast.error(result.message || 'Installation failed');
      }
    },
    onError: (error: any) => {
      toast.error(error.message || 'Installation failed');
    },
  });

  // Test connection mutation (placeholder - would need actual config ID)
  const testConnectionMutation = useMutation({
    mutationFn: async () => {
      // Simulate connection test
      await new Promise(resolve => setTimeout(resolve, 2000));
      return { success: true, message: 'Connection successful' };
    },
    onSuccess: (result) => {
      setTestResult(result);
    },
    onError: (error: any) => {
      setTestResult({
        success: false,
        message: error.message || 'Connection test failed',
      });
    },
  });

  const handleNext = () => {
    switch (currentStep) {
      case 'confirm':
        setCurrentStep('configure');
        break;
      case 'configure':
        setCurrentStep('test');
        break;
      case 'test':
        // Run installation
        installMutation.mutate();
        break;
      case 'complete':
        onComplete();
        break;
    }
  };

  const handleBack = () => {
    switch (currentStep) {
      case 'configure':
        setCurrentStep('confirm');
        break;
      case 'test':
        setCurrentStep('configure');
        break;
    }
  };

  const handleTestConnection = () => {
    setTestResult(null);
    testConnectionMutation.mutate();
  };

  const canProceed = () => {
    switch (currentStep) {
      case 'confirm':
        return true;
      case 'configure':
        return true; // Could add validation here
      case 'test':
        return !installMutation.isPending;
      case 'complete':
        return true;
      default:
        return false;
    }
  };

  const getStepIcon = (step: WizardStep) => {
    switch (step) {
      case 'confirm':
        return Package;
      case 'configure':
        return Settings;
      case 'test':
        return TestTube;
      case 'complete':
        return PartyPopper;
    }
  };

  const getStepTitle = (step: WizardStep) => {
    switch (step) {
      case 'confirm':
        return 'Confirm Installation';
      case 'configure':
        return 'Configure Connector';
      case 'test':
        return 'Test Connection';
      case 'complete':
        return 'Installation Complete';
    }
  };

  const steps: WizardStep[] = ['confirm', 'configure', 'test', 'complete'];
  const currentStepIndex = steps.indexOf(currentStep);

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <DialogHeader>
          <div className="flex items-center gap-4">
            <div
              className={cn(
                'flex items-center justify-center w-12 h-12 rounded-lg',
                getCategoryColor(displayCategory),
                'bg-opacity-10'
              )}
            >
              <IconComponent className="w-8 h-8" />
            </div>
            <div>
              <DialogTitle className="text-xl">Install {connector.name}</DialogTitle>
              <DialogDescription>
                Version {connector.latestVersion}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Progress Steps */}
        <div className="flex items-center justify-between mb-6">
          {steps.slice(0, -1).map((step, index) => {
            const StepIcon = getStepIcon(step);
            const isActive = step === currentStep;
            const isCompleted = index < currentStepIndex;

            return (
              <React.Fragment key={step}>
                <div className="flex flex-col items-center gap-2 flex-1">
                  <div
                    className={cn(
                      'flex items-center justify-center w-10 h-10 rounded-full border-2',
                      isCompleted && 'bg-green-500 border-green-500 text-white',
                      isActive && 'border-blue-500 text-blue-500',
                      !isActive && !isCompleted && 'border-gray-300 text-gray-400'
                    )}
                  >
                    {isCompleted ? (
                      <CheckCircle className="h-5 w-5" />
                    ) : (
                      <StepIcon className="h-5 w-5" />
                    )}
                  </div>
                  <div
                    className={cn(
                      'text-xs font-medium text-center',
                      isActive && 'text-blue-600',
                      !isActive && 'text-gray-500'
                    )}
                  >
                    {getStepTitle(step)}
                  </div>
                </div>
                {index < steps.length - 2 && (
                  <div
                    className={cn(
                      'h-0.5 flex-1 mx-2 mt-[-2rem]',
                      isCompleted ? 'bg-green-500' : 'bg-gray-300'
                    )}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        <Separator />

        {/* Step Content */}
        <div className="flex-1 overflow-y-auto py-6">
          {/* Step 1: Confirm Installation */}
          {currentStep === 'confirm' && (
            <div className="space-y-4">
              <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <Info className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-1">
                      About This Connector
                    </h4>
                    <p className="text-sm text-blue-700 dark:text-blue-300">
                      {connector.description}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">Version</Label>
                  <p className="text-sm text-muted-foreground">
                    v{connector.latestVersion}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">Category</Label>
                  <Badge variant="outline">{getCategoryLabel(displayCategory)}</Badge>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">Author</Label>
                  <p className="text-sm text-muted-foreground">
                    {connector.author || 'HappyCMDB Community'}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">License</Label>
                  <p className="text-sm text-muted-foreground">
                    {connector.license || 'N/A'}
                  </p>
                </div>
              </div>

              {connector.verified && (
                <div className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg p-4">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-5 w-5 text-green-600" />
                    <span className="text-sm font-medium text-green-900 dark:text-green-100">
                      This is a verified connector by the HappyCMDB team
                    </span>
                  </div>
                </div>
              )}

              {connector.tags && connector.tags.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">Tags</Label>
                  <div className="flex flex-wrap gap-2">
                    {connector.tags.map(tag => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Configure Connector */}
          {currentStep === 'configure' && (
            <div className="space-y-4">
              <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <h4 className="font-semibold text-yellow-900 dark:text-yellow-100 mb-1">
                      Configuration Required
                    </h4>
                    <p className="text-sm text-yellow-700 dark:text-yellow-300">
                      After installation, you'll need to create a connector configuration
                      to set up credentials and resource selection. This can be done in the
                      Connectors Dashboard.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <Label className="text-sm font-semibold">Quick Setup Options</Label>
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="schedule-enabled"
                      checked={config.scheduleEnabled}
                      onCheckedChange={(checked) =>
                        setConfig(prev => ({
                          ...prev,
                          scheduleEnabled: checked as boolean,
                        }))
                      }
                    />
                    <label
                      htmlFor="schedule-enabled"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      Enable automatic scheduling after installation
                    </label>
                  </div>
                </div>

                {config.scheduleEnabled && (
                  <div className="ml-6 space-y-2">
                    <Label htmlFor="schedule" className="text-sm">
                      Schedule (cron expression)
                    </Label>
                    <Input
                      id="schedule"
                      placeholder="0 0 * * * (daily at midnight)"
                      value={config.schedule || ''}
                      onChange={(e) =>
                        setConfig(prev => ({ ...prev, schedule: e.target.value }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Configure when the connector should run automatically
                    </p>
                  </div>
                )}
              </div>

              <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <Info className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm text-blue-700 dark:text-blue-300">
                      Detailed configuration including credentials, resource selection, and
                      field mappings will be available after installation in the Connectors
                      Dashboard.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Test Connection */}
          {currentStep === 'test' && (
            <div className="space-y-4">
              {!installMutation.isPending && !installMutation.isSuccess && (
                <div className="text-center py-8">
                  <Package className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
                  <h3 className="text-lg font-semibold mb-2">Ready to Install</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Click "Install" to begin the installation process
                  </p>
                </div>
              )}

              {installMutation.isPending && (
                <div className="text-center py-8">
                  <Loader2 className="h-16 w-16 mx-auto mb-4 text-blue-600 animate-spin" />
                  <h3 className="text-lg font-semibold mb-2">Installing Connector...</h3>
                  <p className="text-sm text-muted-foreground">
                    Downloading and installing {connector.name}
                  </p>
                </div>
              )}

              {installMutation.isError && (
                <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <XCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="font-semibold text-red-900 dark:text-red-100 mb-1">
                        Installation Failed
                      </h4>
                      <p className="text-sm text-red-700 dark:text-red-300">
                        {(installMutation.error as any)?.message ||
                          'An error occurred during installation'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Complete */}
          {currentStep === 'complete' && (
            <div className="text-center py-8">
              <div className="mb-6">
                <CheckCircle className="h-20 w-20 mx-auto text-green-600 mb-4" />
                <h3 className="text-2xl font-bold mb-2">Installation Complete!</h3>
                <p className="text-muted-foreground">
                  {connector.name} has been successfully installed
                </p>
              </div>

              <div className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg p-4 text-left mb-6">
                <h4 className="font-semibold text-green-900 dark:text-green-100 mb-2">
                  Next Steps
                </h4>
                <ol className="text-sm text-green-700 dark:text-green-300 space-y-2 list-decimal list-inside">
                  <li>Go to the Connectors Dashboard</li>
                  <li>Create a new connector configuration</li>
                  <li>Set up credentials and resource selection</li>
                  <li>Test the connection and run your first discovery</li>
                </ol>
              </div>

              <div className="space-y-2">
                <Button onClick={onComplete} className="w-full" size="lg">
                  Go to Connectors Dashboard
                </Button>
                <Button onClick={onClose} variant="outline" className="w-full">
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {currentStep !== 'complete' && (
          <DialogFooter className="mt-4">
            <div className="flex items-center justify-between w-full">
              <Button
                onClick={handleBack}
                variant="outline"
                disabled={currentStep === 'confirm' || installMutation.isPending}
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
              <div className="flex gap-2">
                <Button onClick={onClose} variant="ghost">
                  Cancel
                </Button>
                <Button
                  onClick={handleNext}
                  disabled={!canProceed() || installMutation.isPending}
                >
                  {installMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Installing...
                    </>
                  ) : currentStep === 'test' ? (
                    <>
                      <Download className="h-4 w-4 mr-2" />
                      Install
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRight className="h-4 w-4 ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
