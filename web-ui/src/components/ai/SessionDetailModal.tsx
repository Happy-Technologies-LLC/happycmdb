// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AIDiscoverySession } from '@/services/ai-pattern.service';
import { Brain, Wrench, FileJson, MessageSquare, CheckCircle, XCircle } from 'lucide-react';
import { useAIPatterns } from '@/hooks/useAIPatterns';
import { useToast } from '@/contexts/ToastContext';

interface SessionDetailModalProps {
  session: AIDiscoverySession;
  open: boolean;
  onClose: () => void;
}

export const SessionDetailModal: React.FC<SessionDetailModalProps> = ({ session, open, onClose }) => {
  const [activeTab, setActiveTab] = useState('overview');
  const { showToast } = useToast();

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <Brain className="h-5 w-5 text-navy" />
            <span>Discovery Session</span>
            <Badge variant="outline" className="font-mono text-xs">
              {session.sessionId}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="tools">Tool Calls</TabsTrigger>
            <TabsTrigger value="results">Results</TabsTrigger>
            <TabsTrigger value="reasoning">AI Reasoning</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Session Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Target</p>
                    <p className="font-mono font-semibold">
                      {session.targetHost}:{session.targetPort}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    <div className="mt-1">
                      <Badge variant={
                        session.status === 'completed' ? 'default' :
                        session.status === 'failed' ? 'destructive' : 'outline'
                      }>
                        {session.status}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Provider</p>
                    <p className="font-semibold">{session.provider}</p>
                    <p className="text-xs text-muted-foreground">{session.model}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Confidence</p>
                    <p className="text-lg font-bold text-primary">
                      {(session.confidenceScore * 100).toFixed(0)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Cost</p>
                    <p className="text-lg font-bold">
                      ${session.estimatedCost?.toFixed(4) || '0.0000'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Duration</p>
                    <p className="text-lg font-bold">
                      {session.durationMs ? `${(session.durationMs / 1000).toFixed(1)}s` : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">CIs Found</p>
                    <p className="text-lg font-bold">
                      {session.discoveredCIs?.length || 0}
                    </p>
                  </div>
                </div>

                <div className="border-t pt-4">
                  <p className="text-xs text-muted-foreground mb-2">Token Usage</p>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Total</p>
                      <p className="font-semibold">{session.totalTokens?.toLocaleString() || 0}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Prompt</p>
                      <p className="font-semibold">{session.promptTokens?.toLocaleString() || 0}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Completion</p>
                      <p className="font-semibold">{session.completionTokens?.toLocaleString() || 0}</p>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Started</p>
                      <p className="text-sm">{new Date(session.startedAt).toLocaleString()}</p>
                    </div>
                    {session.completedAt && (
                      <div>
                        <p className="text-xs text-muted-foreground">Completed</p>
                        <p className="text-sm">{new Date(session.completedAt).toLocaleString()}</p>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="tools" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Wrench className="h-4 w-4" />
                  Tool Execution Timeline
                </CardTitle>
              </CardHeader>
              <CardContent>
                {session.toolCalls && session.toolCalls.length > 0 ? (
                  <div className="space-y-3">
                    {session.toolCalls.map((toolCall, index) => (
                      <div
                        key={index}
                        className={`p-4 border rounded-lg ${
                          toolCall.success ? 'border-success/30 bg-success-soft' : 'border-danger/30 bg-danger-soft'
                        }`}
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-2">
                            {toolCall.success ? (
                              <CheckCircle className="h-5 w-5 text-success" />
                            ) : (
                              <XCircle className="h-5 w-5 text-danger" />
                            )}
                            <div>
                              <p className="font-semibold text-sm">{toolCall.toolName}</p>
                              <p className="text-xs text-muted-foreground">
                                {new Date(toolCall.timestamp).toLocaleTimeString()} • {toolCall.executionTimeMs}ms
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground mb-1">Input</p>
                            <pre className="bg-muted/50 p-2 rounded text-xs overflow-x-auto">
                              <code>{JSON.stringify(toolCall.toolInput, null, 2)}</code>
                            </pre>
                          </div>

                          <div>
                            <p className="text-xs font-semibold text-muted-foreground mb-1">Output</p>
                            <pre className="bg-muted/50 p-2 rounded text-xs overflow-x-auto max-h-48">
                              <code>{JSON.stringify(toolCall.toolOutput, null, 2)}</code>
                            </pre>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No tool calls recorded</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="results" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileJson className="h-4 w-4" />
                  Discovered Configuration Items
                </CardTitle>
              </CardHeader>
              <CardContent>
                {session.discoveredCIs && session.discoveredCIs.length > 0 ? (
                  <div className="space-y-3">
                    {session.discoveredCIs.map((ci, index) => (
                      <div key={index} className="p-3 border rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <p className="font-semibold">{ci.name || ci._type}</p>
                          <Badge variant="outline">{ci._type}</Badge>
                        </div>
                        <pre className="bg-muted/50 p-2 rounded text-xs overflow-x-auto">
                          <code>{JSON.stringify(ci, null, 2)}</code>
                        </pre>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No configuration items discovered</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="reasoning" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  AI Reasoning
                </CardTitle>
              </CardHeader>
              <CardContent>
                {session.aiReasoning ? (
                  <div className="prose prose-sm max-w-none">
                    <p className="whitespace-pre-wrap">{session.aiReasoning}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No reasoning available</p>
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
