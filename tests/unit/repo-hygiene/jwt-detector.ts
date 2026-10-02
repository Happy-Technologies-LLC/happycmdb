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

/** base64url (unpadded) lengths of every registered JWS signature size. */
const SIGNATURE_LENGTHS: readonly number[] = [
  43, // HS256
  64, // HS384
  86, // HS512, ES256, Ed25519
  128, // ES384
  152, // Ed448
  171, // RS/PS 1024-bit
  176, // ES512
  342, // RS/PS 2048-bit
  512, // RS/PS 3072-bit
  683, // RS/PS 4096-bit
];

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
 * `e` + `y`/`w` is base64 for `{` + a printable/whitespace char: a JSON object.
 * The token must not continue a base64url run, unless the run ends in a percent
 * or backslash escape. The literal leads so V8 can scan for `e` quickly.
 */
const TOKEN_START =
  /e[wy](?:(?<![A-Za-z0-9_-]..)|(?<=(?:%[0-9A-Fa-f]{2}|\\[nrt]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2})..))/g;
const B64_PIECE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{20,}/g;
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
function splice(src: string, start: number, keep: (c: number) => boolean, limit: number): Spliced {
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

function isJoseHeader(segment: string): boolean {
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  return (
    typeof header === 'object' &&
    header !== null &&
    'alg' in header &&
    typeof header.alg === 'string'
  );
}

/** A signature cut at a splice must look random, not like spliced prose. */
function looksRandom(s: string): boolean {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9_-]/.test(s);
}

/** Whether a candidate whose header already passed isJoseHeader carries a real signature. */
function hasSignature({ text, breaks }: Spliced): boolean {
  const dot1 = text.indexOf('.');
  if (dot1 < 0) return false;
  const dot2 = text.indexOf('.', dot1 + 1);
  if (dot2 < 0) return false;
  const sigStart = dot2 + 1;
  const dot3 = text.indexOf('.', sigStart);
  const run = (dot3 < 0 ? text.length : dot3) - sigStart;
  return SIGNATURE_LENGTHS.some(
    (len) =>
      len === run ||
      (len < run &&
        breaks.includes(sigStart + len) &&
        looksRandom(text.slice(sigStart, sigStart + len)))
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
    // Validate the header before splicing the whole candidate, so a long
    // token-char run with many non-JOSE starts stays linear.
    const head = splice(text, m.index, isB64Url, MAX_HEADER + 1).text;
    if (head.length < MIN_HEADER || head.length > MAX_HEADER || !isJoseHeader(head)) continue;
    if (hasSignature(splice(text, m.index, isTokenChar, MAX_TOKEN))) lines.add(lineOf(m.index));
  }

  if (depth >= MAX_DEPTH) return;
  lineOf = lineCounter(text);
  let resume = 0;
  for (const m of text.matchAll(B64_PIECE)) {
    if (m.index < resume) continue;
    const run = splice(text, m.index, isB64Char, MAX_TOKEN);
    resume = run.end;
    const at = b64RunHit(run, m.index, depth);
    if (at >= 0) lines.add(lineOf(at));
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
