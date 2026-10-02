/**
 * Repo-hygiene guard: no tracked file may carry a full signed JWT.
 *
 * Captured request logs (e.g. axios error dumps in validation notes) embed
 * live-looking bearer tokens that secret scanners flag. Placeholders and
 * truncated examples (`eyJhbGciOi...`, `<header>.<payload>.signature`) are
 * fine; see jwt-detector.ts for what counts as a signed JWT. Hits are reported
 * as path:line so the token value never reaches test output or CI logs.
 *
 * Detector fixtures are minted at runtime from random secrets; no token is
 * committed.
 */
import { createHmac, generateKeyPairSync, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sign } from 'jsonwebtoken';
import { findJwtLines } from './jwt-detector';

const REPO_ROOT = resolve(__dirname, '../../..');

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function readTracked(path: string): Buffer | undefined {
  try {
    return readFileSync(resolve(REPO_ROOT, path));
  } catch {
    return undefined; // tracked but deleted/unreadable (or a submodule dir) in this checkout
  }
}

const b64url = (s: string): string => Buffer.from(s).toString('base64url');

function mintJwt(payload: object = { sub: `user-${randomBytes(4).toString('hex')}` }): string {
  return sign(payload, randomBytes(32), { algorithm: 'HS256' });
}

/** HS256 JWT whose header JSON is serialized verbatim (sign() always emits `{"`). */
function mintWithHeader(headerJson: string): string {
  const signingInput = `${b64url(headerJson)}.${b64url(JSON.stringify({ sub: 'u' }))}`;
  const sig = createHmac('sha256', randomBytes(32)).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

describe('repo hygiene', () => {
  it('has no full three-part JWT literal in any tracked file', () => {
    const hits: string[] = [];
    for (const path of trackedFiles()) {
      const content = readTracked(path);
      if (content === undefined) continue;
      for (const line of findJwtLines(content)) hits.push(`${path}:${line}`);
    }

    expect(hits).toEqual([]);
  });
});

describe('findJwtLines', () => {
  it('detects a short-claim JWT (noTimestamp, empty payload)', () => {
    const token = sign({}, randomBytes(32), { noTimestamp: true });

    expect(findJwtLines(Buffer.from(`# notes\nAuthorization: Bearer ${token}\n`))).toEqual([2]);
  });

  it('detects a JWT split across two string pieces', () => {
    const token = mintJwt();
    const cut = token.indexOf('.') + 12; // mid-payload
    const src = `const a = 1;\nconst token = '${token.slice(0, cut)}' + '${token.slice(cut)}';\n`;

    expect(findJwtLines(Buffer.from(src))).toEqual([2]);
  });

  it('detects a JWT split across lines', () => {
    const token = mintJwt();
    const cut = token.indexOf('.') + 12; // mid-payload
    const md = `## Captured request\n\nBearer ${token.slice(0, cut)}\n${token.slice(cut)}\n\nDone.\n`;

    expect(findJwtLines(Buffer.from(md))).toEqual([3]);
  });

  it('detects a JWT split immediately after e across a line', () => {
    const token = mintJwt();
    const text = `Bearer ${token.slice(0, 1)}\n  ${token.slice(1)}\n`;

    expect(findJwtLines(Buffer.from(text))).toEqual([1]);
  });

  it('detects a JWT split immediately after e across a comment line', () => {
    const token = mintJwt();
    const text = `Bearer ${token.slice(0, 1)}\n// ${token.slice(1)}\n`;

    expect(findJwtLines(Buffer.from(text))).toEqual([1]);
  });

  it('detects a base64url-encoded JWT wrapped at 16 columns', () => {
    const encoded = Buffer.from(mintJwt()).toString('base64url');
    const wrapped = encoded.replace(/(.{16})/g, '$1\n');

    expect(findJwtLines(Buffer.from(`# notes\n${wrapped}\n`))).toEqual([2]);
  });

  it('ignores an incomplete split prefix and a wrapped encoded placeholder', () => {
    const incomplete = 'Bearer e\n// yJ-not-a-header\n';
    const header = b64url('{"alg":"HS256","typ":"JWT"}');
    const placeholder = `${header}.${b64url('{}')}.signature`;
    const wrapped = Buffer.from(placeholder).toString('base64url').replace(/(.{16})/g, '$1\n');

    expect(findJwtLines(Buffer.from(`${incomplete}${wrapped}\n`))).toEqual([]);
  });

  it('detects a base64-encoded JWT', () => {
    const encoded = Buffer.from(mintJwt()).toString('base64');
    // The next key must not bleed into the decoded value.
    const yaml = `apiVersion: v1\nkind: Secret\ndata:\n  token: ${encoded}\n  ca.crt: Cg==\n`;

    expect(findJwtLines(Buffer.from(yaml))).toEqual([4]);
  });

  it('detects an eyAi/ewog-header JWT', () => {
    const spaced = mintWithHeader('{ "alg": "HS256", "typ": "JWT" }'); // eyAi...
    const pretty = mintWithHeader('{\n  "alg": "HS256",\n  "typ": "JWT"\n}'); // ewog...

    expect(findJwtLines(Buffer.from(`a = "${spaced}"\nb = "${pretty}"\n`))).toEqual([1, 2]);
  });

  it('detects a signed JWT with whitespace before the JSON header', () => {
    const token = mintWithHeader(' \n{"alg":"HS256","typ":"JWT"}');

    expect(findJwtLines(Buffer.from(`Authorization: Bearer ${token}\n`))).toEqual([1]);
  });

  it('detects a JWT split inside its initial ey prefix', () => {
    const token = mintJwt();
    const src = `const token = '${token.slice(0, 1)}' + '${token.slice(1)}';\n`;

    expect(findJwtLines(Buffer.from(src))).toEqual([1]);
  });

  it('detects a JWT with percent-encoded dot separators in a URL', () => {
    const token = mintJwt();
    const url = `https://example.invalid/?access_token=${token.replace(/\./g, '%2E')}&mode=test\n`;

    expect(findJwtLines(Buffer.from(url))).toEqual([1]);
  });

  it('detects an RS256 JWT signed with a 5120-bit key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 5120 });
    const token = sign({}, privateKey, { algorithm: 'RS256', noTimestamp: true });

    expect(findJwtLines(Buffer.from(`Bearer ${token}\n`))).toEqual([1]);
  }, 30000);

  it('reports both adjacent base64url-encoded JWTs', () => {
    const first = Buffer.from(mintJwt()).toString('base64url');
    const second = Buffer.from(mintJwt()).toString('base64url');

    expect(findJwtLines(Buffer.from(`${first}\n${second}\n`))).toEqual([1, 2]);
  });

  it('detects a JWT in a UTF-16LE file', () => {
    const utf16 = Buffer.from(`[auth]\r\ntoken=${mintJwt()}\r\n`, 'utf16le'); // no BOM

    expect(findJwtLines(utf16)).toEqual([2]);
  });

  it('ignores the eyJ...signature placeholder style', () => {
    const header = b64url('{"alg":"HS256","typ":"JWT"}');
    const whitespaceHeader = b64url(' \n{"alg":"HS256","typ":"JWT"}');
    const payload = b64url(JSON.stringify({ userId: 'user-admin-001', iat: 1699556400 }));
    const docs = [
      `    "accessToken": "${header}.${payload}.signature",`,
      `    "refreshToken": "${header}.new_refresh_token.signature"`,
      `  -H "Authorization: Bearer ${header}.token_here.signature"`,
      `export ACCESS_TOKEN="${header}..."`,
      `Use ${header}.${payload}.signature`,
      `  -H "Authorization: Bearer ${whitespaceHeader}%2E${payload}%2Esignature"`,
      `as the bearer value.`,
    ].join('\n');

    expect(findJwtLines(Buffer.from(docs))).toEqual([]);
  });
});
