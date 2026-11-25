import { describe, it, expect } from 'vitest';
import { run, scans, verifyErrors, bool, dint, int, sint, real, timer, counter, arr } from './helpers';
import type { TagDef } from '../index';
import { getInstruction } from '../ladder/instructions';
import { compareInstructions } from '../ladder/instructions/compare';

/** Run `cond OTE Out ;` for one scan and return Out. */
function rungResult(cond: string, tags: TagDef[] = []): boolean {
  const c = run({ tags: [...tags, bool('Out')], rungs: [`${cond} OTE Out ;`] });
  scans(c);
  return c.readBool('Out');
}

const verifyText = (setup: Parameters<typeof verifyErrors>[0]) =>
  verifyErrors(setup)
    .map((e) => e.message)
    .join('\n');

type BinOp = 'EQU' | 'NEQ' | 'LES' | 'LEQ' | 'GRT' | 'GEQ';
const OPS: Record<BinOp, (a: number, b: number) => boolean> = {
  EQU: (a, b) => a === b,
  NEQ: (a, b) => a !== b,
  LES: (a, b) => a < b,
  LEQ: (a, b) => a <= b,
  GRT: (a, b) => a > b,
  GEQ: (a, b) => a >= b,
};
const OP_NAMES = Object.keys(OPS) as BinOp[];

describe('compare instruction definitions', () => {
  it('registers all compare instructions with Compare metadata', () => {
    const expected: Record<string, string> = {
      EQU: 'Equal',
      NEQ: 'Not Equal',
      LES: 'Less Than',
      LEQ: 'Less Than or Equal',
      GRT: 'Greater Than',
      GEQ: 'Greater Than or Equal',
      LIM: 'Limit',
      CMP: 'Compare',
    };
    expect(compareInstructions.map((d) => d.mnemonic).sort()).toEqual(Object.keys(expected).sort());
    for (const [m, title] of Object.entries(expected)) {
      const d = getInstruction(m);
      expect(d, m).toBeDefined();
      expect(d!.category).toBe('Compare');
      expect(d!.title).toBe(title);
      expect(d!.kind).toBe('input');
      expect(d!.box).toBe(true);
    }
    expect(getInstruction('EQU')!.operands.map((o) => o.name)).toEqual(['Source A', 'Source B']);
    expect(getInstruction('LIM')!.operands.map((o) => o.name)).toEqual(['Low Limit', 'Test', 'High Limit']);
    expect(getInstruction('CMP')!.operands.map((o) => o.name)).toEqual(['Expression']);
    expect(getInstruction('CMP')!.operands[0].kind).toBe('expression');
  });
});

describe('EQU / NEQ / LES / LEQ / GRT / GEQ', () => {
  // (A, B) pairs covering less, equal, greater and negative values
  const pairs: [number, number][] = [
    [-5, 3],
    [3, 3],
    [3, -5],
    [-7, -7],
    [-8, -7],
    [0, 0],
  ];
  const typeCases: { label: string; mk: (n: string, v: number) => TagDef; pairs: [number, number][] }[] = [
    { label: 'DINT', mk: dint, pairs: [...pairs, [-2147483648, 2147483647], [2147483647, 2147483646], [2147483647, 2147483647]] },
    { label: 'INT', mk: int, pairs: [...pairs, [-32768, 32767], [32767, 32767]] },
    { label: 'SINT', mk: sint, pairs: [...pairs, [-128, 127], [127, -128]] },
    { label: 'REAL', mk: real, pairs: [...pairs, [1.5, 1.25], [-0.5, -0.5], [0.1, 0.2]] },
  ];

  for (const tc of typeCases) {
    for (const op of OP_NAMES) {
      it(`${op} with ${tc.label} tags`, () => {
        for (const [a, b] of tc.pairs) {
          const got = rungResult(`${op} A B`, [tc.mk('A', a), tc.mk('B', b)]);
          const fa = tc.label === 'REAL' ? Math.fround(a) : a;
          const fb = tc.label === 'REAL' ? Math.fround(b) : b;
          expect(got, `${op} ${a} ${b}`).toBe(OPS[op](fa, fb));
        }
      });
    }
  }

  it('compares mixed integer types (SINT vs INT vs DINT) exactly', () => {
    const tags = [sint('S', -100), int('I', -100), dint('D', 30000), int('J', 30000)];
    expect(rungResult('EQU S I', tags)).toBe(true);
    expect(rungResult('NEQ S I', tags)).toBe(false);
    expect(rungResult('EQU D J', tags)).toBe(true);
    expect(rungResult('GRT D S', tags)).toBe(true);
    expect(rungResult('LES S D', tags)).toBe(true);
    expect(rungResult('GEQ I S', tags)).toBe(true);
    expect(rungResult('LEQ J D', tags)).toBe(true);
  });

  it('integer compare keeps full DINT precision', () => {
    const tags = [dint('A', 16777217), dint('B', 16777216)];
    expect(rungResult('EQU A B', tags)).toBe(false);
    expect(rungResult('GRT A B', tags)).toBe(true);
    expect(rungResult('NEQ A 16777216', tags)).toBe(true);
  });

  it('mixed DINT/REAL compares as REAL (integer converted to single precision first)', () => {
    const tags = [dint('D', 16777217), real('R', 16777216.0)];
    expect(rungResult('EQU D R', tags)).toBe(true);
    expect(rungResult('EQU R D', tags)).toBe(true);
    expect(rungResult('NEQ D R', tags)).toBe(false);
    expect(rungResult('GRT D R', tags)).toBe(false);
    expect(rungResult('GEQ D R', tags)).toBe(true);
    expect(rungResult('LEQ R D', tags)).toBe(true);
    // DINT literal against a REAL tag
    expect(rungResult('EQU R 16777217', tags)).toBe(true);
    expect(rungResult('EQU 16777217 R', tags)).toBe(true);
    // DINT tag against a REAL literal
    expect(rungResult('EQU D 16777216.0', tags)).toBe(true);
    expect(rungResult('LES D 16777216.0', tags)).toBe(false);
    // DINT max rounds to 2^31 as REAL
    expect(rungResult('EQU M 2147483648.0', [dint('M', 2147483647)])).toBe(true);
  });

  it('mixed SINT/INT with REAL', () => {
    const tags = [sint('S', -3), int('I', 250), real('R', -3.0), real('H', 250.5)];
    expect(rungResult('EQU S R', tags)).toBe(true);
    expect(rungResult('LES I H', tags)).toBe(true);
    expect(rungResult('GRT H I', tags)).toBe(true);
    expect(rungResult('NEQ I H', tags)).toBe(true);
    expect(rungResult('GEQ S -2.5', tags)).toBe(false);
    expect(rungResult('LES S -2.5', tags)).toBe(true);
  });

  it('integer tag against a fractional REAL literal does not truncate the literal', () => {
    expect(rungResult('EQU A 2.5', [dint('A', 2)])).toBe(false);
    expect(rungResult('GRT A 2.5', [dint('A', 3)])).toBe(true);
    expect(rungResult('LES A 2.5', [dint('A', 2)])).toBe(true);
    expect(rungResult('EQU A 2.0', [dint('A', 2)])).toBe(true);
  });

  it('accepts literals in either position, negatives, hex and both-literal operands', () => {
    const tags = [dint('A', -10)];
    expect(rungResult('LES A -5', tags)).toBe(true);
    expect(rungResult('LES -5 A', tags)).toBe(false);
    expect(rungResult('GRT -5 A', tags)).toBe(true);
    expect(rungResult('EQU -10 A', tags)).toBe(true);
    expect(rungResult('EQU H 16#FF', [dint('H', 255)])).toBe(true);
    expect(rungResult('EQU 5 5')).toBe(true);
    expect(rungResult('EQU 5 6')).toBe(false);
    expect(rungResult('GEQ 2.5 2')).toBe(true);
    expect(rungResult('LES 2 2.5')).toBe(true);
  });

  it('accepts the paren rung form', () => {
    const c = run({ tags: [dint('A', 4), bool('Out')], rungs: ['GRT(A,3)OTE(Out);'] });
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });

  it('reads structure members (TIMER.ACC, COUNTER.PRE) and array elements', () => {
    const tags: TagDef[] = [
      { name: 'T1', dataType: 'TIMER', value: { ACC: 1500 } },
      { name: 'C1', dataType: 'COUNTER', value: { PRE: 7, ACC: 7 } },
      arr('Vals', 'DINT', [4], [1, 2, 3, 4]),
      dint('Idx', 2),
    ];
    expect(rungResult('GEQ T1.ACC 1500', tags)).toBe(true);
    expect(rungResult('EQU C1.ACC C1.PRE', tags)).toBe(true);
    expect(rungResult('EQU Vals[3] 4', tags)).toBe(true);
    expect(rungResult('EQU Vals[Idx] 3', tags)).toBe(true);
  });

  it('follows tag changes scan by scan', () => {
    const c = run({ tags: [dint('Level', 0), bool('High')], rungs: ['GRT Level 50 OTE High ;'] });
    scans(c);
    expect(c.readBool('High')).toBe(false);
    c.write('Level', 51);
    scans(c);
    expect(c.readBool('High')).toBe(true);
    c.write('Level', 50);
    scans(c);
    expect(c.readBool('High')).toBe(false);
  });

  it('is false whenever the rung-condition-in is false', () => {
    const c = run({
      tags: [bool('En'), dint('A', 1), dint('B', 1), bool('Out')],
      rungs: ['XIC En EQU A B OTE Out ;'],
    });
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('En', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    c.write('En', 0);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
  });

  it('does not read operands on a false rung (no subscript fault), faults on a true rung', () => {
    const c = run({
      tags: [bool('En'), arr('Vals', 'DINT', [4]), dint('Idx', 10), bool('Out')],
      rungs: ['XIC En [EQU Vals[Idx] 0 ,LIM 0 Vals[Idx] 5 ] OTE Out ;'],
    });
    scans(c, 3);
    expect(c.mode).toBe('RUN');
    c.write('En', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect([c.majorFault!.type, c.majorFault!.code]).toEqual([4, 20]);
    expect(c.majorFault!.instruction).toBe('EQU');
  });

  it('does not change the arithmetic status flags', () => {
    const c = run({
      tags: [dint('A', 0), dint('B', -1), bool('Out'), bool('Z'), bool('N'), bool('V')],
      rungs: [
        'OTL S:Z OTU S:N OTL S:V ;',
        'EQU A 0 LES B 0 GRT A B NEQ A B LIM -1 A 1 OTE Out ;',
        'XIC S:Z OTE Z ;',
        'XIC S:N OTE N ;',
        'XIC S:V OTE V ;',
      ],
    });
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    expect(c.readBool('Z')).toBe(true);
    expect(c.readBool('N')).toBe(false);
    expect(c.readBool('V')).toBe(true);
  });
});

describe('LIM', () => {
  it('normal range (Low <= High) is inclusive at both limits', () => {
    const cases: [number, boolean][] = [
      [-1, false],
      [0, true],
      [1, true],
      [50, true],
      [99, true],
      [100, true],
      [101, false],
    ];
    for (const [t, want] of cases) {
      expect(rungResult('LIM 0 T 100', [dint('T', t)]), `test ${t}`).toBe(want);
      // limits as tags give the same result
      expect(rungResult('LIM Lo T Hi', [dint('Lo', 0), dint('T', t), dint('Hi', 100)]), `tags ${t}`).toBe(want);
    }
  });

  it('circular range (Low > High) is true at or above Low or at or below High', () => {
    const cases: [number, boolean][] = [
      [-10, true],
      [0, true],
      [1, false],
      [50, false],
      [99, false],
      [100, true],
      [150, true],
    ];
    for (const [t, want] of cases) {
      expect(rungResult('LIM 100 T 0', [dint('T', t)]), `test ${t}`).toBe(want);
      expect(rungResult('LIM Lo T Hi', [dint('Lo', 100), dint('T', t), dint('Hi', 0)]), `tags ${t}`).toBe(want);
    }
  });

  it('Low == High matches only that value', () => {
    expect(rungResult('LIM 5 T 5', [dint('T', 5)])).toBe(true);
    expect(rungResult('LIM 5 T 5', [dint('T', 4)])).toBe(false);
    expect(rungResult('LIM 5 T 5', [dint('T', 6)])).toBe(false);
  });

  it('negative limits', () => {
    expect(rungResult('LIM -20 T -10', [int('T', -15)])).toBe(true);
    expect(rungResult('LIM -20 T -10', [int('T', -21)])).toBe(false);
    expect(rungResult('LIM -20 T -10', [int('T', -9)])).toBe(false);
    // circular with negative limits: Low -10 > High -20
    expect(rungResult('LIM -10 T -20', [sint('T', -15)])).toBe(false);
    expect(rungResult('LIM -10 T -20', [sint('T', -20)])).toBe(true);
    expect(rungResult('LIM -10 T -20', [sint('T', -10)])).toBe(true);
    expect(rungResult('LIM -10 T -20', [sint('T', 0)])).toBe(true);
  });

  it('switches between normal and circular when the limit tags change at run time', () => {
    const c = run({
      tags: [dint('Lo', 10), dint('T', 20), dint('Hi', 30), bool('Out')],
      rungs: ['LIM Lo T Hi OTE Out ;'],
    });
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    // circular: 30 > 10 -> true only for T >= 30 or T <= 10
    c.write('Lo', 30);
    c.write('Hi', 10);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('T', 10);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    c.write('T', 30);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });

  it('REAL and mixed operands', () => {
    expect(rungResult('LIM 0.0 R 1.5', [real('R', 1.5)])).toBe(true);
    expect(rungResult('LIM 0.0 R 1.5', [real('R', 1.5000001)])).toBe(false);
    expect(rungResult('LIM 0.0 R 1.5', [real('R', -0.001)])).toBe(false);
    expect(rungResult('LIM 0.5 D 1.5', [dint('D', 1)])).toBe(true);
    expect(rungResult('LIM 0.5 D 1.5', [dint('D', 2)])).toBe(false);
    expect(rungResult('LIM 1 R 2', [real('R', 1.75)])).toBe(true);
    // integer test converted to REAL when a limit is REAL
    expect(rungResult('LIM 16777216.0 D 16777216.0', [dint('D', 16777217)])).toBe(true);
    // all-integer LIM keeps DINT precision
    expect(rungResult('LIM 16777216 D 16777216', [dint('D', 16777217)])).toBe(false);
    // circular REAL range
    expect(rungResult('LIM 350.0 Ang 10.0', [real('Ang', 355.5)])).toBe(true);
    expect(rungResult('LIM 350.0 Ang 10.0', [real('Ang', 5.25)])).toBe(true);
    expect(rungResult('LIM 350.0 Ang 10.0', [real('Ang', 180)])).toBe(false);
  });

  it('literal Test with tag limits', () => {
    expect(rungResult('LIM Lo 5 Hi', [dint('Lo', 0), dint('Hi', 10)])).toBe(true);
    expect(rungResult('LIM Lo 50 Hi', [dint('Lo', 0), dint('Hi', 10)])).toBe(false);
  });

  it('paren form and false rung', () => {
    const c = run({ tags: [bool('En'), dint('T', 5), bool('Out')], rungs: ['XIC(En)LIM(0,T,10)OTE(Out);'] });
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('En', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });
});

describe('CMP', () => {
  it('arithmetic comparison in spaced form: CMP A+B>C*2', () => {
    const tags = (a: number, b: number, cc: number) => [dint('A', a), dint('B', b), dint('C', cc)];
    expect(rungResult('CMP A+B>C*2', tags(3, 4, 3))).toBe(true);
    expect(rungResult('CMP A+B>C*2', tags(3, 3, 3))).toBe(false);
    expect(rungResult('CMP A+B>C*2', tags(-3, -4, -4))).toBe(true);
  });

  it('logical expression: (A=1) AND (B<>2)', () => {
    const t = (a: number, b: number) => [dint('A', a), dint('B', b)];
    expect(rungResult('CMP((A=1) AND (B<>2))', t(1, 3))).toBe(true);
    expect(rungResult('CMP((A=1) AND (B<>2))', t(1, 2))).toBe(false);
    expect(rungResult('CMP((A=1) AND (B<>2))', t(0, 3))).toBe(false);
    // whitespace before '(' still reads as the paren form
    expect(rungResult('CMP ((A=1) AND (B<>2))', t(1, 3))).toBe(true);
    expect(rungResult('CMP((A=1)OR(B=2))', t(0, 2))).toBe(true);
    expect(rungResult('CMP((A=1)OR(B=2))', t(0, 0))).toBe(false);
    // spaced form without spaces in the expression
    expect(rungResult('CMP A<>B-1', t(1, 3))).toBe(true);
    expect(rungResult('CMP A<>B-1', t(1, 2))).toBe(false);
  });

  it('function calls: ABS, SQRT', () => {
    expect(rungResult('CMP ABS(X)>10', [dint('X', -11)])).toBe(true);
    expect(rungResult('CMP ABS(X)>10', [dint('X', -10)])).toBe(false);
    expect(rungResult('CMP ABS(R)<=0.5', [real('R', -0.5)])).toBe(true);
    expect(rungResult('CMP SQRT(X)=4.0', [dint('X', 16)])).toBe(true);
  });

  it('REAL and mixed expressions', () => {
    expect(rungResult('CMP R*2.0>=3.0', [real('R', 1.5)])).toBe(true);
    expect(rungResult('CMP R*2.0>=3.0', [real('R', 1.25)])).toBe(false);
    expect(rungResult('CMP D=R', [dint('D', 16777217), real('R', 16777216.0)])).toBe(true);
    expect(rungResult('CMP D/2=2', [dint('D', 5)])).toBe(true);
  });

  it('non-comparison expression: nonzero is true, zero is false', () => {
    expect(rungResult('CMP A', [dint('A', 7)])).toBe(true);
    expect(rungResult('CMP A', [dint('A', -1)])).toBe(true);
    expect(rungResult('CMP A', [dint('A', 0)])).toBe(false);
    expect(rungResult('CMP A-B', [dint('A', 5), dint('B', 5)])).toBe(false);
    // bitwise AND on integers: nonzero result is true
    expect(rungResult('CMP(A AND 4)', [dint('A', 6)])).toBe(true);
    expect(rungResult('CMP(A AND 4)', [dint('A', 3)])).toBe(false);
  });

  it('REAL nonzero result is true', () => {
    expect(rungResult('CMP R', [real('R', 0.25)])).toBe(true);
    expect(rungResult('CMP R', [real('R', 0)])).toBe(false);
    expect(rungResult('CMP R*0.5', [real('R', 1e-30)])).toBe(true);
  });

  it('constant expressions', () => {
    expect(rungResult('CMP 1=1')).toBe(true);
    expect(rungResult('CMP 1=2')).toBe(false);
    expect(rungResult('CMP(2*3>5)')).toBe(true);
  });

  it('BOOL operands inside the expression', () => {
    expect(rungResult('CMP(F AND NOT G)', [bool('F', 1), bool('G', 0)])).toBe(true);
    expect(rungResult('CMP(F AND NOT G)', [bool('F', 1), bool('G', 1)])).toBe(false);
  });

  it('divide by zero on a FALSE rung does not evaluate or fault', () => {
    const c = run({
      tags: [bool('En'), dint('A', 10), dint('B', 0), bool('Out')],
      rungs: ['XIC En CMP A/B>0 OTE Out ;'],
    });
    scans(c, 5);
    expect(c.mode).toBe('RUN');
    expect(c.majorFault).toBeNull();
    expect(c.readBool('Out')).toBe(false);
    expect(c.minorFaults.length).toBe(0);
  });

  it('divide by zero on a TRUE rung is a major fault (type 4 code 4)', () => {
    const c = run({
      tags: [bool('En'), dint('A', 10), dint('B', 0), bool('Out')],
      rungs: ['XIC En OTE Out ;', 'XIC En CMP A/B>0 OTE Out ;'],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    c.write('En', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).not.toBeNull();
    expect(c.majorFault!.type).toBe(4);
    expect(c.majorFault!.code).toBe(4);
    expect(c.majorFault!.rung).toBe(1);
    expect(c.majorFault!.instruction).toBe('CMP');
  });

  it('REAL divide by zero and MOD by zero on a TRUE rung fault', () => {
    const c1 = run({ tags: [real('R', 1), real('Z', 0), bool('Out')], rungs: ['CMP R/Z>0 OTE Out ;'] });
    scans(c1);
    expect(c1.mode).toBe('FAULTED');
    expect([c1.majorFault!.type, c1.majorFault!.code]).toEqual([4, 4]);
    const c2 = run({ tags: [dint('A', 1), dint('Z', 0), bool('Out')], rungs: ['CMP(A MOD Z=0)OTE(Out);'] });
    scans(c2);
    expect(c2.mode).toBe('FAULTED');
    expect([c2.majorFault!.type, c2.majorFault!.code]).toEqual([4, 4]);
  });

  it('constant divide by zero faults at run time on a true rung only', () => {
    const c = run({ tags: [bool('En'), bool('Out')], rungs: ['XIC En CMP 1/0=0 OTE Out ;'] });
    scans(c, 2);
    expect(c.mode).toBe('RUN');
    c.write('En', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect([c.majorFault!.type, c.majorFault!.code]).toEqual([4, 4]);
  });

  it('array subscripts in the expression', () => {
    const tags = [arr('V', 'DINT', [3], [5, 10, 15]), dint('I', 1)];
    expect(rungResult('CMP V[I]+V[2]=25', tags)).toBe(true);
    expect(rungResult('CMP V[I+1]=15', tags)).toBe(true);
  });
});

describe('compares in rung logic', () => {
  it('compares in series AND together', () => {
    const c = run({ tags: [dint('A', 0), bool('Out')], rungs: ['GRT A 0 LES A 10 OTE Out ;'] });
    const at = (v: number) => {
      c.write('A', v);
      scans(c);
      return c.readBool('Out');
    };
    expect(at(0)).toBe(false);
    expect(at(1)).toBe(true);
    expect(at(9)).toBe(true);
    expect(at(10)).toBe(false);
    expect(at(-3)).toBe(false);
  });

  it('series of different compares and a CMP', () => {
    const c = run({
      tags: [dint('A', 5), real('R', 2.5), bool('Out')],
      rungs: ['NEQ A 0 GEQ R 2.5 LIM 0 A 10 CMP A*R>12.0 OTE Out ;'],
    });
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    c.write('R', 2.25);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
  });

  it('compares in parallel branches OR together', () => {
    const c = run({ tags: [dint('Sel', 0), bool('Out')], rungs: ['[EQU Sel 1 ,EQU Sel 3 ,LIM 10 Sel 20 ] OTE Out ;'] });
    const at = (v: number) => {
      c.write('Sel', v);
      scans(c);
      return c.readBool('Out');
    };
    expect(at(0)).toBe(false);
    expect(at(1)).toBe(true);
    expect(at(2)).toBe(false);
    expect(at(3)).toBe(true);
    expect(at(15)).toBe(true);
    expect(at(21)).toBe(false);
  });

  it('compares on output branch legs drive separate coils', () => {
    const c = run({
      tags: [bool('En', 1), dint('Lvl', 0), bool('Lo'), bool('Ok'), bool('Hi')],
      rungs: ['XIC En [LES Lvl 10 OTE Lo ,LIM 10 Lvl 90 OTE Ok ,GRT Lvl 90 OTE Hi ] ;'],
    });
    const state = (v: number) => {
      c.write('Lvl', v);
      scans(c);
      return [c.readBool('Lo'), c.readBool('Ok'), c.readBool('Hi')];
    };
    expect(state(5)).toEqual([true, false, false]);
    expect(state(10)).toEqual([false, true, false]);
    expect(state(90)).toEqual([false, true, false]);
    expect(state(91)).toEqual([false, false, true]);
    c.write('En', 0);
    scans(c);
    expect([c.readBool('Lo'), c.readBool('Ok'), c.readBool('Hi')]).toEqual([false, false, false]);
  });

  it('a false compare de-energizes the OTE after it was true', () => {
    const c = run({ tags: [dint('A', 1), bool('Out')], rungs: ['EQU A 1 OTE Out ;'] });
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    c.write('A', 2);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
  });

  it('compares with a timer member written at run time', () => {
    const c = run({ tags: [timer('T1'), bool('Mid')], rungs: ['LIM 300 T1.ACC 600 OTE Mid ;'] });
    const at = (acc: number) => {
      c.write('T1.ACC', acc);
      scans(c);
      return c.readBool('Mid');
    };
    expect(at(299)).toBe(false);
    expect(at(300)).toBe(true);
    expect(at(600)).toBe(true);
    expect(at(601)).toBe(false);
  });

  it('a compare cannot end a rung', () => {
    expect(verifyText({ tags: [dint('A')], rungs: ['EQU A 1 ;'] })).toMatch(/must end with an output/);
    expect(verifyText({ tags: [dint('A')], rungs: ['CMP A>1 ;'] })).toMatch(/must end with an output/);
  });

  it('scans a 200-rung compare program quickly', () => {
    const rungs: string[] = [];
    for (let i = 0; i < 200; i++) rungs.push(`GRT A ${i} LES A 1000 LIM 0 B 100 NEQ R 0.0 OTE Outs[${i}] ;`);
    const c = run({ tags: [dint('A', 100), dint('B', 50), real('R', 1.5), arr('Outs', 'BOOL', [200])], rungs });
    scans(c, 50); // warm up
    const t0 = performance.now();
    const n = 200;
    scans(c, n);
    const perScanMs = (performance.now() - t0) / n;
    expect(c.readBool('Outs[99]')).toBe(true);
    expect(c.readBool('Outs[100]')).toBe(false);
    expect(perScanMs).toBeLessThan(1);
  });
});

describe('compare verify errors', () => {
  it('TIMER / COUNTER structure as a source is rejected', () => {
    const tags = [timer('T1'), counter('C1'), bool('Out')];
    expect(verifyText({ tags, rungs: ['EQU T1 5 OTE Out ;'] })).toMatch(/Invalid data type.*TIMER/);
    expect(verifyText({ tags, rungs: ['LIM 0 C1 10 OTE Out ;'] })).toMatch(/Invalid data type.*COUNTER/);
    expect(verifyText({ tags, rungs: ['GRT 5 T1 OTE Out ;'] })).toMatch(/Operand 1.*Invalid data type/);
    // members are fine
    expect(verifyErrors({ tags, rungs: ['EQU T1.ACC 5 OTE Out ;'] })).toEqual([]);
  });

  it('array, BOOL and undefined tags as sources are rejected', () => {
    const tags = [arr('Arr', 'DINT', [5]), bool('Flag'), bool('Out')];
    expect(verifyText({ tags, rungs: ['EQU Arr 5 OTE Out ;'] })).toMatch(/Invalid data type/);
    expect(verifyText({ tags, rungs: ['NEQ Flag 1 OTE Out ;'] })).toMatch(/BOOL/);
    expect(verifyText({ tags, rungs: ['LES Nope 1 OTE Out ;'] })).toMatch(/Undefined tag 'Nope'/);
    expect(verifyText({ tags, rungs: ['LIM 0 1 Nope OTE Out ;'] })).toMatch(/Operand 2.*Undefined tag 'Nope'/);
  });

  it('missing operands are reported', () => {
    const tags = [dint('A'), bool('Out')];
    expect(verifyText({ tags, rungs: ['EQU A ? OTE Out ;'] })).toMatch(/EQU, Operand 1: Missing operand/);
    expect(verifyText({ tags, rungs: ['LIM 0 ? 10 OTE Out ;'] })).toMatch(/LIM, Operand 1: Missing operand/);
    expect(verifyText({ tags, rungs: ['GEQ(A,)OTE(Out);'] })).toMatch(/Missing operand/);
    expect(verifyText({ tags, rungs: ['GEQ(A)OTE(Out);'] })).toMatch(/GEQ expects 2 operand/);
    expect(verifyText({ tags, rungs: ['LIM(0,A)OTE(Out);'] })).toMatch(/LIM expects 3 operand/);
    expect(verifyText({ tags, rungs: ['CMP(?)OTE(Out);'] })).toMatch(/CMP, Operand 0: Missing operand/);
    expect(verifyText({ tags, rungs: ['CMP()OTE(Out);'] })).toMatch(/CMP expects 1 operand/);
  });

  it('DINT literal out of range is rejected', () => {
    expect(verifyText({ tags: [dint('A'), bool('Out')], rungs: ['EQU A 3000000000 OTE Out ;'] })).toMatch(/out of DINT range/);
  });

  it('bad CMP expression syntax is reported', () => {
    const tags = [dint('A'), dint('B'), bool('Out')];
    expect(verifyText({ tags, rungs: ['CMP(A+>B)OTE(Out);'] })).toMatch(/CMP, Operand 0: Invalid expression/);
    expect(verifyText({ tags, rungs: ['CMP(A>(B)OTE(Out);'] })).not.toBe('');
    expect(verifyText({ tags, rungs: ['CMP(A>B B)OTE(Out);'] })).toMatch(/Invalid expression/);
  });

  it('undefined tag or unknown function inside the CMP expression is reported', () => {
    const tags = [dint('A'), bool('Out')];
    expect(verifyText({ tags, rungs: ['CMP A+Nope>3 OTE Out ;'] })).toMatch(/CMP, Operand 0: .*Undefined tag 'Nope'/);
    expect(verifyText({ tags, rungs: ['CMP FOO(A)>3 OTE Out ;'] })).toMatch(/Unknown function 'FOO'/);
  });

  it('REAL operand to AND inside CMP is a verify error', () => {
    expect(verifyText({ tags: [real('R'), bool('Out')], rungs: ['CMP(R AND 1)OTE(Out);'] })).toMatch(/AND requires BOOL or integer/);
  });

  it('valid compare rungs verify cleanly', () => {
    const tags = [dint('A'), int('I'), sint('S'), real('R'), bool('Out')];
    expect(
      verifyErrors({
        tags,
        rungs: ['EQU A I NEQ S R LES 1 A LEQ R 2.5 GRT A -1 GEQ I S OTE Out ;', 'LIM 0 R 10 LIM R A 1.5 CMP A+I*S>R OTE Out ;'],
      }),
    ).toEqual([]);
  });
});
