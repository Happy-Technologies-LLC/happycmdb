// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle } from 'lucide-react';

export interface RiskItem {
  id: string;
  name: string;
  criticality: 'low' | 'medium' | 'high' | 'critical';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  type?: string;
  description?: string;
}

interface RiskMatrixProps {
  items: RiskItem[];
  title?: string;
  description?: string;
  onItemClick?: (item: RiskItem) => void;
}

const CRITICALITY_ORDER = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const RISK_ORDER = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const CELL_COLORS = {
  '0-0': 'bg-success-soft',
  '0-1': 'bg-success-soft',
  '0-2': 'bg-warning-soft',
  '0-3': 'bg-warning-soft',
  '1-0': 'bg-success-soft',
  '1-1': 'bg-warning-soft',
  '1-2': 'bg-warning-soft',
  '1-3': 'bg-warning-soft',
  '2-0': 'bg-warning-soft',
  '2-1': 'bg-warning-soft',
  '2-2': 'bg-warning-soft',
  '2-3': 'bg-danger-soft',
  '3-0': 'bg-warning-soft',
  '3-1': 'bg-warning-soft',
  '3-2': 'bg-danger-soft',
  '3-3': 'bg-danger-soft',
};

export const RiskMatrix: React.FC<RiskMatrixProps> = ({
  items,
  title = 'Risk Matrix',
  description = 'Services by criticality and risk level',
  onItemClick,
}) => {
  const [selectedCell, setSelectedCell] = useState<string | null>(null);

  const getItemsInCell = (criticality: string, risk: string) => {
    return items.filter(
      (item) => item.criticality === criticality && item.riskLevel === risk
    );
  };

  const handleCellClick = (criticality: string, risk: string) => {
    const cellKey = `${criticality}-${risk}`;
    setSelectedCell(selectedCell === cellKey ? null : cellKey);
  };

  const selectedItems = selectedCell
    ? getItemsInCell(
        selectedCell.split('-')[0],
        selectedCell.split('-')[1]
      )
    : [];

  return (
    <LiquidGlass variant="default" rounded="xl">
      <div>
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
      
      
        <div className="space-y-4">
          {/* Matrix Grid */}
          <div className="grid grid-cols-5 gap-2">
            {/* Header Row */}
            <div className="col-span-1"></div>
            <div className="text-center text-sm font-semibold">Low Risk</div>
            <div className="text-center text-sm font-semibold">Medium Risk</div>
            <div className="text-center text-sm font-semibold">High Risk</div>
            <div className="text-center text-sm font-semibold">Critical Risk</div>

            {/* Critical Row */}
            <div className="text-right text-sm font-semibold pr-2 flex items-center justify-end">
              Critical
            </div>
            {['low', 'medium', 'high', 'critical'].map((risk) => {
              const count = getItemsInCell('critical', risk).length;
              const cellKey = `${CRITICALITY_ORDER.critical}-${RISK_ORDER[risk as keyof typeof RISK_ORDER]}`;
              return (
                <div
                  key={`critical-${risk}`}
                  className={`${CELL_COLORS[cellKey as keyof typeof CELL_COLORS]} p-4 rounded-lg cursor-pointer hover:shadow-md transition-shadow flex items-center justify-center border-2 ${selectedCell === `critical-${risk}` ? 'border-primary' : 'border-transparent'}`}
                  onClick={() => handleCellClick('critical', risk)}
                >
                  <div className="text-center">
                    <div className="text-2xl font-bold">{count}</div>
                    {count > 0 && (
                      <AlertTriangle className="h-4 w-4 mx-auto mt-1 text-muted-foreground" />
                    )}
                  </div>
                </div>
              );
            })}

            {/* High Row */}
            <div className="text-right text-sm font-semibold pr-2 flex items-center justify-end">
              High
            </div>
            {['low', 'medium', 'high', 'critical'].map((risk) => {
              const count = getItemsInCell('high', risk).length;
              const cellKey = `${CRITICALITY_ORDER.high}-${RISK_ORDER[risk as keyof typeof RISK_ORDER]}`;
              return (
                <div
                  key={`high-${risk}`}
                  className={`${CELL_COLORS[cellKey as keyof typeof CELL_COLORS]} p-4 rounded-lg cursor-pointer hover:shadow-md transition-shadow flex items-center justify-center border-2 ${selectedCell === `high-${risk}` ? 'border-primary' : 'border-transparent'}`}
                  onClick={() => handleCellClick('high', risk)}
                >
                  <div className="text-center">
                    <div className="text-2xl font-bold">{count}</div>
                  </div>
                </div>
              );
            })}

            {/* Medium Row */}
            <div className="text-right text-sm font-semibold pr-2 flex items-center justify-end">
              Medium
            </div>
            {['low', 'medium', 'high', 'critical'].map((risk) => {
              const count = getItemsInCell('medium', risk).length;
              const cellKey = `${CRITICALITY_ORDER.medium}-${RISK_ORDER[risk as keyof typeof RISK_ORDER]}`;
              return (
                <div
                  key={`medium-${risk}`}
                  className={`${CELL_COLORS[cellKey as keyof typeof CELL_COLORS]} p-4 rounded-lg cursor-pointer hover:shadow-md transition-shadow flex items-center justify-center border-2 ${selectedCell === `medium-${risk}` ? 'border-primary' : 'border-transparent'}`}
                  onClick={() => handleCellClick('medium', risk)}
                >
                  <div className="text-center">
                    <div className="text-2xl font-bold">{count}</div>
                  </div>
                </div>
              );
            })}

            {/* Low Row */}
            <div className="text-right text-sm font-semibold pr-2 flex items-center justify-end">
              Low
            </div>
            {['low', 'medium', 'high', 'critical'].map((risk) => {
              const count = getItemsInCell('low', risk).length;
              const cellKey = `${CRITICALITY_ORDER.low}-${RISK_ORDER[risk as keyof typeof RISK_ORDER]}`;
              return (
                <div
                  key={`low-${risk}`}
                  className={`${CELL_COLORS[cellKey as keyof typeof CELL_COLORS]} p-4 rounded-lg cursor-pointer hover:shadow-md transition-shadow flex items-center justify-center border-2 ${selectedCell === `low-${risk}` ? 'border-primary' : 'border-transparent'}`}
                  onClick={() => handleCellClick('low', risk)}
                >
                  <div className="text-center">
                    <div className="text-2xl font-bold">{count}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected Items List */}
          {selectedCell && selectedItems.length > 0 && (
            <div className="mt-4 p-4 border border-border rounded-lg">
              <h4 className="font-semibold mb-3">
                Selected Services ({selectedItems.length})
              </h4>
              <div className="space-y-2">
                {selectedItems.map((item) => (
                  <div
                    key={item.id}
                    className="p-3 bg-accent rounded-lg hover:bg-accent/80 cursor-pointer transition-colors"
                    onClick={() => onItemClick?.(item)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <p className="font-medium">{item.name}</p>
                        {item.description && (
                          <p className="text-sm text-muted-foreground">{item.description}</p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Badge variant="outline" className="capitalize">
                          {item.criticality}
                        </Badge>
                        <Badge variant="outline" className="capitalize">
                          {item.riskLevel}
                        </Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </LiquidGlass>
  );
};
