// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * SSH Execution Tool
 * Allows AI to execute commands via SSH
 */

import { Client as SSHClient } from 'ssh2';
import { DiscoveryTool } from '../types';
import { logger } from '@cmdb/common';
import { resolveDiscoveryHost, connectDiscoveryHost } from '@cmdb/common';

export const sshExecuteTool: DiscoveryTool = {
  name: 'ssh_execute',
  description:
    'Execute commands on a remote host via SSH. Use this to gather system information, check installed software, read configuration files, etc. Be careful with commands that modify state.',
  inputSchema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: 'Target hostname or IP address',
      },
      port: {
        type: 'number',
        description: 'SSH port (default: 22)',
      },
      username: {
        type: 'string',
        description: 'SSH username',
      },
      command: {
        type: 'string',
        description:
          'Command to execute (e.g., "uname -a", "cat /etc/os-release")',
      },
    },
    required: ['host', 'username', 'command'],
  },
  execute: async (params: any) => {
    const { host, port = 22, username, command } = params;
    const destination = await connectDiscoveryHost(host, await resolveDiscoveryHost(host));

    // Note: In a real implementation, you would:
    // 1. Load credentials from the unified credential service
    // 2. Support multiple auth methods (password, private key, etc.)
    // 3. Have proper credential management

    logger.info(`Executing SSH command`, { host, port, username, command });

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let output = '';
      let errorOutput = '';

      // Set timeout
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH command timeout after 30 seconds'));
      }, 30000);

      conn
        .on('ready', () => {
          logger.debug('SSH connection ready');

          conn.exec(command, (err, stream) => {
            if (err) {
              clearTimeout(timeout);
              conn.end();
              reject(new Error(`SSH exec error: ${err.message}`));
              return;
            }

            stream
              .on('close', (code: number, signal: string) => {
                clearTimeout(timeout);
                conn.end();

                logger.info('SSH command completed', { code, signal });

                resolve({
                  success: code === 0,
                  exitCode: code,
                  signal,
                  stdout: output,
                  stderr: errorOutput,
                });
              })
              .on('data', (data: Buffer) => {
                output += data.toString();
              })
              .stderr.on('data', (data: Buffer) => {
                errorOutput += data.toString();
              });
          });
        })
        .on('error', (err: Error) => {
          clearTimeout(timeout);
          logger.error('SSH connection error', { host, error: err.message });
          reject(new Error(`SSH connection failed: ${err.message}`));
        })
        .connect({
          host: destination,
          port,
          username,
          // In production, load from credential service:
          // password: credentials.password,
          // privateKey: credentials.privateKey,
          // passphrase: credentials.passphrase,
          readyTimeout: 15000,
        });
    });
  },
};

/**
 * Read file via SSH
 * Helper tool for reading configuration files
 */
export const sshReadFileTool: DiscoveryTool = {
  name: 'ssh_read_file',
  description:
    'Read and return contents of a file on remote host via SSH. Use this to examine configuration files, logs, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: 'Target hostname or IP address',
      },
      port: {
        type: 'number',
        description: 'SSH port (default: 22)',
      },
      username: {
        type: 'string',
        description: 'SSH username',
      },
      filePath: {
        type: 'string',
        description: 'Path to file to read',
      },
      maxLines: {
        type: 'number',
        description: 'Maximum number of lines to return (default: 100)',
      },
    },
    required: ['host', 'username', 'filePath'],
  },
  execute: async (params: any) => {
    const { host, filePath, maxLines = 100, ...sshParams } = params;

    // Use SSH execute to read file
    const command = maxLines
      ? `head -n ${maxLines} "${filePath}"`
      : `cat "${filePath}"`;

    const result = await sshExecuteTool.execute({
      ...sshParams,
      host,
      command,
    });

    if (!result.success) {
      throw new Error(
        `Failed to read file ${filePath}: ${result.stderr || result.stdout}`
      );
    }

    return {
      filePath,
      content: result.stdout,
      truncated: maxLines !== undefined,
      lines: result.stdout.split('\n').length,
    };
  },
};
