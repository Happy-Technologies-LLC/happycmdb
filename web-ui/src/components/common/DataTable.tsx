// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { DataTableColumn, SortOptions } from '../../types';

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  total?: number;
  page?: number;
  rowsPerPage?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  selectable?: boolean;
  selectedRows?: string[];
  onRowSelect?: (selectedIds: string[]) => void;
  onPageChange?: (page: number) => void;
  onRowsPerPageChange?: (rowsPerPage: number) => void;
  onSortChange?: (sort: SortOptions) => void;
  onView?: (row: T) => void;
  onEdit?: (row: T) => void;
  onDelete?: (row: T) => void;
  rowIdField?: keyof T;
  emptyMessage?: string;
  loading?: boolean;
}

function DataTable<T extends Record<string, any>>({
  columns,
  data,
  total = 0,
  page = 0,
  rowsPerPage = 10,
  sortBy,
  sortOrder = 'asc',
  selectable = false,
  selectedRows = [],
  onRowSelect,
  onPageChange,
  onRowsPerPageChange,
  onSortChange,
  onView,
  onEdit,
  onDelete,
  rowIdField = 'id' as keyof T,
  emptyMessage = 'No data available',
  loading = false,
}: DataTableProps<T>) {
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const newSelected = data.map((row) => String(row[rowIdField]));
      onRowSelect?.(newSelected);
    } else {
      onRowSelect?.([]);
    }
  };

  const handleSelectOne = (id: string) => {
    const selectedIndex = selectedRows.indexOf(id);
    let newSelected: string[] = [];

    if (selectedIndex === -1) {
      newSelected = [...selectedRows, id];
    } else {
      newSelected = selectedRows.filter((item) => item !== id);
    }

    onRowSelect?.(newSelected);
  };

  const handleSort = (field: string) => {
    const isAsc = sortBy === field && sortOrder === 'asc';
    onSortChange?.({
      field,
      order: isAsc ? 'desc' : 'asc',
    });
  };

  const isSelected = (id: string) => selectedRows.indexOf(id) !== -1;

  const hasActions = onView || onEdit || onDelete;

  const handlePageChange = (newPage: number) => {
    onPageChange?.(newPage);
  };

  const handleRowsPerPageChange = (value: string) => {
    onRowsPerPageChange?.(parseInt(value, 10));
  };

  return (
    <Card className="shadow-sm">
      <div className="relative w-full overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-12">
                  <Checkbox
                    checked={data.length > 0 && selectedRows.length === data.length}
                    onCheckedChange={handleSelectAll}
                    aria-label="Select all"
                  />
                </TableHead>
              )}
              {columns.map((column) => (
                <TableHead
                  key={String(column.field)}
                  style={{ width: column.width, flex: column.flex }}
                >
                  {column.sortable !== false ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="-ml-3 h-8 data-[state=open]:bg-accent"
                      onClick={() => handleSort(String(column.field))}
                    >
                      <span>{column.headerName}</span>
                      <Icon
                        name="arrows-down-up"
                        size={16}
                        className={cn(
                          'ml-2',
                          sortBy === column.field ? 'opacity-100' : 'opacity-50'
                        )}
                      />
                    </Button>
                  ) : (
                    column.headerName
                  )}
                </TableHead>
              ))}
              {hasActions && (
                <TableHead className="text-right w-32">Actions</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (selectable ? 1 : 0) + (hasActions ? 1 : 0)}
                  className="h-32 text-center"
                >
                  <p className="text-sm text-muted-foreground">Loading...</p>
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (selectable ? 1 : 0) + (hasActions ? 1 : 0)}
                  className="h-32 text-center"
                >
                  <p className="text-sm text-muted-foreground">{emptyMessage}</p>
                </TableCell>
              </TableRow>
            ) : (
              data.map((row) => {
                const rowId = String(row[rowIdField]);
                const isItemSelected = isSelected(rowId);

                return (
                  <TableRow
                    key={rowId}
                    data-state={isItemSelected && 'selected'}
                    className="hover:bg-muted/50"
                  >
                    {selectable && (
                      <TableCell>
                        <Checkbox
                          checked={isItemSelected}
                          onCheckedChange={() => handleSelectOne(rowId)}
                          aria-label="Select row"
                        />
                      </TableCell>
                    )}
                    {columns.map((column) => (
                      <TableCell key={String(column.field)}>
                        {column.renderCell
                          ? column.renderCell(row[column.field], row)
                          : row[column.field]}
                      </TableCell>
                    ))}
                    {hasActions && (
                      <TableCell className="text-right">
                        <div className="flex gap-1 justify-end">
                          {onView && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => onView(row)}
                            >
                              <Icon name="eye" size={16} />
                              <span className="sr-only">View</span>
                            </Button>
                          )}
                          {onEdit && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => onEdit(row)}
                            >
                              <Icon name="pencil-simple" size={16} />
                              <span className="sr-only">Edit</span>
                            </Button>
                          )}
                          {onDelete && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive"
                              onClick={() => onDelete(row)}
                            >
                              <Icon name="trash" size={16} />
                              <span className="sr-only">Delete</span>
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {onPageChange && (
        <div className="flex items-center justify-between px-4 py-4 border-t">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              Rows per page:
            </p>
            <select
              value={rowsPerPage}
              onChange={(e) => handleRowsPerPageChange(e.target.value)}
              className="h-8 w-16 rounded-md border border-input bg-background px-2 text-sm"
            >
              {[5, 10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              Page {page + 1} of {Math.ceil(total / rowsPerPage)}
            </p>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(page - 1)}
                disabled={page === 0}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(page + 1)}
                disabled={page >= Math.ceil(total / rowsPerPage) - 1}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default DataTable;
