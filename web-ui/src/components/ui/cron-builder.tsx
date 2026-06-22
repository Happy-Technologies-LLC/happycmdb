// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Label } from './label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import { Input } from './input';
import { Button } from './button';

interface CronBuilderProps {
  value?: string;
  onChange: (cronExpression: string) => void;
}

export const CronBuilder: React.FC<CronBuilderProps> = ({ value = '0 9 * * *', onChange }) => {
  const [frequency, setFrequency] = useState('daily');
  const [time, setTime] = useState('09:00');
  const [dayOfWeek, setDayOfWeek] = useState('1');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [copied, setCopied] = useState(false);

  // Parse initial value if provided
  useEffect(() => {
    if (value) {
      const parts = value.split(' ');
      if (parts.length === 5) {
        const [min, hour, day, month, weekday] = parts;

        // Determine frequency
        if (min === '*' && hour === '*') {
          setFrequency('minute');
        } else if (hour === '*') {
          setFrequency('hourly');
          setTime(`00:${min}`);
        } else if (day === '*' && weekday === '*') {
          setFrequency('daily');
          setTime(`${hour.padStart(2, '0')}:${min.padStart(2, '0')}`);
        } else if (day === '*' && weekday !== '*') {
          setFrequency('weekly');
          setTime(`${hour.padStart(2, '0')}:${min.padStart(2, '0')}`);
          setDayOfWeek(weekday);
        } else if (day !== '*') {
          setFrequency('monthly');
          setTime(`${hour.padStart(2, '0')}:${min.padStart(2, '0')}`);
          setDayOfMonth(day);
        }
      }
    }
  }, []);

  useEffect(() => {
    const [hours, minutes] = time.split(':');
    let expression = '';

    switch (frequency) {
      case 'minute':
        expression = '* * * * *';
        break;
      case 'hourly':
        expression = `${minutes} * * * *`;
        break;
      case 'daily':
        expression = `${minutes} ${hours} * * *`;
        break;
      case 'weekly':
        expression = `${minutes} ${hours} * * ${dayOfWeek}`;
        break;
      case 'monthly':
        expression = `${minutes} ${hours} ${dayOfMonth} * *`;
        break;
      default:
        expression = '* * * * *';
    }

    onChange(expression);
  }, [frequency, time, dayOfWeek, dayOfMonth, onChange]);

  const copyToClipboard = () => {
    const [hours, minutes] = time.split(':');
    let expression = '';

    switch (frequency) {
      case 'minute':
        expression = '* * * * *';
        break;
      case 'hourly':
        expression = `${minutes} * * * *`;
        break;
      case 'daily':
        expression = `${minutes} ${hours} * * *`;
        break;
      case 'weekly':
        expression = `${minutes} ${hours} * * ${dayOfWeek}`;
        break;
      case 'monthly':
        expression = `${minutes} ${hours} ${dayOfMonth} * *`;
        break;
      default:
        expression = '* * * * *';
    }

    navigator.clipboard.writeText(expression);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getDescription = () => {
    const [hours, minutes] = time.split(':');
    const timeStr = `${hours}:${minutes}`;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    switch (frequency) {
      case 'minute':
        return 'Every minute';
      case 'hourly':
        return `Every hour at ${minutes} minutes past`;
      case 'daily':
        return `Every day at ${timeStr}`;
      case 'weekly':
        return `Every ${days[parseInt(dayOfWeek)]} at ${timeStr}`;
      case 'monthly':
        return `Day ${dayOfMonth} of every month at ${timeStr}`;
      default:
        return '';
    }
  };

  const getCronExpression = () => {
    const [hours, minutes] = time.split(':');
    switch (frequency) {
      case 'minute':
        return '* * * * *';
      case 'hourly':
        return `${minutes} * * * *`;
      case 'daily':
        return `${minutes} ${hours} * * *`;
      case 'weekly':
        return `${minutes} ${hours} * * ${dayOfWeek}`;
      case 'monthly':
        return `${minutes} ${hours} ${dayOfMonth} * *`;
      default:
        return '* * * * *';
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="frequency">How often should this run?</Label>
        <Select value={frequency} onValueChange={setFrequency}>
          <SelectTrigger id="frequency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minute">Every minute</SelectItem>
            <SelectItem value="hourly">Every hour</SelectItem>
            <SelectItem value="daily">Every day</SelectItem>
            <SelectItem value="weekly">Every week</SelectItem>
            <SelectItem value="monthly">Every month</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {frequency !== 'minute' && (
        <div className="space-y-2">
          <Label htmlFor="time">At what time?</Label>
          <Input
            id="time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
      )}

      {frequency === 'weekly' && (
        <div className="space-y-2">
          <Label htmlFor="day-of-week">On which day?</Label>
          <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
            <SelectTrigger id="day-of-week">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Sunday</SelectItem>
              <SelectItem value="1">Monday</SelectItem>
              <SelectItem value="2">Tuesday</SelectItem>
              <SelectItem value="3">Wednesday</SelectItem>
              <SelectItem value="4">Thursday</SelectItem>
              <SelectItem value="5">Friday</SelectItem>
              <SelectItem value="6">Saturday</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {frequency === 'monthly' && (
        <div className="space-y-2">
          <Label htmlFor="day-of-month">On which day of the month?</Label>
          <Input
            id="day-of-month"
            type="number"
            min="1"
            max="31"
            value={dayOfMonth}
            onChange={(e) => setDayOfMonth(e.target.value)}
          />
        </div>
      )}

      <div className="bg-muted rounded-lg p-4 border">
        <div className="flex items-center gap-2 mb-2">
          <Icon name="clock" size={16} className="text-muted-foreground" />
          <span className="text-sm font-semibold">Schedule Summary</span>
        </div>

        <div className="bg-background rounded-md p-3 border">
          <div className="text-base font-medium text-foreground">
            {getDescription()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CronBuilder;
