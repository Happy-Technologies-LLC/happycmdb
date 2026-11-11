/**
 * HAP-1880: the Redis examples of doc-site/docs/deployment/PRODUCTION_CONFIGURATION.md must work when copied.
 *  - A `command: >` value is a folded scalar: a `# ...` line inside it is not a comment, it becomes literal argv.
 *    Every compose `command` in the document's yaml fences is parsed (as Compose would) and must carry no `#` word.
 *  - The `redis-auth.conf` / `sentinel.conf` generation snippets are run in a throwaway directory.
 *    redis-auth.conf (read, never rewritten, by redis-server): a password full of config-significant bytes must decode
 *    back from its `\xHH` escapes, the file is mode 0600 and handed to uid 999 / gid 1000 (the official image's
 *    redis-server identity); `chown` is wrapped to log its argv, and really runs only when the test runs as root.
 *    sentinel.conf (rewritten by Sentinel with `auth-pass` unquoted): only a config-safe password (`^[A-Za-z0-9]+$`) is
 *    written, as the raw value; any other is refused before anything is written, without echoing it.
 *    In both cases the password must reach no child process argv (`od`/`tr`/`sed`/`mkdir` are wrapped to log theirs;
 *    `printf` is a shell builtin).
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

describe('HAP-1880: Sentinel mount in the production configuration guide', () => {
  // Sentinel rewrites its config via temp file + rename(2), which fails with EBUSY on a single-file bind mount.
  it('mounts the directory holding sentinel.conf read-write, and the generator fills that directory', () => {
    const services = fences('yaml').flatMap((block) => {
      const parsed = parse(block) as Record<string, { command?: string; volumes?: string[] }>;
      return Object.values(parsed ?? {}).filter((svc) => typeof svc?.command === 'string' && svc.command.startsWith('redis-sentinel'));
    });
    expect(services).toHaveLength(1);
    const config = services[0].command!.split(/\s+/)[1];
    const mounts = (services[0].volumes ?? []).map((volume) => volume.split(':'));
    // No mount whose container path is the config file itself, and none read-only.
    expect(mounts.filter(([, target]) => target === config)).toEqual([]);
    const dirMount = mounts.find(([, target]) => target.endsWith('/') && config.startsWith(target));
    expect(dirMount).toBeDefined();
    expect(dirMount!.slice(2)).not.toContain('ro');
    // The host side of that mount is where the documented generator writes the file.
    const host = generatorOf('secrets/sentinel/sentinel.conf').match(/> (secrets\/sentinel\/sentinel\.conf)/)![1];
    expect(`./${host.slice(0, host.lastIndexOf('/') + 1)}`).toBe(dirMount![0]);
    expect(config.slice(dirMount![1].length)).toBe(host.slice(host.lastIndexOf('/') + 1));
  });
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
    for (const tool of ['od', 'tr', 'sed', 'mkdir', 'chown']) {
      const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      const wrapper = join(dir, 'bin', tool);
      // chown to uid 999 needs root: unprivileged runs record the call and succeed, root runs execute it for real.
      const exec = tool === 'chown' ? `[ "$(id -u)" = 0 ] || exit 0\nexec ${real} "$@"` : `exec ${real} "$@"`;
      writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "${logFile}"\n${exec}\n`);
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

  it('redis-auth.conf: requirepass and masterauth decode to the password, mode 0600, owner 999:1000, password in no argv', () => {
    const result = run(generatorOf('secrets/redis-auth.conf'), { REDIS_PASSWORD: password });
    expect([result.status, result.stderr]).toEqual([0, '']);
    const lines = readFileSync(join(dir, 'secrets/redis-auth.conf'), 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => line.split(' ')[0])).toEqual(['requirepass', 'masterauth']);
    expect(lines.map(decoded)).toEqual([password, password].map((p) => Buffer.from(p, 'utf8').toString('latin1')));
    const stat = statSync(join(dir, 'secrets/redis-auth.conf'));
    expect(stat.mode & 0o777).toBe(0o600);
    // redis-server runs as uid 999 / gid 1000 under the official image entrypoint: the file must be handed to it.
    expect(argvLog().split('\n')).toContain('chown 999:1000 secrets/redis-auth.conf');
    if (process.getuid?.() === 0) expect([stat.uid, stat.gid]).toEqual([999, 1000]);
    expect(argvLog()).not.toContain(password);
    expect(argvLog()).not.toContain(Buffer.from(password).toString('hex'));
  });

  it('sentinel.conf: auth-pass for the monitored master is the config-safe password verbatim, mode 0600, password in no argv', () => {
    const safe = randomBytes(32).toString('hex'); // `openssl rand -hex 32`
    const result = run(generatorOf('secrets/sentinel/sentinel.conf'), { REDIS_PASSWORD: safe });
    expect([result.status, result.stderr]).toEqual([0, '']);
    const lines = readFileSync(join(dir, 'secrets/sentinel/sentinel.conf'), 'utf8').trimEnd().split('\n');
    const monitor = lines.find((line) => line.startsWith('sentinel monitor '))!;
    const master = monitor.split(' ')[2];
    // Sentinel rewrites this line unquoted, so the file carries the raw value.
    expect(lines).toContain(`sentinel auth-pass ${master} ${safe}`);
    // The master is named by its Compose service name, which Sentinel resolves only with this option.
    expect(lines).toContain('sentinel resolve-hostnames yes');
    expect(statSync(join(dir, 'secrets/sentinel/sentinel.conf')).mode & 0o777).toBe(0o600);
    expect(argvLog()).not.toContain(safe);
  });

  it.each([
    ['whitespace, quote, backslash, hash, dollar, backtick, non-ASCII', () => password],
    ['a trailing newline', () => 'abc123\n'],
    ['a space', () => 'abc 123'],
    ['base64 padding', () => 'Q2xlYW4rL3Bhc3M9PQ=='],
  ])('sentinel.conf: refuses a password with %s before writing anything, without echoing it', (_what, badOf) => {
    const bad = badOf(); // `password` is set per test, after the table is built
    const result = run(generatorOf('secrets/sentinel/sentinel.conf'), { REDIS_PASSWORD: bad });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('^[A-Za-z0-9]+$');
    expect(result.stdout + result.stderr).not.toContain(bad.trim());
    expect(() => statSync(join(dir, 'secrets'))).toThrow();
    expect(argvLog()).not.toContain(bad.trim());
  });

  it.each(['redis-auth.conf', 'sentinel/sentinel.conf'])('%s: refuses to write a file without REDIS_PASSWORD', (file) => {
    const result = run(generatorOf(`secrets/${file}`), { REDIS_PASSWORD: '' });
    expect(result.status).not.toBe(0);
    expect(() => statSync(join(dir, 'secrets', file))).toThrow();
  });
});
