import { describe, expect, it, vi } from 'vitest';

const apiClient = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../lib/api-client', () => ({ apiClient }));
import { connectorRunErrorMessage, connectorsApi } from './connectors';

const sentinel = 'UI_NESTED_SAVED_SECRET_SENTINEL';
const config = {
  id: 'own', name: 'Own Connector', connector_type: 'acme-crm', enabled: true,
  schedule_enabled: false, created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z',
  connection: { nested: { access: sentinel } }, options: { nested: sentinel },
  resource_configs: { nested: sentinel }, notification_channels: [sentinel],
};
const run = {
  id: 'run-own', config_id: 'own', connector_type: 'acme-crm', config_name: 'Own Connector',
  status: 'failed', started_at: '2026-10-07T00:00:00Z', records_loaded: 0,
  errors: [sentinel], error_message: sentinel, job_id: sentinel,
};

describe('connector REST client public DTO', () => {
  it('never puts saved nested secrets into the list, details or run UI state', async () => {
    apiClient.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/runs')
      ? { data: [run] }
      : { data: path === '/connector-configs' ? [config] : config }));
    apiClient.post.mockResolvedValue({ data: run });
    const rendered = {
      list: await connectorsApi.list(), detail: await connectorsApi.get('own'),
      runs: await connectorsApi.getRuns('own'), result: await connectorsApi.run('own'),
    };
    expect(rendered.list[0].name).toBe('Own Connector');
    expect(rendered.runs[0].status).toBe('failed');
    expect(JSON.stringify(rendered)).not.toContain(sentinel);
  });

  it('allows a new connection write without reflecting it in the create response', async () => {
    apiClient.post.mockResolvedValue({ data: config });
    const created = await connectorsApi.create({ name: 'Own Connector', connector_type: 'acme-crm', connection: { token: sentinel } });
    expect(apiClient.post).toHaveBeenCalledWith('/connector-configs', expect.objectContaining({ connection: { token: sentinel } }));
    expect(JSON.stringify(created)).not.toContain(sentinel);
  });
  it('displays only the fixed credential refusal and never arbitrary server errors', () => {
    expect(connectorRunErrorMessage({
      response: { status: 409, data: { error: 'Connector credential reference unavailable' } },
    })).toBe('Connector credential reference unavailable');
    expect(connectorRunErrorMessage({
      response: { status: 409, data: { message: 'Connector credential reference unavailable' } },
    })).toBe('Failed to start connector');
    expect(connectorRunErrorMessage({
      response: { status: 500, data: { message: sentinel } },
    })).toBe('Failed to start connector');
  });
});
