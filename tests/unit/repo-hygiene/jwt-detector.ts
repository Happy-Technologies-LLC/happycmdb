/**
 * JWT detector behind the repo-hygiene guard (no-jwt-literals.test.ts).
 *
 * A candidate counts only when it is structurally a signed JWS:
 *   - its first segment base64url-decodes to a JSON object with a string `alg`
 *     (`eyJ` = `{"`, `eyAi` = `{ "`, `ewog` = `{\n `, ...);
 *   - its third segment has the exact length of a real signature (see
 *     SIGNATURE_LENGTHS). The payload may be any length, even `e30` (`{}`).
 * Placeholders such as `<header>.<payload>.signature` or `<header>...` fail the
 * signature-length gate.
 *
 * Before matching, the detector sees through:
 *   - pieces spliced by a line break (plus indentation and an optional `//`, `#`,
 *     `*` or `>` line prefix), a backslash line continuation, or string
 *     concatenation (`' + '`, `" +\n "`, adjacent literals);
 *   - percent-encoded or backslash-escaped separators right before the token
 *     (`Bearer%20eyJ...`, `\u0022eyJ...`, `\neyJ...`);
 *   - base64/base64url runs (possibly line-wrapped) whose decoded bytes hold a JWT;
 *   - UTF-16LE/BE content (BOM or NUL-interleaved); other NUL-bearing content is
 *     scanned as latin1 instead of being skipped as binary.
 *
 * Only line numbers leave this module; token values never do.
 */

/** base64url (unpadded) lengths of fixed-size JWS signatures. */
const SIGNATURE_LENGTHS: readonly number[] = [
  43, // HS256
  64, // HS384
  86, // HS512, ES256, Ed25519
  128, // ES384
  152, // Ed448
  176, // ES512
];
/** RSA/PS signature size equals the key modulus size; accept 1024–8192 bits. */
const MIN_RSA_BYTES = 128;
const MAX_RSA_BYTES = 1024;

/** `{"alg":"none"}` already encodes to 19 chars. */
const MIN_HEADER = 16;
/** Headers carrying x5c certificate chains run to several KB. */
const MAX_HEADER = 16384;
/** Never splice a single candidate past this many characters. */
const MAX_TOKEN = 65536;
/** The smallest signed JWT is 68 chars; its base64 form is 92. */
const MIN_B64_RUN = 88;
/** Re-scan decoded base64 at most this deep (base64 inside base64). */
const MAX_DEPTH = 2;
/** Same window git uses to sniff binary content. */
const SNIFF_BYTES = 8000;

/**
 * `ey`/`ew` starts JSON at `{`. Leading JSON whitespace encodes as I, C or
 * D; limit the other prefixes to actual whitespace byte possibilities before
 * attempting to decode a header. A lone `e` is considered only when a JOIN
 * immediately follows and the next piece begins `y`/`w`.
 */
const TOKEN_START = /e[wy]|e(?=['"`]|[ \t]*\\?\r?\n)|(?:I[ACH]|C[ginQSX]|D[QSX])[A-Za-z0-9_-]{0,2}/g;
const ESCAPED_BOUNDARY = /(?:%[0-9A-Fa-f]{2}|\\[nrt]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2})$/;
/** A 16-column wrapped run still reaches MIN_B64_RUN after bounded splicing. */
const B64_PIECE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{16,}/g;
/**
 * Splices between two pieces of one value: a single line break with optional
 * indentation and comment/quote prefix (a blank line ends the value), a `\`
 * continuation, or a quote join. Each branch fails in linear time.
 */
const JOIN =
  /(?:[ \t]*\\?\r?\n(?![ \t]*\r?\n)[ \t]*(?:(?:\/\/|#+|\*|>+)[ \t]*)?|['"`]\s*(?:\+\s*)?['"`])+/y;

function isB64Url(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95
  );
}

function isTokenChar(c: number): boolean {
  return isB64Url(c) || c === 46; // '.'
}

function isB64Char(c: number): boolean {
  return isB64Url(c) || c === 43 || c === 47; // '+', '/'
}

interface Spliced {
  text: string;
  /** Ascending offsets in `text` where a JOIN was removed. */
  breaks: number[];
  /** Source offset of the piece that follows each entry of `breaks`. */
  breakSources: number[];
  /** Source offset just past the last consumed character. */
  end: number;
}

/**
 * Collect characters accepted by `keep` from `start`, splicing across JOINs,
 * until `limit` characters are collected.
 */
function splice(
  src: string,
  start: number,
  keep: (c: number) => boolean,
  limit: number,
  decodeDots = false
): Spliced {
  const parts: string[] = [];
  const breaks: number[] = [];
  const breakSources: number[] = [];
  let len = 0;
  let i = start;
  for (;;) {
    let j = i;
    const stop = Math.min(src.length, i + limit - len);
    while (j < stop && keep(src.charCodeAt(j))) j++;
    parts.push(src.slice(i, j));
    len += j - i;
    i = j;
    if (len >= limit || i >= src.length) break;
    // A URL query may encode JWT separators as %2E. Only the token pass
    // normalizes them; the header pass must stop before the first separator.
    if (decodeDots && src[i] === '%' && src.slice(i + 1, i + 3).toLowerCase() === '2e') {
      parts.push('.');
      len++;
      i += 3;
      continue;
    }
    JOIN.lastIndex = i;
    const join = JOIN.exec(src);
    if (!join) break;
    const next = i + join[0].length;
    if (next >= src.length || !keep(src.charCodeAt(next))) break;
    breaks.push(len);
    breakSources.push(next);
    i = next;
  }
  return { text: parts.join(''), breaks, breakSources, end: i };
}

function joseAlgorithm(segment: string): string | undefined {
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof header === 'object' && header !== null && 'alg' in header && typeof header.alg === 'string') {
    return header.alg;
  }
  return undefined;
}

/** A signature cut at a splice must look random, not like spliced prose. */
function looksRandom(s: string): boolean {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9_-]/.test(s);
}

/** Whether a candidate whose header passed joseAlgorithm carries a real signature. */
function hasSignature({ text, breaks }: Spliced, alg: string): boolean {
  const dot1 = text.indexOf('.');
  if (dot1 < 0) return false;
  const dot2 = text.indexOf('.', dot1 + 1);
  if (dot2 < 0) return false;
  const sigStart = dot2 + 1;
  const dot3 = text.indexOf('.', sigStart);
  const run = (dot3 < 0 ? text.length : dot3) - sigStart;
  const plausible = (len: number): boolean => {
    if (SIGNATURE_LENGTHS.includes(len)) return true;
    if (!/^(?:RS|PS)(?:256|384|512)$/.test(alg)) return false;
    const bytes = Math.floor(len * 3 / 4);
    return bytes >= MIN_RSA_BYTES && bytes <= MAX_RSA_BYTES && len === Math.ceil(bytes * 4 / 3);
  };
  if (plausible(run)) return true;
  return breaks.some((offset) =>
    offset > sigStart && offset < sigStart + run &&
    plausible(offset - sigStart) && looksRandom(text.slice(sigStart, offset))
  );
}

/** Maps ascending source offsets to 1-based line numbers. */
function lineCounter(text: string): (pos: number) => number {
  let at = 0;
  let line = 1;
  return (pos) => {
    for (let nl = text.indexOf('\n', at); nl !== -1 && nl < pos; nl = text.indexOf('\n', at)) {
      line++;
      at = nl + 1;
    }
    return line;
  };
}

function scanText(text: string, depth: number, lines: Set<number>): void {
  let lineOf = lineCounter(text);
  for (const m of text.matchAll(TOKEN_START)) {
    const start = m.index;
    if (isB64Url(text.charCodeAt(start - 1)) &&
        !ESCAPED_BOUNDARY.test(text.slice(Math.max(0, start - 6), start))) continue;
    if (m[0][0] !== 'e' && ![9, 10, 13, 32].includes(Buffer.from(m[0], 'base64url')[0])) continue;
    if (m[0] === 'e') {
      JOIN.lastIndex = start + 1;
      const join = JOIN.exec(text);
      if (!join || !/[yw]/.test(text[start + 1 + join[0].length] ?? '')) continue;
    }
    // Validate the header before splicing the whole candidate, so a long
    // token-char run with many non-JOSE starts stays linear.
    const head = splice(text, start, isB64Url, MAX_HEADER + 1).text;
    const alg = head.length >= MIN_HEADER && head.length <= MAX_HEADER
      ? joseAlgorithm(head) : undefined;
    if (alg === undefined) continue;
    if (hasSignature(splice(text, start, isTokenChar, MAX_TOKEN, true), alg)) lines.add(lineOf(start));
  }

  if (depth >= MAX_DEPTH) return;
  lineOf = lineCounter(text);
  let resume = 0;
  for (const m of text.matchAll(B64_PIECE)) {
    if (m.index < resume) continue;
    const run = splice(text, m.index, isB64Char, MAX_TOKEN);
    resume = run.end;
    const hits: number[] = [];
    const joinedHit = b64RunHit(run, m.index, depth);
    if (joinedHit >= 0) hits.push(joinedHit);
    // A newline can join two independently encoded values. Inspect each piece
    // as well as the full run, or the second JWT is hidden by the first.
    if (run.breaks.length > 0) {
      let from = 0;
      for (let piece = 0; piece <= run.breaks.length; piece++) {
        const end = piece < run.breaks.length ? run.breaks[piece] : run.text.length;
        if (end - from >= MIN_B64_RUN &&
            scanBuffer(Buffer.from(run.text.slice(from, end), 'base64'), depth + 1).size > 0) {
          hits.push(piece === 0 ? m.index : run.breakSources[piece - 1]);
        }
        from = end;
      }
    }
    hits.sort((a, b) => a - b);
    for (const at of hits) lines.add(lineOf(at));
  }
}

/**
 * Decode a base64 run starting at source offset `start` and re-scan it;
 * return the source offset of the decoded value holding a JWT, or -1.
 * A splice may have glued a word from the previous or next line onto the
 * value, which misaligns or lengthens the decode, so also try the run without
 * its first and/or last piece.
 */
function b64RunHit({ text, breaks, breakSources }: Spliced, start: number, depth: number): number {
  const firstBreak = breaks.length > 0 ? breaks[0] : 0;
  const lastBreak = breaks.length > 0 ? breaks[breaks.length - 1] : text.length;
  const second = breaks.length > 0 ? breakSources[0] : start;
  const variants: [string, number][] = [
    [text, start],
    [text.slice(0, lastBreak), start],
    [text.slice(firstBreak), second],
    [text.slice(firstBreak, lastBreak), second],
  ];
  const tried = new Set<string>();
  for (const [variant, at] of variants) {
    if (variant.length < MIN_B64_RUN || tried.has(variant)) continue;
    tried.add(variant);
    if (scanBuffer(Buffer.from(variant, 'base64'), depth + 1).size > 0) return at;
  }
  return -1;
}

function utf16beToString(buf: Buffer): string {
  const swapped = Buffer.from(buf.subarray(0, buf.length & ~1));
  return swapped.swap16().toString('utf16le');
}

/**
 * Decode bytes to text: UTF-16 by BOM or NUL interleaving, latin1 for other
 * NUL-bearing (binary) content so embedded ASCII stays scannable, else UTF-8.
 */
function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) return utf16beToString(buf.subarray(2));

  const n = Math.min(buf.length, SNIFF_BYTES) & ~1;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) evenNul++;
    if (buf[i + 1] === 0) oddNul++;
  }
  if (evenNul + oddNul === 0) return buf.toString('utf8');
  const pairs = n / 2;
  if (oddNul >= pairs / 4 && oddNul > evenNul * 4) return buf.toString('utf16le');
  if (evenNul >= pairs / 4 && evenNul > oddNul * 4) return utf16beToString(buf);
  return buf.toString('latin1');
}

function scanBuffer(buf: Buffer, depth: number): Set<number> {
  const lines = new Set<number>();
  scanText(decodeText(buf), depth, lines);
  return lines;
}

/** 1-based, ascending line numbers at which a signed JWT starts in `content`. */
export function findJwtLines(content: Buffer): number[] {
  return [...scanBuffer(content, 0)].sort((a, b) => a - b);
}
