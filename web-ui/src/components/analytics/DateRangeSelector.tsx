// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * DateRangeSelector Component
 * Date range picker with preset options and custom range selection
 */

import React, { useState } from 'react';
import { Button, Card, Input } from '@happy-technologies/design-system';
import { DateRangeParams } from '../../services/analytics.service';

export interface DateRangeSelectorProps {
  onChange: (dateRange: DateRangeParams) => void;
  defaultRange?: PresetRange;
}

export type PresetRange = 'today' | '7days' | '30days' | '90days' | 'custom';

interface PresetOption {
  id: PresetRange;
  label: string;
  getRange: () => DateRangeParams;
}

const presetOptions: PresetOption[] = [
  {
    id: 'today',
    label: 'Today',
    getRange: () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return {
        startDate: today.toISOString(),
        endDate: new Date().toISOString(),
      };
    },
  },
  {
    id: '7days',
    label: 'Last 7 Days',
    getRange: () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      return {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      };
    },
  },
  {
    id: '30days',
    label: 'Last 30 Days',
    getRange: () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
      return {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      };
    },
  },
  {
    id: '90days',
    label: 'Last 90 Days',
    getRange: () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 90);
      return {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      };
    },
  },
];

export const DateRangeSelector: React.FC<DateRangeSelectorProps> = ({
  onChange,
  defaultRange = '7days',
}) => {
  const [selectedRange, setSelectedRange] = useState<PresetRange>(defaultRange);
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [showCustom, setShowCustom] = useState(false);

  const handlePresetSelect = (preset: PresetOption) => {
    setSelectedRange(preset.id);
    setShowCustom(false);
    const range = preset.getRange();
    onChange(range);
  };

  const handleCustomRangeApply = () => {
    if (customStartDate && customEndDate) {
      setSelectedRange('custom');
      onChange({
        startDate: new Date(customStartDate).toISOString(),
        endDate: new Date(customEndDate).toISOString(),
      });
    }
  };

  return (
    <Card className="mb-4">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {presetOptions.map((preset) => (
            <Button
              key={preset.id}
              onClick={() => handlePresetSelect(preset)}
              variant={selectedRange === preset.id ? 'primary' : 'secondary'}
              aria-pressed={selectedRange === preset.id}
            >
              {preset.label}
            </Button>
          ))}
          <Button
            onClick={() => setShowCustom(!showCustom)}
            variant={selectedRange === 'custom' ? 'primary' : 'secondary'}
            aria-pressed={selectedRange === 'custom'}
          >
            Custom
          </Button>
        </div>

        {showCustom && (
          <div className="flex flex-wrap items-end gap-4">
            <Input
              id="start-date"
              label="Start Date"
              type="date"
              size="sm"
              containerClassName="flex-1"
              value={customStartDate}
              onChange={(e) => setCustomStartDate(e.target.value)}
            />
            <Input
              id="end-date"
              label="End Date"
              type="date"
              size="sm"
              containerClassName="flex-1"
              value={customEndDate}
              onChange={(e) => setCustomEndDate(e.target.value)}
            />
            <Button
              onClick={handleCustomRangeApply}
              disabled={!customStartDate || !customEndDate}
            >
              Apply
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
};
