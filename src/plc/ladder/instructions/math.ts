/**
 * Compute/Math instructions: ADD, SUB, MUL, DIV, MOD, NEG, ABS, SQR, CPT.
 *
 * All are output box instructions that execute only while rung-condition-in is
 * true (a false rung leaves the destination and the status flags untouched) and
 * pass rung-condition-in through.
 *
 * Data types:
 *  - If any source or the destination is REAL, the operation is done in single
 *    precision: integer operands are converted to REAL first and the result is
 *    rounded to REAL before it is stored (a REAL result stored into an integer
 *    destination rounds half to even).
 *  - Otherwise the operation is done in DINT with 32-bit wrap-around; an exact
 *    result outside the DINT range is an overflow.
 *  - The result is stored with Logix conversion; a value that does not fit the
 *    destination (e.g. 200 into a SINT) keeps the low bits and is an overflow.
 *  - S:Z / S:N reflect the stored value, S:V the overflow; an overflow also logs
 *    a minor fault (Type 4 Code 4).
 *  - DIV / MOD by zero is a major fault (Type 4 Code 4; LogixSim promotes it).
 *
 * CPT evaluates its expression with the expression compiler's typing rules
 * (DINT unless an operand is REAL, integer division truncates), then stores the
 * result with conversion.
 */
import type { AtomicRef } from '../../core/refs';
import type { Runtime } from '../../core/runtime';
import { FAULT } from '../../core/faults';
import type { Expr } from '../../expr/ast';
import { parseExpression } from '../../expr/parser';
import { isMissingOperand } from '../ast';
import type { Executable, InstrCompiler, InstructionDef, OperandSpec } from './registry';

type Getter = () => number;
/** Binary operation. Integer variants receive DINT values and return the wrapped DINT result. */
type BinFn = (a: number, b: number, rt: Runtime) => number;
type UnFn = (a: number) => number;

/**
 * Set by the integer operations when the exact result is outside the DINT
 * range. Reset before each integer operation (module-level to keep the hot path
 * allocation-free; execution is single-threaded).
 */
let intOverflow = false;

const isReal = (r: AtomicRef) => r.atype === 'REAL';

/**
 * Getter returning the operand converted to REAL. SINT/INT values and REAL
 * values are already exact single-precision numbers; only DINT needs rounding.
 */
function realGetter(r: AtomicRef): Getter {
  const g = r.get;
  if (r.atype !== 'DINT') return g;
  if (r.isConst) {
    const v = Math.fround(g());
    return () => v;
  }
  return () => Math.fround(g());
}

/** True when a REAL result is out of range (infinite) or not a number. */
const notFinite = (f: number) => f - f !== 0;

// ----------------------------------------------------------------------------- integer operations

const intAdd: BinFn = (a, b) => {
  const r = a + b;
  const w = r | 0;
  if (w !== r) intOverflow = true;
  return w;
};

const intSub: BinFn = (a, b) => {
  const r = a - b;
  const w = r | 0;
  if (w !== r) intOverflow = true;
  return w;
};

const intMul: BinFn = (a, b) => {
  const r = a * b;
  const w = Math.imul(a, b);
  // r may be inexact above 2^53, but then it is far outside the DINT range anyway
  if (w !== r) intOverflow = true;
  return w;
};

const intDiv: BinFn = (a, b, rt) => {
  if (b === 0) rt.majorFault(FAULT.DIVIDE_BY_ZERO);
  // truncate toward zero; only DINT_MIN / -1 is out of range
  const q = Math.trunc(a / b);
  const w = q | 0;
  if (w !== q) intOverflow = true;
  return w;
};

const intMod: BinFn = (a, b, rt) => {
  if (b === 0) rt.majorFault(FAULT.DIVIDE_BY_ZERO);
  // remainder takes the sign of the dividend; `| 0` also turns -0 into 0
  return (a % b) | 0;
};

const intNeg: UnFn = (a) => {
  const r = 0 - a;
  const w = r | 0;
  if (w !== r) intOverflow = true;
  return w;
};

const intAbs: UnFn = (a) => {
  const r = a < 0 ? 0 - a : a;
  const w = r | 0;
  if (w !== r) intOverflow = true;
  return w;
};

/** Square root of an integer: the (fractional) result is rounded by the store. */
const intSqr: UnFn = (a) => Math.sqrt(Math.abs(a));

// ----------------------------------------------------------------------------- REAL operations (operands already REAL)

const realAdd: BinFn = (a, b) => a + b;
const realSub: BinFn = (a, b) => a - b;
const realMul: BinFn = (a, b) => a * b;
const realDiv: BinFn = (a, b, rt) => {
  if (b === 0) rt.majorFault(FAULT.DIVIDE_BY_ZERO);
  return a / b;
};
const realMod: BinFn = (a, b, rt) => {
  if (b === 0) rt.majorFault(FAULT.DIVIDE_BY_ZERO);
  return a - b * Math.trunc(a / b);
};
const realNeg: UnFn = (a) => -a;
const realAbs: UnFn = (a) => Math.abs(a);
const realSqr: UnFn = (a) => Math.sqrt(Math.abs(a));

// ----------------------------------------------------------------------------- executables

function binaryExec(c: InstrCompiler, intOp: BinFn, realOp: BinFn): Executable {
  const a = c.source(0);
  const b = c.source(1);
  const d = c.dest(2);
  const rt = c.rt;
  const set = d.set;
  const get = d.get;
  if (isReal(a) || isReal(b) || isReal(d)) {
    const ga = realGetter(a);
    const gb = realGetter(b);
    return {
      exec(rin) {
        if (rin) {
          const f = Math.fround(realOp(ga(), gb(), rt));
          const ov = set(f);
          rt.setArith(get(), ov || notFinite(f));
        }
        return rin;
      },
    };
  }
  const ga = a.get;
  const gb = b.get;
  return {
    exec(rin) {
      if (rin) {
        intOverflow = false;
        const r = intOp(ga(), gb(), rt);
        const ov = set(r) || intOverflow;
        rt.setArith(get(), ov);
      }
      return rin;
    },
  };
}

function unaryExec(c: InstrCompiler, intOp: UnFn, realOp: UnFn): Executable {
  const s = c.source(0);
  const d = c.dest(1);
  const rt = c.rt;
  const set = d.set;
  const get = d.get;
  if (isReal(s) || isReal(d)) {
    const gs = realGetter(s);
    return {
      exec(rin) {
        if (rin) {
          const f = Math.fround(realOp(gs()));
          const ov = set(f);
          rt.setArith(get(), ov || notFinite(f));
        }
        return rin;
      },
    };
  }
  const gs = s.get;
  return {
    exec(rin) {
      if (rin) {
        intOverflow = false;
        const r = intOp(gs());
        const ov = set(r) || intOverflow;
        rt.setArith(get(), ov);
      }
      return rin;
    },
  };
}

const COMPARISON_OPS = new Set(['=', '<>', '<', '<=', '>', '>=']);

/** First comparison operator used in an expression (not valid in CPT), or null. */
function findComparison(e: Expr): string | null {
  switch (e.kind) {
    case 'binary':
      if (COMPARISON_OPS.has(e.op)) return e.op;
      return findComparison(e.left) ?? findComparison(e.right);
    case 'unary':
      return findComparison(e.arg);
    case 'call':
      for (const a of e.args) {
        const f = findComparison(a);
        if (f) return f;
      }
      return null;
    default:
      return null;
  }
}

function cptExec(c: InstrCompiler): Executable {
  const d = c.dest(0);
  const e = c.expression(1);
  const text = c.operands[1];
  if (!isMissingOperand(text)) {
    let ast: Expr | null = null;
    try {
      ast = parseExpression(text);
    } catch {
      // parse errors were already reported by c.expression
    }
    const op = ast && findComparison(ast);
    if (op) c.error(1, `Operator '${op}' is not allowed in a CPT expression (use CMP for comparisons)`);
  }
  const rt = c.rt;
  const st = rt.status;
  const ev = e.eval;
  const set = d.set;
  const get = d.get;
  return {
    exec(rin) {
      if (rin) {
        // the expression sets S:V (and logs the minor fault) on intermediate DINT overflow
        st.V = 0;
        const v = ev();
        const exprOverflow = st.V === 1;
        const ov = set(v) || notFinite(v);
        const r = get();
        if (exprOverflow) {
          // already logged by the expression: update the flags without a second log entry
          st.Z = r === 0 ? 1 : 0;
          st.N = r < 0 ? 1 : 0;
          st.V = 1;
        } else rt.setArith(r, ov);
      }
      return rin;
    },
  };
}

// ----------------------------------------------------------------------------- definitions

const BIN_OPERANDS: OperandSpec[] = [
  { name: 'Source A', kind: 'source' },
  { name: 'Source B', kind: 'source' },
  { name: 'Dest', kind: 'dest' },
];

const UN_OPERANDS: OperandSpec[] = [
  { name: 'Source', kind: 'source' },
  { name: 'Dest', kind: 'dest' },
];

function binary(mnemonic: string, title: string, intOp: BinFn, realOp: BinFn): InstructionDef {
  return {
    mnemonic,
    category: 'Compute/Math',
    title,
    kind: 'output',
    box: true,
    operands: BIN_OPERANDS,
    compile: (c) => binaryExec(c, intOp, realOp),
  };
}

function unary(mnemonic: string, title: string, intOp: UnFn, realOp: UnFn): InstructionDef {
  return {
    mnemonic,
    category: 'Compute/Math',
    title,
    kind: 'output',
    box: true,
    operands: UN_OPERANDS,
    compile: (c) => unaryExec(c, intOp, realOp),
  };
}

export const mathInstructions: InstructionDef[] = [
  binary('ADD', 'Add', intAdd, realAdd),
  binary('SUB', 'Subtract', intSub, realSub),
  binary('MUL', 'Multiply', intMul, realMul),
  binary('DIV', 'Divide', intDiv, realDiv),
  binary('MOD', 'Modulo', intMod, realMod),
  unary('NEG', 'Negate', intNeg, realNeg),
  unary('ABS', 'Absolute Value', intAbs, realAbs),
  unary('SQR', 'Square Root', intSqr, realSqr),
  {
    mnemonic: 'CPT',
    category: 'Compute/Math',
    title: 'Compute',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Dest', kind: 'dest' },
      { name: 'Expression', kind: 'expression' },
    ],
    compile: cptExec,
  },
];
