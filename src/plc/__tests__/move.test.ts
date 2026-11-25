import { describe, it, expect } from 'vitest';
import { run, scans, verifyErrors, bool, dint, int, sint, real, timer, counter, arr } from './helpers';
import type { TagDef, UDTDef, Controller } from '../index';
import { getInstruction } from '../ladder/instructions';
import { moveInstructions } from '../ladder/instructions/move';

const verifyText = (setup: Parameters<typeof verifyErrors>[0]) =>
  verifyErrors(setup)
    .map((e) => e.message)
    .join('\n');

const tagOf = (dataType: string, name: string, value?: number): TagDef => ({ name, dataType, value });

/** Reinterpret helpers (independent of the engine) */
const f32bits = (x: number) => {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, x, true);
  return dv.getInt32(0, true);
};

const RECIPE: UDTDef = {
  name: 'Recipe',
  members: [
    { name: 'Speed', dataType: 'DINT' },
    { name: 'Temp', dataType: 'REAL' },
    { name: 'Enabled', dataType: 'BOOL' },
    { name: 'Steps', dataType: 'DINT', dims: [3] },
    { name: 'Hold', dataType: 'TIMER' },
  ],
};

const OTHER: UDTDef = { name: 'Other', members: [{ name: 'Speed', dataType: 'DINT' }] };

const recipeValue = (k: number) => ({
  Speed: 100 * k,
  Temp: k + 0.5,
  Enabled: k % 2,
  Steps: [k, k + 1, k + 2],
  Hold: { PRE: 1000 * k, ACC: 10 * k, DN: k % 2 },
});

function minorCount(c: Controller): number {
  return c.minorFaults.length;
}

// ----------------------------------------------------------------------------- metadata

describe('move/logical instruction definitions', () => {
  it('registers MOV, MVM, CLR, AND, OR, XOR, NOT, COP, FLL with Move/Logical metadata', () => {
    const expected: Record<string, [string, string[]]> = {
      MOV: ['Move', ['Source', 'Dest']],
      MVM: ['Masked Move', ['Source', 'Mask', 'Dest']],
      CLR: ['Clear', ['Dest']],
      AND: ['Bitwise AND', ['Source A', 'Source B', 'Dest']],
      OR: ['Bitwise OR', ['Source A', 'Source B', 'Dest']],
      XOR: ['Bitwise Exclusive OR', ['Source A', 'Source B', 'Dest']],
      NOT: ['Bitwise NOT', ['Source', 'Dest']],
      COP: ['Copy File', ['Source', 'Dest', 'Length']],
      FLL: ['File Fill', ['Source', 'Dest', 'Length']],
    };
    expect(moveInstructions.map((d) => d.mnemonic).sort()).toEqual(Object.keys(expected).sort());
    for (const [m, [title, ops]] of Object.entries(expected)) {
      const d = getInstruction(m);
      expect(d, m).toBeDefined();
      expect(d!.category).toBe('Move/Logical');
      expect(d!.title).toBe(title);
      expect(d!.kind).toBe('output');
      expect(d!.box).toBe(true);
      expect(d!.variadic ?? false).toBe(false);
      expect(d!.operands.map((o) => o.name)).toEqual(ops);
    }
  });

  it('passes rung-condition-in through as rung-condition-out', () => {
    const c = run({
      tags: [bool('A'), dint('X'), dint('Y'), dint('Z'), arr('Arr', 'DINT', [4]), bool('Out1'), bool('Out2'), bool('Out3')],
      rungs: ['XIC A MOV 1 X OTE Out1 ;', 'XIC A AND 3 1 Y COP Arr Arr[1] 2 OTE Out2 ;', 'XIC A FLL 0 Arr 4 CLR Z OTE Out3 ;'],
    });
    scans(c);
    expect([c.readBool('Out1'), c.readBool('Out2'), c.readBool('Out3')]).toEqual([false, false, false]);
    c.write('A', 1);
    scans(c);
    expect([c.readBool('Out1'), c.readBool('Out2'), c.readBool('Out3')]).toEqual([true, true, true]);
  });

  it('parses both spaced and paren rung forms', () => {
    const c = run({
      tags: [arr('Src', 'DINT', [5], [1, 2, 3, 4, 5]), arr('D1', 'DINT', [5]), arr('D2', 'DINT', [5]), dint('M'), dint('N')],
      rungs: ['COP Src[1] D1[0] 2 ;', 'COP(Src[1],D2[0],2);', 'MVM(16#FF,16#0F,M)NOT(M,N);'],
    });
    scans(c);
    expect(c.read('D1')).toEqual([2, 3, 0, 0, 0]);
    expect(c.read('D2')).toEqual([2, 3, 0, 0, 0]);
    expect(c.readNumber('M')).toBe(15);
    expect(c.readNumber('N')).toBe(-16);
  });
});

// ----------------------------------------------------------------------------- MOV

describe('MOV', () => {
  type T = 'SINT' | 'INT' | 'DINT' | 'REAL';
  // [source type, source value, dest type, expected dest, overflow]
  const cases: [T, number, T, number, boolean][] = [
    ['SINT', -5, 'SINT', -5, false],
    ['SINT', -5, 'INT', -5, false],
    ['SINT', -5, 'DINT', -5, false],
    ['SINT', -5, 'REAL', -5, false],
    ['INT', 1000, 'SINT', -24, true],
    ['INT', -32768, 'INT', -32768, false],
    ['INT', 1000, 'DINT', 1000, false],
    ['INT', -1000, 'REAL', -1000, false],
    ['DINT', 70000, 'SINT', 112, true],
    ['DINT', 70000, 'INT', 4464, true],
    ['DINT', 127, 'SINT', 127, false],
    ['DINT', -32768, 'INT', -32768, false],
    ['DINT', -2147483648, 'DINT', -2147483648, false],
    ['DINT', 70000, 'REAL', 70000, false],
    ['REAL', 2.5, 'SINT', 2, false],
    ['REAL', 200.7, 'SINT', -55, true],
    ['REAL', 3.5, 'INT', 4, false],
    ['REAL', -2.5, 'DINT', -2, false],
    ['REAL', 2.5, 'REAL', 2.5, false],
  ];
  it.each(cases)('MOV %s %d -> %s gives %d (overflow %s)', (st, sv, dt, expected, overflow) => {
    const c = run({ tags: [tagOf(st, 'Src', sv), tagOf(dt, 'Dst')], rungs: ['MOV Src Dst ;'] });
    scans(c);
    expect(c.readNumber('Dst')).toBe(expected);
    expect(c.readNumber('S:V')).toBe(overflow ? 1 : 0);
    expect(minorCount(c)).toBe(overflow ? 1 : 0);
  });

  it('rounds REAL to integer half to even', () => {
    const values: [number, number][] = [
      [0.5, 0],
      [1.5, 2],
      [2.5, 2],
      [3.5, 4],
      [-0.5, 0],
      [-1.5, -2],
      [-2.5, -2],
      [2.4999, 2],
      [2.5001, 3],
      [-2.6, -3],
    ];
    const tags: TagDef[] = [];
    const rungs: string[] = [];
    values.forEach(([v], i) => {
      tags.push(real(`R${i}`, v), dint(`D${i}`, 99));
      rungs.push(`MOV R${i} D${i} ;`);
    });
    const c = run({ tags, rungs });
    scans(c);
    values.forEach(([, expected], i) => {
      expect(Object.is(c.readNumber(`D${i}`), -0) ? 'minus zero' : c.readNumber(`D${i}`), `R${i}`).toBe(expected);
    });
  });

  it('moves a REAL literal into a DINT with rounding', () => {
    const c = run({ tags: [dint('D'), int('I')], rungs: ['MOV 1.5 D ;', 'MOV -7.5 I ;'] });
    scans(c);
    expect(c.readNumber('D')).toBe(2);
    expect(c.readNumber('I')).toBe(-8);
  });

  it('wraps DINT into SINT keeping the low bits, sets S:V and logs a minor fault', () => {
    const c = run({ tags: [dint('Src', 300), sint('Dst'), bool('Go', 1)], rungs: ['XIC Go MOV Src Dst ;'] });
    scans(c);
    expect(c.readNumber('Dst')).toBe(44);
    expect(c.readNumber('S:V')).toBe(1);
    expect(c.readNumber('S:MINOR')).toBe(1);
    expect(c.minorFaults[0]).toMatchObject({ type: 4, code: 4 });
    // a following in-range MOV clears S:V
    c.write('Src', -128);
    scans(c);
    expect(c.readNumber('Dst')).toBe(-128);
    expect(c.readNumber('S:V')).toBe(0);
    expect(c.readNumber('S:N')).toBe(1);
  });

  it('flags overflow for REAL out of DINT range', () => {
    const c = run({ tags: [real('R', 3e9), dint('D')], rungs: ['MOV R D ;'] });
    scans(c);
    expect(c.readNumber('S:V')).toBe(1);
  });

  it('loses precision moving large DINT into REAL', () => {
    const c = run({
      tags: [dint('A', 16777217), dint('B', 2147483647), dint('C', 123456789), real('RA'), real('RB'), real('RC')],
      rungs: ['MOV A RA ;', 'MOV B RB ;', 'MOV C RC ;'],
    });
    scans(c);
    expect(c.readNumber('RA')).toBe(16777216);
    expect(c.readNumber('RB')).toBe(2147483648);
    expect(c.readNumber('RC')).toBe(Math.fround(123456789));
    expect(c.readNumber('S:V')).toBe(0);
  });

  it('accepts radix literals', () => {
    const c = run({
      tags: [dint('H'), dint('B'), dint('O'), dint('Neg'), dint('U')],
      rungs: ['MOV 16#FF H ;', 'MOV 2#1010 B ;', 'MOV 8#17 O ;', 'MOV 16#FFFF_FFFF Neg ;', 'MOV 16#8000_0000 U ;'],
    });
    scans(c);
    expect(c.readNumber('H')).toBe(255);
    expect(c.readNumber('B')).toBe(10);
    expect(c.readNumber('O')).toBe(15);
    expect(c.readNumber('Neg')).toBe(-1);
    expect(c.readNumber('U')).toBe(-2147483648);
    expect(c.readNumber('S:N')).toBe(1);
  });

  it('updates S:Z and S:N from the destination value', () => {
    const c = run({ tags: [dint('Src', -3), dint('Dst'), real('R')], rungs: ['MOV Src Dst ;'] });
    scans(c);
    expect([c.readNumber('S:Z'), c.readNumber('S:N')]).toEqual([0, 1]);
    c.write('Src', 0);
    scans(c);
    expect([c.readNumber('S:Z'), c.readNumber('S:N')]).toEqual([1, 0]);
    c.write('Src', 9);
    scans(c);
    expect([c.readNumber('S:Z'), c.readNumber('S:N')]).toEqual([0, 0]);
  });

  it('does nothing when the rung is false', () => {
    const c = run({ tags: [bool('Go'), dint('Src', 5), dint('Dst', 77)], rungs: ['XIC Go MOV Src Dst ;'] });
    scans(c, 3);
    expect(c.readNumber('Dst')).toBe(77);
    c.write('Go', 1);
    scans(c);
    expect(c.readNumber('Dst')).toBe(5);
    c.write('Go', 0);
    c.write('Src', 6);
    scans(c);
    expect(c.readNumber('Dst')).toBe(5);
  });

  it('moves array elements and members (static and indexed)', () => {
    const c = run({
      tags: [arr('A', 'DINT', [4], [10, 20, 30, 40]), dint('I', 2), dint('X'), timer('T'), dint('P')],
      rungs: ['MOV A[I] X ;', 'MOV 1500 T.PRE ;', 'MOV T.PRE P ;', 'MOV X A[0] ;'],
    });
    scans(c);
    expect(c.readNumber('X')).toBe(30);
    expect(c.readNumber('P')).toBe(1500);
    expect(c.readNumber('A[0]')).toBe(30);
  });

  it('rejects BOOL operands, bit addresses and literal destinations at verify', () => {
    const tags = [bool('B'), dint('D'), dint('Src')];
    expect(verifyText({ tags, rungs: ['MOV Src B ;'] })).toMatch(/MOV, Operand 1: Invalid data type: 'B' is BOOL/);
    expect(verifyText({ tags, rungs: ['MOV Src D.5 ;'] })).toMatch(/MOV, Operand 1: Invalid data type/);
    expect(verifyText({ tags, rungs: ['MOV B D ;'] })).toMatch(/MOV, Operand 0: Invalid data type: 'B' is BOOL/);
    expect(verifyText({ tags, rungs: ['MOV Src 10 ;'] })).toMatch(/MOV, Operand 1: Immediate value not allowed/);
    expect(verifyText({ tags: [...tags, timer('T')], rungs: ['MOV T D ;'] })).toMatch(/MOV, Operand 0: Invalid data type: 'T' is TIMER/);
    expect(verifyText({ tags, rungs: ['MOV Src Nope ;'] })).toMatch(/Undefined tag 'Nope'/);
  });

  it('reports missing operands', () => {
    const tags = [dint('D')];
    expect(verifyText({ tags, rungs: ['MOV(D);'] })).toMatch(/MOV expects 2 operand\(s\), found 1/);
    expect(verifyText({ tags, rungs: ['MOV ? D ;'] })).toMatch(/MOV, Operand 0: Missing operand/);
    expect(verifyText({ tags, rungs: ['MOV(5,?);'] })).toMatch(/MOV, Operand 1: Missing operand/);
  });

  it('rejects writing a constant tag', () => {
    expect(verifyText({ tags: [{ name: 'K', dataType: 'DINT', constant: true }], rungs: ['MOV 1 K ;'] })).toMatch(/'K' is read-only/);
  });
});

// ----------------------------------------------------------------------------- MVM

describe('MVM', () => {
  it('moves only the masked bits', () => {
    const c = run({
      tags: [dint('Src', 0x12345678), dint('Mask', 0x0000ffff), dint('Dst', 0xaaaaaaaa | 0)],
      rungs: ['MVM Src Mask Dst ;'],
    });
    scans(c);
    expect(c.readNumber('Dst')).toBe(0xaaaa5678 | 0);
    expect(c.readNumber('S:N')).toBe(1);
  });

  it('mask of all ones copies the source, mask of zero keeps the destination', () => {
    const c = run({
      tags: [dint('A', 55), dint('B', 66)],
      rungs: ['MVM -123456 -1 A ;', 'MVM -123456 0 B ;'],
    });
    scans(c);
    expect(c.readNumber('A')).toBe(-123456);
    expect(c.readNumber('B')).toBe(66);
  });

  it('works with literal hex masks and sign-extended SINT sources', () => {
    const c = run({
      tags: [sint('S', -1), dint('D1'), dint('D2', 0x0f)],
      rungs: ['MVM S 16#F0 D1 ;', 'MVM 16#FFFF_FFFF 16#F000_0000 D2 ;'],
    });
    scans(c);
    expect(c.readNumber('D1')).toBe(0xf0);
    expect(c.readNumber('D2')).toBe(0xf000000f | 0);
  });

  it('stores into narrower destinations keeping the low bits without overflow', () => {
    const c = run({
      tags: [int('I1', 0x1234), int('I2', 0), sint('S1', 0x55), int('I3', 0x0abc)],
      rungs: ['MVM 16#ABCD 16#FF I1 ;', 'MVM 16#8000 16#FFFF I2 ;', 'MVM -1 16#80 S1 ;', 'MVM 0 16#FFFF_0000 I3 ;'],
    });
    scans(c);
    expect(c.readNumber('I1')).toBe(0x12cd);
    expect(c.readNumber('I2')).toBe(-32768);
    expect(c.readNumber('S1')).toBe((0xd5 << 24) >> 24);
    expect(c.readNumber('I3')).toBe(0x0abc);
    expect(c.readNumber('S:V')).toBe(0);
    expect(minorCount(c)).toBe(0);
  });

  it('does nothing when the rung is false', () => {
    const c = run({ tags: [bool('Go'), dint('D', 7)], rungs: ['XIC Go MVM -1 -1 D ;'] });
    scans(c);
    expect(c.readNumber('D')).toBe(7);
  });

  it('rejects REAL operands', () => {
    const tags = [real('R'), dint('D')];
    expect(verifyText({ tags, rungs: ['MVM R 1 D ;'] })).toMatch(/MVM, Operand 0: Invalid data type: 'R' is REAL/);
    expect(verifyText({ tags, rungs: ['MVM 1 1.5 D ;'] })).toMatch(/MVM, Operand 1: Invalid data type/);
    expect(verifyText({ tags, rungs: ['MVM 1 1 R ;'] })).toMatch(/MVM, Operand 2: Invalid data type: 'R' is REAL/);
    expect(verifyText({ tags, rungs: ['MVM 1 1 5 ;'] })).toMatch(/MVM, Operand 2: Immediate value not allowed/);
  });
});

// ----------------------------------------------------------------------------- CLR

describe('CLR', () => {
  it('clears REAL, INT, SINT and DINT destinations and sets S:Z', () => {
    const c = run({
      tags: [real('R', 3.7), int('I', -5), sint('S', 9), dint('D', -100000), arr('A', 'REAL', [2], [1.5, 2.5])],
      rungs: ['MOV -1 S ;', 'CLR R ;', 'CLR I ;', 'CLR S ;', 'CLR D ;', 'CLR A[1] ;'],
    });
    scans(c);
    expect(c.readNumber('R')).toBe(0);
    expect(c.readNumber('I')).toBe(0);
    expect(c.readNumber('S')).toBe(0);
    expect(c.readNumber('D')).toBe(0);
    expect(c.read('A')).toEqual([1.5, 0]);
    expect([c.readNumber('S:Z'), c.readNumber('S:N'), c.readNumber('S:V')]).toEqual([1, 0, 0]);
  });

  it('does nothing when the rung is false', () => {
    const c = run({ tags: [bool('Go'), real('R', 3.25)], rungs: ['XIC Go CLR R ;'] });
    scans(c, 2);
    expect(c.readNumber('R')).toBe(3.25);
  });

  it('rejects BOOL and literal destinations', () => {
    expect(verifyText({ tags: [bool('B')], rungs: ['CLR B ;'] })).toMatch(/CLR, Operand 0: Invalid data type/);
    expect(verifyText({ rungs: ['CLR 0 ;'] })).toMatch(/CLR, Operand 0: Immediate value not allowed/);
    expect(verifyText({ rungs: ['CLR ? ;'] })).toMatch(/CLR, Operand 0: Missing operand/);
  });
});

// ----------------------------------------------------------------------------- AND / OR / XOR / NOT

describe('AND / OR / XOR / NOT', () => {
  const pairs: [number, number][] = [
    [-6, -3],
    [-8, 7],
    [-1, 0x0f0f],
    [0x12345678, -0x12345679],
    [-2147483648, -1],
    [0, 0],
    [0x7fffffff, 0x55555555],
  ];
  const ops = { AND: (a: number, b: number) => a & b, OR: (a: number, b: number) => a | b, XOR: (a: number, b: number) => a ^ b };
  for (const [name, f] of Object.entries(ops)) {
    it.each(pairs)(`${name} %d %d into DINT`, (a, b) => {
      const c = run({ tags: [dint('A', a), dint('B', b), dint('D', 12345)], rungs: [`${name} A B D ;`] });
      scans(c);
      const expected = f(a, b);
      expect(c.readNumber('D')).toBe(expected);
      expect(c.readNumber('S:Z')).toBe(expected === 0 ? 1 : 0);
      expect(c.readNumber('S:N')).toBe(expected < 0 ? 1 : 0);
      expect(c.readNumber('S:V')).toBe(0);
    });
  }

  it('computes specific negative results', () => {
    const c = run({
      tags: [dint('A'), dint('O'), dint('X'), dint('N1'), dint('N2'), dint('N3')],
      rungs: ['AND -6 -3 A ;', 'OR -8 3 O ;', 'XOR -1 5 X ;', 'NOT 0 N1 ;', 'NOT -1 N2 ;', 'NOT 5 N3 ;'],
    });
    scans(c);
    expect(c.readNumber('A')).toBe(-8);
    expect(c.readNumber('O')).toBe(-5);
    expect(c.readNumber('X')).toBe(-6);
    expect(c.readNumber('N1')).toBe(-1);
    expect(c.readNumber('N2')).toBe(0);
    expect(c.readNumber('N3')).toBe(-6);
  });

  it('keeps the low bits in INT/SINT destinations without overflow', () => {
    const c = run({
      tags: [int('I1'), int('I2'), sint('S1'), sint('S2'), sint('S3'), int('I3')],
      rungs: [
        'AND 16#12345678 16#FFFF_FFFF I1 ;',
        'OR 16#8000 0 I2 ;',
        'XOR 16#1FF 16#100 S1 ;',
        'NOT 16#0F S2 ;',
        'NOT 16#100 S3 ;',
        'NOT 16#7FFF I3 ;',
      ],
    });
    scans(c);
    expect(c.readNumber('I1')).toBe(0x5678);
    expect(c.readNumber('I2')).toBe(-32768);
    expect(c.readNumber('S1')).toBe(-1);
    expect(c.readNumber('S2')).toBe(-16);
    expect(c.readNumber('S3')).toBe(-1);
    expect(c.readNumber('I3')).toBe(-32768);
    expect(c.readNumber('S:V')).toBe(0);
    expect(c.readNumber('S:N')).toBe(1);
    expect(minorCount(c)).toBe(0);
  });

  it('sign-extends SINT and INT sources to 32 bits', () => {
    const c = run({
      tags: [sint('S', -1), int('I', -2), dint('M', 0xff00), dint('D1'), dint('D2'), dint('D3')],
      rungs: ['AND S M D1 ;', 'OR I 0 D2 ;', 'XOR S 16#FFFF_0000 D3 ;'],
    });
    scans(c);
    expect(c.readNumber('D1')).toBe(0xff00);
    expect(c.readNumber('D2')).toBe(-2);
    expect(c.readNumber('D3')).toBe(0x0000ffff);
  });

  it('S:Z is set from a zero result', () => {
    const c = run({ tags: [dint('D', 1)], rungs: ['AND 16#F0 16#0F D ;'] });
    scans(c);
    expect(c.readNumber('D')).toBe(0);
    expect(c.readNumber('S:Z')).toBe(1);
  });

  it('does nothing when the rung is false', () => {
    const c = run({
      tags: [bool('Go'), dint('A', 1), dint('O', 2), dint('X', 3), dint('N', 4)],
      rungs: ['XIC Go AND 0 0 A ;', 'XIC Go OR 8 8 O ;', 'XIC Go XOR 8 8 X ;', 'XIC Go NOT 0 N ;'],
    });
    scans(c);
    expect([c.readNumber('A'), c.readNumber('O'), c.readNumber('X'), c.readNumber('N')]).toEqual([1, 2, 3, 4]);
  });

  it('rejects REAL operands, literal and BOOL destinations, and missing operands', () => {
    const tags = [real('R'), dint('D'), bool('B')];
    for (const m of ['AND', 'OR', 'XOR']) {
      expect(verifyText({ tags, rungs: [`${m} R 1 D ;`] })).toMatch(new RegExp(`${m}, Operand 0: Invalid data type: 'R' is REAL`));
      expect(verifyText({ tags, rungs: [`${m} 1 2.5 D ;`] })).toMatch(new RegExp(`${m}, Operand 1: Invalid data type`));
      expect(verifyText({ tags, rungs: [`${m} 1 1 R ;`] })).toMatch(new RegExp(`${m}, Operand 2: Invalid data type: 'R' is REAL`));
      expect(verifyText({ tags, rungs: [`${m} 1 1 7 ;`] })).toMatch(new RegExp(`${m}, Operand 2: Immediate value not allowed`));
      expect(verifyText({ tags, rungs: [`${m} 1 1 B ;`] })).toMatch(new RegExp(`${m}, Operand 2: Invalid data type: 'B' is BOOL`));
      expect(verifyText({ tags, rungs: [`${m}(1,D);`] })).toMatch(new RegExp(`${m} expects 3 operand\\(s\\), found 2`));
      expect(verifyText({ tags, rungs: [`${m} 1 ? D ;`] })).toMatch(new RegExp(`${m}, Operand 1: Missing operand`));
    }
    expect(verifyText({ tags, rungs: ['NOT R D ;'] })).toMatch(/NOT, Operand 0: Invalid data type: 'R' is REAL/);
    expect(verifyText({ tags, rungs: ['NOT 1 R ;'] })).toMatch(/NOT, Operand 1: Invalid data type: 'R' is REAL/);
    expect(verifyText({ tags, rungs: ['NOT(D);'] })).toMatch(/NOT expects 2 operand\(s\), found 1/);
  });
});

// ----------------------------------------------------------------------------- COP

describe('COP', () => {
  const tens = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];

  it('copies same-type array elements starting at an element', () => {
    const c = run({
      tags: [arr('Src', 'DINT', [10], tens), arr('Dst', 'DINT', [5]), arr('All', 'DINT', [10])],
      rungs: ['COP Src[2] Dst[0] 3 ;', 'COP Src All 10 ;'],
    });
    scans(c);
    expect(c.read('Dst')).toEqual([20, 30, 40, 0, 0]);
    expect(c.read('All')).toEqual(tens);
  });

  it('copies REAL arrays and scalars of the same type', () => {
    const c = run({
      tags: [arr('Src', 'REAL', [3], [1.5, -2.25, 3.125]), arr('Dst', 'REAL', [3]), int('I1', -7), int('I2')],
      rungs: ['COP Src Dst 3 ;', 'COP I1 I2 1 ;'],
    });
    scans(c);
    expect(c.read('Dst')).toEqual([1.5, -2.25, 3.125]);
    expect(c.readNumber('I2')).toBe(-7);
  });

  it('clamps the length at the end of the destination array', () => {
    const c = run({
      tags: [arr('Src', 'DINT', [10], tens), arr('Dst', 'DINT', [5], [1, 1, 1, 1, 1])],
      rungs: ['COP Src[1] Dst[3] 10 ;'],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.read('Dst')).toEqual([1, 1, 1, 10, 20]);
  });

  it('never reads past the end of the source array', () => {
    const c = run({
      tags: [arr('Src', 'DINT', [10], tens), arr('Dst', 'DINT', [6], [5, 5, 5, 5, 5, 5])],
      rungs: ['COP Src[8] Dst[0] 5 ;'],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.read('Dst')).toEqual([80, 90, 5, 5, 5, 5]);
  });

  it('copies a whole UDT deeply and keeps destination containers bound', () => {
    const c = run({
      dataTypes: [RECIPE],
      tags: [
        { name: 'RecA', dataType: 'Recipe', value: recipeValue(3) },
        { name: 'RecB', dataType: 'Recipe', value: recipeValue(1) },
        bool('Go', 1),
        dint('Step1'),
        dint('Pre'),
      ],
      rungs: ['XIC Go COP RecA RecB 1 ;', 'MOV RecB.Steps[1] Step1 ;', 'MOV RecB.Hold.PRE Pre ;'],
    });
    scans(c);
    expect(c.read('RecB')).toEqual(c.read('RecA'));
    expect(c.read('RecB')).toMatchObject({ Speed: 300, Temp: 3.5, Enabled: 1, Steps: [3, 4, 5], Hold: { PRE: 3000, ACC: 30, DN: 1 } });
    // later references to RecB members see the copied data in the same scan
    expect(c.readNumber('Step1')).toBe(4);
    expect(c.readNumber('Pre')).toBe(3000);
    // deep copy: changing the source afterwards does not affect the destination
    c.write('Go', 0);
    c.write('RecA.Steps[1]', 99);
    c.write('RecA.Hold.PRE', 1);
    scans(c);
    expect(c.readNumber('RecB.Steps[1]')).toBe(4);
    expect(c.readNumber('RecB.Hold.PRE')).toBe(3000);
    // destination members written by the watch window stay independent of the source
    c.write('RecB.Speed', 7);
    expect(c.readNumber('RecA.Speed')).toBe(300);
  });

  it('copies TIMER structures', () => {
    const c = run({ tags: [timer('T1'), timer('T2')], rungs: ['COP T1 T2 1 ;'] });
    c.write('T1', { PRE: 1000, ACC: 500, EN: 1, TT: 1, DN: 0 });
    scans(c);
    expect(c.read('T2')).toEqual({ PRE: 1000, ACC: 500, EN: 1, TT: 1, DN: 0 });
  });

  it('copies ranges of structure arrays', () => {
    const c = run({
      dataTypes: [RECIPE],
      tags: [
        { name: 'Src', dataType: 'Recipe', dims: [4], value: [recipeValue(1), recipeValue(2), recipeValue(3), recipeValue(4)] },
        { name: 'Dst', dataType: 'Recipe', dims: [3] },
        { name: 'One', dataType: 'Recipe' },
      ],
      rungs: ['COP Src[1] Dst[0] 5 ;', 'COP Src[3] One 1 ;'],
    });
    scans(c);
    const src = c.read('Src') as unknown[];
    expect(c.read('Dst')).toEqual([src[1], src[2], src[3]]);
    expect(c.read('One')).toEqual(src[3]);
  });

  it('copies the IEEE bit pattern of a REAL into a DINT', () => {
    const c = run({
      tags: [real('R', 1.0), dint('D'), arr('Rs', 'REAL', [2], [-2.5, 0.1]), arr('Ds', 'DINT', [2]), real('Back')],
      rungs: ['COP R D 1 ;', 'COP Rs Ds 2 ;', 'COP D Back 1 ;'],
    });
    scans(c);
    expect(c.readNumber('D')).toBe(1065353216);
    expect(c.read('Ds')).toEqual([f32bits(-2.5), f32bits(0.1)]);
    expect(c.readNumber('Back')).toBe(1.0);
    expect(c.readNumber('S:V')).toBe(0);
  });

  it('splits a DINT into two INTs (little-endian) and packs them back', () => {
    const c = run({
      tags: [dint('D', 0x12345678), arr('I', 'INT', [2]), dint('N', -2), arr('J', 'INT', [2]), dint('Packed'), arr('K', 'INT', [2], [0x5678, 0x1234])],
      rungs: ['COP D I[0] 2 ;', 'COP N J[0] 2 ;', 'COP K[0] Packed 1 ;'],
    });
    scans(c);
    expect(c.read('I')).toEqual([0x5678, 0x1234]);
    expect(c.read('J')).toEqual([-2, -1]);
    expect(c.readNumber('Packed')).toBe(0x12345678);
  });

  it('reinterprets DINT into SINT bytes and SINT bytes into a REAL', () => {
    const c = run({
      tags: [dint('D', 0x80ff017f | 0), arr('S', 'SINT', [4]), arr('B', 'SINT', [4], [0, 0, -128, 63]), real('R')],
      rungs: ['COP D S[0] 4 ;', 'COP B[0] R 1 ;'],
    });
    scans(c);
    expect(c.read('S')).toEqual([127, 1, -1, -128]);
    expect(c.readNumber('R')).toBe(1.0);
  });

  it('copies only the bytes the source has (partial last destination element keeps its other bytes)', () => {
    const c = run({
      tags: [arr('S', 'SINT', [3], [1, 2, 3]), dint('D', 0x7f000000), dint('One', 0x11223344), arr('I', 'INT', [4], [9, 9, 9, 9])],
      rungs: ['COP S D 1 ;', 'COP One I[0] 4 ;'],
    });
    scans(c);
    expect(c.readNumber('D')).toBe(0x7f030201);
    expect(c.read('I')).toEqual([0x3344, 0x1122, 9, 9]);
  });

  it('clamps a reinterpreting copy at the end of the destination', () => {
    const c = run({
      tags: [arr('D', 'DINT', [3], [0x01020304, 0x05060708, -1]), arr('S', 'SINT', [6], [9, 9, 9, 9, 9, 9])],
      rungs: ['COP D[0] S[2] 100 ;'],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.read('S')).toEqual([9, 9, 4, 3, 2, 1]);
  });

  it('shifts up by one element within one array (overlap)', () => {
    const c = run({ tags: [arr('A', 'DINT', [10], tens)], rungs: ['COP A[0] A[1] 9 ;'] });
    scans(c);
    expect(c.read('A')).toEqual([0, 0, 10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('shifts down by one element within one array (overlap)', () => {
    const c = run({ tags: [arr('A', 'DINT', [10], tens)], rungs: ['COP A[1] A[0] 9 ;'] });
    scans(c);
    expect(c.read('A')).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 90]);
  });

  it('shifts a whole-array source into its own element (overlap with base reference)', () => {
    const c = run({ tags: [arr('A', 'REAL', [5], [1, 2, 3, 4, 5])], rungs: ['COP A A[2] 3 ;'] });
    scans(c);
    expect(c.read('A')).toEqual([1, 2, 1, 2, 3]);
  });

  it('shifts structure arrays in both directions', () => {
    const vals = [1, 2, 3, 4].map(recipeValue);
    const mk = (name: string) => ({ name, dataType: 'Recipe', dims: [4], value: vals });
    const c = run({ dataTypes: [RECIPE], tags: [mk('Up'), mk('Down')], rungs: ['COP Up[0] Up[1] 3 ;', 'COP Down[1] Down[0] 3 ;'] });
    const orig = c.read('Up') as unknown[];
    scans(c);
    expect(c.read('Up')).toEqual([orig[0], orig[0], orig[1], orig[2]]);
    expect(c.read('Down')).toEqual([orig[1], orig[2], orig[3], orig[3]]);
    // elements are still independent copies
    c.write('Up[1].Speed', -1);
    expect(c.readNumber('Up[0].Speed')).toBe(100);
  });

  it('executes on every scan while the rung is true, and not when false', () => {
    const c = run({
      tags: [bool('Go'), arr('Src', 'DINT', [3], [1, 2, 3]), arr('Dst', 'DINT', [3])],
      rungs: ['XIC Go COP Src Dst 3 ;'],
    });
    scans(c, 2);
    expect(c.read('Dst')).toEqual([0, 0, 0]);
    c.write('Go', 1);
    scans(c);
    expect(c.read('Dst')).toEqual([1, 2, 3]);
    c.write('Src[0]', 7);
    scans(c);
    expect(c.read('Dst')).toEqual([7, 2, 3]);
    c.write('Go', 0);
    c.write('Src[1]', 8);
    scans(c);
    expect(c.read('Dst')).toEqual([7, 2, 3]);
  });

  it('takes the length from a tag; zero copies nothing', () => {
    const c = run({
      tags: [dint('Len', 2), int('ILen', 0), arr('Src', 'DINT', [4], [1, 2, 3, 4]), arr('Dst', 'DINT', [4]), arr('Dst2', 'DINT', [4], [9, 9, 9, 9])],
      rungs: ['COP Src Dst Len ;', 'COP Src Dst2 ILen ;', 'COP Src Dst2 0 ;'],
    });
    scans(c);
    expect(c.read('Dst')).toEqual([1, 2, 0, 0]);
    expect(c.read('Dst2')).toEqual([9, 9, 9, 9]);
    c.write('Len', 4);
    scans(c);
    expect(c.read('Dst')).toEqual([1, 2, 3, 4]);
  });

  it('faults (type 4 code 20) on a negative length', () => {
    const c = run({
      tags: [dint('Len', -1), arr('Src', 'DINT', [4]), arr('Dst', 'DINT', [4])],
      rungs: ['COP Src Dst Len ;'],
    });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, rung: 0, instruction: 'COP' });
  });

  it('uses a dynamic start index and faults when it is out of range', () => {
    const c = run({
      tags: [dint('Idx', 3), arr('Src', 'DINT', [10], tens), arr('Dst', 'DINT', [2])],
      rungs: ['COP Src[Idx] Dst[0] 2 ;'],
    });
    scans(c);
    expect(c.read('Dst')).toEqual([30, 40]);
    c.write('Idx', 9);
    scans(c);
    // clamped at the end of the source
    expect(c.read('Dst')).toEqual([90, 40]);
    c.write('Idx', 10);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, instruction: 'COP' });
  });

  it('uses a dynamic destination index and faults when it is negative', () => {
    const c = run({
      tags: [dint('Idx', 1), arr('Src', 'DINT', [3], [7, 8, 9]), arr('Dst', 'DINT', [4])],
      rungs: ['COP Src[0] Dst[Idx] 3 ;'],
    });
    scans(c);
    expect(c.read('Dst')).toEqual([0, 7, 8, 9]);
    c.write('Idx', -1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20 });
  });

  it('reports verify errors', () => {
    const tags: TagDef[] = [
      arr('Src', 'DINT', [4]),
      arr('Dst', 'DINT', [4]),
      real('R'),
      timer('T'),
      counter('C'),
      dint('D'),
      { name: 'K', dataType: 'DINT', dims: [4], constant: true },
      { name: 'U', dataType: 'Other' },
      { name: 'V', dataType: 'Recipe' },
    ];
    const dataTypes = [RECIPE, OTHER];
    const v = (rung: string) => verifyText({ tags, dataTypes, rungs: [rung] });
    expect(v('COP 5 Dst 1 ;')).toMatch(/COP, Operand 0: Immediate value not allowed/);
    expect(v('COP Src 5 1 ;')).toMatch(/COP, Operand 1: Immediate value not allowed/);
    expect(v('COP Src Dst R ;')).toMatch(/COP, Operand 2: Invalid data type: 'R' is REAL/);
    expect(v('COP Src Dst 1.5 ;')).toMatch(/COP, Operand 2: Invalid data type/);
    expect(v('COP(Src,Dst);')).toMatch(/COP expects 3 operand\(s\), found 2/);
    expect(v('COP Src ? 1 ;')).toMatch(/COP, Operand 1: Missing operand/);
    expect(v('COP Src Dst ? ;')).toMatch(/COP, Operand 2: Missing operand/);
    expect(v('COP Src K 1 ;')).toMatch(/COP, Operand 1: 'K' is read-only/);
    expect(v('COP Src D.3 1 ;')).toMatch(/COP, Operand 1: 'D.3': a bit cannot be used as an array/);
    expect(v('COP T C 1 ;')).toMatch(/COP: .*LogixSim only supports COP between identical structure types/);
    expect(v('COP U V 1 ;')).toMatch(/LogixSim only supports COP between identical structure types/);
    expect(v('COP T D 1 ;')).toMatch(/LogixSim only supports COP between identical structure types/);
    expect(v('COP Src T 1 ;')).toMatch(/LogixSim only supports COP between identical structure types/);
    expect(v('COP Nope Dst 1 ;')).toMatch(/Undefined tag 'Nope'/);
    // valid combinations verify cleanly
    expect(v('COP Src Dst 4 ;')).toBe('');
    expect(v('COP R D 1 ;')).toBe('');
    expect(v('COP V V 1 ;')).toBe('');
  });
});

// ----------------------------------------------------------------------------- FLL

describe('FLL', () => {
  it('fills numeric arrays from an element, clamped at the end', () => {
    const c = run({
      tags: [arr('A', 'DINT', [10], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), arr('B', 'DINT', [5]), arr('Z', 'INT', [4], [5, 5, 5, 5])],
      rungs: ['FLL 7 A[2] 3 ;', 'FLL -4 B[3] 100 ;', 'FLL 0 Z 4 ;'],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.read('A')).toEqual([1, 1, 7, 7, 7, 1, 1, 1, 1, 1]);
    expect(c.read('B')).toEqual([0, 0, 0, -4, -4]);
    expect(c.read('Z')).toEqual([0, 0, 0, 0]);
  });

  it('converts the source to the destination type', () => {
    const c = run({
      tags: [arr('D', 'DINT', [3]), arr('D2', 'DINT', [2]), arr('R', 'REAL', [2]), dint('Big', 16777217), arr('R2', 'REAL', [2]), real('Half', -2.5), arr('I', 'INT', [2]), arr('S', 'SINT', [2])],
      rungs: ['FLL 1.5 D 3 ;', 'FLL 2.5 D2 2 ;', 'FLL 1.5 R 2 ;', 'FLL Big R2 2 ;', 'FLL Half I 2 ;', 'FLL 300 S 2 ;'],
    });
    scans(c);
    expect(c.read('D')).toEqual([2, 2, 2]);
    expect(c.read('D2')).toEqual([2, 2]);
    expect(c.read('R')).toEqual([1.5, 1.5]);
    expect(c.read('R2')).toEqual([16777216, 16777216]);
    expect(c.read('I')).toEqual([-2, -2]);
    expect(c.read('S')).toEqual([44, 44]);
  });

  it('fills a scalar destination', () => {
    const c = run({ tags: [dint('X', 3), real('Y')], rungs: ['FLL 42 X 1 ;', 'FLL 0.25 Y 5 ;'] });
    scans(c);
    expect(c.readNumber('X')).toBe(42);
    expect(c.readNumber('Y')).toBe(0.25);
  });

  it('fills structure arrays with deep copies of a structure', () => {
    const c = run({
      dataTypes: [RECIPE],
      tags: [
        { name: 'Proto', dataType: 'Recipe', value: recipeValue(5) },
        { name: 'Recs', dataType: 'Recipe', dims: [4] },
        timer('T0'),
        { name: 'Timers', dataType: 'TIMER', dims: [3] },
        dint('Step'),
      ],
      rungs: ['FLL Proto Recs[1] 10 ;', 'FLL T0 Timers 3 ;', 'MOV Recs[3].Steps[2] Step ;'],
    });
    c.write('T0', { PRE: 250, ACC: 0, EN: 0, TT: 0, DN: 1 });
    scans(c);
    const proto = c.read('Proto');
    const empty = { Speed: 0, Temp: 0, Enabled: 0, Steps: [0, 0, 0], Hold: { PRE: 0, ACC: 0, EN: 0, TT: 0, DN: 0 } };
    expect(c.read('Recs')).toEqual([empty, proto, proto, proto]);
    expect(c.readNumber('Step')).toBe(7);
    expect(c.read('Timers')).toEqual([0, 1, 2].map(() => ({ PRE: 250, ACC: 0, EN: 0, TT: 0, DN: 1 })));
    // deep copies: elements are independent of the source and of each other
    c.write('Recs[1].Steps[0]', 123);
    expect(c.readNumber('Recs[2].Steps[0]')).toBe(5);
    expect(c.readNumber('Proto.Steps[0]')).toBe(5);
  });

  it('fills from an element of the same structure array', () => {
    const c = run({
      dataTypes: [RECIPE],
      tags: [{ name: 'Recs', dataType: 'Recipe', dims: [4], value: [recipeValue(1), recipeValue(2), recipeValue(3), recipeValue(4)] }],
      rungs: ['FLL Recs[2] Recs[0] 4 ;'],
    });
    const before = c.read('Recs') as unknown[];
    scans(c);
    expect(c.read('Recs')).toEqual([before[2], before[2], before[2], before[2]]);
  });

  it('executes every scan while true and does nothing when false', () => {
    const c = run({ tags: [bool('Go'), dint('V', 3), arr('A', 'DINT', [3], [9, 9, 9])], rungs: ['XIC Go FLL V A 3 ;'] });
    scans(c);
    expect(c.read('A')).toEqual([9, 9, 9]);
    c.write('Go', 1);
    scans(c);
    expect(c.read('A')).toEqual([3, 3, 3]);
    c.write('V', 4);
    scans(c);
    expect(c.read('A')).toEqual([4, 4, 4]);
    c.write('Go', 0);
    c.write('V', 5);
    scans(c);
    expect(c.read('A')).toEqual([4, 4, 4]);
  });

  it('takes the length from a tag, length 0 fills nothing, negative length faults', () => {
    const c = run({ tags: [dint('Len', 0), arr('A', 'DINT', [3], [9, 9, 9])], rungs: ['FLL 1 A Len ;'] });
    scans(c);
    expect(c.read('A')).toEqual([9, 9, 9]);
    c.write('Len', 2);
    scans(c);
    expect(c.read('A')).toEqual([1, 1, 9]);
    c.write('Len', -2);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, instruction: 'FLL' });
  });

  it('uses a dynamic destination index and faults when it is out of range', () => {
    const c = run({ tags: [dint('Idx', 2), arr('A', 'DINT', [4])], rungs: ['FLL 6 A[Idx] 9 ;'] });
    scans(c);
    expect(c.read('A')).toEqual([0, 0, 6, 6]);
    c.write('Idx', 4);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20 });
  });

  it('reports verify errors', () => {
    const tags: TagDef[] = [
      arr('A', 'DINT', [4]),
      real('R'),
      timer('T'),
      counter('C'),
      { name: 'Timers', dataType: 'TIMER', dims: [2] },
      { name: 'Recs', dataType: 'Recipe', dims: [2] },
      { name: 'U', dataType: 'Other' },
      { name: 'K', dataType: 'DINT', dims: [4], constant: true },
    ];
    const v = (rung: string) => verifyText({ tags, dataTypes: [RECIPE, OTHER], rungs: [rung] });
    expect(v('FLL 1 5 1 ;')).toMatch(/FLL, Operand 1: Immediate value not allowed/);
    expect(v('FLL T A 1 ;')).toMatch(/FLL, Operand 0: Invalid data type: 'T' is TIMER/);
    expect(v('FLL C Timers 2 ;')).toMatch(/FLL, Operand 0: Invalid data type: Source 'C' is COUNTER/);
    expect(v('FLL U Recs 2 ;')).toMatch(/FLL, Operand 0: Invalid data type: Source 'U' is Other/);
    expect(v('FLL 0 Timers 2 ;')).toMatch(/FLL, Operand 0: Invalid data type: Source '0' is DINT/);
    expect(v('FLL Timers T 1 ;')).toMatch(/FLL, Operand 0: Invalid data type: Source 'Timers' is an array of TIMER/);
    expect(v('FLL 1 A R ;')).toMatch(/FLL, Operand 2: Invalid data type: 'R' is REAL/);
    expect(v('FLL 1 K 1 ;')).toMatch(/FLL, Operand 1: 'K' is read-only/);
    expect(v('FLL(1,A);')).toMatch(/FLL expects 3 operand\(s\), found 2/);
    expect(v('FLL ? A 1 ;')).toMatch(/FLL, Operand 0: Missing operand/);
    expect(v('FLL 1 A ? ;')).toMatch(/FLL, Operand 2: Missing operand/);
    // valid
    expect(v('FLL T Timers 2 ;')).toBe('');
    expect(v('FLL R A 4 ;')).toBe('');
  });
});

// ----------------------------------------------------------------------------- performance

describe('move/logical performance', () => {
  it('scans 200 move/logical rungs in well under a millisecond', () => {
    const tags: TagDef[] = [dint('A', 5), dint('B', 0x0f0f), real('R', 1.25), arr('Arr', 'DINT', [16]), arr('Buf', 'DINT', [16]), arr('Ints', 'INT', [32])];
    const kinds = ['MOV A Arr[3] ;', 'AND A B Arr[4] ;', 'OR A B Arr[5] ;', 'XOR A B Arr[6] ;', 'NOT A Arr[7] ;', 'MVM A B Arr[8] ;', 'COP Arr Buf 16 ;', 'FLL R Arr[10] 4 ;', 'COP Buf Ints[0] 32 ;', 'CLR Arr[15] ;'];
    const rungs: string[] = [];
    for (let i = 0; i < 200; i++) rungs.push(kinds[i % kinds.length]);
    const c = run({ tags, rungs });
    scans(c, 200); // warm up the JIT
    let best = Infinity;
    for (let k = 0; k < 20; k++) {
      scans(c);
      best = Math.min(best, c.stats.lastScanUs);
    }
    expect(c.mode).toBe('RUN');
    expect(best).toBeLessThan(1000);
  });
});
