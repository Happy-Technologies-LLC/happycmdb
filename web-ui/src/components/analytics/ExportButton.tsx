// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ExportButton Component
 * Button with dropdown menu to export analytics data as CSV or JSON
 */

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@happy-technologies/design-system';
import { analyticsService } from '../../services/analytics.service';

export interface ExportButtonProps {
  data: any[];
  filename: string;
  disabled?: boolean;
}

type ExportFormat = 'csv' | 'json';

export const ExportButton: React.FC<ExportButtonProps> = ({
  data,
  filename,
  disabled = false,
}) => {
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format: ExportFormat) => {
    setExporting(true);

    try {
      const timestamp = new Date().toISOString().split('T')[0];
      const fullFilename = `${filename}_${timestamp}.${format}`;

      if (format === 'csv') {
        await analyticsService.exportToCSV(data, fullFilename);
      } else {
        await analyticsService.exportToJSON(data, fullFilename);
      }
    } catch (error) {
      console.error('Export failed:', error);
      alert('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          size="sm"
          disabled={disabled || exporting}
        >
          {exporting ? (
            <>
              <Icon name="spinner-gap" size={16} className="animate-spin" />
              Exporting...
            </>
          ) : (
            <>
              <Icon name="download-simple" size={16} />
              Export
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleExport('csv')}>
          Export as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport('json')}>
          Export as JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
