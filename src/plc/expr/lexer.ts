/**
 * Tokenizer shared by operand paths, CPT/CMP expressions and Structured Text.
 */

export type TokenKind = 'ident' | 'number' | 'string' | 'op' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Raw text (identifiers keep their case) */
  text: string;
  /** For numbers: numeric value */
  value?: number;
  /** For numbers: true if REAL literal */
  isReal?: boolean;
  /** Offset into the source */
  pos: number;
  /** 1-based line and column */
  line: number;
  col: number;
  end: number;
}

export class LexError extends Error {
  constructor(
    message: string,
    readonly pos: number,
    readonly line: number,
    readonly col: number,
  ) {
    super(message);
  }
}

const OPS = [':=', '<=', '>=', '<>', '**', '..', '+', '-', '*', '/', '(', ')', '[', ']', ',', ';', ':', '.', '=', '<', '>', '&', '?'];

const isIdentStart = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
const isIdentChar = (c: string) => isIdentStart(c) || (c >= '0' && c <= '9');
const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * Tokenize `src`. Comments `// ...`, `(* ... *)` and `/* ... *\/` are skipped.
 *
 * Module / system tag names such as `Local:1:I` or `S:FS` are lexed as a single
 * identifier when the colon segments follow with no whitespace (so ST CASE
 * labels like `1:` and `x := 1` are unaffected).
 */
export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;

  const err = (msg: string, at: number): never => {
    throw new LexError(msg, at, line, at - lineStart + 1);
  };

  while (i < n) {
    const c = src[i];
    // newline / whitespace
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    // comments
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if ((c === '(' && src[i + 1] === '*') || (c === '/' && src[i + 1] === '*')) {
      const close = c === '(' ? '*)' : '*/';
      const start = i;
      i += 2;
      while (i < n && !(src[i] === close[0] && src[i + 1] === close[1])) {
        if (src[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (i >= n) err('Unterminated comment', start);
      i += 2;
      continue;
    }
    const start = i;
    const col = i - lineStart + 1;
    if (isIdentStart(c)) {
      while (i < n && isIdentChar(src[i])) i++;
      // module-style names: Ident(:Seg)+ with no whitespace
      while (src[i] === ':' && src[i + 1] !== '=' && i + 1 < n && isIdentChar(src[i + 1])) {
        i++;
        while (i < n && isIdentChar(src[i])) i++;
      }
      toks.push({ kind: 'ident', text: src.slice(start, i), pos: start, line, col, end: i });
      continue;
    }
    if (isDigit(c)) {
      // radix literal 16#FF, 2#1010, 8#17
      let j = i;
      while (j < n && (isDigit(src[j]) || src[j] === '_')) j++;
      if (src[j] === '#') {
        const radix = Number(src.slice(i, j).replace(/_/g, ''));
        if (radix !== 2 && radix !== 8 && radix !== 16) err(`Invalid radix ${radix}`, start);
        j++;
        const ds = j;
        while (j < n && (isIdentChar(src[j]))) j++;
        const digits = src.slice(ds, j).replace(/_/g, '');
        const valid = radix === 16 ? /^[0-9A-Fa-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[01]+$/;
        if (!digits || !valid.test(digits)) err(`Invalid base-${radix} literal`, start);
        let v = parseInt(digits, radix);
        // Logix stores radix literals as 32-bit patterns
        if (v > 0xffffffff) err('Literal too large', start);
        v = v | 0;
        i = j;
        toks.push({ kind: 'number', text: src.slice(start, i), value: v, isReal: false, pos: start, line, col, end: i });
        continue;
      }
      let isReal = false;
      i = j;
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        // A '.' right after an identifier/']' is a member/bit access, not a fraction:
        // the parser never produces a number token there because '.' is lexed first.
        isReal = true;
        i++;
        while (i < n && (isDigit(src[i]) || src[i] === '_')) i++;
      }
      if ((src[i] === 'e' || src[i] === 'E') && (isDigit(src[i + 1] ?? '') || ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src[i + 2] ?? '')))) {
        isReal = true;
        i += 2;
        while (i < n && isDigit(src[i])) i++;
      }
      const text = src.slice(start, i);
      const v = Number(text.replace(/_/g, ''));
      if (Number.isNaN(v)) err(`Invalid number '${text}'`, start);
      toks.push({ kind: 'number', text, value: v, isReal, pos: start, line, col, end: i });
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) j++;
      if (j >= n) err('Unterminated string', start);
      toks.push({ kind: 'string', text: src.slice(i + 1, j), pos: start, line, col, end: j + 1 });
      i = j + 1;
      continue;
    }
    let matched: string | null = null;
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (!matched) err(`Unexpected character '${c}'`, start);
    i += matched!.length;
    toks.push({ kind: 'op', text: matched!, pos: start, line, col, end: i });
  }
  toks.push({ kind: 'eof', text: '', pos: n, line, col: n - lineStart + 1, end: n });
  return toks;
}

/**
 * Lex a bit/member number after a '.' . Because "Data.8" lexes '.' then '8',
 * but "Arr[0].1.5" would not be valid anyway, a number token following '.'
 * that was lexed as a REAL ("8.5") is split by the parser if needed.
 */
export function isKeyword(tok: Token, kw: string): boolean {
  return tok.kind === 'ident' && tok.text.toUpperCase() === kw;
}
