/**
 * Compare instructions: EQU, NEQ, LES, LEQ, GRT, GEQ, LIM, CMP.
 *
 * All are conditional (input) instructions: rung-condition-out is
 * rung-condition-in AND the comparison. Operands are not read at all when the
 * rung-condition-in is false. Compares never change the arithmetic status flags.
 *
 * Data types: when any operand is REAL the comparison is done in single
 * precision (integer operands are converted to REAL first); otherwise the
 * integer values are compared exactly.
 */
import type { AtomicRef } from '../../core/refs';
import type { Executable, InstrCompiler, InstructionDef } from './registry';

type Getter = () => number;
type Exec = (rungIn: boolean) => boolean;

/** A compiled numeric operand: either a constant or a getter, already in the comparison domain. */
type Operand = { isConst: true; value: number; get: Getter } | { isConst: false; value: 0; get: Getter };

/**
 * Bind an operand for a comparison. `asReal` converts an integer operand to
 * REAL (single precision). SINT/INT values are always exactly representable as
 * REAL, so only DINT needs a conversion closure.
 */
function bindOperand(r: AtomicRef, asReal: boolean): Operand {
  const needsFround = asReal && r.atype === 'DINT';
  if (r.isConst) {
    const v = needsFround ? Math.fround(r.get()) : r.get();
    return { isConst: true, value: v, get: () => v };
  }
  const g = r.get;
  return { isConst: false, value: 0, get: needsFround ? () => Math.fround(g()) : g };
}

const isReal = (r: AtomicRef) => r.atype === 'REAL';

type BinOp = 'EQU' | 'NEQ' | 'LES' | 'LEQ' | 'GRT' | 'GEQ';

function constCompare(op: BinOp, a: number, b: number): boolean {
  switch (op) {
    case 'EQU':
      return a === b;
    case 'NEQ':
      return a !== b;
    case 'LES':
      return a < b;
    case 'LEQ':
      return a <= b;
    case 'GRT':
      return a > b;
    case 'GEQ':
      return a >= b;
  }
}

/**
 * Specialized closures per operator and operand shape (tag/tag, tag/const,
 * const/tag) so the hot path is a single getter call plus a primitive compare.
 */
function makeBinary(op: BinOp, a: Operand, b: Operand): Exec {
  if (a.isConst && b.isConst) {
    const k = constCompare(op, a.value, b.value);
    return (rin) => rin && k;
  }
  if (b.isConst) {
    const ga = a.get;
    const kb = b.value;
    switch (op) {
      case 'EQU':
        return (rin) => rin && ga() === kb;
      case 'NEQ':
        return (rin) => rin && ga() !== kb;
      case 'LES':
        return (rin) => rin && ga() < kb;
      case 'LEQ':
        return (rin) => rin && ga() <= kb;
      case 'GRT':
        return (rin) => rin && ga() > kb;
      case 'GEQ':
        return (rin) => rin && ga() >= kb;
    }
  }
  if (a.isConst) {
    const ka = a.value;
    const gb = b.get;
    switch (op) {
      case 'EQU':
        return (rin) => rin && ka === gb();
      case 'NEQ':
        return (rin) => rin && ka !== gb();
      case 'LES':
        return (rin) => rin && ka < gb();
      case 'LEQ':
        return (rin) => rin && ka <= gb();
      case 'GRT':
        return (rin) => rin && ka > gb();
      case 'GEQ':
        return (rin) => rin && ka >= gb();
    }
  }
  const ga = a.get;
  const gb = b.get;
  switch (op) {
    case 'EQU':
      return (rin) => rin && ga() === gb();
    case 'NEQ':
      return (rin) => rin && ga() !== gb();
    case 'LES':
      return (rin) => rin && ga() < gb();
    case 'LEQ':
      return (rin) => rin && ga() <= gb();
    case 'GRT':
      return (rin) => rin && ga() > gb();
    case 'GEQ':
      return (rin) => rin && ga() >= gb();
  }
}

function binaryCompare(mnemonic: BinOp, title: string): InstructionDef {
  return {
    mnemonic,
    category: 'Compare',
    title,
    kind: 'input',
    box: true,
    operands: [
      { name: 'Source A', kind: 'source', description: 'Value to test against Source B' },
      { name: 'Source B', kind: 'source', description: 'Value to test against Source A' },
    ],
    compile(c: InstrCompiler): Executable {
      const ra = c.source(0);
      const rb = c.source(1);
      const asReal = isReal(ra) || isReal(rb);
      return { exec: makeBinary(mnemonic, bindOperand(ra, asReal), bindOperand(rb, asReal)) };
    },
  };
}

function makeLimit(lo: Operand, test: Operand, hi: Operand): Exec {
  const gt = test.get;
  if (lo.isConst && hi.isConst) {
    const l = lo.value;
    const h = hi.value;
    if (l <= h) {
      return (rin) => {
        if (!rin) return false;
        const t = gt();
        return t >= l && t <= h;
      };
    }
    // circular range: true outside (l, h) exclusive, i.e. at or above Low or at or below High
    return (rin) => {
      if (!rin) return false;
      const t = gt();
      return t >= l || t <= h;
    };
  }
  const gl = lo.get;
  const gh = hi.get;
  return (rin) => {
    if (!rin) return false;
    const l = gl();
    const t = gt();
    const h = gh();
    return l <= h ? t >= l && t <= h : t >= l || t <= h;
  };
}

export const compareInstructions: InstructionDef[] = [
  binaryCompare('EQU', 'Equal'),
  binaryCompare('NEQ', 'Not Equal'),
  binaryCompare('LES', 'Less Than'),
  binaryCompare('LEQ', 'Less Than or Equal'),
  binaryCompare('GRT', 'Greater Than'),
  binaryCompare('GEQ', 'Greater Than or Equal'),
  {
    mnemonic: 'LIM',
    category: 'Compare',
    title: 'Limit',
    kind: 'input',
    box: true,
    operands: [
      { name: 'Low Limit', kind: 'source', description: 'Lower limit of the range' },
      { name: 'Test', kind: 'source', description: 'Value to test' },
      { name: 'High Limit', kind: 'source', description: 'Upper limit of the range' },
    ],
    compile(c) {
      const rl = c.source(0);
      const rtst = c.source(1);
      const rh = c.source(2);
      const asReal = isReal(rl) || isReal(rtst) || isReal(rh);
      return { exec: makeLimit(bindOperand(rl, asReal), bindOperand(rtst, asReal), bindOperand(rh, asReal)) };
    },
  },
  {
    mnemonic: 'CMP',
    category: 'Compare',
    title: 'Compare',
    kind: 'input',
    box: true,
    operands: [{ name: 'Expression', kind: 'expression', description: 'Comparison expression; a nonzero result is true' }],
    compile(c) {
      const ce = c.expression(0);
      if (ce.constValue !== undefined) {
        const k = ce.constValue !== 0;
        return { exec: (rin) => rin && k };
      }
      const ev = ce.eval;
      return { exec: (rin) => rin && ev() !== 0 };
    },
  },
];
