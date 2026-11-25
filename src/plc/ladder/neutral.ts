/**
 * Neutral (ASCII) rung text, as typed in the rung text box or pasted.
 *
 * Accepted forms (can be mixed):
 *   spaced:  [XIC Start ,XIC Run ] XIC Stop OTE Run ;
 *   paren:   [XIC(Start) ,XIC(Run) ]XIC(Stop)OTE(Run);
 *
 * Whole routines: one rung per `;`, optional `// comment` lines (attached to the
 * next rung), or L5K-style `RC: "comment";` / `N: rung;` lines.
 */
import type { LadderElement, LadderInstr, Rung } from './ast';
import { isMissingOperand } from './ast';
import { getInstruction } from './instructions';

export class NeutralParseError extends Error {
  constructor(
    message: string,
    readonly pos: number,
    /** Zero-based rung index when parsing a routine */
    readonly rung?: number,
  ) {
    super(message);
  }
}

const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentChar = (c: string) => /[A-Za-z0-9_]/.test(c);

class Scanner {
  pos = 0;
  constructor(readonly s: string) {}
  peek(): string {
    return this.s[this.pos] ?? '';
  }
  eof(): boolean {
    return this.pos >= this.s.length;
  }
  skipWs(): void {
    while (!this.eof() && isWs(this.s[this.pos])) this.pos++;
  }
  fail(msg: string, at = this.pos): never {
    throw new NeutralParseError(msg, at);
  }
}

/** Read an operand word in spaced form (balanced [] and () allowed). */
function readWord(sc: Scanner): string {
  const start = sc.pos;
  let depth = 0;
  while (!sc.eof()) {
    const c = sc.peek();
    if (depth === 0 && (isWs(c) || c === ',' || c === ';' || c === ']')) break;
    if (c === '[' || c === '(') depth++;
    else if ((c === ']' || c === ')') && depth > 0) depth--;
    sc.pos++;
  }
  return sc.s.slice(start, sc.pos);
}

/** Read `( ... )` operand list in paren form. */
function readParenOperands(sc: Scanner): string[] {
  const open = sc.pos;
  sc.pos++; // (
  const ops: string[] = [];
  let depth = 0;
  let cur = '';
  for (;;) {
    if (sc.eof()) sc.fail("Missing ')'", open);
    const c = sc.peek();
    sc.pos++;
    if (depth === 0 && c === ')') {
      ops.push(cur.trim());
      break;
    }
    if (depth === 0 && c === ',') {
      ops.push(cur.trim());
      cur = '';
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    cur += c;
  }
  if (ops.length === 1 && ops[0] === '') return [];
  return ops.map((o) => (o === '' ? '?' : o));
}

function isStructureChar(c: string): boolean {
  return c === ',' || c === ';' || c === ']' || c === '[' || c === '';
}

function parseInstr(sc: Scanner): LadderInstr {
  const start = sc.pos;
  while (!sc.eof() && isIdentChar(sc.peek())) sc.pos++;
  const mnemonic = sc.s.slice(start, sc.pos).toUpperCase();
  // optional whitespace before '('
  const afterName = sc.pos;
  sc.skipWs();
  if (sc.peek() === '(') return { kind: 'instr', mnemonic, operands: readParenOperands(sc) };
  sc.pos = afterName;
  const def = getInstruction(mnemonic);
  const operands: string[] = [];
  const variadic = !def || def.variadic;
  if (variadic) {
    for (;;) {
      const save = sc.pos;
      sc.skipWs();
      const c = sc.peek();
      if (isStructureChar(c)) {
        sc.pos = save;
        break;
      }
      const w = readWord(sc);
      // stop when the word is a known mnemonic and more text follows (start of next instruction)
      if (def && operands.length >= minVariadic(mnemonic) && getInstruction(w) && /^[A-Za-z_]+$/.test(w)) {
        sc.pos = save;
        break;
      }
      operands.push(w);
    }
    return { kind: 'instr', mnemonic, operands };
  }
  const n = def.operands.length;
  for (let k = 0; k < n; k++) {
    const save = sc.pos;
    sc.skipWs();
    if (isStructureChar(sc.peek())) {
      sc.pos = save;
      break;
    }
    operands.push(readWord(sc));
  }
  while (operands.length < n) operands.push('?');
  return { kind: 'instr', mnemonic, operands };
}

function minVariadic(mnemonic: string): number {
  // JSR needs routine name + input count before params
  return mnemonic === 'JSR' ? 2 : 0;
}

function parseSeries(sc: Scanner, inBranch: boolean): LadderElement[] {
  const series: LadderElement[] = [];
  for (;;) {
    sc.skipWs();
    const c = sc.peek();
    if (c === '') {
      if (inBranch) sc.fail("Missing ']' to close branch");
      return series;
    }
    if (c === ';') {
      if (inBranch) sc.fail("Missing ']' to close branch");
      return series;
    }
    if (c === ',' || c === ']') {
      if (!inBranch) sc.fail(`Unexpected '${c}' outside a branch`);
      return series;
    }
    if (c === '[') {
      const open = sc.pos;
      sc.pos++;
      const legs: LadderElement[][] = [];
      for (;;) {
        legs.push(parseSeries(sc, true));
        sc.skipWs();
        const d = sc.peek();
        if (d === ',') {
          sc.pos++;
          continue;
        }
        if (d === ']') {
          sc.pos++;
          break;
        }
        sc.fail("Missing ']' to close branch", open);
      }
      series.push({ kind: 'branch', legs });
      continue;
    }
    if (isIdentStart(c)) {
      series.push(parseInstr(sc));
      continue;
    }
    sc.fail(`Unexpected character '${c}'`);
  }
}

/** Parse one rung of neutral text. A trailing ';' is optional. Throws NeutralParseError. */
export function parseRung(text: string): Rung {
  const sc = new Scanner(text);
  const elements = parseSeries(sc, false);
  sc.skipWs();
  if (sc.peek() === ';') sc.pos++;
  sc.skipWs();
  if (!sc.eof()) sc.fail('Unexpected text after end of rung');
  return { elements };
}

export type NeutralStyle = 'spaced' | 'paren';

const SPACE_SAFE = /^[^\s,;()]+$/;

function instrText(el: LadderInstr, style: NeutralStyle): string {
  const ops = el.operands.map((o) => (isMissingOperand(o) ? '?' : o.trim()));
  if (style === 'paren' || ops.some((o) => !SPACE_SAFE.test(o) || /^\[/.test(o))) return `${el.mnemonic}(${ops.join(',')})`;
  return ops.length ? `${el.mnemonic} ${ops.join(' ')}` : el.mnemonic;
}

function seriesText(series: LadderElement[], style: NeutralStyle): string {
  const parts = series.map((el) => (el.kind === 'instr' ? instrText(el, style) : '[' + el.legs.map((l) => seriesText(l, style)).join(' ,') + ' ]'));
  return style === 'paren' ? parts.join('') : parts.join(' ');
}

/** Serialize a rung to neutral text. */
export function serializeRung(rung: Rung | LadderElement[], style: NeutralStyle = 'spaced'): string {
  const elements = Array.isArray(rung) ? rung : rung.elements;
  const body = seriesText(elements, style);
  if (style === 'paren') return body + ';';
  return body ? body + ' ;' : ';';
}

function readL5KString(text: string, i: number): { value: string; next: number } {
  // text[i] === '"'
  let out = '';
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '"') return { value: out, next: j + 1 };
    if (c === '$' && j + 1 < text.length) {
      const e = text[j + 1];
      if (e === 'N' || e === 'n' || e === 'L' || e === 'l') out += '\n';
      else if (e === 'Q' || e === 'q') out += '"';
      else if (e === 'T' || e === 't') out += '\t';
      else if (e === '$') out += '$';
      else if (e === "'") out += "'";
      else out += e;
      j += 2;
      continue;
    }
    out += c;
    j++;
  }
  throw new NeutralParseError('Unterminated comment string', i);
}

/** Find the end of a rung: the ';' at bracket/paren depth 0. */
function findRungEnd(text: string, i: number): number {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) return j;
    else if (c === '\n' && text.slice(j + 1).trimStart().startsWith('//') && depth === 0) {
      // allow a missing ';' before a comment line
      return j;
    }
  }
  return text.length;
}

/** Parse a whole routine of rungs. Throws NeutralParseError (with rung index). */
export function parseRoutineText(text: string): Rung[] {
  const rungs: Rung[] = [];
  let comment: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && isWs(text[i])) i++;
    if (i >= n) break;
    if (text.startsWith('//', i)) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      comment.push(text.slice(i + 2, j).replace(/^ /, '').replace(/\r$/, ''));
      i = j;
      continue;
    }
    if (/^RC\s*:/i.test(text.slice(i, i + 6))) {
      i = text.indexOf(':', i) + 1;
      while (i < n && isWs(text[i])) i++;
      if (text[i] !== '"') throw new NeutralParseError('Expected a quoted rung comment after RC:', i, rungs.length);
      const s = readL5KString(text, i);
      comment.push(s.value);
      i = s.next;
      while (i < n && isWs(text[i])) i++;
      if (text[i] === ';') i++;
      continue;
    }
    if (/^N\s*:/.test(text.slice(i, i + 4))) i = text.indexOf(':', i) + 1;
    const end = findRungEnd(text, i);
    const body = text.slice(i, end);
    try {
      const rung = parseRung(body);
      if (comment.length) rung.comment = comment.join('\n');
      rungs.push(rung);
    } catch (e) {
      if (e instanceof NeutralParseError) throw new NeutralParseError(`Rung ${rungs.length}: ${e.message}`, i + e.pos, rungs.length);
      throw e;
    }
    comment = [];
    i = end + 1;
  }
  if (comment.length) rungs.push({ comment: comment.join('\n'), elements: [] });
  return rungs;
}

/** Serialize a routine to text that `parseRoutineText` reads back. */
export function serializeRoutineText(rungs: Rung[], style: NeutralStyle = 'spaced'): string {
  const lines: string[] = [];
  for (const r of rungs) {
    if (r.comment) for (const l of r.comment.split('\n')) lines.push(`// ${l}`);
    lines.push(serializeRung(r, style));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}
