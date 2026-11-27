// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FieldMappingBuilder } from './FieldMappingBuilder';

type Mappings = React.ComponentProps<typeof FieldMappingBuilder>['mappings'];

const base = (id: string, extra: Partial<Mappings[number]> = {}): Mappings[number] => ({
  id,
  source_field: '',
  target_field: '',
  transformation: { type: 'direct' },
  required: false,
  ...extra,
});

/** Holds the controlled `mappings` like ConnectorConfigModal does and records the latest value. */
function renderBuilder(initial: Mappings = []) {
  const latest = { current: initial };
  const Wrapper = () => {
    const [mappings, setMappings] = useState<Mappings>(initial);
    return (
      <FieldMappingBuilder
        connectorType="servicenow"
        mappings={mappings}
        onChange={(next) => {
          latest.current = next;
          setMappings(next);
        }}
      />
    );
  };
  render(<Wrapper />);
  return latest;
}

afterEach(cleanup);

describe('FieldMappingBuilder', () => {
  it('shows the empty state copy when there are no mappings', () => {
    renderBuilder();
    expect(screen.getByText('No field mappings configured yet')).toBeInTheDocument();
    expect(screen.getByText('Add your first mapping to get started')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Field Mapping' })).toBeInTheDocument();
  });

  it('appends a blank direct mapping in edit mode', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();

    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    expect(latest.current).toHaveLength(1);
    expect(latest.current[0]).toMatchObject({
      source_field: '',
      target_field: '',
      transformation: { type: 'direct' },
      required: false,
    });
    expect(latest.current[0].id).toMatch(/^mapping_/);
    expect(screen.queryByText('No field mappings configured yet')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mapping #1' })).toBeInTheDocument();
    expect(screen.getByLabelText('Source Field')).toHaveValue('');
  });

  it('exposes the source field by its label and hints the connector type', async () => {
    const user = userEvent.setup();
    renderBuilder([base('m1', { source_field: 'sys_id' })]);
    await user.click(screen.getByText('sys_id'));

    const source = screen.getByLabelText('Source Field');
    expect(source).toHaveValue('sys_id');
    expect(source).toHaveAccessibleDescription('Field name from servicenow source');
  });

  it('gives every field a label unique to its mapping', async () => {
    const user = userEvent.setup();
    renderBuilder([base('m1', { source_field: 'a' }), base('m2', { source_field: 'b' })]);
    await user.click(screen.getByText('a'));
    expect(screen.getAllByLabelText('Source Field')).toHaveLength(1);
    expect(screen.getByLabelText('Target Field')).toBeInTheDocument();
    expect(screen.getByLabelText('Transformation Type')).toBeInTheDocument();
    expect(screen.getByLabelText('Default Value (Optional)')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Required field' })).not.toBeChecked();
  });

  it('writes the typed source field into the mapping', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    await user.type(screen.getByLabelText('Source Field'), 'sys_id');

    expect(latest.current[0]).toMatchObject({ source_field: 'sys_id', target_field: '' });
    expect(screen.getByLabelText('Source Field')).toHaveValue('sys_id');
  });

  it('offers grouped target fields and writes a chosen standard field', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    const target = screen.getByLabelText('Target Field');
    expect(target).toHaveValue('');
    expect(within(target).getByRole('option', { name: 'Select target field or enter custom' })).toBeDisabled();
    expect(within(target).getByRole('group', { name: 'Standard CI Fields' })).toBeInTheDocument();
    expect(within(target).getByRole('group', { name: 'Common Metadata Fields' })).toBeInTheDocument();
    expect(within(target).getByRole('group', { name: 'Custom' })).toBeInTheDocument();
    expect(within(target).getByRole('option', { name: 'Name (Core) *' })).toBeInTheDocument();
    expect(within(target).getByRole('option', { name: 'Status (Core)' })).toBeInTheDocument();
    expect(within(target).getByRole('option', { name: 'RAM (MB) (Hardware)' })).toBeInTheDocument();
    expect(within(target).getByRole('option', { name: 'Enter custom field name...' })).toHaveValue('custom');

    await user.selectOptions(target, 'name');

    expect(latest.current[0].target_field).toBe('name');
    expect(screen.getByLabelText('Target Field')).toHaveValue('name');
    expect(
      screen.getByText('Select a standard CI field or create a custom metadata field')
    ).toBeInTheDocument();
  });

  it('notes metadata storage for a common metadata target', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    await user.selectOptions(screen.getByLabelText('Target Field'), 'os_version');

    expect(latest.current[0].target_field).toBe('os_version');
    expect(screen.getByText('This field will be stored in dynamic metadata')).toBeInTheDocument();
  });

  it('adds a custom target with Enter, shows the metadata hint and keeps the value selectable', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    await user.selectOptions(screen.getByLabelText('Target Field'), 'custom');
    expect(latest.current[0].target_field).toBe('');
    const custom = screen.getByLabelText('Target Field');
    expect(custom).toHaveAttribute(
      'placeholder',
      'Enter custom field name (e.g., cpu_cores, patch_level)'
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();

    await user.type(custom, '  patch_level  {Enter}');

    expect(latest.current[0].target_field).toBe('patch_level');
    expect(screen.getByText('This field will be stored in dynamic metadata')).toBeInTheDocument();
    const select = screen.getByLabelText('Target Field');
    expect(select).toHaveValue('patch_level');
    expect(
      within(within(select).getByRole('group', { name: 'Custom' })).getByRole('option', {
        name: 'patch_level',
      })
    ).toBeInTheDocument();
  });

  it('adds a custom target with the Add button and ignores a blank name', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));
    await user.selectOptions(screen.getByLabelText('Target Field'), 'custom');

    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(latest.current[0].target_field).toBe('');
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Target Field'), 'cpu_cores');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(latest.current[0].target_field).toBe('cpu_cores');
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('cancels the custom target with Escape and with Cancel without changing the mapping', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder([base('m1', { source_field: 's', target_field: 'name' })]);
    await user.click(screen.getByText('s'));

    await user.selectOptions(screen.getByLabelText('Target Field'), 'custom');
    await user.type(screen.getByLabelText('Target Field'), 'abandoned{Escape}');
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Target Field')).toHaveValue('name');

    await user.selectOptions(screen.getByLabelText('Target Field'), 'custom');
    expect(screen.getByLabelText('Target Field')).toHaveValue('');
    await user.type(screen.getByLabelText('Target Field'), 'abandoned');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Target Field')).toHaveValue('name');
    expect(latest.current[0].target_field).toBe('name');
  });

  it('keeps a pre-existing custom target visible in the select', async () => {
    const user = userEvent.setup();
    renderBuilder([base('m1', { source_field: 's', target_field: 'legacy_tag' })]);
    await user.click(screen.getByText('s'));

    expect(screen.getByLabelText('Target Field')).toHaveValue('legacy_tag');
    expect(screen.getByText('This field will be stored in dynamic metadata')).toBeInTheDocument();
  });

  it('switches to an expression transformation and stores the typed expression', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    const type = screen.getByLabelText('Transformation Type');
    expect(within(type).getAllByRole('option').map((o) => [o.getAttribute('value'), o.textContent])).toEqual([
      ['direct', 'Direct (no transformation)'],
      ['expression', 'Expression (JavaScript)'],
      ['lookup', 'Lookup Table'],
      ['conditional', 'Conditional Logic'],
    ]);
    await user.selectOptions(type, 'expression');
    expect(latest.current[0].transformation).toEqual({ type: 'expression' });

    await user.type(screen.getByLabelText('Expression'), 'value.trim()');

    expect(latest.current[0].transformation).toEqual({
      type: 'expression',
      expression: 'value.trim()',
    });
    expect(screen.getByText('JavaScript expression to transform the value')).toBeInTheDocument();
  });

  it('switches to a lookup transformation and stores the table name', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    await user.selectOptions(screen.getByLabelText('Transformation Type'), 'lookup');
    await user.type(screen.getByLabelText('Lookup Table Name'), 'status_map');

    expect(latest.current[0].transformation).toEqual({ type: 'lookup', lookup_table: 'status_map' });
    expect(
      screen.getByText('Reference to a lookup table for value translation')
    ).toBeInTheDocument();
  });

  it('switches to a conditional transformation and stores all three fields', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    await user.selectOptions(screen.getByLabelText('Transformation Type'), 'conditional');
    await user.type(screen.getByLabelText('If Condition'), 'v');
    await user.type(screen.getByLabelText('Then Value'), 'up');
    await user.type(screen.getByLabelText('Else Value'), 'down');

    expect(latest.current[0].transformation).toEqual({
      type: 'conditional',
      if_condition: 'v',
      then_value: 'up',
      else_value: 'down',
    });
  });

  it('stores the default value and the required flag', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    await user.type(screen.getByLabelText('Default Value (Optional)'), 'N/A');
    const required = screen.getByRole('checkbox', { name: 'Required field' });
    await user.click(required);

    expect(latest.current[0]).toMatchObject({ default_value: 'N/A', required: true });
    expect(required).toBeChecked();

    await user.click(required);
    expect(latest.current[0].required).toBe(false);
  });

  it('leaves edit mode with Done and shows the view summary', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));
    await user.type(screen.getByLabelText('Source Field'), 'sys_id');
    await user.selectOptions(screen.getByLabelText('Target Field'), 'name');
    await user.click(screen.getByRole('checkbox', { name: 'Required field' }));

    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByLabelText('Source Field')).not.toBeInTheDocument();
    expect(screen.getByText('sys_id')).toBeInTheDocument();
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('Direct')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
  });

  it('shows (empty) placeholders and the transformation badge in view mode', () => {
    renderBuilder([
      base('m1'),
      base('m2', { source_field: 'a', target_field: 'b', transformation: { type: 'expression' } }),
      base('m3', { source_field: 'c', target_field: 'd', transformation: { type: 'lookup' } }),
      base('m4', { source_field: 'e', target_field: 'f', transformation: { type: 'conditional' } }),
    ]);

    expect(screen.getAllByText('(empty)')).toHaveLength(2);
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
    expect(screen.getByText('Expression')).toBeInTheDocument();
    expect(screen.getByText('Lookup')).toBeInTheDocument();
    expect(screen.getByText('Conditional')).toBeInTheDocument();
    expect(screen.getByText('Direct')).toBeInTheDocument();
    expect(screen.queryByLabelText('Source Field')).not.toBeInTheDocument();
  });

  it('keeps insertion order (there is no reorder control) and numbers rows by position', () => {
    renderBuilder([
      base('m1', { source_field: 'first' }),
      base('m2', { source_field: 'second' }),
      base('m3', { source_field: 'third' }),
    ]);

    const text = document.body.textContent ?? '';
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
    expect(screen.getByText('#3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move|up|down|reorder/i })).not.toBeInTheDocument();
  });

  it('appends a new mapping after the existing rows without disturbing them', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder([base('m1', { source_field: 'first' })]);

    await user.click(screen.getByRole('button', { name: 'Add Field Mapping' }));

    expect(latest.current.map((m) => m.id)).toEqual(['m1', expect.stringMatching(/^mapping_/)]);
    expect(screen.getByRole('heading', { name: 'Mapping #2' })).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
  });

  it('deletes exactly the edited mapping and keeps the others in order', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder([
      base('m1', { source_field: 'first' }),
      base('m2', { source_field: 'second' }),
      base('m3', { source_field: 'third' }),
    ]);
    await user.click(screen.getByText('second'));

    await user.click(screen.getByRole('button', { name: 'Delete mapping' }));

    expect(latest.current.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(screen.queryByText('second')).not.toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('third')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
  });

  it('deleting the last mapping returns to the empty state', async () => {
    const user = userEvent.setup();
    const latest = renderBuilder([base('m1', { source_field: 'only' })]);
    await user.click(screen.getByText('only'));

    await user.click(screen.getByRole('button', { name: 'Delete mapping' }));

    expect(latest.current).toEqual([]);
    expect(screen.getByText('No field mappings configured yet')).toBeInTheDocument();
  });

  it('shows the Required badge only for required mappings in view mode', () => {
    renderBuilder([
      base('m1', { source_field: 'a', required: true }),
      base('m2', { source_field: 'b' }),
    ]);

    expect(screen.getAllByText('Required')).toHaveLength(1);
  });
});
