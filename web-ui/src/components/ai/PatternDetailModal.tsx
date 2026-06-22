// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AIPattern } from '@/services/ai-pattern.service';
import { Icon } from '@happy-technologies/design-system';

interface PatternDetailModalProps {
  pattern: AIPattern;
  open: boolean;
  onClose: () => void;
}

export const PatternDetailModal: React.FC<PatternDetailModalProps> = ({ pattern, open, onClose }) => {
  const [activeTab, setActiveTab] = useState('info');

  const successRate = pattern.usageCount > 0
    ? (pattern.successCount / pattern.usageCount) * 100
    : 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span>{pattern.name}</span>
            <Badge variant="outline">{pattern.category}</Badge>
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="info">Info</TabsTrigger>
            <TabsTrigger value="detection">Detection</TabsTrigger>
            <TabsTrigger value="discovery">Discovery</TabsTrigger>
            <TabsTrigger value="tests">Tests</TabsTrigger>
          </TabsList>

          <TabsContent value="info" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Pattern Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Pattern ID</p>
                    <p className="font-mono text-sm">{pattern.patternId}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    <div className="flex items-center gap-2 mt-1">
                      {pattern.isActive ? (
                        <Badge variant="default">Active</Badge>
                      ) : (
                        <Badge variant="secondary">{pattern.status}</Badge>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Confidence Score</p>
                    <p className="text-lg font-bold text-primary">
                      {(pattern.confidenceScore * 100).toFixed(0)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Success Rate</p>
                    <p className="text-lg font-bold">
                      {successRate.toFixed(0)}%
                    </p>
                  </div>
                </div>

                {pattern.description && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Description</p>
                    <p className="text-sm">{pattern.description}</p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Usage Count</p>
                    <p className="text-sm font-semibold">{pattern.usageCount}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Avg Execution Time</p>
                    <p className="text-sm font-semibold">{pattern.avgExecutionTimeMs}ms</p>
                  </div>
                </div>

                {pattern.learnedFromSessions && pattern.learnedFromSessions.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Learned From</p>
                    <p className="text-sm">
                      {pattern.learnedFromSessions.length} discovery sessions
                    </p>
                  </div>
                )}

                {pattern.tags && pattern.tags.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">Tags</p>
                    <div className="flex flex-wrap gap-2">
                      {pattern.tags.map(tag => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4 pt-3 border-t">
                  <div>
                    <p className="text-xs text-muted-foreground">Created</p>
                    <p className="text-sm">
                      {new Date(pattern.createdAt).toLocaleDateString()}
                    </p>
                    {pattern.createdBy && (
                      <p className="text-xs text-muted-foreground">{pattern.createdBy}</p>
                    )}
                  </div>
                  {pattern.approvedAt && (
                    <div>
                      <p className="text-xs text-muted-foreground">Approved</p>
                      <p className="text-sm">
                        {new Date(pattern.approvedAt).toLocaleDateString()}
                      </p>
                      {pattern.approvedBy && (
                        <p className="text-xs text-muted-foreground">{pattern.approvedBy}</p>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="detection" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Icon name="code" size={16} />
                  Detection Function
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted/50 p-4 rounded-lg overflow-x-auto text-xs">
                  <code>{pattern.detectionCode}</code>
                </pre>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="discovery" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Icon name="file-code" size={16} />
                  Discovery Function
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted/50 p-4 rounded-lg overflow-x-auto text-xs">
                  <code>{pattern.discoveryCode}</code>
                </pre>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="tests" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Icon name="test-tube" size={16} />
                  Test Cases
                </CardTitle>
              </CardHeader>
              <CardContent>
                {pattern.testCases && pattern.testCases.length > 0 ? (
                  <div className="space-y-3">
                    {pattern.testCases.map((testCase, index) => (
                      <div
                        key={index}
                        className="p-3 border rounded-lg space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <p className="font-semibold text-sm">{testCase.name}</p>
                          {testCase.expectedMatch ? (
                            <Badge variant="default" className="text-xs">
                              <Icon name="check-circle" size={12} className="mr-1" />
                              Should Match
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">
                              <Icon name="x-circle" size={12} className="mr-1" />
                              Should Not Match
                            </Badge>
                          )}
                        </div>
                        {testCase.expectedConfidence !== undefined && (
                          <p className="text-xs text-muted-foreground">
                            Expected confidence: {(testCase.expectedConfidence * 100).toFixed(0)}%
                          </p>
                        )}
                        <pre className="bg-muted/50 p-2 rounded text-xs overflow-x-auto">
                          <code>{JSON.stringify(testCase.input, null, 2)}</code>
                        </pre>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No test cases defined</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
