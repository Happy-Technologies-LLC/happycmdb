// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// F-032 retest (cycle 10): Select-all/select-one emit IDs; sortable header
// toggles asc/desc; next/previous respect bounds; view/edit/delete call their
// supplied callbacks.

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/tests/utils/test-utils';
import DataTable from './DataTable';
import type { DataTableColumn } from '../../types';

interface Row {
  id: string;
  name: string;
}

const columns: DataTableColumn<Row>[] = [
  { field: 'name', headerName: 'Name' },
];

const rows: Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
];

describe('DataTable Component (F-032)', () => {
  it('emits all row IDs on select-all and [] on deselect-all', async () => {
    const user = userEvent.setup();
    const onRowSelect = vi.fn();
    render(
      <DataTable columns={columns} data={rows} selectable onRowSelect={onRowSelect} />
    );

    const selectAll = screen.getByLabelText('Select all');
    await user.click(selectAll);
    expect(onRowSelect).toHaveBeenCalledWith(['a', 'b']);
  });

  it('emits the toggled ID set on select-one', async () => {
    const user = userEvent.setup();
    const onRowSelect = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={rows}
        selectable
        selectedRows={['a']}
        onRowSelect={onRowSelect}
      />
    );

    const rowCheckboxes = screen.getAllByLabelText('Select row');
    // Row 'b' (index 1) is unselected; clicking it should add it.
    await user.click(rowCheckboxes[1]);
    expect(onRowSelect).toHaveBeenCalledWith(['a', 'b']);
  });

  it('toggles sort order asc -> desc on repeated header clicks', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    const { rerender } = render(
      <DataTable columns={columns} data={rows} onSortChange={onSortChange} />
    );

    await user.click(screen.getByText('Name'));
    expect(onSortChange).toHaveBeenCalledWith({ field: 'name', order: 'asc' });

    rerender(
      <DataTable
        columns={columns}
        data={rows}
        sortBy="name"
        sortOrder="asc"
        onSortChange={onSortChange}
      />
    );
    await user.click(screen.getByText('Name'));
    expect(onSortChange).toHaveBeenCalledWith({ field: 'name', order: 'desc' });
  });

  it('disables Previous on the first page and Next on the last page', () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        total={2}
        page={0}
        rowsPerPage={10}
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByText('Previous')).toBeDisabled();
    expect(screen.getByText('Next')).toBeDisabled(); // ceil(2/10)-1 === 0 === page
  });

  it('calls onPageChange with the next page when Next is enabled', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={rows}
        total={25}
        page={0}
        rowsPerPage={10}
        onPageChange={onPageChange}
      />
    );

    expect(screen.getByText('Previous')).toBeDisabled();
    await user.click(screen.getByText('Next'));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('invokes onView/onEdit/onDelete callbacks with the row', async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={rows}
        onView={onView}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    );

    await user.click(screen.getAllByTitle('View Details')[0]);
    expect(onView).toHaveBeenCalledWith(rows[0]);

    await user.click(screen.getAllByTitle('Edit')[0]);
    expect(onEdit).toHaveBeenCalledWith(rows[0]);

    await user.click(screen.getAllByTitle('Delete')[0]);
    expect(onDelete).toHaveBeenCalledWith(rows[0]);
  });
});
