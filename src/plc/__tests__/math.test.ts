import { describe, it, expect } from 'vitest';
import { getInstruction, type Controller, type TagDef } from '../index';
import { run, scans, verifyErrors, dint, bool, real, int, sint, timer, arr } from './helpers';

const DINT_MIN = -2147483648;
const DINT_MAX = 2147483647;
const f32 = Math.fround;

/** Download, go to Run and execute one scan. */
function once(rungs: string | string[], tags: TagDef[] = []): Controller {
  const c = run({ tags, rungs: Array.isArray(rungs) ? rungs : [rungs] });
  scans(c);
  return c;
}

/** Value of `dest` after one scan of a single rung. */
function result(rung: string, tags: TagDef[] = [], dest = 'D'): number {
  return once(rung, tags).readNumber(dest);
}

const flags = (c: Controller) => ({ Z: c.readNumber('S:Z'), N: c.readNumber('S:N'), V: c.readNumber('S:V') });

const errorText = (rungs: string[], tags: TagDef[]) =>
  verifyErrors({ tags, rungs })
    .filter((e) => e.severity === 'error')
    .map((e) => e.message)
    .join('\n');

const MATH = ['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'NEG', 'ABS', 'SQR', 'CPT'];

describe('math instruction definitions', () => {
  it('registers every Compute/Math instruction as an output box', () => {
    const titles: Record<string, string> = {
      ADD: 'Add',
      SUB: 'Subtract',
      MUL: 'Multiply',
      DIV: 'Divide',
      MOD: 'Modulo',
      NEG: 'Negate',
      ABS: 'Absolute Value',
      SQR: 'Square Root',
      CPT: 'Compute',
    };
    for (const m of MATH) {
      const d = getInstruction(m);
      expect(d, m).toBeDefined();
      expect(d!.category).toBe('Compute/Math');
      expect(d!.kind).toBe('output');
      expect(d!.box).toBe(true);
      expect(d!.title).toBe(titles[m]);
    }
  });

  it('lists the operands in Logix order', () => {
    for (const m of ['ADD', 'SUB', 'MUL', 'DIV', 'MOD']) expect(getInstruction(m)!.operands.map((o) => o.name)).toEqual(['Source A', 'Source B', 'Dest']);
    for (const m of ['NEG', 'ABS', 'SQR']) expect(getInstruction(m)!.operands.map((o) => o.name)).toEqual(['Source', 'Dest']);
    expect(getInstruction('CPT')!.operands.map((o) => o.name)).toEqual(['Dest', 'Expression']);
    expect(getInstruction('CPT')!.operands[1].kind).toBe('expression');
  });

  it('parses spaced and paren forms identically', () => {
    const tags = [dint('A', 9), dint('B', 4), dint('D1'), dint('D2')];
    const c = once(['ADD A B D1 ;', 'ADD(A,B,D2);'], tags);
    expect(c.readNumber('D1')).toBe(13);
    expect(c.readNumber('D2')).toBe(13);
  });

  it('does nothing during prescan', () => {
    const c = run({ tags: [dint('D', 55)], rungs: ['ADD 1 2 D ;'] });
    expect(c.readNumber('D')).toBe(55);
    scans(c);
    expect(c.readNumber('D')).toBe(3);
  });
});

describe('ADD', () => {
  it('adds DINT tags and literals', () => {
    expect(result('ADD A B D ;', [dint('A', 3), dint('B', 4), dint('D')])).toBe(7);
    expect(result('ADD 5 -12 D ;', [dint('D')])).toBe(-7);
    expect(result('ADD A 100 D ;', [dint('A', -1), dint('D')])).toBe(99);
  });

  it('adds INT and SINT sources in DINT and stores into INT', () => {
    expect(result('ADD I S D ;', [int('I', 30000), sint('S', 100), int('D')])).toBe(30100);
    expect(result('ADD S S D ;', [sint('S', -100), dint('D')])).toBe(-200);
  });

  it('computes in REAL when a source is REAL', () => {
    expect(result('ADD R 2 D ;', [real('R', 1.5), real('D')])).toBe(3.5);
    expect(result('ADD 0.1 0.2 D ;', [real('D')])).toBe(f32(f32(0.1) + f32(0.2)));
  });

  it('computes in REAL when the destination is REAL (no DINT overflow)', () => {
    const c = once('ADD 2147483647 1 D ;', [real('D')]);
    expect(c.readNumber('D')).toBe(2147483648);
    expect(flags(c).V).toBe(0);
    expect(c.minorFaults).toHaveLength(0);
  });

  it('rounds a REAL result half to even when storing into an integer', () => {
    const c = run({ tags: [real('R'), dint('D'), int('I'), sint('S')], rungs: ['ADD R 0 D ;', 'ADD R 0 I ;', 'ADD R 0 S ;'] });
    const cases: [number, number][] = [
      [2.5, 2],
      [3.5, 4],
      [-2.5, -2],
      [-3.5, -4],
      [0.5, 0],
      [1.5, 2],
      [2.4, 2],
      [2.6, 3],
      [-2.6, -3],
    ];
    for (const [x, want] of cases) {
      c.write('R', x);
      scans(c);
      expect(c.readNumber('D'), `${x}`).toBe(want);
      expect(c.readNumber('I'), `${x}`).toBe(want);
      expect(c.readNumber('S'), `${x}`).toBe(want);
    }
  });

  it('converts DINT operands to REAL (single precision) in REAL math', () => {
    // 16777217 is not representable as REAL: it becomes 16777216.0 before the add
    expect(result('ADD A R D ;', [dint('A', 16777217), real('R', 0.5), dint('D')])).toBe(16777216);
  });

  it('wraps on DINT overflow, sets S:V and logs a minor fault', () => {
    const c = once('ADD A 1 D ;', [dint('A', DINT_MAX), dint('D')]);
    expect(c.readNumber('D')).toBe(DINT_MIN);
    expect(flags(c)).toEqual({ Z: 0, N: 1, V: 1 });
    expect(c.readNumber('S:MINOR')).toBe(1);
    expect(c.minorFaults).toHaveLength(1);
    expect(c.minorFaults[0]).toMatchObject({ type: 4, code: 4, major: false, routine: 'MainRoutine', rung: 0 });
    expect(c.mode).toBe('RUN');
  });

  it('wraps on negative DINT overflow', () => {
    const c = once('ADD A -1 D ;', [dint('A', DINT_MIN), dint('D')]);
    expect(c.readNumber('D')).toBe(DINT_MAX);
    expect(flags(c)).toEqual({ Z: 0, N: 0, V: 1 });
  });

  it('flags a narrowing store into SINT as an overflow (keeps the low byte)', () => {
    const c = once('ADD A B S ;', [sint('A', 100), sint('B', 100), sint('S')]);
    expect(c.readNumber('S')).toBe(-56);
    expect(flags(c)).toEqual({ Z: 0, N: 1, V: 1 });
    expect(c.minorFaults).toHaveLength(1);
  });

  it('flags a narrowing store into INT (DINT 40000 keeps the low 16 bits)', () => {
    const c = once('ADD 40000 0 I ;', [int('I')]);
    expect(c.readNumber('I')).toBe(40000 - 65536);
    expect(flags(c).V).toBe(1);
  });

  it('clears S:V on the next math instruction without overflow', () => {
    const c = once(['ADD 2147483647 1 D ;', 'XIC S:V OTE Ov1 ;', 'ADD 1 1 E ;', 'XIC S:V OTE Ov2 ;'], [dint('D'), dint('E'), bool('Ov1'), bool('Ov2')]);
    expect(c.readBool('Ov1')).toBe(true);
    expect(c.readBool('Ov2')).toBe(false);
    expect(c.minorFaults).toHaveLength(1);
  });

  it('sets S:Z and S:N, visible to XIC in a following rung on the same scan', () => {
    const tags = [dint('A'), dint('B'), dint('D'), bool('Zero'), bool('Neg')];
    const c = run({ tags, rungs: ['ADD A B D ;', 'XIC S:Z OTE Zero ;', 'XIC S:N OTE Neg ;'] });
    c.write('A', 1);
    c.write('B', -1);
    scans(c);
    expect(c.readBool('Zero')).toBe(true);
    expect(c.readBool('Neg')).toBe(false);
    c.write('A', -5);
    scans(c);
    expect(c.readNumber('D')).toBe(-6);
    expect(c.readBool('Zero')).toBe(false);
    expect(c.readBool('Neg')).toBe(true);
    c.write('A', 5);
    scans(c);
    expect(c.readBool('Zero')).toBe(false);
    expect(c.readBool('Neg')).toBe(false);
  });

  it('does nothing when the rung is false (no store, flags unchanged, no fault)', () => {
    const tags = [bool('En'), dint('D', 99), dint('Z0'), bool('ZeroFlag'), bool('OvFlag')];
    const c = run({ tags, rungs: ['ADD 0 0 Z0 ;', 'XIC En ADD 2147483647 1 D ;', 'XIC S:Z OTE ZeroFlag ;', 'XIC S:V OTE OvFlag ;'] });
    scans(c, 3);
    expect(c.readNumber('D')).toBe(99);
    expect(c.readBool('ZeroFlag')).toBe(true);
    expect(c.readBool('OvFlag')).toBe(false);
    expect(c.minorFaults).toHaveLength(0);
    c.write('En', 1);
    scans(c);
    expect(c.readNumber('D')).toBe(DINT_MIN);
    expect(c.readBool('ZeroFlag')).toBe(false);
    expect(c.readBool('OvFlag')).toBe(true);
  });

  it('passes rung-condition-in through', () => {
    const tags = [bool('En'), dint('D'), bool('Out')];
    const c = run({ tags, rungs: ['XIC En ADD 1 2 D OTE Out ;'] });
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('En', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });

  it('works with indexed array elements and structure members', () => {
    const tags = [arr('Arr', 'DINT', [4], [1, 2, 3, 4]), dint('Idx', 2), timer('T1')];
    const c = once(['ADD Arr[Idx] 10 Arr[Idx] ;', 'ADD Arr[0] Arr[3] T1.PRE ;'], tags);
    expect(c.read('Arr')).toEqual([1, 2, 13, 4]);
    expect(c.readNumber('T1.PRE')).toBe(5);
  });
});

describe('SUB', () => {
  it('subtracts integers and literals', () => {
    expect(result('SUB A B D ;', [dint('A', 10), dint('B', 3), dint('D')])).toBe(7);
    expect(result('SUB 3 10 D ;', [dint('D')])).toBe(-7);
    expect(result('SUB I S D ;', [int('I', -100), sint('S', 100), int('D')])).toBe(-200);
  });

  it('subtracts in REAL with mixed types', () => {
    expect(result('SUB R 2 D ;', [real('R', 5.5), real('D')])).toBe(3.5);
    // 3 - 5.5 = -2.5 -> DINT rounds half to even
    expect(result('SUB 3 R D ;', [real('R', 5.5), dint('D')])).toBe(-2);
    expect(result('SUB 3 R D ;', [real('R', 6.5), dint('D')])).toBe(-4);
  });

  it('wraps on DINT overflow and sets S:V', () => {
    const c = once('SUB A 1 D ;', [dint('A', DINT_MIN), dint('D')]);
    expect(c.readNumber('D')).toBe(DINT_MAX);
    expect(flags(c)).toEqual({ Z: 0, N: 0, V: 1 });
    expect(c.minorFaults).toHaveLength(1);
  });

  it('flags a narrowing store into SINT', () => {
    const c = once('SUB A B S ;', [int('A', -100), int('B', 100), sint('S')]);
    expect(c.readNumber('S')).toBe(56);
    expect(flags(c)).toEqual({ Z: 0, N: 0, V: 1 });
  });

  it('sets S:Z on a zero result', () => {
    const c = once('SUB 5 5 D ;', [dint('D', 1)]);
    expect(c.readNumber('D')).toBe(0);
    expect(flags(c)).toEqual({ Z: 1, N: 0, V: 0 });
  });
});

describe('MUL', () => {
  it('multiplies integers', () => {
    expect(result('MUL A B D ;', [dint('A', 6), dint('B', 7), dint('D')])).toBe(42);
    expect(result('MUL -6 7 D ;', [dint('D')])).toBe(-42);
    expect(result('MUL I S D ;', [int('I', 300), sint('S', -2), int('D')])).toBe(-600);
  });

  it('stores +0 (not -0) for a zero integer product', () => {
    const v = result('MUL -3 0 D ;', [dint('D', 1)]);
    expect(Object.is(v, 0)).toBe(true);
  });

  it('stores +0 into integer destinations for a REAL -0.0 result', () => {
    // -1.5 * 0 is -0.0 in REAL; integers have no negative zero
    const c = once(['MUL R 0 D ;', 'MUL R 0 I ;', 'MUL R 0 S ;'], [real('R', -1.5), dint('D', 5), int('I', 5), sint('S', 5)]);
    expect(Object.is(c.readNumber('D'), 0)).toBe(true);
    expect(Object.is(c.readNumber('I'), 0)).toBe(true);
    expect(Object.is(c.readNumber('S'), 0)).toBe(true);
    expect(flags(c)).toEqual({ Z: 1, N: 0, V: 0 });
  });

  it('multiplies in REAL with mixed types and rounds into an integer dest', () => {
    expect(result('MUL R 3 D ;', [real('R', 1.5), real('D')])).toBe(4.5);
    expect(result('MUL R 3 D ;', [real('R', 1.5), dint('D')])).toBe(4);
    expect(result('MUL R 3 D ;', [real('R', 2.5), dint('D')])).toBe(8);
    expect(result('MUL 0.1 3 D ;', [real('D')])).toBe(f32(f32(0.1) * 3));
  });

  it('wraps on DINT overflow (low 32 bits of the product)', () => {
    const c = once('MUL A B D ;', [dint('A', 100000), dint('B', 100000), dint('D')]);
    expect(c.readNumber('D')).toBe(Math.imul(100000, 100000));
    expect(c.readNumber('D')).toBe(1410065408);
    expect(flags(c)).toEqual({ Z: 0, N: 0, V: 1 });
    expect(c.minorFaults).toHaveLength(1);
  });

  it('sets S:Z and S:V together when the wrapped product is zero', () => {
    const c = once('MUL 65536 65536 D ;', [dint('D', 1)]);
    expect(c.readNumber('D')).toBe(0);
    expect(flags(c)).toEqual({ Z: 1, N: 0, V: 1 });
  });

  it('does not overflow when the destination is REAL', () => {
    const c = once('MUL 100000 100000 R ;', [real('R')]);
    expect(c.readNumber('R')).toBe(1e10);
    expect(flags(c).V).toBe(0);
  });

  it('flags REAL overflow to infinity', () => {
    const c = once('MUL R R R2 ;', [real('R', 1e30), real('R2')]);
    expect(c.readNumber('R2')).toBe(Infinity);
    expect(flags(c).V).toBe(1);
    expect(c.minorFaults).toHaveLength(1);
  });

  it('flags a narrowing store into SINT', () => {
    const c = once('MUL S S S ;', [sint('S', 16)]);
    expect(c.readNumber('S')).toBe(0);
    expect(flags(c)).toEqual({ Z: 1, N: 0, V: 1 });
  });
});

describe('DIV', () => {
  it('truncates toward zero when all operands are integers', () => {
    expect(result('DIV 7 2 D ;', [dint('D')])).toBe(3);
    expect(result('DIV -7 2 D ;', [dint('D')])).toBe(-3);
    expect(result('DIV 7 -2 D ;', [dint('D')])).toBe(-3);
    expect(result('DIV -7 -2 D ;', [dint('D')])).toBe(3);
    expect(result('DIV A B D ;', [int('A', 100), sint('B', 7), int('D')])).toBe(14);
    expect(Object.is(result('DIV -1 2 D ;', [dint('D', 5)]), 0)).toBe(true);
  });

  it('divides in REAL when the destination is REAL', () => {
    expect(result('DIV 7 2 R ;', [real('R')], 'R')).toBe(3.5);
    expect(result('DIV A B R ;', [dint('A', 1), dint('B', 3), real('R')], 'R')).toBe(f32(1 / 3));
  });

  it('divides in REAL and rounds half to even when a source is REAL and the dest is an integer', () => {
    expect(result('DIV 7.0 2 D ;', [dint('D')])).toBe(4);
    expect(result('DIV 7 2.0 D ;', [dint('D')])).toBe(4);
    expect(result('DIV R 2 D ;', [real('R', 5), dint('D')])).toBe(2);
    expect(result('DIV R 2 D ;', [real('R', -5), dint('D')])).toBe(-2);
    expect(result('DIV R 4 D ;', [real('R', 10), int('D')])).toBe(2);
  });

  it('overflows on DINT_MIN / -1', () => {
    const c = once('DIV A -1 D ;', [dint('A', DINT_MIN), dint('D')]);
    expect(c.readNumber('D')).toBe(DINT_MIN);
    expect(flags(c)).toEqual({ Z: 0, N: 1, V: 1 });
    expect(c.minorFaults).toHaveLength(1);
  });

  it('faults the controller (Type 4 Code 4) on integer divide by zero, pointing at the instruction', () => {
    const tags = [bool('In'), bool('Out'), dint('A', 10), dint('B', 0), dint('X'), dint('D', 77)];
    const c = once(['XIC In OTE Out ;', 'ADD 1 2 X DIV A B D ;'], tags);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({
      type: 4,
      code: 4,
      major: true,
      program: 'MainProgram',
      routine: 'MainRoutine',
      rung: 1,
      element: 1,
      instruction: 'DIV',
    });
    expect(c.faultLog).toHaveLength(1);
    expect(c.readNumber('X')).toBe(3);
    expect(c.readNumber('D')).toBe(77);
  });

  it('faults on REAL divide by zero', () => {
    const c = once('DIV R Z D ;', [real('R', 1.5), real('Z', 0), real('D')]);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 4, rung: 0, instruction: 'DIV' });
    const c2 = once('DIV 1 0.0 D ;', [dint('D')]);
    expect(c2.majorFault).toMatchObject({ type: 4, code: 4, instruction: 'DIV' });
  });

  it('faults only when the divisor becomes zero at run time and the rung is true', () => {
    const tags = [bool('En', 1), dint('B', 2), dint('D')];
    const c = run({ tags, rungs: ['XIC En DIV 10 B D ;'] });
    scans(c);
    expect(c.readNumber('D')).toBe(5);
    c.write('En', 0);
    c.write('B', 0);
    scans(c, 2);
    expect(c.mode).toBe('RUN');
    c.write('En', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.instruction).toBe('DIV');
  });
});

describe('MOD', () => {
  it('computes the integer remainder with the sign of the dividend', () => {
    expect(result('MOD 7 3 D ;', [dint('D')])).toBe(1);
    expect(result('MOD -7 3 D ;', [dint('D')])).toBe(-1);
    expect(result('MOD 7 -3 D ;', [dint('D')])).toBe(1);
    expect(result('MOD -7 -3 D ;', [dint('D')])).toBe(-1);
    expect(result('MOD A B D ;', [int('A', 1000), sint('B', 7), sint('D')])).toBe(6);
  });

  it('sets S:Z on a zero remainder and stores +0', () => {
    const c = once('MOD -6 3 D ;', [dint('D', 9)]);
    expect(Object.is(c.readNumber('D'), 0)).toBe(true);
    expect(flags(c)).toEqual({ Z: 1, N: 0, V: 0 });
  });

  it('sets S:N on a negative remainder', () => {
    expect(flags(once('MOD -7 3 D ;', [dint('D')]))).toEqual({ Z: 0, N: 1, V: 0 });
  });

  it('does not overflow on DINT_MIN MOD -1', () => {
    const c = once('MOD A -1 D ;', [dint('A', DINT_MIN), dint('D', 4)]);
    expect(c.readNumber('D')).toBe(0);
    expect(flags(c).V).toBe(0);
  });

  it('computes the REAL modulo as A - B * TRN(A / B)', () => {
    expect(result('MOD R 2 D ;', [real('R', 7.5), real('D')])).toBe(1.5);
    expect(result('MOD R 2 D ;', [real('R', -7.5), real('D')])).toBe(-1.5);
    expect(result('MOD 7.5 -2 D ;', [real('D')])).toBe(1.5);
    expect(result('MOD 7 3 D ;', [real('D')])).toBe(1);
    // REAL result 1.5 into a DINT rounds half to even
    expect(result('MOD 7.5 2 D ;', [dint('D')])).toBe(2);
  });

  it('faults on MOD by zero', () => {
    const c = once(['ADD 1 1 X ;', 'MOD A 0 D ;'], [dint('A', 5), dint('D'), dint('X')]);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 4, rung: 1, element: 0, instruction: 'MOD' });
    const c2 = once('MOD R 0.0 D ;', [real('R', 5), real('D')]);
    expect(c2.majorFault).toMatchObject({ type: 4, code: 4, instruction: 'MOD' });
  });
});

describe('NEG', () => {
  it('negates integers', () => {
    expect(result('NEG A D ;', [dint('A', 5), dint('D')])).toBe(-5);
    expect(result('NEG A D ;', [dint('A', -5), dint('D')])).toBe(5);
    expect(result('NEG 12 D ;', [sint('D')])).toBe(-12);
    const c = once('NEG A D ;', [dint('A', 0), dint('D', 3)]);
    expect(Object.is(c.readNumber('D'), 0)).toBe(true);
    expect(flags(c)).toEqual({ Z: 1, N: 0, V: 0 });
  });

  it('sets S:N for a negative result', () => {
    expect(flags(once('NEG 5 D ;', [dint('D')]))).toEqual({ Z: 0, N: 1, V: 0 });
  });

  it('overflows on DINT_MIN', () => {
    const c = once('NEG A D ;', [dint('A', DINT_MIN), dint('D')]);
    expect(c.readNumber('D')).toBe(DINT_MIN);
    expect(flags(c)).toEqual({ Z: 0, N: 1, V: 1 });
    expect(c.minorFaults).toHaveLength(1);
  });

  it('overflows when the negated INT minimum does not fit an INT dest', () => {
    const c = once('NEG I I ;', [int('I', -32768)]);
    expect(c.readNumber('I')).toBe(-32768);
    expect(flags(c).V).toBe(1);
    // ...but fits a DINT dest
    const c2 = once('NEG I D ;', [int('I', -32768), dint('D')]);
    expect(c2.readNumber('D')).toBe(32768);
    expect(flags(c2).V).toBe(0);
  });

  it('negates REAL values and rounds into integers', () => {
    expect(result('NEG R D ;', [real('R', 2.25), real('D')])).toBe(-2.25);
    expect(result('NEG R D ;', [real('R', 2.5), dint('D')])).toBe(-2);
    expect(result('NEG R D ;', [real('R', -3.5), dint('D')])).toBe(4);
    expect(result('NEG 7 R ;', [real('R')], 'R')).toBe(-7);
  });
});

describe('ABS', () => {
  it('takes the absolute value of integers', () => {
    expect(result('ABS A D ;', [dint('A', -5), dint('D')])).toBe(5);
    expect(result('ABS A D ;', [dint('A', 5), dint('D')])).toBe(5);
    expect(result('ABS -32768 D ;', [dint('D')])).toBe(32768);
    expect(result('ABS S D ;', [sint('S', -128), int('D')])).toBe(128);
  });

  it('overflows on DINT_MIN', () => {
    const c = once('ABS A D ;', [dint('A', DINT_MIN), dint('D')]);
    expect(c.readNumber('D')).toBe(DINT_MIN);
    expect(flags(c)).toEqual({ Z: 0, N: 1, V: 1 });
    expect(c.minorFaults).toHaveLength(1);
  });

  it('overflows when |SINT -128| is stored into a SINT', () => {
    const c = once('ABS S S ;', [sint('S', -128)]);
    expect(c.readNumber('S')).toBe(-128);
    expect(flags(c).V).toBe(1);
  });

  it('takes the absolute value of REALs and rounds into integers', () => {
    expect(result('ABS R D ;', [real('R', -3.25), real('D')])).toBe(3.25);
    expect(result('ABS R D ;', [real('R', -2.5), dint('D')])).toBe(2);
    expect(result('ABS R D ;', [real('R', -3.5), dint('D')])).toBe(4);
    expect(result('ABS -4 R ;', [real('R')], 'R')).toBe(4);
  });
});

describe('SQR', () => {
  it('computes integer square roots, truncating the result (integer source and dest)', () => {
    expect(result('SQR 16 D ;', [dint('D')])).toBe(4);
    expect(result('SQR 2 D ;', [dint('D')])).toBe(1); // 1.414
    expect(result('SQR 7 D ;', [dint('D')])).toBe(2); // 2.646 truncated
    expect(result('SQR 99 D ;', [dint('D')])).toBe(9); // 9.95 truncated
    expect(result('SQR A D ;', [int('A', 10000), sint('D')])).toBe(100);
  });

  it('takes the absolute value of a negative source', () => {
    expect(result('SQR -16 D ;', [dint('D')])).toBe(4);
    expect(result('SQR A D ;', [dint('A', -2), real('D')])).toBe(f32(Math.SQRT2));
    expect(result('SQR -2.0 D ;', [real('D')])).toBe(f32(Math.SQRT2));
    const c = once('SQR -9 D ;', [dint('D')]);
    expect(flags(c)).toEqual({ Z: 0, N: 0, V: 0 });
    expect(c.mode).toBe('RUN');
  });

  it('computes in REAL and rounds half to even into an integer dest', () => {
    expect(result('SQR R D ;', [real('R', 6.25), real('D')])).toBe(2.5);
    expect(result('SQR R D ;', [real('R', 6.25), dint('D')])).toBe(2);
    expect(result('SQR R D ;', [real('R', 12.25), dint('D')])).toBe(4);
  });

  it('flags a narrowing store', () => {
    const c = once('SQR 2147483647 S ;', [sint('S')]);
    expect(c.readNumber('S')).toBe(((46340 << 24) >> 24)); // sqrt = 46340.95, truncated
    expect(flags(c).V).toBe(1);
  });

  it('sets S:Z for SQR 0', () => {
    expect(flags(once('SQR 0 D ;', [dint('D', 5)]))).toEqual({ Z: 1, N: 0, V: 0 });
  });
});

describe('CPT', () => {
  const tags = () => [dint('A', 7), dint('B', 2), dint('C', 3), dint('D'), real('R', 7), real('RD'), int('I', 10), sint('S'), dint('Zero', 0)];

  it('respects operator precedence and parentheses', () => {
    expect(result('CPT(D,2 + 3 * 4);', tags())).toBe(14);
    expect(result('CPT(D,(2 + 3) * 4);', tags())).toBe(20);
    expect(result('CPT(D,A - B - C);', tags())).toBe(2);
    expect(result('CPT(D,A - (B - C));', tags())).toBe(8);
    expect(result('CPT(D,2 * 3 ** 2);', tags())).toBe(18);
    expect(result('CPT(D,17 MOD 5 + 1);', tags())).toBe(3);
    expect(result('CPT(D,(A + B) * C - I / 3);', tags())).toBe(24);
  });

  it('accepts the spaced form when the expression has no spaces', () => {
    expect(result('CPT D A+B*C ;', tags())).toBe(13);
  });

  it('evaluates functions', () => {
    expect(result('CPT(RD,SIN(0.0));', tags(), 'RD')).toBe(0);
    expect(result('CPT(RD,SIN(1.5707964));', tags(), 'RD')).toBeCloseTo(1, 6);
    expect(result('CPT(RD,COS(0.0) + ABS(-2.5));', tags(), 'RD')).toBe(3.5);
    expect(result('CPT(D,ABS(B - A));', tags())).toBe(5);
    expect(result('CPT(D,SQR(16));', tags())).toBe(4);
    expect(result('CPT(D,SQR(2));', tags())).toBe(1);
    expect(result('CPT(RD,SQR(2));', tags(), 'RD')).toBe(f32(Math.SQRT2));
  });

  it('evaluates ** and MOD', () => {
    expect(result('CPT(D,2 ** 10);', tags())).toBe(1024);
    expect(result('CPT(RD,2.0 ** 0.5);', tags(), 'RD')).toBe(f32(Math.SQRT2));
    expect(result('CPT(D,A MOD C);', tags())).toBe(1);
    expect(result('CPT(D,-7 MOD 3);', tags())).toBe(-1);
    expect(result('CPT(RD,R MOD 2);', tags(), 'RD')).toBe(1);
  });

  it('applies DINT / REAL typing for mixed operands', () => {
    // all integer: truncating division
    expect(result('CPT(D,A / B);', tags())).toBe(3);
    expect(result('CPT(RD,A / B);', tags(), 'RD')).toBe(3);
    // REAL operand: REAL division; 3.5 into DINT rounds half to even
    expect(result('CPT(RD,R / B);', tags(), 'RD')).toBe(3.5);
    expect(result('CPT(D,R / B);', tags())).toBe(4);
    expect(result('CPT(D,R / B - 1);', tags())).toBe(2);
    expect(result('CPT(D,I * R + S);', tags())).toBe(70);
  });

  it('rounds half to even when storing a REAL result into an integer', () => {
    expect(result('CPT(D,2.5);', tags())).toBe(2);
    expect(result('CPT(D,3.5);', tags())).toBe(4);
    expect(result('CPT(D,-2.5);', tags())).toBe(-2);
    expect(result('CPT(D,R / 2 - 1);', tags())).toBe(2); // 2.5
  });

  it('sets S:Z and S:N from the stored value', () => {
    const c = run({ tags: [...tags(), bool('Zf'), bool('Nf')], rungs: ['CPT(D,A - B * C);', 'XIC S:Z OTE Zf ;', 'XIC S:N OTE Nf ;'] });
    scans(c);
    expect(c.readNumber('D')).toBe(1);
    expect(c.readBool('Zf')).toBe(false);
    expect(c.readBool('Nf')).toBe(false);
    c.write('A', 6);
    scans(c);
    expect(c.readBool('Zf')).toBe(true);
    c.write('A', 0);
    scans(c);
    expect(c.readNumber('D')).toBe(-6);
    expect(c.readBool('Nf')).toBe(true);
  });

  it('flags DINT overflow inside the expression once (S:V, one minor fault)', () => {
    const c = once(['CPT(D,A * B);', 'XIC S:V OTE Ov ;'], [dint('A', 65536), dint('B', 65536), dint('D', 1), bool('Ov')]);
    expect(c.readNumber('D')).toBe(0);
    expect(flags(c)).toEqual({ Z: 1, N: 0, V: 1 });
    expect(c.readBool('Ov')).toBe(true);
    expect(c.minorFaults).toHaveLength(1);
    expect(c.minorFaults[0]).toMatchObject({ type: 4, code: 4, rung: 0, routine: 'MainRoutine' });
  });

  it('flags DINT overflow of a constant expression at run time', () => {
    // Constant expressions are folded at compile time; the overflow must still be
    // reported when the instruction executes, not during download.
    const c = run({ tags: [dint('D')], rungs: ['CPT(D,2147483647 + 1);'] });
    expect(c.minorFaults).toHaveLength(0);
    scans(c);
    expect(c.readNumber('D')).toBe(DINT_MIN);
    expect(flags(c).V).toBe(1);
    expect(c.minorFaults).toHaveLength(1);
    expect(c.minorFaults[0]).toMatchObject({ rung: 0, routine: 'MainRoutine' });
  });

  it('flags a narrowing store into SINT', () => {
    const c = once('CPT(S,A * 100);', tags());
    expect(c.readNumber('S')).toBe(((700 << 24) >> 24));
    expect(flags(c).V).toBe(1);
    expect(c.minorFaults).toHaveLength(1);
  });

  it('clears S:V when the expression does not overflow', () => {
    const c = once(['ADD 2147483647 1 D ;', 'CPT(D,A + B);', 'XIC S:V OTE Ov ;'], [...tags(), bool('Ov')]);
    expect(c.readNumber('D')).toBe(9);
    expect(c.readBool('Ov')).toBe(false);
  });

  it('faults on divide by zero in the expression, pointing at CPT', () => {
    const c = once(['ADD 1 1 D ;', 'CPT(D,A / Zero);'], tags());
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 4, rung: 1, instruction: 'CPT', routine: 'MainRoutine' });
    const c2 = once('CPT(D,A MOD Zero);', tags());
    expect(c2.majorFault).toMatchObject({ type: 4, code: 4, instruction: 'CPT' });
  });

  it('does nothing when the rung is false', () => {
    const c = run({ tags: [...tags(), bool('En')], rungs: ['XIC En CPT(D,A / Zero);'] });
    c.write('D', 42);
    scans(c, 2);
    expect(c.mode).toBe('RUN');
    expect(c.readNumber('D')).toBe(42);
  });
});

describe('math verify errors', () => {
  it('accepts REAL destinations and sources for every instruction', () => {
    const tags = [real('R1', 1), real('R2', 2), real('RD')];
    const rungs = [
      'ADD R1 R2 RD ;',
      'SUB R1 2 RD ;',
      'MUL 1.5 R2 RD ;',
      'DIV R1 R2 RD ;',
      'MOD R1 R2 RD ;',
      'NEG R1 RD ;',
      'ABS R1 RD ;',
      'SQR R1 RD ;',
      'CPT(RD,R1 * 2.0 + SIN(R2));',
    ];
    expect(errorText(rungs, tags)).toBe('');
  });

  it('rejects a TIMER as a source', () => {
    const errs = verifyErrors({ tags: [timer('T1'), dint('D')], rungs: ['ADD T1 1 D ;'] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ severity: 'error', rung: 0, operand: 0 });
    expect(errs[0].message).toMatch(/TIMER/);
    expect(errorText(['NEG T1 D ;'], [timer('T1'), dint('D')])).toMatch(/TIMER/);
    expect(errorText(['CPT(D,T1 + 1);'], [timer('T1'), dint('D')])).toMatch(/TIMER/);
  });

  it('accepts TIMER members as operands', () => {
    expect(errorText(['ADD T1.ACC 1 T1.PRE ;', 'CPT(T1.PRE,T1.ACC * 2);'], [timer('T1')])).toBe('');
  });

  it('rejects a literal destination', () => {
    for (const rung of ['ADD 1 2 5 ;', 'SUB 1 2 5 ;', 'MUL 1 2 3 ;', 'DIV 4 2 1 ;', 'MOD 4 2 1 ;', 'NEG 1 2 ;', 'ABS 1 2 ;', 'SQR 4 2 ;', 'CPT(5,1 + 2);']) {
      const errs = verifyErrors({ rungs: [rung] });
      expect(errs.length, rung).toBeGreaterThan(0);
      expect(errs[0].message, rung).toMatch(/Immediate value not allowed/);
    }
  });

  it('rejects BOOL and structure operands', () => {
    expect(errorText(['ADD B1 1 D ;'], [bool('B1'), dint('D')])).toMatch(/BOOL/);
    expect(errorText(['ADD 1 1 B1 ;'], [bool('B1')])).toMatch(/BOOL/);
    expect(errorText(['MUL 2 2 T1 ;'], [timer('T1')])).toMatch(/TIMER/);
    expect(errorText(['ADD 1 1 Arr ;'], [arr('Arr', 'DINT', [3])])).toMatch(/array/);
  });

  it('reports missing operands', () => {
    expect(errorText(['ADD A B ;'], [dint('A'), dint('B')])).toMatch(/Missing operand/);
    expect(errorText(['NEG A ;'], [dint('A')])).toMatch(/Missing operand/);
    expect(errorText(['ADD(A,?,D);'], [dint('A'), dint('D')])).toMatch(/Missing operand/);
    expect(errorText(['ADD(A,B);'], [dint('A'), dint('B')])).toMatch(/expects 3 operand/);
    expect(errorText(['CPT(D,?);'], [dint('D')])).toMatch(/Missing operand/);
    expect(errorText(['CPT D ;'], [dint('D')])).toMatch(/Missing operand/);
  });

  it('reports undefined tags', () => {
    expect(errorText(['ADD Nope 1 D ;'], [dint('D')])).toMatch(/Undefined tag 'Nope'/);
    expect(errorText(['CPT(D,Nope * 2);'], [dint('D')])).toMatch(/Undefined tag 'Nope'/);
  });

  it('reports invalid CPT expressions', () => {
    expect(errorText(['CPT(D,A +);'], [dint('A'), dint('D')])).toMatch(/Invalid expression/);
    expect(errorText(['CPT(D,FOO(A));'], [dint('A'), dint('D')])).toMatch(/Unknown function/);
  });

  it('rejects comparison operators in a CPT expression', () => {
    const msg = errorText(['CPT(D,A > 1);'], [dint('A'), dint('D')]);
    expect(msg).toMatch(/not allowed in a CPT expression/);
    expect(errorText(['CPT(D,ABS(A = 1) + 1);'], [dint('A'), dint('D')])).toMatch(/not allowed/);
  });

  it('accepts logical / bitwise operators on integers in CPT', () => {
    const c = once('CPT(D,(A AND 6) OR 8 XOR 1);', [dint('A', 7), dint('D')]);
    expect(c.readNumber('D')).toBe((7 & 6) | (8 ^ 1));
  });

  it('blocks the download when an operand is invalid', () => {
    expect(() => run({ tags: [timer('T1'), dint('D')], rungs: ['ADD T1 1 D ;'] })).toThrow(/Download failed/);
  });
});

describe('math performance', () => {
  it('scans 200 math rungs in well under 1 ms', () => {
    const tags: TagDef[] = [dint('A', 3), dint('B', 4), real('R', 1.5), arr('D', 'DINT', [200]), arr('RD', 'REAL', [200])];
    const rungs: string[] = [];
    for (let i = 0; i < 200; i++) {
      const k = i % 5;
      if (k === 0) rungs.push(`ADD A ${i} D[${i}] ;`);
      else if (k === 1) rungs.push(`MUL R B RD[${i}] ;`);
      else if (k === 2) rungs.push(`DIV A B D[${i}] ;`);
      else if (k === 3) rungs.push(`CPT(D[${i}],A * B + ${i});`);
      else rungs.push(`SQR R RD[${i}] ;`);
    }
    const c = run({ tags, rungs });
    scans(c, 200); // warm up
    const t0 = performance.now();
    const n = 200;
    scans(c, n);
    const perScanMs = (performance.now() - t0) / n;
    expect(c.mode).toBe('RUN');
    expect(c.readNumber('D[5]')).toBe(8);
    expect(c.readNumber('D[3]')).toBe(15);
    expect(perScanMs).toBeLessThan(1);
  });
});
