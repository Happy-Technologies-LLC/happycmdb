/**
 * JWT detector behind the repo-hygiene guard (no-jwt-literals.test.ts).
 *
 * A candidate counts only when it is structurally a signed JWS:
 *   - its first segment base64url-decodes to a JSON object with a string `alg`
 *     (`eyJ` = `{"`, `eyAi` = `{ "`, `ewog` = `{\n `, `IHsi` = ` {"`, ...);
 *   - its third segment has the exact length of a real signature (see
 *     SIGNATURE_LENGTHS / the RSA range). The payload may be any length, even
 *     `e30` (`{}`).
 * Placeholders such as `<header>.<payload>.signature` or `<header>...` fail the
 * signature-length gate.
 *
 * Before matching, the detector sees through:
 *   - pieces spliced by a line break (plus indentation and an optional `//`, `#`,
 *     `*` or `>` line prefix), a backslash line continuation, or string
 *     concatenation (`' + '`, `" +\n "`, adjacent literals), even right after
 *     the first character;
 *   - any delimiter before the token (`Bearer%20eyJ...`, `_eyJ..._`,
 *     `<!--eyJ...-->`) and up to MAX_TRAILING `-`/`_` after the signature;
 *   - `%2E`-encoded separators;
 *   - base64/base64url runs, wrapped at any width, whose decoded bytes hold a JWT;
 *   - UTF-16LE/BE content (BOM or NUL-interleaved); other NUL-bearing content is
 *     scanned as latin1 instead of being skipped as binary.
 *
 * Cost is bounded: every candidate start inside one JOIN-chained run shares a
 * single splice of that run, and header decoding draws on a per-text budget.
 * A crafted text that exhausts the budget fails closed: the line where it ran
 * out is reported.
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
/** Longest plausible signature in base64url characters (8192-bit RSA). */
const MAX_SIGNATURE = Math.ceil((MAX_RSA_BYTES * 4) / 3);
/** Formatting delimiters (`_`, `__`, `-->`) glued after a signature. */
const MAX_TRAILING = 4;

/** `{"alg":"none"}` already encodes to 19 chars. */
const MIN_HEADER = 16;
/** Headers carrying x5c certificate chains run to several KB. */
const MAX_HEADER = 16384;
/** Never splice a single run past this many characters. */
const MAX_TOKEN = 65536;
/** The smallest signed JWT is 68 chars; its base64 form is 92. */
const MIN_B64_RUN = 88;
/**
 * A base64 run longer than MAX_TOKEN is re-spliced from this many characters
 * (a multiple of 4, so alignment is kept) before the cut, so an encoded JWT up
 * to ~12 KB that straddles the cut is still decoded whole.
 */
const B64_OVERLAP = 16384;
/** Trailing glued pieces shorter than this (words, not wrapped lines) may be dropped. */
const MAX_GLUED_TRAILING_PIECE = 24;
/** Leading pieces a splice may glue in front of a wrapped value (`# token\n`). */
const MAX_GLUED_PIECES = 3;
/** Header characters decoded per input character before scanning fails closed. */
const HEADER_BUDGET_PER_CHAR = 64;
/** Re-scan decoded base64 at most this deep (base64 inside base64). */
const MAX_DEPTH = 2;
/** Same window git uses to sniff binary content. */
const SNIFF_BYTES = 8000;

/** A JOIN may start here (see JOIN); used in lookaheads. */
const JOIN_AHEAD = `['"\`]|[ \\t]*\\\\?\\r?\\n`;
/**
 * First character of a base64url JSON object: `{` encodes as `e[wy]`; leading
 * JSON whitespace as `I[ACH]`, `C[ginQSX]` or `D[QSX]`. A lone first character
 * may also be JOINed to the rest. Each match consumes one character, so
 * overlapping prefixes cannot hide a start; there is no left boundary, so any
 * delimiter may precede the token.
 */
const TOKEN_START = new RegExp(
  `e(?=[wy])|I(?=[ACH])|C(?=[ginQSX])|D(?=[QSX])|[eICD](?=${JOIN_AHEAD})`,
  'g'
);
const JSON_PREFIX = /^(?:e[wy]|I[ACH]|C[ginQSX]|D[QSX])/;
/** Decoded header lead: optional whitespace, `{`, whitespace, then `"` or `}`. */
const JSON_OBJECT_LEAD = /^\s*(?:\{\s*(?:["}]|$)|$)/;
/**
 * A base64 run starts at a piece that is long enough to decode on its own, or
 * at a piece of any length that a JOIN immediately continues (wrapped at any
 * width, or a short first piece after a key). scanText re-checks the JOIN and
 * only decodes runs of at least MIN_B64_RUN characters.
 */
const B64_PIECE = new RegExp(
  '(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]+(?![A-Za-z0-9+/_-])' + // whole run, no backtracking
    `(?:(?<=[A-Za-z0-9+/_-]{${MIN_B64_RUN}})|(?=${JOIN_AHEAD}))`,
  'g'
);
/**
 * Splices between two pieces of one value: a single line break with optional
 * indentation and a comment/quote prefix followed by whitespace (a blank line
 * ends the value; `//abc` stays data, since base64 lines may start `//`), a `\`
 * continuation, or a quote join. Each branch fails in linear time.
 */
const JOIN =
  /(?:[ \t]*\\?\r?\n(?![ \t]*\r?\n)[ \t]*(?:(?:\/\/|#+|\*|>+)[ \t]+)?|['"`]\s*(?:\+\s*)?['"`])+/y;

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
  /**
   * Ascending offsets in `text` where the source stops being contiguous (start,
   * every JOIN, every decoded `%2E`), and the source offset of each.
   */
  segments: number[];
  segmentSources: number[];
  /** Source offset just past the last consumed character. */
  end: number;
}

/**
 * Collect characters accepted by `keep` from `start`, splicing across JOINs
 * (and decoding `%2E` to `.` when asked), until `limit` characters are collected.
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
  const segments = [0];
  const segmentSources = [start];
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
    if (decodeDots && src[i] === '%' && src.slice(i + 1, i + 3).toLowerCase() === '2e') {
      parts.push('.');
      len++;
      i += 3;
      segments.push(len);
      segmentSources.push(i);
      continue;
    }
    const next = joinedPiece(src, i);
    if (next < 0 || next >= src.length || !keep(src.charCodeAt(next))) break;
    breaks.push(len);
    segments.push(len);
    segmentSources.push(next);
    i = next;
  }
  return { text: parts.join(''), breaks, segments, segmentSources, end: i };
}

/** Source offset of the piece a JOIN at `at` leads to, or -1 if none does. */
function joinedPiece(src: string, at: number): number {
  JOIN.lastIndex = at;
  const join = JOIN.exec(src);
  return join ? at + join[0].length : -1;
}

/** Index of the first element of ascending `xs` that is >= `x` (xs.length if none). */
function firstAtLeast(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function joseAlgorithm(segment: string): string | undefined {
  // Reject cheaply before decoding a long segment.
  if (!JSON_OBJECT_LEAD.test(Buffer.from(segment.slice(0, 8), 'base64url').toString('latin1'))) {
    return undefined;
  }
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

/** One JOIN-chained token run, shared by every candidate start inside it. */
interface Chain extends Spliced {
  /** Ascending offsets of every `.` in `text`. */
  dots: number[];
}

function tokenChain(src: string, start: number): Chain {
  const spliced = splice(src, start, isTokenChar, MAX_TOKEN, true);
  const dots: number[] = [];
  for (let d = spliced.text.indexOf('.'); d !== -1; d = spliced.text.indexOf('.', d + 1)) dots.push(d);
  return { ...spliced, dots };
}

/** Offset in `spliced.text` of source offset `at`, which the splice consumed. */
function chainOffset({ segments, segmentSources }: Spliced, at: number): number {
  const k = firstAtLeast(segmentSources, at + 1) - 1;
  return segments[k] + (at - segmentSources[k]);
}

/** Source offset of offset `at` in `spliced.text`. */
function sourceOffset({ segments, segmentSources }: Spliced, at: number): number {
  const k = firstAtLeast(segments, at + 1) - 1;
  return segmentSources[k] + (at - segments[k]);
}

/** Header characters still decodable for one text (see HEADER_BUDGET_PER_CHAR). */
interface Budget {
  left: number;
}

/**
 * Whether `chain.text` holds a signed JWT starting at offset `from`;
 * 'budget' when decoding its header would exhaust `budget`.
 */
function signedJwtAt(chain: Chain, from: number, budget: Budget): 'jwt' | 'none' | 'budget' {
  const { text, dots, breaks } = chain;
  const k = firstAtLeast(dots, from);
  if (k + 1 >= dots.length) return 'none';
  const headerEnd = dots[k];
  if (headerEnd - from < MIN_HEADER || headerEnd - from > MAX_HEADER) return 'none';
  budget.left -= headerEnd - from;
  if (budget.left < 0) return 'budget';
  const alg = joseAlgorithm(text.slice(from, headerEnd));
  if (alg === undefined) return 'none';

  const sigStart = dots[k + 1] + 1;
  const sigEnd = k + 2 < dots.length ? dots[k + 2] : text.length;
  const plausible = (len: number): boolean => {
    if (SIGNATURE_LENGTHS.includes(len)) return true;
    if (!/^(?:RS|PS)(?:256|384|512)$/.test(alg)) return false;
    const bytes = Math.floor((len * 3) / 4);
    return bytes >= MIN_RSA_BYTES && bytes <= MAX_RSA_BYTES && len === Math.ceil((bytes * 4) / 3);
  };
  // The signature ends at the run end or at a splice; either way it may carry
  // trailing formatting delimiters. A splice cut must look random.
  const ends = [sigEnd];
  const limit = Math.min(sigEnd, sigStart + MAX_SIGNATURE + MAX_TRAILING + 1);
  for (let b = firstAtLeast(breaks, sigStart + 1); b < breaks.length && breaks[b] < limit; b++) {
    ends.push(breaks[b]);
  }
  for (const end of ends) {
    for (let e = end; e > sigStart && end - e <= MAX_TRAILING; e--) {
      if (e < end && text[e] !== '-' && text[e] !== '_') break;
      if (e - sigStart > MAX_SIGNATURE || !plausible(e - sigStart)) continue;
      if (end === sigEnd || looksRandom(text.slice(sigStart, e))) return 'jwt';
    }
  }
  return 'none';
}

/** Maps source offsets (ascending, with rare rewinds) to 1-based line numbers. */
function lineCounter(text: string): (pos: number) => number {
  let at = 0;
  let line = 1;
  return (pos) => {
    if (pos < at) {
      at = 0;
      line = 1;
    }
    for (let nl = text.indexOf('\n', at); nl !== -1 && nl < pos; nl = text.indexOf('\n', at)) {
      line++;
      at = nl + 1;
    }
    return line;
  };
}

function scanText(text: string, depth: number, lines: Set<number>): void {
  let lineOf = lineCounter(text);
  let chain: Chain | undefined;
  const budget: Budget = { left: HEADER_BUDGET_PER_CHAR * text.length + MAX_HEADER };
  for (const m of text.matchAll(TOKEN_START)) {
    const start = m.index;
    let prefix = text.slice(start, start + 4);
    if (!JSON_PREFIX.test(prefix)) {
      // A lone first character must be JOINed straight into a valid prefix.
      const next = joinedPiece(text, start + 1);
      if (next < 0) continue;
      prefix = text[start] + text.slice(next, next + 3);
      if (!JSON_PREFIX.test(prefix)) continue;
    }
    if (prefix[0] !== 'e' && ![9, 10, 13, 32].includes(Buffer.from(prefix, 'base64url')[0])) continue;

    let from = 0;
    if (chain !== undefined && start < chain.end) from = chainOffset(chain, start);
    // Restart near the end of a truncated chain so a late token is not cut.
    if (chain === undefined || start >= chain.end ||
        (chain.text.length >= MAX_TOKEN && from > MAX_TOKEN / 2)) {
      chain = tokenChain(text, start);
      from = 0;
    }
    const verdict = signedJwtAt(chain, from, budget);
    if (verdict === 'none') continue;
    lines.add(lineOf(start));
    if (verdict === 'budget') break; // fail closed; the line is reported
  }

  if (depth >= MAX_DEPTH) return;
  lineOf = lineCounter(text);
  let resume = 0;
  for (const m of text.matchAll(B64_PIECE)) {
    if (m.index < resume) continue;
    if (m[0].length < MIN_B64_RUN) {
      // Too short to decode alone: only a start when a JOIN continues it.
      const next = joinedPiece(text, m.index + m[0].length);
      if (next < 0 || !isB64Char(text.charCodeAt(next))) continue;
    }
    for (let at = m.index; ;) {
      const run = splice(text, at, isB64Char, MAX_TOKEN);
      resume = run.end;
      if (run.text.length >= MIN_B64_RUN) {
        for (const hit of b64RunHits(run, depth)) lines.add(lineOf(hit));
      }
      if (run.text.length < MAX_TOKEN) break;
      at = sourceOffset(run, MAX_TOKEN - B64_OVERLAP);
    }
  }
}

/** Source offsets of the decoded values in one base64 run that hold a JWT. */
function b64RunHits(run: Spliced, depth: number): number[] {
  const hits: number[] = [];
  const joinedHit = b64RunHit(run, depth);
  if (joinedHit >= 0) hits.push(joinedHit);
  // A newline can join two independently encoded values. Inspect each piece
  // as well as the full run, or the second JWT is hidden by the first.
  let from = 0;
  for (let piece = 0; run.breaks.length > 0 && piece <= run.breaks.length; piece++) {
    const end = piece < run.breaks.length ? run.breaks[piece] : run.text.length;
    if (end - from >= MIN_B64_RUN &&
        scanBuffer(Buffer.from(run.text.slice(from, end), 'base64'), depth + 1).size > 0) {
      hits.push(sourceOffset(run, from));
    }
    from = end;
  }
  return hits.sort((a, b) => a - b);
}

/**
 * Decode a base64 run and re-scan it; return the source offset of the decoded
 * value holding a JWT, or -1.
 * A splice may glue up to MAX_GLUED_PIECES short lines (`# token`, a prose
 * word) in front of a wrapped value or after it (`Thanks\nNick`), and
 * formatting may glue `_`/`-` before it (`_<value>_`). Each misaligns or
 * lengthens the decode, so also try the run without leading pieces (first,
 * when the first piece is too short to be a value on its own, so the hit is
 * reported on the value's line), without the leading `-`/`_` of whichever
 * piece it starts at, and without its last piece plus up to MAX_GLUED_PIECES
 * further short trailing pieces. As a last resort, shift the whole run by 1-3
 * characters (a glued `auth-` style prefix).
 */
function b64RunHit(run: Spliced, depth: number): number {
  const { text, breaks } = run;
  const dropped = breaks.slice(0, MAX_GLUED_PIECES);
  const firstPiece = breaks.length > 0 ? breaks[0] : text.length;
  const bases = firstPiece < MIN_B64_RUN ? [...dropped, 0] : [0, ...dropped];
  const offsets: number[] = [];
  for (const base of bases) {
    offsets.push(base);
    let lead = base;
    while (text[lead] === '-' || text[lead] === '_') lead++;
    if (lead > base) offsets.push(lead);
  }
  offsets.push(1, 2, 3);
  // Ends: the whole run, without its last piece, then without up to
  // MAX_GLUED_PIECES further trailing pieces only while each is short (a glued
  // word, not a full-width wrapped line), so crafted wrapped data does not
  // multiply work.
  const ends = [text.length];
  for (let b = breaks.length - 1; b >= 0 && ends.length <= MAX_GLUED_PIECES + 1; b--) {
    const piece = ends[ends.length - 1] - breaks[b];
    if (ends.length > 1 && piece >= MAX_GLUED_TRAILING_PIECE) break;
    ends.push(breaks[b]);
  }
  const tried = new Set<number>();
  for (const offset of offsets) {
    if (tried.has(offset) || offset >= text.length) continue;
    tried.add(offset);
    // A decoded prefix equals the decode of the prefix, so decode once per
    // offset and re-scan prefixes for each end.
    const decoded = Buffer.from(text.slice(offset), 'base64');
    for (const end of ends) {
      if (end - offset < MIN_B64_RUN) continue;
      const bytes = decoded.subarray(0, Math.floor(((end - offset) * 3) / 4));
      // Report where the decoded value starts, not where the splice began.
      if (scanBuffer(bytes, depth + 1).size > 0) return sourceOffset(run, offset);
    }
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
