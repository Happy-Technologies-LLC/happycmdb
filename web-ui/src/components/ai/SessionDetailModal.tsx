// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  Badge,
  Card,
  Dialog,
  FieldList,
  Icon,
  JsonBlock,
  SectionHeading,
  Stat,
  TabPanel,
  Tabs,
  type BadgeVariant,
} from '@happy-technologies/design-system';
import { AIDiscoverySession } from '@/services/ai-pattern.service';
import { EMPTY_VALUE, formatCount, isKnown } from '@/lib/dashboardValue';

/**
 * Discovered CIs are heterogeneous (their shape depends on the pattern/tool
 * that found them - see AIDiscoveryResult.discoveredCIs in @cmdb/ai-discovery),
 * so read the two display fields defensively instead of assuming a shape.
 */
function ciDisplayName(ci: unknown): string {
  if (ci && typeof ci === 'object') {
    if ('name' in ci && typeof ci.name === 'string') return ci.name;
    if ('_type' in ci && typeof ci._type === 'string') return ci._type;
  }
  return 'Unknown CI';
}

function ciType(ci: unknown): string {
  if (ci && typeof ci === 'object' && '_type' in ci && typeof ci._type === 'string') {
    return ci._type;
  }
  return 'unknown';
}

interface SessionDetailModalProps {
  session: AIDiscoverySession;
  open: boolean;
  onClose: () => void;
}

type TabValue = 'overview' | 'tools' | 'results' | 'reasoning';

const TABS_ID = 'session-detail-tabs';
const TAB_OPTIONS: Array<{ value: TabValue; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'tools', label: 'Tool Calls' },
  { value: 'results', label: 'Results' },
  { value: 'reasoning', label: 'AI Reasoning' },
];

const STATUS_VARIANT: Record<string, BadgeVariant> = { completed: 'success', failed: 'danger' };

/** A stat whose figure is unknown shows a dash and says so in its label: never 0. */
const figure = (known: boolean, value: string, label: string) => ({
  value: known ? value : EMPTY_VALUE,
  label: known ? label : `${label} (not available yet)`,
});

export const SessionDetailModal: React.FC<SessionDetailModalProps> = ({ session, open, onClose }) => {
  const [activeTab, setActiveTab] = useState<TabValue>('overview');

  const confidence = figure(
    isKnown(session.confidenceScore),
    `${((session.confidenceScore ?? 0) * 100).toFixed(0)}%`,
    'Confidence',
  );
  const cost = figure(isKnown(session.estimatedCost), `$${(session.estimatedCost ?? 0).toFixed(4)}`, 'Cost');

  const panel = (value: TabValue, content: React.ReactNode) => (
    <TabPanel tabsId={TABS_ID} value={value} selected={activeTab === value} className="mt-4 space-y-4">
      {activeTab === value && content}
    </TabPanel>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-label={`Discovery session ${session.sessionId}`}
      className="max-h-[90vh] max-w-5xl overflow-y-auto"
    >
      <div className="space-y-4 p-6">
        <SectionHeading className="mb-0 pr-10">
          <span className="flex items-center gap-3">
            <Icon name="brain" size={20} />
            <span>Discovery Session</span>
            <Badge variant="neutral" className="hh-mono">
              {session.sessionId}
            </Badge>
          </span>
        </SectionHeading>

        <Tabs
          id={TABS_ID}
          aria-label="Session details"
          value={activeTab}
          onChange={setActiveTab}
          options={TAB_OPTIONS}
        />

        {panel(
          'overview',
          <Card className="space-y-4">
            <SectionHeading level={3} className="mb-0">Session Information</SectionHeading>
            <FieldList
              fields={[
                ['Target', <span className="hh-mono font-semibold">{session.targetHost}:{session.targetPort}</span>],
                [
                  'Status',
                  <Badge variant={STATUS_VARIANT[session.status] ?? 'info'}>{session.status}</Badge>,
                ],
                ['AI Model', session.aiModel],
              ]}
            />

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat size="sm" align="left" {...confidence} />
              <Stat size="sm" align="left" {...cost} />
              <Stat
                size="sm"
                align="left"
                label="Duration"
                value={session.durationMs ? `${(session.durationMs / 1000).toFixed(1)}s` : '-'}
              />
              <Stat
                size="sm"
                align="left"
                label="CIs Found"
                value={session.discoveredCIs ? session.discoveredCIs.length : EMPTY_VALUE}
              />
            </div>

            <div className="border-t border-[var(--hh-hairline)] pt-4">
              <p className="mb-2 text-xs text-[var(--hh-text-muted)]">Token Usage</p>
              <FieldList
                fields={[
                  ['Total', formatCount(session.totalTokens)],
                  ['Prompt', formatCount(session.promptTokens)],
                  ['Completion', formatCount(session.completionTokens)],
                ]}
              />
            </div>

            <div className="border-t border-[var(--hh-hairline)] pt-4">
              <FieldList
                fields={[
                  ['Started', new Date(session.startedAt).toLocaleString()],
                  ['Completed', session.completedAt ? new Date(session.completedAt).toLocaleString() : null],
                ]}
              />
            </div>
          </Card>,
        )}

        {panel(
          'tools',
          <Card className="space-y-4">
            <SectionHeading level={3} className="mb-0">
              <span className="flex items-center gap-2">
                <Icon name="wrench" size={16} />
                Tool Execution Timeline
              </span>
            </SectionHeading>
            {session.toolCalls && session.toolCalls.length > 0 ? (
              <div className="space-y-3">
                {session.toolCalls.map((toolCall, index) => (
                  <Card key={index} inset="none" className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{toolCall.toolName}</p>
                        <p className="text-xs text-[var(--hh-text-muted)]">
                          {new Date(toolCall.timestamp).toLocaleTimeString()} • {toolCall.executionTime}ms
                        </p>
                      </div>
                      <Badge variant={toolCall.success ? 'success' : 'danger'}>
                        <Icon name={toolCall.success ? 'check-circle' : 'x-circle'} size={12} />
                        {toolCall.success ? 'Succeeded' : 'Failed'}
                      </Badge>
                    </div>
                    <JsonBlock label="Input" value={toolCall.input} />
                    <JsonBlock label="Output" value={toolCall.output} />
                  </Card>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--hh-text-muted)]">No tool calls recorded</p>
            )}
          </Card>,
        )}

        {panel(
          'results',
          <Card className="space-y-4">
            <SectionHeading level={3} className="mb-0">
              <span className="flex items-center gap-2">
                <Icon name="file-code" size={16} />
                Discovered Configuration Items
              </span>
            </SectionHeading>
            {session.discoveredCIs && session.discoveredCIs.length > 0 ? (
              <div className="space-y-3">
                {session.discoveredCIs.map((ci, index) => (
                  <Card key={index} inset="none" className="space-y-2 p-3">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold">{ciDisplayName(ci)}</p>
                      <Badge variant="neutral">{ciType(ci)}</Badge>
                    </div>
                    <JsonBlock label="Data" value={ci} />
                  </Card>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--hh-text-muted)]">No configuration items discovered</p>
            )}
          </Card>,
        )}

        {panel(
          'reasoning',
          <Card className="space-y-4">
            <SectionHeading level={3} className="mb-0">
              <span className="flex items-center gap-2">
                <Icon name="chat-text" size={16} />
                AI Reasoning
              </span>
            </SectionHeading>
            {session.aiReasoning ? (
              <p className="whitespace-pre-wrap text-sm">{session.aiReasoning}</p>
            ) : (
              <p className="text-sm text-[var(--hh-text-muted)]">No reasoning available</p>
            )}
          </Card>,
        )}
      </div>
    </Dialog>
  );
};
