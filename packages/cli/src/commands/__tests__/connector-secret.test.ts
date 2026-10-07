import { Command } from 'commander';
import axios from 'axios';
import { ConnectorConfigCommand } from '../connector-config.command';
import { ConnectorRunCommand } from '../connector-run.command';

jest.mock('axios');
jest.mock('chalk', () => {
  const style = (value: unknown) => String(value);
  return { __esModule: true, default: {
    cyan: style, red: style, green: style, gray: style, yellow: style, blue: style,
    bold: Object.assign(style, { green: style, red: style }),
  } };
});
jest.mock('ora', () => ({
  __esModule: true,
  default: () => {
    const spinner = { succeed: jest.fn(), fail: jest.fn(), warn: jest.fn() };
    return { ...spinner, start: () => spinner };
  },
}));
const get = axios.get as jest.Mock;
const put = axios.put as jest.Mock;
const post = axios.post as jest.Mock;
const isAxiosError = axios.isAxiosError as unknown as jest.Mock;
const sentinel = 'NESTED_SAVED_SECRET_SENTINEL';

const config = {
  id: 'cfg-a', name: 'own', connector_type: 'acme-crm', enabled: true,
  organization_id: 'org-a', connection: { nested: { access: sentinel } },
  options: { opaque: sentinel }, resource_configs: { opaque: sentinel },
  notification_channels: [sentinel], enabled_resources: ['accounts'],
  schedule: null, schedule_enabled: false,
};
const run = {
  id: 'run-a', config_id: 'cfg-a', connector_type: 'acme-crm', config_name: 'own',
  status: 'failed', started_at: '2026-10-07T00:00:00Z',
  records_loaded: 0, errors: [sentinel], error_message: sentinel, job_id: sentinel,
};

async function outputFor(args: string[], install: (command: Command) => void): Promise<string> {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const command = new Command();
    install(command);
    await command.parseAsync(['node', 'happycmdb', ...args]);
    return [...log.mock.calls, ...error.mock.calls].flat().join(' ');
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  post.mockReset();
  isAxiosError.mockReset();
  get.mockImplementation(async (url: string) => url.endsWith('/runs/run-a')
    ? { data: { success: true, data: run } }
    : { data: { success: true, data: [config], pagination: { total: 1 } } });
});

test('config show and run status ignore saved nested secret and untrusted raw run errors', async () => {
  const configText = await outputFor(['config', 'show', 'own'], command => new ConnectorConfigCommand('http://example.invalid').register(command));
  const runText = await outputFor(['run-status', 'run-a'], command => new ConnectorRunCommand('http://example.invalid').register(command));
  expect(configText).toContain('own');
  expect(runText).toContain('FAILED');
  expect(configText + runText).not.toContain(sentinel);
});

test('public-only CLI update does not overwrite an existing secret field', async () => {
  put.mockResolvedValue({ data: { success: true, data: config } });
  await outputFor(['config', 'edit', 'own', '--description', 'public change'], command => new ConnectorConfigCommand('http://example.invalid').register(command));
  expect(put).toHaveBeenCalledWith('http://example.invalid/connector-configs/cfg-a',
    { description: 'public change' }, expect.any(Object));
});

test('CLI never repeats raw error bodies', async () => {
  get.mockRejectedValue({ response: { status: 500, data: { message: sentinel } } });
  const text = await outputFor(['config', 'show', 'own'], command => new ConnectorConfigCommand('http://example.invalid').register(command));
  expect(text).not.toContain(sentinel);
  expect(text).toContain('Connector request failed');
});
test('CLI preserves only the approved credential refusal', async () => {
  isAxiosError.mockReturnValue(true);
  post.mockRejectedValue({ response: { status: 409, data: { message: 'Connector credential reference unavailable' } } });
  const known = await outputFor(['run', 'own'], command => new ConnectorRunCommand('http://example.invalid').register(command));
  expect(known).toContain('Connector credential reference unavailable');
  post.mockRejectedValue({ response: { status: 500, data: { message: sentinel } } });
  const unknown = await outputFor(['run', 'own'], command => new ConnectorRunCommand('http://example.invalid').register(command));
  expect(unknown).toContain('Connector request failed');
  expect(unknown).not.toContain(sentinel);
});
