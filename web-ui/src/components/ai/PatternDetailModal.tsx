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
} from '@happy-technologies/design-system';
import { AIPattern } from '@/services/ai-pattern.service';
import { EMPTY_VALUE, isKnown } from '@/lib/dashboardValue';

interface PatternDetailModalProps {
  pattern: AIPattern;
  open: boolean;
  onClose: () => void;
}

type TabValue = 'info' | 'detection' | 'discovery' | 'tests';

const TABS_ID = 'pattern-detail-tabs';
const TAB_OPTIONS: Array<{ value: TabValue; label: string }> = [
  { value: 'info', label: 'Info' },
  { value: 'detection', label: 'Detection' },
  { value: 'discovery', label: 'Discovery' },
  { value: 'tests', label: 'Tests' },
];

const CodeBlock: React.FC<{ code: string }> = ({ code }) => (
  <pre className="hh-mono overflow-x-auto rounded-[var(--hh-radius-md)] bg-[var(--hh-bg-elevated)] p-4 text-xs text-[var(--hh-text-secondary)]">
    <code>{code}</code>
  </pre>
);

export const PatternDetailModal: React.FC<PatternDetailModalProps> = ({ pattern, open, onClose }) => {
  const [activeTab, setActiveTab] = useState<TabValue>('info');

  // Unknown (a pattern that was never used), not 0%
  const successRate = pattern.usageCount > 0
    ? (pattern.successCount / pattern.usageCount) * 100
    : null;

  const panel = (value: TabValue, content: React.ReactNode) => (
    <TabPanel tabsId={TABS_ID} value={value} selected={activeTab === value} className="mt-4 space-y-4">
      {activeTab === value && content}
    </TabPanel>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-label={`Pattern ${pattern.name}`}
      className="max-h-[90vh] max-w-4xl overflow-y-auto"
    >
      <div className="space-y-4 p-6">
        <SectionHeading className="mb-0 pr-10">
          <span className="flex items-center gap-3">
            <span>{pattern.name}</span>
            <Badge variant="neutral">{pattern.category}</Badge>
          </span>
        </SectionHeading>

        <Tabs
          id={TABS_ID}
          aria-label="Pattern details"
          value={activeTab}
          onChange={setActiveTab}
          options={TAB_OPTIONS}
        />

        {panel(
          'info',
          <Card className="space-y-4">
            <SectionHeading level={3} className="mb-0">Pattern Information</SectionHeading>
            <div className="grid grid-cols-2 gap-4">
              <Stat
                size="sm"
                align="left"
                label="Confidence Score"
                value={isKnown(pattern.confidenceScore) ? `${(pattern.confidenceScore * 100).toFixed(0)}%` : EMPTY_VALUE}
              />
              <Stat
                size="sm"
                align="left"
                label="Success Rate"
                value={successRate === null ? EMPTY_VALUE : `${successRate.toFixed(0)}%`}
              />
            </div>
            <FieldList
              fields={[
                ['Pattern ID', <span className="hh-mono">{pattern.patternId}</span>],
                [
                  'Status',
                  pattern.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">{pattern.status}</Badge>,
                ],
                ['Description', pattern.description],
                ['Usage Count', pattern.usageCount],
                [
                  'Avg Execution Time',
                  isKnown(pattern.avgExecutionTimeMs) ? `${pattern.avgExecutionTimeMs}ms` : EMPTY_VALUE,
                ],
                [
                  'Learned From',
                  pattern.learnedFromSessions && pattern.learnedFromSessions.length > 0
                    ? `${pattern.learnedFromSessions.length} discovery sessions`
                    : null,
                ],
                [
                  'Created',
                  <>
                    {new Date(pattern.createdAt).toLocaleDateString()}
                    <span className="block text-xs text-[var(--hh-text-muted)]">{pattern.author}</span>
                  </>,
                ],
                [
                  'Approved',
                  pattern.approvedAt ? (
                    <>
                      {new Date(pattern.approvedAt).toLocaleDateString()}
                      {pattern.approvedBy && (
                        <span className="block text-xs text-[var(--hh-text-muted)]">{pattern.approvedBy}</span>
                      )}
                    </>
                  ) : null,
                ],
              ]}
            />
          </Card>,
        )}

        {panel(
          'detection',
          <Card className="space-y-4">
            <SectionHeading level={3} className="mb-0">
              <span className="flex items-center gap-2">
                <Icon name="code" size={16} />
                Detection Function
              </span>
            </SectionHeading>
            <CodeBlock code={pattern.detectionCode} />
          </Card>,
        )}

        {panel(
          'discovery',
          <Card className="space-y-4">
            <SectionHeading level={3} className="mb-0">
              <span className="flex items-center gap-2">
                <Icon name="file-code" size={16} />
                Discovery Function
              </span>
            </SectionHeading>
            <CodeBlock code={pattern.discoveryCode} />
          </Card>,
        )}

        {panel(
          'tests',
          <Card className="space-y-4">
            <SectionHeading level={3} className="mb-0">
              <span className="flex items-center gap-2">
                <Icon name="test-tube" size={16} />
                Test Cases
              </span>
            </SectionHeading>
            {pattern.testCases && pattern.testCases.length > 0 ? (
              <div className="space-y-3">
                {pattern.testCases.map((testCase, index) => (
                  <Card key={index} inset="none" className="space-y-2 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">{testCase.name}</p>
                      {testCase.expectedMatch ? (
                        <Badge variant="success">
                          <Icon name="check-circle" size={12} />
                          Should Match
                        </Badge>
                      ) : (
                        <Badge variant="neutral">
                          <Icon name="x-circle" size={12} />
                          Should Not Match
                        </Badge>
                      )}
                    </div>
                    {testCase.expectedConfidence !== undefined && (
                      <p className="text-xs text-[var(--hh-text-muted)]">
                        Expected confidence: {(testCase.expectedConfidence * 100).toFixed(0)}%
                      </p>
                    )}
                    <JsonBlock label="Input" value={testCase.input} />
                  </Card>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--hh-text-muted)]">No test cases defined</p>
            )}
          </Card>,
        )}
      </div>
    </Dialog>
  );
};
