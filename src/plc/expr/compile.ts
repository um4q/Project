/**
 * Expression compiler: AST -> closure, with Logix typing rules.
 *
 *  - Integer operands (BOOL/SINT/INT/DINT) are evaluated as DINT with 32-bit
 *    wrap-around (overflow sets S:V and logs a minor fault).
 *  - If either operand is REAL the operation is done in single precision.
 *  - Integer division truncates toward zero. Divide by zero is a major fault
 *    (LogixSim spec), as is MOD by zero.
 *  - Comparisons yield BOOL. AND/OR/XOR/NOT are logical on BOOL and bitwise on
 *    integers; REAL operands are a verify error.
 */
import type { Expr, TagPath } from './ast';
import { DINT_MAX, DINT_MIN } from '../core/values';
import { FAULT } from '../core/faults';
import type { Runtime } from '../core/runtime';
import type { AtomicRef, RefResult } from '../core/refs';

export type ExprClass = 'BOOL' | 'DINT' | 'REAL';

export interface CompiledExpr {
  cls: ExprClass;
  eval: () => number;
  /** Constant value if the expression has no tag references */
  constValue?: number;
  /** Atomic refs read by this expression (for online display / cross reference) */
  refs: AtomicRef[];
}

export interface ExprEnv {
  rt: Runtime;
  /** Resolve a tag reference. */
  resolve(path: TagPath, text: string, pos: number): RefResult;
  /** Report a compile error at a source position. */
  error(message: string, pos: number): void;
}

const err = (env: ExprEnv, msg: string, pos: number): CompiledExpr => {
  env.error(msg, pos);
  return { cls: 'DINT', eval: () => 0, constValue: 0, refs: [] };
};

function classOf(t: string): ExprClass {
  return t === 'BOOL' ? 'BOOL' : t === 'REAL' ? 'REAL' : 'DINT';
}

/** Integer overflow handling for DINT math. */
function intResult(rt: Runtime, r: number): number {
  if (r > DINT_MAX || r < DINT_MIN) {
    rt.status.V = 1;
    rt.minorFault(FAULT.ARITH_OVERFLOW);
    return Number(BigInt.asIntN(32, BigInt(Math.trunc(r))));
  }
  return r;
}

type Fn = () => number;

interface FuncDef {
  args: number;
  /** result class given argument classes */
  result: (cls: ExprClass[]) => ExprClass;
  make: (rt: Runtime, args: Fn[], cls: ExprClass[]) => Fn;
}

const real1 = (f: (x: number) => number): FuncDef => ({
  args: 1,
  result: () => 'REAL',
  make: (_rt, [a]) => () => Math.fround(f(a())),
});

const FUNCS: Record<string, FuncDef> = {
  ABS: {
    args: 1,
    result: ([c]) => (c === 'REAL' ? 'REAL' : 'DINT'),
    make: (rt, [a], [c]) => (c === 'REAL' ? () => Math.abs(a()) : () => intResult(rt, Math.abs(a()))),
  },
  SQR: real1((x) => Math.sqrt(Math.abs(x))),
  SQRT: real1((x) => Math.sqrt(Math.abs(x))),
  SIN: real1(Math.sin),
  COS: real1(Math.cos),
  TAN: real1(Math.tan),
  ASN: real1(Math.asin),
  ASIN: real1(Math.asin),
  ACS: real1(Math.acos),
  ACOS: real1(Math.acos),
  ATN: real1(Math.atan),
  ATAN: real1(Math.atan),
  LN: real1(Math.log),
  LOG: real1(Math.log10),
  DEG: real1((x) => (x * 180) / Math.PI),
  RAD: real1((x) => (x * Math.PI) / 180),
  TRN: { args: 1, result: () => 'DINT', make: (rt, [a]) => () => intResult(rt, Math.trunc(a())) },
  TRUNC: { args: 1, result: () => 'DINT', make: (rt, [a]) => () => intResult(rt, Math.trunc(a())) },
  // BCD conversions
  FRD: {
    args: 1,
    result: () => 'DINT',
    make: (_rt, [a]) => () => {
      let v = a() | 0;
      let out = 0;
      let mul = 1;
      while (v > 0) {
        out += (v & 0xf) * mul;
        mul *= 10;
        v >>>= 4;
      }
      return out | 0;
    },
  },
  TOD: {
    args: 1,
    result: () => 'DINT',
    make: (_rt, [a]) => () => {
      let v = Math.abs(a() | 0);
      let out = 0;
      let shift = 0;
      while (v > 0 && shift < 32) {
        out |= (v % 10) << shift;
        v = Math.floor(v / 10);
        shift += 4;
      }
      return out | 0;
    },
  },
};

export function knownFunction(name: string): boolean {
  return name.toUpperCase() in FUNCS;
}

export function compileExpr(e: Expr, env: ExprEnv): CompiledExpr {
  const rt = env.rt;
  switch (e.kind) {
    case 'num': {
      const v = e.isReal ? Math.fround(e.value) : e.value;
      if (!e.isReal && (v > DINT_MAX || v < DINT_MIN)) return err(env, `Integer literal ${e.value} is out of DINT range`, e.pos);
      return { cls: e.isReal ? 'REAL' : 'DINT', eval: () => v, constValue: v, refs: [] };
    }
    case 'bool': {
      const v = e.value ? 1 : 0;
      return { cls: 'BOOL', eval: () => v, constValue: v, refs: [] };
    }
    case 'ref': {
      const r = env.resolve(e.path, e.text, e.pos);
      if ('error' in r) return err(env, r.error, e.pos);
      if (r.kind !== 'atomic') return err(env, `'${e.text}' is a ${r.info.type.name}${r.kind === 'array' ? ' array' : ''}; an atomic value is required`, e.pos);
      return { cls: classOf(r.atype), eval: r.get, refs: [r] };
    }
    case 'call': {
      const def = FUNCS[e.name.toUpperCase()];
      if (!def) return err(env, `Unknown function '${e.name}'`, e.pos);
      if (e.args.length !== def.args) return err(env, `${e.name} expects ${def.args} argument(s)`, e.pos);
      const args = e.args.map((a) => compileExpr(a, env));
      const cls = args.map((a) => a.cls);
      const f = def.make(rt, args.map((a) => a.eval), cls);
      return finish(def.result(cls), f, args);
    }
    case 'unary': {
      const a = compileExpr(e.arg, env);
      const fa = a.eval;
      if (e.op === 'NOT') {
        if (a.cls === 'REAL') return err(env, 'NOT requires a BOOL or integer operand', e.pos);
        if (a.cls === 'BOOL') return finish('BOOL', () => (fa() ? 0 : 1), [a]);
        return finish('DINT', () => ~fa(), [a]);
      }
      if (a.cls === 'REAL') return finish('REAL', () => Math.fround(-fa()), [a]);
      return finish('DINT', () => intResult(rt, -fa()), [a]);
    }
    case 'binary': {
      const l = compileExpr(e.left, env);
      const r = compileExpr(e.right, env);
      const fl = l.eval;
      const fr = r.eval;
      const anyReal = l.cls === 'REAL' || r.cls === 'REAL';
      switch (e.op) {
        case '+':
          return anyReal ? finish('REAL', () => Math.fround(fl() + fr()), [l, r]) : finish('DINT', () => intResult(rt, fl() + fr()), [l, r]);
        case '-':
          return anyReal ? finish('REAL', () => Math.fround(fl() - fr()), [l, r]) : finish('DINT', () => intResult(rt, fl() - fr()), [l, r]);
        case '*':
          return anyReal
            ? finish('REAL', () => Math.fround(fl() * fr()), [l, r])
            : finish('DINT', () => {
                const a = fl();
                const b = fr();
                const p = a * b;
                if (p > DINT_MAX || p < DINT_MIN) {
                  rt.status.V = 1;
                  rt.minorFault(FAULT.ARITH_OVERFLOW);
                  return Math.imul(a, b);
                }
                return p;
              }, [l, r]);
        case '/':
          return anyReal
            ? finish('REAL', () => {
                const b = fr();
                if (b === 0) rt.majorFault(FAULT.DIVIDE_BY_ZERO);
                return Math.fround(fl() / b);
              }, [l, r])
            : finish('DINT', () => {
                const a = fl();
                const b = fr();
                if (b === 0) rt.majorFault(FAULT.DIVIDE_BY_ZERO);
                return intResult(rt, Math.trunc(a / b));
              }, [l, r]);
        case 'MOD':
          return anyReal
            ? finish('REAL', () => {
                const a = fl();
                const b = fr();
                if (b === 0) rt.majorFault(FAULT.DIVIDE_BY_ZERO);
                return Math.fround(a - b * Math.trunc(a / b));
              }, [l, r])
            : finish('DINT', () => {
                const a = fl();
                const b = fr();
                if (b === 0) rt.majorFault(FAULT.DIVIDE_BY_ZERO);
                return (a % b) | 0;
              }, [l, r]);
        case '**':
          return anyReal
            ? finish('REAL', () => Math.fround(Math.pow(fl(), fr())), [l, r])
            : finish('DINT', () => intResult(rt, Math.trunc(Math.pow(fl(), fr()))), [l, r]);
        case '=':
        case '<>':
        case '<':
        case '<=':
        case '>':
        case '>=': {
          // mixed integer/REAL comparisons convert the integer to REAL first
          const a = anyReal && l.cls !== 'REAL' ? () => Math.fround(fl()) : fl;
          const b = anyReal && r.cls !== 'REAL' ? () => Math.fround(fr()) : fr;
          const f =
            e.op === '='
              ? () => (a() === b() ? 1 : 0)
              : e.op === '<>'
                ? () => (a() !== b() ? 1 : 0)
                : e.op === '<'
                  ? () => (a() < b() ? 1 : 0)
                  : e.op === '<='
                    ? () => (a() <= b() ? 1 : 0)
                    : e.op === '>'
                      ? () => (a() > b() ? 1 : 0)
                      : () => (a() >= b() ? 1 : 0);
          return finish('BOOL', f, [l, r]);
        }
        case 'AND':
        case 'OR':
        case 'XOR': {
          if (anyReal) return err(env, `${e.op} requires BOOL or integer operands`, e.pos);
          if (l.cls === 'BOOL' && r.cls === 'BOOL') {
            // both sides are always evaluated (no short-circuit), as in Logix
            const f =
              e.op === 'AND'
                ? () => {
                    const x = fl();
                    const y = fr();
                    return x && y ? 1 : 0;
                  }
                : e.op === 'OR'
                  ? () => {
                      const x = fl();
                      const y = fr();
                      return x || y ? 1 : 0;
                    }
                  : () => (!fl() !== !fr() ? 1 : 0);
            return finish('BOOL', f, [l, r]);
          }
          const f = e.op === 'AND' ? () => fl() & fr() : e.op === 'OR' ? () => fl() | fr() : () => fl() ^ fr();
          return finish('DINT', f, [l, r]);
        }
      }
    }
  }
}

function finish(cls: ExprClass, f: Fn, parts: CompiledExpr[]): CompiledExpr {
  const refs = parts.flatMap((p) => p.refs);
  if (parts.every((p) => p.constValue !== undefined)) {
    // constant fold (errors like divide-by-zero still surface at run time)
    try {
      const v = f();
      return { cls, eval: () => v, constValue: v, refs };
    } catch {
      return { cls, eval: f, refs };
    }
  }
  return { cls, eval: f, refs };
}
