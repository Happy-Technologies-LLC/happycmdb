/**
 * HAP-1880: the Redis examples of doc-site/docs/deployment/PRODUCTION_CONFIGURATION.md must work when copied.
 *  - A `command: >` value is a folded scalar: a `# ...` line inside it is not a comment, it becomes literal argv.
 *    Every compose `command` in the document's yaml fences is parsed (as Compose would) and must carry no `#` word.
 *  - The `redis-auth.conf` / `sentinel.conf` generation snippets are run in a throwaway directory with a password full
 *    of config-significant bytes: the files must decode back to that password (Redis reads `\xHH` escapes in a
 *    double-quoted value), be mode 0600, and the password must reach no child process argv (`od`/`tr`/`sed` are wrapped
 *    to log theirs; `printf` is a shell builtin).
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parse } from 'yaml';

const DOC = 'doc-site/docs/deployment/PRODUCTION_CONFIGURATION.md';
const doc = readFileSync(resolve(__dirname, '../../..', DOC), 'utf8');

/** Every fenced block of `lang` in the document. */
function fences(lang: string): string[] {
  return [...doc.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```', 'g'))].map((m) => m[1]);
}

/** Every string `command` (a folded scalar or a plain string) anywhere in a parsed yaml value. */
function commands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(commands);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => (key === 'command' && typeof child === 'string' ? [child] : commands(child)));
}

/** The one fenced bash snippet that writes `target`, or a failure that says which doc contract broke. */
function generatorOf(target: string): string {
  const found = fences('bash').filter((block) => block.includes(`> ${target}`));
  if (found.length !== 1) {
    throw new Error(`${DOC} must contain exactly one fenced bash snippet that writes ${target} (found ${found.length}): copy-pasting it is how operators create that file.`);
  }
  return found[0];
}

/** The password a Redis config value decodes to: `"\x70\x61..."` (every byte a \xHH escape). */
function decoded(line: string | undefined): string {
  const escaped = /^\S+(?: \S+)* "((?:\\x[0-9a-f]{2})+)"$/.exec(line ?? '');
  if (!escaped) throw new Error(`expected a double-quoted \\xHH value, got: ${line}`);
  return Buffer.from(escaped[1].replace(/\\x/g, ''), 'hex').toString('latin1');
}

describe('HAP-1880: compose commands in the production configuration guide', () => {
  const composeCommands = fences('yaml').flatMap((block) => commands(parse(block)));

  it('finds compose commands to check', () => {
    expect(composeCommands.length).toBeGreaterThan(0);
  });

  it.each(composeCommands.map((command) => [command.split(/\s+/)[0] + ' ' + (command.split(/\s+/)[1] ?? ''), command]))(
    '%s: no argv word is a folded-in comment',
    (_label, command) => {
      // Compose splits a string command on whitespace/quotes: a `#` word is passed to the program verbatim.
      const comments = command.split(/\s+/).filter((word) => word.startsWith('#'));
      expect(comments).toEqual([]);
    },
  );
});

describe('HAP-1880: generated Redis auth files', () => {
  let dir: string;
  let password: string;
  let logFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1880-'));
    // Quote, backslash, space, hash, dollar, backtick and a non-ASCII byte pair: all break an unescaped config value.
    password = `p"a\\ss #w$o\`rd-é-${randomBytes(6).toString('hex')}`;
    logFile = join(dir, 'argv.log');
    // Wrap the pipeline's external commands so each call's argv is recorded, then run the real one.
    mkdirSync(join(dir, 'bin'));
    for (const tool of ['od', 'tr', 'sed', 'mkdir']) {
      const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      const wrapper = join(dir, 'bin', tool);
      writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "${logFile}"\nexec ${real} "$@"\n`);
      chmodSync(wrapper, 0o755);
    }
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(snippet: string, env: Record<string, string>) {
    return spawnSync('sh', ['-s'], {
      input: snippet,
      cwd: dir,
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, ...env },
      encoding: 'utf8',
    });
  }

  function argvLog(): string {
    try { return readFileSync(logFile, 'utf8'); } catch { return ''; }
  }

  it('redis-auth.conf: requirepass and masterauth decode to the password, mode 0600, password in no argv', () => {
    const result = run(generatorOf('secrets/redis-auth.conf'), { REDIS_PASSWORD: password });
    expect([result.status, result.stderr]).toEqual([0, '']);
    const lines = readFileSync(join(dir, 'secrets/redis-auth.conf'), 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => line.split(' ')[0])).toEqual(['requirepass', 'masterauth']);
    expect(lines.map(decoded)).toEqual([password, password].map((p) => Buffer.from(p, 'utf8').toString('latin1')));
    expect(statSync(join(dir, 'secrets/redis-auth.conf')).mode & 0o777).toBe(0o600);
    expect(argvLog()).not.toContain(password);
    expect(argvLog()).not.toContain(Buffer.from(password).toString('hex'));
  });

  it('sentinel.conf: auth-pass for the monitored master decodes to the password, mode 0600, password in no argv', () => {
    const result = run(generatorOf('secrets/sentinel.conf'), { REDIS_PASSWORD: password });
    expect([result.status, result.stderr]).toEqual([0, '']);
    const lines = readFileSync(join(dir, 'secrets/sentinel.conf'), 'utf8').trimEnd().split('\n');
    const monitor = lines.find((line) => line.startsWith('sentinel monitor '))!;
    const master = monitor.split(' ')[2];
    const authPass = lines.find((line) => line.startsWith(`sentinel auth-pass ${master} `));
    expect(decoded(authPass)).toBe(Buffer.from(password, 'utf8').toString('latin1'));
    // The master is named by its Compose service name, which Sentinel resolves only with this option.
    expect(lines).toContain('sentinel resolve-hostnames yes');
    expect(statSync(join(dir, 'secrets/sentinel.conf')).mode & 0o777).toBe(0o600);
    expect(argvLog()).not.toContain(password);
  });

  it.each(['redis-auth.conf', 'sentinel.conf'])('%s: refuses to write a file without REDIS_PASSWORD', (file) => {
    const result = run(generatorOf(`secrets/${file}`), { REDIS_PASSWORD: '' });
    expect(result.status).not.toBe(0);
    expect(() => statSync(join(dir, 'secrets', file))).toThrow();
  });
});
