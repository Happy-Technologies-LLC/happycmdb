// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'events';
import { sshExecuteTool, sshReadFileTool, SSH_MAX_OUTPUT_BYTES } from '../ssh-tool';

/** One fake ssh2 connection per `new Client()`; the test drives its exec stream. */
class FakeStream extends EventEmitter {
  stderr = new EventEmitter();
}
class FakeClient extends EventEmitter {
  static last: FakeClient;
  stream = new FakeStream();
  end = jest.fn();
  constructor() {
    super();
    FakeClient.last = this;
  }
  connect(): this {
    setImmediate(() => this.emit('ready'));
    return this;
  }
  exec(_command: string, callback: (err: Error | undefined, stream: FakeStream) => void): void {
    callback(undefined, this.stream);
  }
}
jest.mock('ssh2', () => ({ Client: jest.fn().mockImplementation(() => new FakeClient()) }));

const CHUNK = 64 * 1024;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Wait until the tool has opened the connection and attached its exec stream handlers. */
async function connected(): Promise<FakeClient> {
  for (let i = 0; i < 50 && !(FakeClient.last?.stream.listenerCount('close') > 0); i++) await tick();
  return FakeClient.last;
}

beforeEach(() => {
  FakeClient.last = undefined as never;
});

/**
 * A hostile host that never ends the stream: it keeps sending until the client
 * closes the connection. The 16 MiB ceiling and the final close only exist so an
 * uncapped client finishes (with an oversized result) instead of hanging the test.
 */
async function streamUntilClientHangsUp(channel: 'stdout' | 'stderr'): Promise<void> {
  const client = await connected();
  const target = channel === 'stdout' ? client.stream : client.stream.stderr;
  let sent = 0;
  while (client.end.mock.calls.length === 0 && sent < 16 * 1024 * 1024) {
    target.emit('data', Buffer.alloc(CHUNK, 0x41));
    sent += CHUNK;
  }
  if (client.end.mock.calls.length === 0) client.stream.emit('close', 0, null);
}

describe('ssh output cap', () => {
  it.each(['stdout', 'stderr'] as const)('cuts a never-ending %s stream at 1 MiB, ends the connection and flags it', async (channel) => {
    const pending = sshExecuteTool.execute({ host: '8.8.8.8', username: 'u', command: 'yes' });
    await streamUntilClientHangsUp(channel);
    const result = await pending;

    expect(result.truncated).toBe(true);
    expect(result.success).toBe(false);
    expect(FakeClient.last.end).toHaveBeenCalled();
    expect(Buffer.byteLength(result[channel])).toBe(SSH_MAX_OUTPUT_BYTES);
  });

  it('shares one budget between stdout and stderr and drops data that arrives after the cut', async () => {
    const pending = sshExecuteTool.execute({ host: '8.8.8.8', username: 'u', command: 'noisy' });
    const { stream } = await connected();
    stream.emit('data', Buffer.alloc(SSH_MAX_OUTPUT_BYTES - 10, 0x6f));
    stream.stderr.emit('data', Buffer.alloc(100, 0x65));
    stream.emit('data', Buffer.alloc(CHUNK, 0x6f));
    stream.emit('close', 0, null);
    const result = await pending;

    expect(result.truncated).toBe(true);
    expect(result.stdout).toHaveLength(SSH_MAX_OUTPUT_BYTES - 10);
    expect(result.stderr).toHaveLength(10);
  });

  it('returns output under the cap unchanged, with the real exit status', async () => {
    const pending = sshExecuteTool.execute({ host: '8.8.8.8', username: 'u', command: 'uname -a' });
    const { stream } = await connected();
    stream.emit('data', Buffer.from('Linux '));
    stream.emit('data', Buffer.from('host 6.1\n'));
    stream.stderr.emit('data', Buffer.from('warn'));
    stream.emit('close', 0, null);

    await expect(pending).resolves.toEqual({
      success: true, exitCode: 0, signal: null, stdout: 'Linux host 6.1\n', stderr: 'warn', truncated: false,
    });
  });

  it('accepts output of exactly the cap without truncating', async () => {
    const pending = sshExecuteTool.execute({ host: '8.8.8.8', username: 'u', command: 'cat big' });
    await connected();
    FakeClient.last.stream.emit('data', Buffer.alloc(SSH_MAX_OUTPUT_BYTES, 0x41));
    FakeClient.last.stream.emit('close', 0, null);

    const result = await pending;
    expect(result.truncated).toBe(false);
    expect(result.stdout).toHaveLength(SSH_MAX_OUTPUT_BYTES);
  });

  it('keeps a multi-byte character split across two chunks intact', async () => {
    const pending = sshExecuteTool.execute({ host: '8.8.8.8', username: 'u', command: 'echo' });
    await connected();
    const bytes = Buffer.from('é', 'utf8');
    FakeClient.last.stream.emit('data', bytes.subarray(0, 1));
    FakeClient.last.stream.emit('data', bytes.subarray(1));
    FakeClient.last.stream.emit('close', 0, null);

    expect((await pending).stdout).toBe('é');
  });

  it('ssh_read_file returns the capped content flagged truncated instead of failing', async () => {
    const pending = sshReadFileTool.execute({ host: '8.8.8.8', username: 'u', filePath: '/var/log/huge' });
    await streamUntilClientHangsUp('stdout');
    const result = await pending;

    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(SSH_MAX_OUTPUT_BYTES);
    expect(FakeClient.last.end).toHaveBeenCalled();
  });

  it('ssh_read_file reports an uncut read as not truncated', async () => {
    const pending = sshReadFileTool.execute({ host: '8.8.8.8', username: 'u', filePath: '/etc/hostname' });
    await connected();
    FakeClient.last.stream.emit('data', Buffer.from('web01\n'));
    FakeClient.last.stream.emit('close', 0, null);

    await expect(pending).resolves.toMatchObject({ content: 'web01\n', truncated: false });
  });
});
