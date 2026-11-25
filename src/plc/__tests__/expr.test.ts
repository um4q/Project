/**
 * Expressions: tokenizer, Pratt parser, formatter, tag paths, literals and the
 * typed expression compiler (DINT / REAL / BOOL rules, overflow, faults).
 */
import { describe, it, expect } from 'vitest';
import {
  tokenize,
  parseExpression,
  parseTagPath,
  parseLiteral,
  formatExpr,
  formatPath,
  compileExpr,
  compileRef,
  Runtime,
  TagDatabase,
  ParseError,
  PlcMajorFault,
  DINT_MIN,
  DINT_MAX,
  type Expr,
  type ExprEnv,
  type CompiledExpr,
  type TagDef,
  type TagProblem,
  type Token,
} from '../index';
import { LexError } from '../expr/lexer';
import type { RefCompileEnv } from '../core/refs';

// ----------------------------------------------------------------------------- helpers

/** Fully parenthesised prefix form of an AST, for precedence checks. */
function sx(e: Expr): string {
  switch (e.kind) {
    case 'num':
      return e.isReal ? `${e.value}r` : String(e.value);
    case 'bool':
      return e.value ? 'TRUE' : 'FALSE';
    case 'ref':
      return e.text;
    case 'call':
      return `${e.name}(${e.args.map(sx).join(' ')})`;
    case 'unary':
      return `(${e.op === '-' ? 'neg' : 'NOT'} ${sx(e.arg)})`;
    case 'binary':
      return `(${e.op} ${sx(e.left)} ${sx(e.right)})`;
  }
}

const p = (src: string) => sx(parseExpression(src));

/** AST without positions / source slices, for structural comparison. */
function strip(e: Expr): unknown {
  switch (e.kind) {
    case 'num':
      return { kind: 'num', value: e.value, isReal: e.isReal };
    case 'bool':
      return { kind: 'bool', value: e.value };
    case 'ref':
      return { kind: 'ref', path: formatPath(e.path) };
    case 'call':
      return { kind: 'call', name: e.name, args: e.args.map(strip) };
    case 'unary':
      return { kind: 'unary', op: e.op, arg: strip(e.arg) };
    case 'binary':
      return { kind: 'binary', op: e.op, left: strip(e.left), right: strip(e.right) };
  }
}

interface Env {
  rt: Runtime;
  db: TagDatabase;
  errors: string[];
  env: ExprEnv;
  compile(src: string): CompiledExpr;
  /** Compile (must succeed) and evaluate. */
  ev(src: string): number;
  /** Compile (must succeed) and return the class. */
  cls(src: string): string;
  /** Compile and return the reported errors. */
  fails(src: string): string;
  set(name: string, v: number): void;
}

function makeEnv(tags: TagDef[] = []): Env {
  const rt = new Runtime();
  const db = new TagDatabase(rt);
  const problems: TagProblem[] = [];
  for (const t of tags) db.createTag(db.controller, t, problems);
  if (problems.length) throw new Error(problems.map((x) => x.message).join('\n'));
  const errors: string[] = [];
  const refEnv: RefCompileEnv = {
    rt,
    compileIndex: (e) => {
      const n = errors.length;
      const ce = compileExpr(e, env);
      if (errors.length > n || ce.cls === 'REAL') return null;
      return ce.eval;
    },
  };
  const env: ExprEnv = {
    rt,
    resolve: (path, text) => compileRef(db.controller, path, text, refEnv),
    error: (m) => errors.push(m),
  };
  const compile = (src: string) => compileExpr(parseExpression(src), env);
  const ok = (src: string) => {
    errors.length = 0;
    const ce = compile(src);
    if (errors.length) throw new Error(`'${src}': ${errors.join('; ')}`);
    return ce;
  };
  return {
    rt,
    db,
    errors,
    env,
    compile,
    ev: (src) => ok(src).eval(),
    cls: (src) => ok(src).cls,
    fails(src) {
      errors.length = 0;
      compile(src);
      if (!errors.length) throw new Error(`expected '${src}' to fail`);
      return errors.join('\n');
    },
    set(name, v) {
      const tag = db.controller.own(name);
      if (!tag) throw new Error(name);
      tag.holder.value = v;
    },
  };
}

const T = (name: string, dataType: string, value?: unknown, dims?: number[]): TagDef => ({ name, dataType, value, dims });

function majorFault(fn: () => unknown): PlcMajorFault {
  try {
    fn();
  } catch (e) {
    if (e instanceof PlcMajorFault) return e;
    throw e;
  }
  throw new Error('expected a major fault');
}

const texts = (toks: Token[]) => toks.map((t) => t.text);
const kinds = (toks: Token[]) => toks.map((t) => t.kind);

// ============================================================================ tokenize

describe('tokenize', () => {
  it('module and status names are single identifiers', () => {
    const t = tokenize('Local:1:I.Data.8');
    expect(texts(t)).toEqual(['Local:1:I', '.', 'Data', '.', '8', '']);
    expect(kinds(t)).toEqual(['ident', 'op', 'ident', 'op', 'number', 'eof']);
    expect(texts(tokenize('S:FS AND s:z'))).toEqual(['S:FS', 'AND', 's:z', '']);
    expect(texts(tokenize('Local:12:O.Data'))).toEqual(['Local:12:O', '.', 'Data', '']);
  });

  it(':= is an assignment, not part of a name; spaced colons are not merged', () => {
    expect(texts(tokenize('x:=1'))).toEqual(['x', ':=', '1', '']);
    expect(texts(tokenize('x := 1'))).toEqual(['x', ':=', '1', '']);
    expect(texts(tokenize('1: y'))).toEqual(['1', ':', 'y', '']);
    expect(texts(tokenize('Lbl : y'))).toEqual(['Lbl', ':', 'y', '']);
  });

  it.each<[string, number, boolean]>([
    ['16#FF', 255, false],
    ['16#ff', 255, false],
    ['16#FF_FF', 65535, false],
    ['2#1010_1010', 170, false],
    ['2#0', 0, false],
    ['8#17', 15, false],
    ['8#777', 511, false],
    ['16#FFFFFFFF', -1, false],
    ['16#8000_0000', DINT_MIN, false],
    ['16#7FFFFFFF', DINT_MAX, false],
    ['42', 42, false],
    ['1_000', 1000, false],
    ['1_000_000', 1000000, false],
    ['0', 0, false],
    ['1.5', 1.5, true],
    ['0.25', 0.25, true],
    ['1.5e3', 1500, true],
    ['1.5E-3', 0.0015, true],
    ['2e+2', 200, true],
    ['1e3', 1000, true],
    ['1_000.000_1', 1000.0001, true],
  ])('number %s = %s (REAL: %s)', (src, value, isReal) => {
    const [t, eof] = tokenize(src);
    expect(t).toMatchObject({ kind: 'number', text: src, value, isReal });
    expect(eof.kind).toBe('eof');
  });

  it('ranges and member access next to numbers', () => {
    expect(texts(tokenize('1..5'))).toEqual(['1', '..', '5', '']);
    expect(texts(tokenize('Arr[1].3'))).toEqual(['Arr', '[', '1', ']', '.', '3', '']);
    expect(texts(tokenize('1.'))).toEqual(['1', '.', '']);
  });

  it.each(['10#5', '3#1', '16#G', '16#', '2#102', '8#8', '16#1_0000_0000'])('bad radix literal %s is a LexError', (src) => {
    expect(() => tokenize(src)).toThrow(LexError);
  });

  it('comments are skipped: //, (* *), /* */', () => {
    expect(texts(tokenize('1 // comment ) here\n+ 2'))).toEqual(['1', '+', '2', '']);
    expect(texts(tokenize('(* a (b) *) 1 /* x * y */ + 2'))).toEqual(['1', '+', '2', '']);
    expect(texts(tokenize('A(*inline*)B'))).toEqual(['A', 'B', '']);
    // a parenthesised expression is not a comment
    expect(texts(tokenize('(A)*(B)'))).toEqual(['(', 'A', ')', '*', '(', 'B', ')', '']);
  });

  it('comments track lines', () => {
    const t = tokenize('(* a\n b\n *) X\n  Y');
    expect(t[0]).toMatchObject({ text: 'X', line: 3, col: 5 });
    expect(t[1]).toMatchObject({ text: 'Y', line: 4, col: 3 });
  });

  it('unterminated comments are errors', () => {
    expect(() => tokenize('1 (* never closed')).toThrow(/Unterminated comment/);
    expect(() => tokenize('1 /* never closed')).toThrow(/Unterminated comment/);
  });

  it('strings', () => {
    expect(tokenize("'abc'")[0]).toMatchObject({ kind: 'string', text: 'abc', pos: 0, end: 5 });
    expect(tokenize('"x y"')[0]).toMatchObject({ kind: 'string', text: 'x y' });
    expect(() => tokenize("'open")).toThrow(/Unterminated string/);
  });

  it('multi-character operators', () => {
    expect(texts(tokenize('a<>b<=c>=d**e:=f..g&h'))).toEqual(['a', '<>', 'b', '<=', 'c', '>=', 'd', '**', 'e', ':=', 'f', '..', 'g', '&', 'h', '']);
    expect(texts(tokenize('a<b>c=d'))).toEqual(['a', '<', 'b', '>', 'c', '=', 'd', '']);
    expect(texts(tokenize('[a,b];?'))).toEqual(['[', 'a', ',', 'b', ']', ';', '?', '']);
  });

  it('positions, lines and columns', () => {
    const t = tokenize('a\n  bb + 3');
    expect(t[0]).toMatchObject({ text: 'a', pos: 0, end: 1, line: 1, col: 1 });
    expect(t[1]).toMatchObject({ text: 'bb', pos: 4, end: 6, line: 2, col: 3 });
    expect(t[2]).toMatchObject({ text: '+', pos: 7, line: 2, col: 6 });
    expect(t[4]).toMatchObject({ kind: 'eof', pos: 10 });
  });

  it('unexpected characters report their position', () => {
    try {
      tokenize('A + @');
      throw new Error('no error');
    } catch (e) {
      expect(e).toBeInstanceOf(LexError);
      expect((e as LexError).pos).toBe(4);
      expect((e as LexError).col).toBe(5);
      expect((e as Error).message).toMatch(/Unexpected character '@'/);
    }
  });

  it('identifiers keep their case', () => {
    expect(tokenize('MyTag')[0]).toMatchObject({ kind: 'ident', text: 'MyTag' });
  });
});

// ============================================================================ parseExpression

describe('parseExpression precedence', () => {
  it.each([
    // ** binds tighter than unary minus
    ['-2**2', '(neg (** 2 2))'],
    ['(-2)**2', '(** -2 2)'],
    ['2**-2', '(** 2 -2)'],
    ['-A**2', '(neg (** A 2))'],
    ['-A*B', '(* (neg A) B)'],
    ['2*3**2', '(* 2 (** 3 2))'],
    ['2**3**2', '(** (** 2 3) 2)'],
    ['10-4-3', '(- (- 10 4) 3)'],
    ['100/10/5', '(/ (/ 100 10) 5)'],
    ['1+2*3', '(+ 1 (* 2 3))'],
    ['(1+2)*3', '(* (+ 1 2) 3)'],
    ['A MOD B * C', '(* (MOD A B) C)'],
    ['A + B MOD C', '(+ A (MOD B C))'],
    ['-3 MOD 2', '(MOD -3 2)'],
    ['NOT A AND B', '(AND (NOT A) B)'],
    ['NOT (A AND B)', '(NOT (AND A B))'],
    ['NOT NOT A', '(NOT (NOT A))'],
    ['NOT A = B', '(= (NOT A) B)'],
    ['A OR B AND C', '(OR A (AND B C))'],
    ['A AND B OR C', '(OR (AND A B) C)'],
    ['A XOR B OR C', '(OR (XOR A B) C)'],
    ['A OR B XOR C', '(OR A (XOR B C))'],
    ['A AND B XOR C', '(XOR (AND A B) C)'],
    ['A & B', '(AND A B)'],
    ['A & B OR C', '(OR (AND A B) C)'],
    ['a and b or not c', '(OR (AND a b) (NOT c))'],
    ['A > 1 AND B < 2', '(AND (> A 1) (< B 2))'],
    ['A + 1 = B * 2', '(= (+ A 1) (* B 2))'],
    ['A < B = C', '(= (< A B) C)'],
    ['A <> B', '(<> A B)'],
    ['A >= B', '(>= A B)'],
    ['A <= -B', '(<= A (neg B))'],
    ['A - -B', '(- A (neg B))'],
    ['A--2', '(- A -2)'],
  ])('%s  =>  %s', (src, expected) => {
    expect(p(src)).toBe(expected);
  });

  it('unary minus on a literal folds into the literal', () => {
    expect(parseExpression('-5')).toMatchObject({ kind: 'num', value: -5, isReal: false });
    expect(parseExpression('-2.5')).toMatchObject({ kind: 'num', value: -2.5, isReal: true });
    expect(parseExpression('- -5')).toMatchObject({ kind: 'num', value: 5 });
    expect(parseExpression('-(-5)')).toMatchObject({ kind: 'num', value: 5 });
    expect(parseExpression('+7')).toMatchObject({ kind: 'num', value: 7 });
    expect(parseExpression('-2147483648')).toMatchObject({ kind: 'num', value: DINT_MIN });
  });

  it('literals, booleans, calls and references', () => {
    expect(parseExpression('TRUE')).toMatchObject({ kind: 'bool', value: true });
    expect(parseExpression('false')).toMatchObject({ kind: 'bool', value: false });
    expect(parseExpression('16#FF')).toMatchObject({ kind: 'num', value: 255 });
    expect(p('abs(x) + SQR(2.0)')).toBe('(+ ABS(x) SQR(2r))');
    expect(p('ABS(-5)+1')).toBe('(+ ABS(-5) 1)');
    expect(p('TRN(A, B)')).toBe('TRN(A B)');
    const e = parseExpression('Arr[Idx+1].Val * 2');
    expect(e.kind).toBe('binary');
    if (e.kind === 'binary' && e.left.kind === 'ref') {
      expect(e.left.text).toBe('Arr[Idx+1].Val');
      expect(formatPath(e.left.path)).toBe('Arr[Idx+1].Val');
    } else throw new Error('expected a ref');
    expect(p('Local:1:I.Data.8 AND S:FS')).toBe('(AND Local:1:I.Data.8 S:FS)');
    expect(p('Word.[Idx] OR Data[0].3')).toBe('(OR Word.[Idx] Data[0].3)');
  });

  it.each([
    ['', /Expected an expression/],
    ['   ', /Expected an expression/],
    ['1 +', /Expected an operand, found end of text/],
    ['(1', /Expected '\)'/],
    ['1)', /Unexpected text after expression/],
    ['1 2', /Unexpected text after expression/],
    ['AND 1', /Expected an operand/],
    ['A..B', /Unexpected text after expression/],
    ['ABS(', /Expected an operand/],
    ['Arr[1', /Expected '\]'/],
    ['A +* B', /Expected an operand/],
    ['THEN', /Expected an operand/],
  ])('%j is a ParseError (%s)', (src, re) => {
    expect(() => parseExpression(src)).toThrow(ParseError);
    expect(() => parseExpression(src)).toThrow(re);
  });

  it('parse errors carry the position of the offending token', () => {
    try {
      parseExpression('1 + )');
      throw new Error('no error');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).pos).toBe(4);
      expect((e as ParseError).col).toBe(5);
    }
    try {
      parseExpression('A +\n  @');
    } catch (e) {
      // lexer errors are converted to ParseError
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBe(2);
      expect((e as ParseError).col).toBe(3);
    }
  });
});

// ============================================================================ formatExpr

describe('formatExpr', () => {
  it.each([
    ['(A+B)*C', '(A+B)*C'],
    ['A-(B-C)', 'A-(B-C)'],
    ['A-B-C', 'A-B-C'],
    ['A/(B*C)', 'A/(B*C)'],
    ['A MOD B', 'A MOD B'],
    ['a and b', 'a AND b'],
    ['A & B', 'A AND B'],
    ['NOT (A AND B)', 'NOT (A AND B)'],
    ['-(A+B)', '-(A+B)'],
    ['2.0', '2.0'],
    ['1.5', '1.5'],
    ['16#FF', '255'],
    ['abs(x)', 'ABS(x)'],
    ['TRUE', 'TRUE'],
    ['A <> B', 'A<>B'],
    ['Arr[i + 1, 2].Val', 'Arr[i+1,2].Val'],
    ['(A**B)**C', 'A**B**C'],
    ['A**(B**C)', 'A**(B**C)'],
  ])('formatExpr(%s) = %s', (src, expected) => {
    expect(formatExpr(parseExpression(src))).toBe(expected);
  });

  const ROUND_TRIP = [
    '1+2*3',
    '(1+2)*3',
    'A-(B-C)',
    'A-B-C',
    '-A*B',
    '-(A*B)',
    '-A**2',
    '-(2**2)',
    '(-A)**2',
    '(-2)**2',
    '(-2.5)**2',
    '2**-2',
    'A**(-B)',
    'A - -B',
    'A * -2',
    'NOT A AND B',
    'NOT (A AND B)',
    'NOT NOT A',
    '(NOT A)**2',
    'A OR B AND C',
    '(A OR B) AND C',
    'A XOR (B OR C)',
    '(A = B) = C',
    'A = (B = C)',
    'A < B = C < D',
    'ABS(A - B) / 2.5',
    'SIN(R) ** 2.0 + COS(R) ** 2.0',
    'Arr[Idx + 1] MOD 3',
    'TRUE XOR FALSE',
    '-2147483648',
    '1.0e-7 * X',
  ];

  it.each(ROUND_TRIP)('round trip keeps the AST: %s', (src) => {
    const ast = parseExpression(src);
    const text = formatExpr(ast);
    const again = parseExpression(text);
    expect(strip(again)).toEqual(strip(ast));
    expect(formatExpr(again)).toBe(text);
  });

  it('round trip keeps the value: (-2)**2 is 4, not -4', () => {
    const e = makeEnv();
    const text = formatExpr(parseExpression('(-2)**2'));
    expect(e.ev('(-2)**2')).toBe(4);
    expect(e.ev(text)).toBe(4);
  });
});

// ============================================================================ parseTagPath / parseLiteral

describe('parseTagPath', () => {
  it('module I/O path with member and bit', () => {
    expect(parseTagPath('Local:1:I.Data.8')).toEqual({
      base: 'Local:1:I',
      segs: [
        { kind: 'member', name: 'Data' },
        { kind: 'bit', bit: 8 },
      ],
    });
  });

  it('subscripts, members, bits and indirect bits', () => {
    const a = parseTagPath('Arr[1,2].Val');
    expect(a.base).toBe('Arr');
    expect(a.segs).toHaveLength(2);
    expect(a.segs[0]).toMatchObject({ kind: 'index', indices: [{ kind: 'num', value: 1 }, { kind: 'num', value: 2 }] });
    expect(a.segs[1]).toEqual({ kind: 'member', name: 'Val' });

    expect(parseTagPath('Data[0].3').segs).toEqual([{ kind: 'index', indices: [expect.objectContaining({ kind: 'num', value: 0 })] }, { kind: 'bit', bit: 3 }]);

    const ind = parseTagPath('Word.[Idx]');
    expect(ind.segs[0]).toMatchObject({ kind: 'bitIndirect', index: { kind: 'ref', text: 'Idx' } });

    const ex = parseTagPath('Arr[Idx+1]');
    expect(ex.segs[0].kind).toBe('index');
    if (ex.segs[0].kind === 'index') expect(sx(ex.segs[0].indices[0])).toBe('(+ Idx 1)');

    expect(parseTagPath('S:FS')).toEqual({ base: 'S:FS', segs: [] });
    expect(parseTagPath('A.B.C').segs).toEqual([
      { kind: 'member', name: 'B' },
      { kind: 'member', name: 'C' },
    ]);
    expect(parseTagPath('T.ACC.31').segs[1]).toEqual({ kind: 'bit', bit: 31 });
    expect(formatPath(parseTagPath('L.M[I, J+1].Faults[2].[B]'))).toBe('L.M[I,J+1].Faults[2].[B]');
  });

  it.each(['', '1abc', '16#FF', 'A B', 'A.', 'A. B', 'A.1.5', 'A.1e3', 'A[1', 'A+B', 'A.Local:1', '(A)', 'A[]'])('%j is not a tag path', (src) => {
    expect(() => parseTagPath(src)).toThrow(ParseError);
  });
});

describe('parseLiteral', () => {
  it.each<[string, number, boolean]>([
    ['5', 5, false],
    ['-2.5', -2.5, true],
    ['+3', 3, false],
    ['16#FF', 255, false],
    ['-16#1', -1, false],
    ['1_000', 1000, false],
    ['1.5e3', 1500, true],
    ['  7 ', 7, false],
    ['0', 0, false],
    ['2147483648', 2147483648, false],
  ])('%j -> %s', (src, value, isReal) => {
    expect(parseLiteral(src)).toEqual({ value, isReal });
  });

  it.each(['abc', '5abc', 'S:FS', '', '   ', '1.5.3', '16#', '--5', 'Arr[1]', '1+2', 'TRUE'])('%j is not a literal', (src) => {
    expect(parseLiteral(src)).toBeNull();
  });
});

// ============================================================================ compileExpr typing

describe('compileExpr: result classes', () => {
  const e = makeEnv([T('D', 'DINT'), T('S', 'SINT'), T('I', 'INT'), T('B', 'BOOL'), T('B2', 'BOOL'), T('R', 'REAL')]);
  it.each([
    ['1+2', 'DINT'],
    ['1+2.0', 'REAL'],
    ['D', 'DINT'],
    ['S', 'DINT'],
    ['I', 'DINT'],
    ['B', 'BOOL'],
    ['R', 'REAL'],
    ['D + S + I', 'DINT'],
    ['D + R', 'REAL'],
    ['D + B', 'DINT'],
    ['D / 2', 'DINT'],
    ['D / 2.0', 'REAL'],
    ['D = 1', 'BOOL'],
    ['R > D', 'BOOL'],
    ['B AND B2', 'BOOL'],
    ['B OR B2', 'BOOL'],
    ['D AND 1', 'DINT'],
    ['NOT B', 'BOOL'],
    ['NOT D', 'DINT'],
    ['-B', 'DINT'],
    ['-R', 'REAL'],
    ['SIN(D)', 'REAL'],
    ['SQR(16)', 'REAL'],
    ['ABS(D)', 'DINT'],
    ['ABS(R)', 'REAL'],
    ['TRN(R)', 'DINT'],
    ['FRD(D)', 'DINT'],
    ['TOD(D)', 'DINT'],
    ['D ** 2', 'DINT'],
    ['D ** 2.0', 'REAL'],
    ['TRUE', 'BOOL'],
  ])('%s is %s', (src, cls) => {
    expect(e.cls(src)).toBe(cls);
  });
});

describe('compileExpr: integer and REAL arithmetic', () => {
  it.each<[string, number]>([
    ['7 / 2', 3],
    ['-7 / 2', -3],
    ['7 / -2', -3],
    ['-7 / -2', 3],
    ['1 / 3', 0],
    ['7 MOD 3', 1],
    ['-7 MOD 3', -1],
    ['7 MOD -3', 1],
    ['-7 MOD -3', -1],
    ['2 ** 10', 1024],
    ['(-2) ** 3', -8],
    ['10 - 4 - 3', 3],
    ['2 * 3 ** 2', 18],
    ['-2 ** 2', -4],
    ['1 + 2 * 3 - 4 / 2', 5],
    ['16#FF + 1', 256],
  ])('constant %s = %s', (src, expected) => {
    expect(makeEnv().ev(src)).toBe(expected);
  });

  it('integer division truncates toward zero with tag operands', () => {
    const e = makeEnv([T('A', 'DINT', -7), T('B', 'DINT', 2)]);
    expect(e.ev('A / B')).toBe(-3);
    e.set('A', 7);
    expect(e.ev('A / B')).toBe(3);
    e.set('B', -4);
    expect(e.ev('A / B')).toBe(-1);
  });

  it('REAL division and MOD', () => {
    const e = makeEnv([T('D', 'DINT', 7), T('R', 'REAL', 2)]);
    expect(e.ev('7.0 / 2')).toBe(3.5);
    expect(e.ev('7 / 2.0')).toBe(3.5);
    expect(e.ev('D / R')).toBe(3.5);
    expect(e.ev('7.5 MOD 2')).toBe(1.5);
    expect(e.ev('-7.5 MOD 2')).toBe(-1.5);
    expect(e.ev('7.5 MOD -2')).toBe(1.5);
  });

  it('MOD of DINT_MIN by -1 is 0 (not -0)', () => {
    const e = makeEnv([T('A', 'DINT', DINT_MIN), T('B', 'DINT', -1)]);
    expect(Object.is(e.ev('A MOD B'), 0)).toBe(true);
  });

  it('REAL arithmetic is single precision', () => {
    const e = makeEnv([T('R', 'REAL', 16777216)]);
    const sum = e.ev('0.1 + 0.2');
    expect(sum).toBe(Math.fround(Math.fround(0.1) + Math.fround(0.2)));
    expect(sum).not.toBe(0.1 + 0.2);
    expect(e.ev('R + 1.0')).toBe(16777216);
    expect(e.ev('1.0 / 3.0')).toBe(Math.fround(1 / 3));
    expect(e.ev('2.0 ** 0.5')).toBe(Math.fround(Math.SQRT2));
  });

  it('SINT / INT operands are promoted to DINT (no intermediate overflow)', () => {
    const e = makeEnv([T('S', 'SINT', 127), T('I', 'INT', 32767)]);
    expect(e.ev('S + 1')).toBe(128);
    expect(e.ev('I * 2')).toBe(65534);
    expect(e.rt.status.V).toBe(0);
    expect(e.rt.minorFaults).toHaveLength(0);
  });

  it('BOOL operands count as 0 / 1 in arithmetic', () => {
    const e = makeEnv([T('B', 'BOOL', 1), T('D', 'DINT', 5)]);
    expect(e.ev('D + B')).toBe(6);
    expect(e.ev('-B')).toBe(-1);
    expect(e.ev('TRUE + 1')).toBe(2);
  });
});

describe('compileExpr: comparisons', () => {
  it.each<[string, number]>([
    ['1 = 1.0', 1],
    ['2 > 1.5', 1],
    ['-1 < 0', 1],
    ['3 >= 3', 1],
    ['3 <= 2', 0],
    ['3 <> 3', 0],
    ['0.1 = 0.1', 1],
    ['TRUE = 1', 1],
    ['FALSE <> 0', 0],
  ])('%s = %s', (src, expected) => {
    expect(makeEnv().ev(src)).toBe(expected);
  });

  it('mixed DINT/REAL comparisons convert the DINT to REAL first', () => {
    const e = makeEnv([T('D', 'DINT', 16777217), T('R', 'REAL', 16777216), T('F', 'REAL', 0.1), T('B', 'BOOL', 1)]);
    expect(e.ev('D = R')).toBe(1);
    expect(e.ev('D > R')).toBe(0);
    expect(e.ev('F = 0.1')).toBe(1);
    expect(e.ev('F <> 0.1')).toBe(0);
    expect(e.ev('B = 1')).toBe(1);
    expect(e.ev('B > 0.5')).toBe(1);
  });
});

describe('compileExpr: logical vs bitwise', () => {
  it('AND/OR/XOR/NOT are bitwise on integers', () => {
    const e = makeEnv([T('D', 'DINT', -1)]);
    expect(e.ev('5 AND 3')).toBe(1);
    expect(e.ev('5 OR 3')).toBe(7);
    expect(e.ev('5 XOR 3')).toBe(6);
    expect(e.ev('5 & 3')).toBe(1);
    expect(e.ev('NOT 5')).toBe(-6);
    expect(e.ev('NOT 0')).toBe(-1);
    expect(e.ev('16#FF00 AND 16#0FF0')).toBe(0x0f00);
    expect(e.ev('D AND 16#FF')).toBe(255);
    expect(e.ev('D XOR 16#FFFFFFFF')).toBe(0);
    expect(e.ev('NOT D')).toBe(0);
  });

  it('AND/OR/XOR/NOT are logical on BOOL', () => {
    const e = makeEnv([T('B1', 'BOOL', 1), T('B0', 'BOOL', 0)]);
    expect(e.ev('B1 AND B0')).toBe(0);
    expect(e.ev('B1 AND B1')).toBe(1);
    expect(e.ev('B1 OR B0')).toBe(1);
    expect(e.ev('B0 OR B0')).toBe(0);
    expect(e.ev('B1 XOR B1')).toBe(0);
    expect(e.ev('B1 XOR B0')).toBe(1);
    expect(e.ev('NOT B1')).toBe(0);
    expect(e.ev('NOT B0')).toBe(1);
    expect(e.ev('TRUE XOR FALSE')).toBe(1);
    expect(e.ev('NOT (B1 AND B0) AND B1')).toBe(1);
    expect(e.ev('(1 < 2) AND (3 > 2)')).toBe(1);
  });

  it('logical operators do not short-circuit: both sides are evaluated', () => {
    const e = makeEnv([T('B0', 'BOOL', 0), T('B1', 'BOOL', 1), T('Arr', 'DINT', undefined, [2]), T('Idx', 'DINT', 5)]);
    errorFree(e, 'B0 AND (Arr[Idx] = 1)');
    expect(majorFault(() => e.ev('B0 AND (Arr[Idx] = 1)')).code).toBe(20);
    expect(majorFault(() => e.ev('B1 OR (Arr[Idx] = 1)')).code).toBe(20);
  });

  it('REAL operands are rejected by AND / OR / XOR / NOT', () => {
    const e = makeEnv([T('R', 'REAL')]);
    expect(e.fails('R AND 1')).toMatch(/AND requires BOOL or integer operands/);
    expect(e.fails('1.5 OR 2')).toMatch(/OR requires BOOL or integer operands/);
    expect(e.fails('R XOR R')).toMatch(/XOR requires/);
    expect(e.fails('NOT R')).toMatch(/NOT requires a BOOL or integer operand/);
  });
});

function errorFree(e: Env, src: string): void {
  e.errors.length = 0;
  e.compile(src);
  expect(e.errors).toEqual([]);
}

describe('compileExpr: functions', () => {
  it.each<[string, number]>([
    ['ABS(-5)', 5],
    ['ABS(5)', 5],
    ['ABS(-2.5)', 2.5],
    ['SQR(16)', 4],
    ['SQR(-16)', 4],
    ['SQRT(2.0)', Math.fround(Math.SQRT2)],
    ['SIN(0)', 0],
    ['COS(0)', 1],
    ['TRN(2.7)', 2],
    ['TRN(-2.7)', -2],
    ['TRN(5)', 5],
    ['FRD(16#1234)', 1234],
    ['FRD(0)', 0],
    ['TOD(1234)', 0x1234],
    ['TOD(0)', 0],
    ['TOD(FRD(16#9876))', 0x9876],
    ['DEG(0)', 0],
    ['LN(1)', 0],
    ['LOG(100)', 2],
  ])('%s = %s', (src, expected) => {
    expect(makeEnv().ev(src)).toBe(expected);
  });

  it('trigonometry is single precision', () => {
    const e = makeEnv([T('R', 'REAL', Math.PI / 2)]);
    expect(e.ev('SIN(R)')).toBe(Math.fround(Math.sin(Math.fround(Math.PI / 2))));
    expect(e.ev('ATN(1.0)')).toBe(Math.fround(Math.PI / 4));
  });

  it('unknown functions and wrong argument counts are errors', () => {
    const e = makeEnv();
    expect(e.fails('FOO(1)')).toMatch(/Unknown function 'FOO'/);
    expect(e.fails('ABS(1, 2)')).toMatch(/ABS expects 1 argument/);
    expect(e.fails('SIN()')).toMatch(/SIN expects 1 argument/);
  });

  it('ABS(DINT_MIN) overflows', () => {
    const e = makeEnv([T('D', 'DINT', DINT_MIN)]);
    expect(e.ev('ABS(D)')).toBe(DINT_MIN);
    expect(e.rt.status.V).toBe(1);
    expect(e.rt.minorFaults[0]).toMatchObject({ type: 4, code: 4 });
  });
});

describe('compileExpr: overflow, faults and errors', () => {
  it('DINT overflow wraps, sets S:V and logs a minor fault', () => {
    const e = makeEnv([T('D', 'DINT', DINT_MAX)]);
    expect(e.rt.status.V).toBe(0);
    expect(e.ev('D + 1')).toBe(DINT_MIN);
    expect(e.rt.status.V).toBe(1);
    expect(e.rt.status.MINOR).toBe(1);
    expect(e.rt.minorFaults).toHaveLength(1);
    expect(e.rt.minorFaults[0]).toMatchObject({ type: 4, code: 4, major: false });
  });

  it.each<[string, number, number]>([
    ['D * 2', DINT_MAX, -2],
    ['D * D', 65536, 0],
    ['D - 1', DINT_MIN, DINT_MAX],
    ['-D', DINT_MIN, DINT_MIN],
    ['D / -1', DINT_MIN, DINT_MIN],
    ['D ** 2', 65536, 0],
    ['2 ** D', 31, DINT_MIN],
  ])('%s with D=%s overflows to %s', (src, d, expected) => {
    const e = makeEnv([T('D', 'DINT', d)]);
    expect(e.ev(src)).toBe(expected);
    expect(e.rt.status.V).toBe(1);
    expect(e.rt.minorFaults.length).toBeGreaterThan(0);
  });

  it('no overflow leaves S:V clear and logs nothing', () => {
    const e = makeEnv([T('D', 'DINT', DINT_MAX - 1)]);
    expect(e.ev('D + 1')).toBe(DINT_MAX);
    expect(e.ev('-D')).toBe(-(DINT_MAX - 1));
    expect(e.rt.status.V).toBe(0);
    expect(e.rt.minorFaults).toHaveLength(0);
  });

  it('integer ** overflowing past the double range still wraps (no internal error)', () => {
    const e = makeEnv([T('Base', 'DINT', 10), T('Exp', 'DINT', 400)]);
    let v = NaN;
    expect(() => {
      v = e.ev('Base ** Exp');
    }).not.toThrow();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(DINT_MIN);
    expect(v).toBeLessThanOrEqual(DINT_MAX);
    expect(e.rt.status.V).toBe(1);
    expect(e.rt.minorFaults[0]).toMatchObject({ type: 4, code: 4 });
  });

  it('TRN of a non-finite REAL gives a DINT and flags overflow (no internal error)', () => {
    const e = makeEnv([T('R', 'REAL')]);
    for (const x of [Infinity, -Infinity, NaN]) {
      e.set('R', x);
      e.rt.status.V = 0;
      let v = 0.5;
      expect(() => {
        v = e.ev('TRN(R)');
      }, String(x)).not.toThrow();
      expect(Number.isInteger(v), String(x)).toBe(true);
      expect(e.rt.status.V, String(x)).toBe(1);
    }
  });

  it('constant folding has no side effects at compile time; overflow is flagged when evaluated', () => {
    const e = makeEnv();
    e.errors.length = 0;
    const ce = e.compile('2147483647 + 1');
    expect(e.errors).toEqual([]);
    // compiling (Verify / Download) must not touch the status flags or the fault log
    expect(e.rt.status.V).toBe(0);
    expect(e.rt.status.MINOR).toBe(0);
    expect(e.rt.minorFaults).toHaveLength(0);
    // each evaluation behaves like the run-time operation
    expect(ce.eval()).toBe(DINT_MIN);
    expect(e.rt.status.V).toBe(1);
    expect(e.rt.minorFaults).toHaveLength(1);
  });

  it('constant expressions fold to a constant value', () => {
    const e = makeEnv([T('A', 'DINT')]);
    expect(e.compile('2 + 3 * 4').constValue).toBe(14);
    expect(e.compile('ABS(-2.5)').constValue).toBe(2.5);
    expect(e.compile('A + 1').constValue).toBeUndefined();
  });

  it('divide by zero is a major fault (DINT, REAL, MOD)', () => {
    const e = makeEnv([T('D', 'DINT', 5), T('Z', 'DINT', 0), T('R', 'REAL', 1.5), T('RZ', 'REAL', 0)]);
    for (const src of ['D / Z', 'D MOD Z', 'R / RZ', 'R / 0.0', 'R MOD RZ', 'D / RZ']) {
      const f = majorFault(() => e.ev(src));
      expect([f.type, f.code], src).toEqual([4, 4]);
      expect(f.message, src).toMatch(/divide by zero/);
    }
  });

  it('a constant divide by zero compiles, and faults when evaluated', () => {
    const e = makeEnv();
    e.errors.length = 0;
    const ce = e.compile('1 / 0');
    expect(e.errors).toEqual([]);
    expect(ce.constValue).toBeUndefined();
    expect(majorFault(() => ce.eval()).code).toBe(4);
  });

  it('integer literals must fit in a DINT', () => {
    const e = makeEnv();
    expect(e.fails('2147483648')).toMatch(/out of DINT range/);
    expect(e.fails('1 + 3000000000')).toMatch(/out of DINT range/);
    expect(e.ev('-2147483648')).toBe(DINT_MIN);
    expect(e.ev('16#FFFFFFFF')).toBe(-1);
    expect(e.ev('3000000000.0')).toBe(Math.fround(3e9));
  });

  it('references must be atomic and defined', () => {
    const e = makeEnv([T('Tm', 'TIMER'), T('Arr', 'DINT', undefined, [3]), T('D', 'DINT')]);
    expect(e.fails('Tm + 1')).toMatch(/'Tm' is a TIMER; an atomic value is required/);
    expect(e.fails('Arr * 2')).toMatch(/'Arr' is a DINT array/);
    expect(e.fails('Nope + 1')).toMatch(/Undefined tag 'Nope'/);
    expect(e.ev('Tm.PRE + 1')).toBe(1);
  });

  it('collects the atomic refs it reads', () => {
    const e = makeEnv([T('A', 'DINT'), T('B', 'DINT'), T('C', 'REAL')]);
    const ce = e.compile('A + B * C - ABS(A)');
    expect(ce.refs.map((r) => r.canonical)).toEqual(['A', 'B', 'C', 'A']);
  });

  it('subscript expressions inside an expression', () => {
    const e = makeEnv([T('Arr', 'DINT', [10, 20, 30, 40], [4]), T('Idx', 'DINT', 1)]);
    expect(e.ev('Arr[Idx + 1] * 2')).toBe(60);
    expect(e.ev('Arr[Idx] + Arr[Idx * 3]')).toBe(60);
    e.set('Idx', 3);
    expect(majorFault(() => e.ev('Arr[Idx + 1]')).code).toBe(20);
  });

  it('status flags and module paths are usable in expressions', () => {
    const e = makeEnv([T('D', 'DINT', 2)]);
    e.rt.status.Z = 1;
    expect(e.ev('S:Z + D')).toBe(3);
    expect(e.cls('S:Z')).toBe('BOOL');
  });
});
