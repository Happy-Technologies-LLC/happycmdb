// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ExportButton Component
 * Button with dropdown menu to export analytics data as CSV or JSON
 */

import React, { useState } from 'react';
import {
  Button,
  ExportButton as DsExportButton,
  type ExportFormat,
} from '@happy-technologies/design-system';
import { analyticsService } from '../../services/analytics.service';
import { logClientError } from '../../utils/logger';

export interface ExportButtonProps {
  data: any[];
  filename: string;
  disabled?: boolean;
}

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
      logClientError('Export failed:', error);
      alert('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  if (disabled || exporting) {
    return (
      <Button variant="secondary" icon="download-simple" loading={exporting} disabled>
        {exporting ? 'Exporting...' : 'Export'}
      </Button>
    );
  }

  return <DsExportButton formats={['csv', 'json']} onExport={handleExport} />;
};
