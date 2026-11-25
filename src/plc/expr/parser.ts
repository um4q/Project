/**
 * Pratt parser for Logix expressions (CPT/CMP, ST, array subscripts) and for
 * operand tag paths. The `TokenStream` is reused by the ST statement parser.
 */
import { tokenize, LexError, type Token } from './lexer';
import type { BinaryOp, Expr, PathSeg, TagPath } from './ast';

export class ParseError extends Error {
  constructor(
    message: string,
    readonly pos: number,
    readonly line: number,
    readonly col: number,
  ) {
    super(message);
  }
}

export class TokenStream {
  i = 0;
  constructor(
    readonly toks: Token[],
    readonly src: string,
  ) {}

  static of(src: string): TokenStream {
    try {
      return new TokenStream(tokenize(src), src);
    } catch (e) {
      if (e instanceof LexError) throw new ParseError(e.message, e.pos, e.line, e.col);
      throw e;
    }
  }

  peek(k = 0): Token {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }
  next(): Token {
    const t = this.toks[this.i];
    if (this.i < this.toks.length - 1) this.i++;
    return t;
  }
  atEnd(): boolean {
    return this.peek().kind === 'eof';
  }
  isOp(text: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'op' && t.text === text;
  }
  isKw(kw: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'ident' && t.text.toUpperCase() === kw;
  }
  eatOp(text: string): boolean {
    if (this.isOp(text)) {
      this.next();
      return true;
    }
    return false;
  }
  eatKw(kw: string): boolean {
    if (this.isKw(kw)) {
      this.next();
      return true;
    }
    return false;
  }
  expectOp(text: string): Token {
    if (!this.isOp(text)) this.fail(`Expected '${text}'`);
    return this.next();
  }
  expectKw(kw: string): Token {
    if (!this.isKw(kw)) this.fail(`Expected '${kw}'`);
    return this.next();
  }
  fail(msg: string, tok: Token = this.peek()): never {
    const found = tok.kind === 'eof' ? 'end of text' : `'${tok.text}'`;
    throw new ParseError(`${msg}, found ${found}`, tok.pos, tok.line, tok.col);
  }
}

const BINARY_OPS: Record<string, { op: BinaryOp; prec: number }> = {
  OR: { op: 'OR', prec: 1 },
  XOR: { op: 'XOR', prec: 2 },
  AND: { op: 'AND', prec: 3 },
  '&': { op: 'AND', prec: 3 },
  '=': { op: '=', prec: 4 },
  '<>': { op: '<>', prec: 4 },
  '<': { op: '<', prec: 5 },
  '<=': { op: '<=', prec: 5 },
  '>': { op: '>', prec: 5 },
  '>=': { op: '>=', prec: 5 },
  '+': { op: '+', prec: 6 },
  '-': { op: '-', prec: 6 },
  '*': { op: '*', prec: 7 },
  '/': { op: '/', prec: 7 },
  MOD: { op: 'MOD', prec: 7 },
  '**': { op: '**', prec: 9 },
};

const UNARY_PREC = 8;

/** Keywords that terminate an expression in ST (never parsed as tag names). */
const STOP_WORDS = new Set(['THEN', 'DO', 'OF', 'TO', 'BY', 'END_IF', 'ELSE', 'ELSIF', 'UNTIL', 'END_WHILE', 'END_FOR', 'END_REPEAT', 'END_CASE']);

function binaryAt(ts: TokenStream): { op: BinaryOp; prec: number } | null {
  const t = ts.peek();
  if (t.kind === 'op') return BINARY_OPS[t.text] ?? null;
  if (t.kind === 'ident') {
    const u = t.text.toUpperCase();
    if (u === 'AND' || u === 'OR' || u === 'XOR' || u === 'MOD') return BINARY_OPS[u];
  }
  return null;
}

export function parseExpr(ts: TokenStream, minPrec = 0): Expr {
  let left = parsePrefix(ts);
  for (;;) {
    const b = binaryAt(ts);
    if (!b || b.prec < minPrec) break;
    const opTok = ts.next();
    // left associative: right side binds tighter
    const right = parseExpr(ts, b.prec + 1);
    left = { kind: 'binary', op: b.op, left, right, pos: opTok.pos };
  }
  return left;
}

function parsePrefix(ts: TokenStream): Expr {
  const t = ts.peek();
  if (t.kind === 'op') {
    if (t.text === '(') {
      ts.next();
      const e = parseExpr(ts, 0);
      ts.expectOp(')');
      return e;
    }
    if (t.text === '-') {
      ts.next();
      const arg = parseExpr(ts, UNARY_PREC);
      if (arg.kind === 'num') return { ...arg, value: -arg.value, pos: t.pos };
      return { kind: 'unary', op: '-', arg, pos: t.pos };
    }
    if (t.text === '+') {
      ts.next();
      return parseExpr(ts, UNARY_PREC);
    }
    ts.fail('Expected an operand');
  }
  if (t.kind === 'number') {
    ts.next();
    return { kind: 'num', value: t.value!, isReal: !!t.isReal, pos: t.pos };
  }
  if (t.kind === 'ident') {
    const u = t.text.toUpperCase();
    if (u === 'NOT') {
      ts.next();
      const arg = parseExpr(ts, UNARY_PREC);
      return { kind: 'unary', op: 'NOT', arg, pos: t.pos };
    }
    if (u === 'TRUE' || u === 'FALSE') {
      ts.next();
      return { kind: 'bool', value: u === 'TRUE', pos: t.pos };
    }
    if (STOP_WORDS.has(u) || u === 'AND' || u === 'OR' || u === 'XOR' || u === 'MOD') ts.fail('Expected an operand');
    if (ts.isOp('(', 1)) {
      ts.next();
      ts.next();
      const args: Expr[] = [];
      if (!ts.isOp(')')) {
        do args.push(parseExpr(ts, 0));
        while (ts.eatOp(','));
      }
      const close = ts.expectOp(')');
      return { kind: 'call', name: u, args, pos: t.pos, end: close.end };
    }
    return parseRefAt(ts);
  }
  ts.fail('Expected an operand');
}

/** Parse a tag reference starting at the current identifier token. */
export function parseRefAt(ts: TokenStream): Expr & { kind: 'ref' } {
  const first = ts.next();
  if (first.kind !== 'ident') ts.fail('Expected a tag name', first);
  const segs: PathSeg[] = [];
  let end = first.end;
  for (;;) {
    if (ts.isOp('[')) {
      ts.next();
      const indices: Expr[] = [];
      do indices.push(parseExpr(ts, 0));
      while (ts.eatOp(','));
      end = ts.expectOp(']').end;
      segs.push({ kind: 'index', indices });
      continue;
    }
    if (ts.isOp('.')) {
      const dot = ts.peek();
      const nt = ts.peek(1);
      // member/bit must follow the dot immediately
      if (nt.pos !== dot.end) break;
      if (nt.kind === 'ident') {
        ts.next();
        ts.next();
        if (nt.text.includes(':')) ts.fail('Invalid member name', nt);
        segs.push({ kind: 'member', name: nt.text });
        end = nt.end;
        continue;
      }
      if (nt.kind === 'number') {
        ts.next();
        ts.next();
        if (nt.isReal || !/^\d+$/.test(nt.text)) ts.fail('Invalid bit number', nt);
        segs.push({ kind: 'bit', bit: nt.value! });
        end = nt.end;
        continue;
      }
      if (nt.kind === 'op' && nt.text === '[') {
        ts.next();
        ts.next();
        const index = parseExpr(ts, 0);
        end = ts.expectOp(']').end;
        segs.push({ kind: 'bitIndirect', index });
        continue;
      }
      break;
    }
    break;
  }
  const path: TagPath = { base: first.text, segs };
  return { kind: 'ref', path, text: ts.src.slice(first.pos, end), pos: first.pos, end };
}

/** Parse a complete expression from text. Throws ParseError. */
export function parseExpression(src: string): Expr {
  const ts = TokenStream.of(src);
  if (ts.atEnd()) ts.fail('Expected an expression');
  const e = parseExpr(ts, 0);
  if (!ts.atEnd()) ts.fail('Unexpected text after expression');
  return e;
}

/** Parse an operand that must be a tag reference (e.g. `Local:1:I.Data.8`). Throws ParseError. */
export function parseTagPath(src: string): TagPath {
  const ts = TokenStream.of(src);
  if (ts.peek().kind !== 'ident') ts.fail('Expected a tag name');
  const r = parseRefAt(ts);
  if (!ts.atEnd()) ts.fail('Unexpected text after tag reference');
  return r.path;
}

/** Parse a numeric literal operand (`5`, `-2.5`, `16#FF`). Returns null if not a literal. */
export function parseLiteral(src: string): { value: number; isReal: boolean } | null {
  const s = src.trim();
  if (!s) return null;
  if (!/^[+-]?[0-9]/.test(s) && !/^[+-]?\.[0-9]/.test(s)) return null;
  try {
    const ts = TokenStream.of(s);
    let sign = 1;
    if (ts.isOp('-')) {
      ts.next();
      sign = -1;
    } else if (ts.isOp('+')) ts.next();
    const t = ts.next();
    if (t.kind !== 'number' || !ts.atEnd()) return null;
    return { value: sign * t.value!, isReal: !!t.isReal };
  } catch {
    return null;
  }
}
