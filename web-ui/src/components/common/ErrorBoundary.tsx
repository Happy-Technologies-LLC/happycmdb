// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error caught by ErrorBoundary:', error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-background p-6">
          <div className="container max-w-2xl">
            <Card className="shadow-lg">
              <CardHeader className="text-center pb-4">
                <div className="flex justify-center mb-4">
                  <Icon name="warning-circle" size={80} className="text-destructive" />
                </div>
                <CardTitle className="text-2xl text-destructive">
                  Oops! Something went wrong
                </CardTitle>
              </CardHeader>
              <CardContent className="text-center">
                <p className="text-muted-foreground mb-6">
                  We're sorry for the inconvenience. An unexpected error has occurred.
                </p>

                {this.state.error && (
                  <div className="mt-6 mb-6 p-4 bg-muted rounded-lg text-left overflow-auto">
                    <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                      {this.state.error.toString()}
                    </pre>
                    {import.meta.env.DEV && this.state.errorInfo && (
                      <pre className="text-xs font-mono mt-4 whitespace-pre-wrap break-words text-muted-foreground">
                        {this.state.errorInfo.componentStack}
                      </pre>
                    )}
                  </div>
                )}
              </CardContent>
              <CardFooter className="flex gap-4 justify-center pt-4">
                <Button
                  variant="outline"
                  onClick={this.handleReset}
                  className="gap-2"
                >
                  <Icon name="arrows-clockwise" size={16} />
                  Try Again
                </Button>
                <Button
                  onClick={this.handleReload}
                >
                  Reload Page
                </Button>
              </CardFooter>
            </Card>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
