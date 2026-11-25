import { describe, it, expect } from 'vitest';
import { run, load, scans, bool, dint, counter, arr, type LadderSetup } from './helpers';
import type { Controller, RoutineDef } from '../index';

const rll = (name: string, ...rungs: string[]): RoutineDef => ({ name, type: 'RLL', rungs: rungs.map((text) => ({ text })) });

/** Download + Run + one scan; null when the project is rejected at verify/download. */
function tryRun(setup: LadderSetup): Controller | null {
  let c: Controller;
  try {
    c = run(setup);
  } catch {
    return null;
  }
  scans(c);
  return c;
}

const faulted31 = (c: Controller) => c.mode === 'FAULTED' && c.majorFault?.type === 4 && c.majorFault?.code === 31;

describe('regression: Logix program control', () => {
  it('CTL-1: structure/array JSR parameters never leave impossible values in typed tags (mismatch -> 4/31)', () => {
    // REAL[3] -> DINT[3] and DINT[3] (300,-200) -> SINT[3]
    const a = tryRun({
      tags: [arr('R', 'REAL', [3], [1.7, 2.5, -3.2]), arr('D', 'DINT', [3]), arr('DS', 'DINT', [3], [300, -200, 5]), arr('S', 'SINT', [3])],
      rungs: ['JSR Sub 2 R DS ;'],
      routines: [rll('Sub', 'SBR D S ;')],
    });
    if (a && !faulted31(a)) {
      for (const x of a.read('D') as number[]) expect(Number.isInteger(x)).toBe(true);
      for (const x of a.read('S') as number[]) expect(Number.isInteger(x) && x >= -128 && x <= 127).toBe(true);
    }
    // DINT[1] = [2] -> BOOL[32]
    const b = tryRun({
      tags: [arr('BA', 'BOOL', [32]), arr('DA', 'DINT', [1], [2])],
      rungs: ['JSR Sub 1 DA ;'],
      routines: [rll('Sub', 'SBR BA ;')],
    });
    if (b && !faulted31(b)) for (const x of b.read('BA') as number[]) expect(x === 0 || x === 1).toBe(true);
    // TIMER -> COUNTER: no conversion exists, so it must be a parameter mismatch
    const k = tryRun({
      tags: [{ name: 'T', dataType: 'TIMER', value: { PRE: 1500, ACC: 200, DN: 1 } }, counter('K')],
      rungs: ['JSR Sub 1 T ;'],
      routines: [rll('Sub', 'SBR K ;')],
    });
    expect(k === null || faulted31(k)).toBe(true);
  });

  it('CTL-2: a JMP pending on the JSR rung stays local to the caller (no 4/42 in the subroutine, no jump inside it)', () => {
    for (const rung0 of ['XIC A [JMP Skip ,JSR Sub 0 ] ;', 'XIC A JMP Skip JSR Sub 0 ;']) {
      const c = run({
        tags: [bool('A', 1), bool('B'), bool('C'), bool('S')],
        rungs: [rung0, 'OTE B ;', 'LBL Skip OTE C ;'],
        routines: [rll('Sub', 'OTE S ;')],
      });
      scans(c);
      expect(c.majorFault).toBeNull();
      expect(c.mode).toBe('RUN');
      expect(c.readBool('B')).toBe(false);
      expect(c.readBool('C')).toBe(true);
    }
    // the subroutine has a label of the same name: it must not take the caller's jump
    const c = run({
      tags: [bool('A', 1), bool('B'), bool('C'), bool('S1'), bool('S2')],
      rungs: ['XIC A [JMP Skip ,JSR Sub 0 ] ;', 'OTE B ;', 'LBL Skip OTE C ;'],
      routines: [rll('Sub', 'OTE S1 ;', 'LBL Skip OTE S2 ;')],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.readBool('B')).toBe(false);
    expect(c.readBool('C')).toBe(true);
    expect(c.readBool('S1')).toBe(c.readBool('S2'));
  });

  it('CTL-4: TON/CTU with an out-of-range indirect subscript fault 4/20 during prescan, like OTE does', () => {
    const t = load({ tags: [arr('T', 'TIMER', [4]), dint('I', 9), bool('A')], rungs: ['XIC A TON T[I] 100 0 ;'] });
    expect(t.setMode('RUN')).toMatch(/Major fault during prescan: Type 4 Code 20/);
    expect(t.mode).toBe('FAULTED');
    const k = load({ tags: [arr('K', 'COUNTER', [4]), dint('I', 9), bool('A')], rungs: ['XIC A CTU K[I] 10 0 ;'] });
    expect(k.setMode('RUN')).toMatch(/Major fault during prescan: Type 4 Code 20/);
    expect(k.mode).toBe('FAULTED');
  });

  it('CTL-5: a RET with more values than the JSR return parameters ignores the extras (only fewer faults)', () => {
    const c = run({
      tags: [dint('X'), dint('Y', 5), dint('Z', 6)],
      rungs: ['JSR Sub 0 X ;'],
      routines: [rll('Sub', 'RET Y Z ;')],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.readNumber('X')).toBe(5);
  });
});
