// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for CICommand
 */

import axios from 'axios';
import { CICommand } from '../../src/commands/ci.command';
import { Command } from 'commander';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock ora (spinner)
jest.mock('ora', () => ({
  __esModule: true,
  default: () => ({
    start: () => ({
      succeed: jest.fn(),
      fail: jest.fn(),
    }),
  }),
}));

// Mock chalk (colors)
jest.mock('chalk', () => ({
  __esModule: true,
  default: {
    green: (str: string) => str,
    red: (str: string) => str,
    yellow: (str: string) => str,
    cyan: (str: string) => str,
    gray: (str: string) => str,
    bold: (str: string) => str,
  },
}));

describe('CICommand', () => {
  let ciCommand: CICommand;
  let program: Command;

  beforeEach(() => {
    ciCommand = new CICommand('http://localhost:3000/api', 'test-api-key');
    program = new Command();
    jest.clearAllMocks();
    // Suppress console output during tests
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('register', () => {
    it('should register all CI commands', () => {
      ciCommand.register(program);

      const ciCmd = program.commands.find(cmd => cmd.name() === 'ci');
      expect(ciCmd).toBeDefined();

      const subcommands = ciCmd!.commands.map(cmd => cmd.name());
      expect(subcommands).toContain('list');
      expect(subcommands).toContain('get');
      expect(subcommands).toContain('create');
      expect(subcommands).toContain('update');
      expect(subcommands).toContain('delete');
      expect(subcommands).toContain('relate');
      expect(subcommands).toContain('relationships');
      expect(subcommands).toContain('search');
    });
  });

  describe('listCIs', () => {
    it('should fetch and display CIs', async () => {
      const mockResponse = {
        data: {
          items: [
            {
              id: 'ci-1',
              name: 'Web Server 1',
              type: 'server',
              status: 'active',
              description: 'Production web server',
            },
            {
              id: 'ci-2',
              name: 'Database 1',
              type: 'database',
              status: 'active',
            },
          ],
          total: 2,
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);

      await (ciCommand as any).listCIs({ limit: '20', offset: '0' });

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://localhost:3000/api/cis',
        expect.objectContaining({
          params: { _limit: '20', _offset: '0' },
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-api-key',
          }),
        })
      );

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Web Server 1'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Database 1'));
    });

    it('should handle empty CI list', async () => {
      const mockResponse = {
        data: {
          items: [],
          total: 0,
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);

      await (ciCommand as any).listCIs({ limit: '20', offset: '0' });

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No CIs found'));
    });

    it('should apply filters', async () => {
      const mockResponse = {
        data: { items: [], total: 0 },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);

      await (ciCommand as any).listCIs({
        limit: '20',
        offset: '0',
        type: 'server',
        status: 'active',
      });

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://localhost:3000/api/cis',
        expect.objectContaining({
          params: {
            _limit: '20',
            _offset: '0',
            type: 'server',
            status: 'active',
          },
        })
      );
    });

    it('should handle API errors', async () => {
      const error = {
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: { message: 'Database connection failed' },
        },
      };

      mockedAxios.get.mockRejectedValue(error);

      await (ciCommand as any).listCIs({ limit: '20', offset: '0' });

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Database connection failed')
      );
    });
  });

  describe('getCIDetails', () => {
    it('should fetch and display CI details', async () => {
      const mockResponse = {
        data: {
          id: 'ci-1',
          name: 'Web Server 1',
          type: 'server',
          status: 'active',
          description: 'Production web server',
          attributes: {
            ip_address: '192.168.1.100',
            os: 'Ubuntu 20.04',
          },
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-15T12:00:00Z',
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);

      await (ciCommand as any).getCIDetails('ci-1', {});

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://localhost:3000/api/cis/ci-1',
        expect.any(Object)
      );

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Web Server 1'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('192.168.1.100'));
    });

    it('should include relationships when requested', async () => {
      const mockResponse = {
        data: {
          id: 'ci-1',
          name: 'Web Server 1',
          type: 'server',
          status: 'active',
          relationships: {
            inbound: [{ id: 'rel-1' }],
            outbound: [{ id: 'rel-2' }, { id: 'rel-3' }],
          },
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-15T12:00:00Z',
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);

      await (ciCommand as any).getCIDetails('ci-1', { relationships: true });

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://localhost:3000/api/cis/ci-1',
        expect.objectContaining({
          params: { includeRelationships: true },
        })
      );
    });
  });

  describe('createCI', () => {
    it('posts no client ID and displays the ID assigned by the REST API', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { data: { id: 'issued-by-api', name: 'New Server', type: 'server' } },
      });
      await (ciCommand as any).createCI({
        id: 'caller-chosen',
        type: 'server',
        name: 'New Server',
        description: 'Test server',
      });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://localhost:3000/api/cis',
        { name: 'New Server', type: 'server', metadata: { description: 'Test server' } },
        expect.any(Object)
      );
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('issued-by-api'));
    });

    it('should handle invalid JSON attributes', async () => {
      await (ciCommand as any).createCI({
        type: 'server',
        name: 'New Server',
        attributes: 'invalid-json',
      });

      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('updateCI', () => {
    it('should fail when no updates specified', async () => {
      await (ciCommand as any).updateCI('ci-1', {});

      expect(mockedAxios.patch).not.toHaveBeenCalled();
    });
  });

  describe('deleteCI', () => {
    it('should delete CI when force flag is set', async () => {
      mockedAxios.delete.mockResolvedValue({ data: {} });

      await (ciCommand as any).deleteCI('ci-1', { force: true });

      expect(mockedAxios.delete).toHaveBeenCalledWith(
        'http://localhost:3000/api/cis/ci-1',
        expect.any(Object)
      );
    });

    it('should not delete CI without force flag', async () => {
      await (ciCommand as any).deleteCI('ci-1', { force: false });

      expect(mockedAxios.delete).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--force'));
    });
  });

  describe('listRelationships', () => {
    it('should list relationships for a CI', async () => {
      const mockResponse = {
        data: {
          inbound: [
            { fromCi: { name: 'App Server' }, type: 'runs_on' },
          ],
          outbound: [
            { toCi: { name: 'Database' }, type: 'connects_to' },
          ],
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);

      await (ciCommand as any).listRelationships('ci-1', { direction: 'both' });

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://localhost:3000/api/cis/ci-1/relationships',
        expect.objectContaining({
          params: { direction: 'both' },
        })
      );

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Inbound'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Outbound'));
    });

    it('should filter by direction', async () => {
      const mockResponse = {
        data: {
          inbound: [],
          outbound: [{ toCi: { name: 'Database' }, type: 'connects_to' }],
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);

      await (ciCommand as any).listRelationships('ci-1', { direction: 'outbound' });

      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Inbound'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Outbound'));
    });
  });

  describe('getHeaders', () => {
    it('should return headers with authorization', () => {
      const headers = (ciCommand as any).getHeaders();

      expect(headers).toHaveProperty('Content-Type', 'application/json');
      expect(headers).toHaveProperty('Authorization', 'Bearer test-api-key');
    });

    it('should return headers without authorization when no API key', () => {
      const noKeyCommand = new CICommand('http://localhost:3000/api');
      const headers = (noKeyCommand as any).getHeaders();

      expect(headers).toHaveProperty('Content-Type', 'application/json');
      expect(headers).not.toHaveProperty('Authorization');
    });
  });

  describe('colorizeStatus', () => {
    it('should colorize different statuses', () => {
      expect((ciCommand as any).colorizeStatus('active')).toBeDefined();
      expect((ciCommand as any).colorizeStatus('inactive')).toBeDefined();
      expect((ciCommand as any).colorizeStatus('maintenance')).toBeDefined();
      expect((ciCommand as any).colorizeStatus('failed')).toBeDefined();
      expect((ciCommand as any).colorizeStatus('unknown')).toBeDefined();
    });
  });

  describe('handleError', () => {
    it('should handle response errors', () => {
      const error = {
        response: {
          status: 404,
          statusText: 'Not Found',
          data: { message: 'CI not found' },
        },
      };

      (ciCommand as any).handleError(error);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('CI not found'));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('404'));
    });

    it('should handle request errors', () => {
      const error = {
        request: {},
      };

      (ciCommand as any).handleError(error);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No response'));
    });

    it('should handle generic errors', () => {
      const error = new Error('Network timeout');

      (ciCommand as any).handleError(error);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Network timeout'));
    });
  });
});
