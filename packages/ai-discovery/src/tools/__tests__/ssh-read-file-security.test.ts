// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { sshExecuteTool, sshReadFileTool } from '../ssh-tool';

it('quotes a hostile path as exactly one remote argument', async () => {
  const execute = jest.spyOn(sshExecuteTool, 'execute').mockResolvedValue({
    success: true, stdout: 'safe', stderr: '', exitCode: 0,
  });
  const filePath = '/tmp/name"; curl http://169.254.169.254/; echo "';
  const result = await sshReadFileTool.execute({ host: '8.8.8.8', username: 'u', filePath, maxLines: 5 });
  expect(execute).toHaveBeenCalledWith({ host: '8.8.8.8', username: 'u',
    command: `head -n 5 -- '${filePath}'` });
  expect(result.content).toBe('safe');
});

it('escapes apostrophes without allowing a second shell command', async () => {
  const execute = jest.spyOn(sshExecuteTool, 'execute').mockResolvedValue({
    success: true, stdout: 'ok', stderr: '', exitCode: 0,
  });
  await sshReadFileTool.execute({ host: '8.8.8.8', username: 'u', filePath: `x';id;echo 'y` });
  expect(execute).toHaveBeenCalledWith({ host: '8.8.8.8', username: 'u',
    command: `head -n 100 -- 'x'"'"';id;echo '"'"'y'` });
});

it('rejects shell metacharacters in maxLines before invoking SSH', async () => {
  const execute = jest.spyOn(sshExecuteTool, 'execute').mockResolvedValue({
    success: true, stdout: '', stderr: '', exitCode: 0,
  });
  for (const maxLines of ['5;id', Infinity, -1, 1.5]) {
    await expect(sshReadFileTool.execute({ host: '8.8.8.8', username: 'u', filePath: '/tmp/safe', maxLines }))
      .rejects.toThrow('Invalid file read request');
  }
  expect(execute).not.toHaveBeenCalled();
});

it('does not include the requested path or remote output in a read failure', async () => {
  const secret = 'SENSITIVE-TEST-VALUE';
  jest.spyOn(sshExecuteTool, 'execute').mockResolvedValue({
    success: false, stdout: `stdout ${secret}`, stderr: `stderr ${secret}`, exitCode: 1,
  });
  await expect(sshReadFileTool.execute({ host: '8.8.8.8', username: 'u',
    filePath: `/tmp/${secret}` })).rejects.toThrow('SSH file read failed');
});
