import { describe, it, expect } from 'vitest';
import { run, load, scans, bool, dint, timer, counter, control, arr, verifyErrors } from './helpers';
import { getInstruction, DINT_MAX, DINT_MIN, type Controller } from '../index';

type Ctr = { PRE: number; ACC: number; CU: number; CD: number; DN: number; OV: number; UN: number };
const ctr = (c: Controller, path: string): Ctr => c.read(path) as Ctr;
const errorText = (setup: Parameters<typeof verifyErrors>[0]) =>
  verifyErrors(setup)
    .map((e) => e.message)
    .join('\n');

/** Drive a rising edge on a BOOL: one scan low, one scan high. */
function pulse(c: Controller, bit: string, n = 1): void {
  for (let i = 0; i < n; i++) {
    c.write(bit, 0);
    scans(c);
    c.write(bit, 1);
    scans(c);
  }
}

describe('counter instruction metadata', () => {
  it.each([
    ['CTU', 'Count Up'],
    ['CTD', 'Count Down'],
  ])('%s is a Timer/Counter output box with Counter, Preset, Accum operands', (m, title) => {
    const d = getInstruction(m)!;
    expect(d.category).toBe('Timer/Counter');
    expect(d.title).toBe(title);
    expect(d.kind).toBe('output');
    expect(d.box).toBe(true);
    expect(d.operands.map((o) => o.name)).toEqual(['Counter', 'Preset', 'Accum']);
    expect(d.operands.map((o) => o.kind)).toEqual(['counter', 'immediate', 'immediate']);
  });

  it('RES is a Timer/Counter output with one Structure operand', () => {
    const d = getInstruction('RES')!;
    expect(d.category).toBe('Timer/Counter');
    expect(d.title).toBe('Reset');
    expect(d.kind).toBe('output');
    expect(d.box).toBe(false);
    expect(d.operands.map((o) => o.name)).toEqual(['Structure']);
  });
});

describe('CTU', () => {
  const setup = (pre = 3, accum = 0, up = 0) => ({
    tags: [bool('Up', up), counter('C1'), bool('Out')],
    rungs: [`XIC Up CTU C1 ${pre} ${accum} ;`, 'XIC C1.DN OTE Out ;'],
  });

  it('applies the literal preset and accum to the tag at download', () => {
    const c = load(setup(7, 2));
    expect(ctr(c, 'C1')).toEqual({ PRE: 7, ACC: 2, CU: 0, CD: 0, DN: 0, OV: 0, UN: 0 });
  });

  it('counts only on false -> true transitions of the rung', () => {
    const c = run(setup(100));
    scans(c, 3);
    expect(c.readNumber('C1.ACC')).toBe(0);
    c.write('Up', 1);
    scans(c);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 1, CU: 1 });
    scans(c, 10); // held true: no more counts
    expect(c.readNumber('C1.ACC')).toBe(1);
    c.write('Up', 0);
    scans(c);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 1, CU: 0 });
    scans(c, 5);
    expect(c.readNumber('C1.ACC')).toBe(1);
    pulse(c, 'Up', 4);
    expect(c.readNumber('C1.ACC')).toBe(5);
  });

  it('sets DN when ACC >= PRE', () => {
    const c = run(setup(3));
    pulse(c, 'Up', 2);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 2, DN: 0 });
    expect(c.readBool('Out')).toBe(false);
    pulse(c, 'Up');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 3, DN: 1 });
    expect(c.readBool('Out')).toBe(true);
    pulse(c, 'Up');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 4, DN: 1 });
  });

  it('re-evaluates DN on every true scan, but not while the rung is false', () => {
    const c = run(setup(3, 0, 1));
    pulse(c, 'Up', 3);
    expect(c.readBool('C1.DN')).toBe(true);
    // rung true: raising PRE clears DN on the next scan without a count
    c.write('C1.PRE', 10);
    scans(c);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 3, DN: 0 });
    c.write('C1.PRE', 2);
    scans(c);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 3, DN: 1 });
    // rung false: DN is left alone
    c.write('Up', 0);
    scans(c);
    c.write('C1.PRE', 10);
    scans(c, 3);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 3, DN: 1, CU: 0 });
  });

  it('preset 0 with accum 0 is done on the first counted scan; DN tracks negative presets', () => {
    const c = run({ tags: [bool('Up'), counter('C1'), counter('C2')], rungs: ['XIC Up CTU C1 0 0 ;', 'XIC Up CTU C2 -5 -10 ;'] });
    pulse(c, 'Up');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 1, DN: 1 });
    expect(ctr(c, 'C2')).toMatchObject({ PRE: -5, ACC: -9, DN: 0 });
    pulse(c, 'Up', 4);
    expect(ctr(c, 'C2')).toMatchObject({ ACC: -5, DN: 1 });
  });

  it('prescan sets CU: a rung already true on the first scan does not count', () => {
    const c = load(setup(3, 0, 1));
    expect(c.readNumber('C1.CU')).toBe(0);
    c.setMode('RUN');
    expect(c.readNumber('C1.CU')).toBe(1);
    scans(c, 5);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 0, CU: 1, DN: 0 });
    // after a false scan the next true scan counts
    c.write('Up', 0);
    scans(c);
    c.write('Up', 1);
    scans(c);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 1, CU: 1 });
  });

  it('wraps DINT_MAX -> DINT_MIN and sets OV', () => {
    const c = run(setup(0, DINT_MAX - 1));
    pulse(c, 'Up');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MAX, OV: 0, UN: 0, DN: 1 });
    pulse(c, 'Up');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MIN, OV: 1, UN: 0, DN: 0 });
    pulse(c, 'Up');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MIN + 1, OV: 1, UN: 0 });
  });

  it('a wrap up while UN is set clears UN instead of setting OV', () => {
    const c = load(setup(0, DINT_MAX));
    c.write('C1.UN', 1);
    c.setMode('RUN');
    pulse(c, 'Up');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MIN, OV: 0, UN: 0 });
  });

  it('accepts the paren form', () => {
    const c = run({ tags: [bool('Up'), counter('C1')], rungs: ['XIC(Up)CTU(C1,2,0);'] });
    expect(c.readNumber('C1.PRE')).toBe(2);
    pulse(c, 'Up', 2);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 2, DN: 1 });
  });

  it('passes the rung condition through', () => {
    const c = run({ tags: [bool('Up'), counter('C1'), bool('Out')], rungs: ['XIC Up CTU C1 5 0 OTE Out ;'] });
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('Up', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });

  it('counts with a COUNTER array element and a UDT member', () => {
    const c = run({
      dataTypes: [{ name: 'Lane', members: [{ name: 'Parts', dataType: 'COUNTER' }] }],
      tags: [bool('Up'), arr('Ctrs', 'COUNTER', [3]), { name: 'L1', dataType: 'Lane' }],
      rungs: ['XIC Up CTU Ctrs[1] 2 0 ;', 'XIC Up CTU L1.Parts 3 0 ;'],
    });
    expect(c.readNumber('Ctrs[1].PRE')).toBe(2);
    expect(c.readNumber('L1.Parts.PRE')).toBe(3);
    pulse(c, 'Up', 2);
    expect(ctr(c, 'Ctrs[1]')).toMatchObject({ ACC: 2, DN: 1 });
    expect(ctr(c, 'L1.Parts')).toMatchObject({ ACC: 2, DN: 0 });
    expect(ctr(c, 'Ctrs[0]').ACC).toBe(0);
    expect(ctr(c, 'Ctrs[2]').ACC).toBe(0);
  });

  it('counts with an indirectly addressed element (Ctrs[Idx])', () => {
    const c = run({ tags: [bool('Up'), dint('Idx', 2), arr('Ctrs', 'COUNTER', [3])], rungs: ['XIC Up CTU Ctrs[Idx] 5 0 ;'] });
    pulse(c, 'Up', 2);
    expect(c.readNumber('Ctrs[2].ACC')).toBe(2);
    c.write('Idx', 0);
    pulse(c, 'Up');
    expect(c.readNumber('Ctrs[0].ACC')).toBe(1);
    expect(c.readNumber('Ctrs[2].ACC')).toBe(2);
  });

  it('reports verify errors for bad operands', () => {
    const tags = [counter('C1'), timer('T1'), dint('D1')];
    expect(errorText({ tags, rungs: ['CTU T1 5 0 ;'] })).toMatch(/Operand 0: Invalid data type: 'T1' is TIMER; COUNTER required/);
    expect(errorText({ tags, rungs: ['CTU D1 5 0 ;'] })).toMatch(/'D1' is DINT; COUNTER required/);
    expect(errorText({ tags, rungs: ['CTU 3 5 0 ;'] })).toMatch(/Operand 0: Immediate value not allowed/);
    expect(errorText({ tags, rungs: ['CTU C1 D1 0 ;'] })).toMatch(/Operand 1: Immediate value required, found 'D1'/);
    expect(errorText({ tags, rungs: ['CTU C1 5 D1 ;'] })).toMatch(/Operand 2: Immediate value required, found 'D1'/);
    expect(errorText({ tags, rungs: ['CTU C1 ? 0 ;'] })).toMatch(/Operand 1: Missing operand/);
    expect(errorText({ tags, rungs: ['CTU(C1,5);'] })).toMatch(/expects 3 operand/);
    expect(errorText({ tags, rungs: ['CTU C1 2.5 0 ;'] })).toMatch(/Operand 1: Integer immediate value required/);
    expect(errorText({ tags, rungs: ['CTU C1 5 2147483648 ;'] })).toMatch(/Operand 2: Value 2147483648 is greater than the maximum/);
    expect(errorText({ tags, rungs: ['CTU C1 -5 -2147483648 ;'] })).toBe('');
    expect(errorText({ tags: [{ name: 'K', dataType: 'COUNTER', constant: true }], rungs: ['CTU K 5 0 ;'] })).toMatch(/'K' is read-only/);
  });
});

describe('CTD', () => {
  const setup = (pre = 0, accum = 3) => ({
    tags: [bool('Dn'), counter('C1')],
    rungs: [`XIC Dn CTD C1 ${pre} ${accum} ;`],
  });

  it('counts down on false -> true transitions; DN = ACC >= PRE', () => {
    const c = run(setup(2, 4));
    expect(ctr(c, 'C1')).toMatchObject({ PRE: 2, ACC: 4 });
    scans(c); // rung false: clears the CD set by prescan
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 4, CD: 0 });
    c.write('Dn', 1);
    scans(c);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 3, CD: 1, DN: 1 });
    scans(c, 5);
    expect(c.readNumber('C1.ACC')).toBe(3);
    pulse(c, 'Dn');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 2, DN: 1 });
    pulse(c, 'Dn');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 1, DN: 0 });
    c.write('Dn', 0);
    scans(c);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 1, CD: 0, DN: 0 });
  });

  it('prescan sets CD: a rung already true on the first scan does not count', () => {
    const c = load(setup(0, 3));
    c.write('Dn', 1);
    c.setMode('RUN');
    expect(c.readNumber('C1.CD')).toBe(1);
    scans(c, 3);
    expect(c.readNumber('C1.ACC')).toBe(3);
    pulse(c, 'Dn');
    expect(c.readNumber('C1.ACC')).toBe(2);
  });

  it('wraps DINT_MIN -> DINT_MAX and sets UN', () => {
    const c = run(setup(0, DINT_MIN + 1));
    pulse(c, 'Dn');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MIN, OV: 0, UN: 0, DN: 0 });
    pulse(c, 'Dn');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MAX, OV: 0, UN: 1, DN: 1 });
  });

  it('a wrap down while OV is set clears OV instead of setting UN', () => {
    const c = load(setup(0, DINT_MIN));
    c.write('C1.OV', 1);
    c.setMode('RUN');
    pulse(c, 'Dn');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MAX, OV: 0, UN: 0 });
  });

  it('reports verify errors for bad operands', () => {
    const tags = [counter('C1'), timer('T1'), dint('D1')];
    expect(errorText({ tags, rungs: ['CTD T1 0 3 ;'] })).toMatch(/COUNTER required/);
    expect(errorText({ tags, rungs: ['CTD C1 D1 3 ;'] })).toMatch(/Operand 1: Immediate value required/);
    expect(errorText({ tags, rungs: ['CTD(C1,0,?);'] })).toMatch(/Operand 2: Missing operand/);
  });
});

describe('CTU + CTD sharing one COUNTER', () => {
  const setup = () => ({
    tags: [bool('Up'), bool('Dn'), counter('C1')],
    rungs: ['XIC Up CTU C1 3 0 ;', 'XIC Dn CTD C1 3 0 ;'],
  });

  it('counts up and down on the same accumulator', () => {
    const c = run(setup());
    pulse(c, 'Up', 4);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 4, DN: 1 });
    pulse(c, 'Dn');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 3, DN: 1 });
    pulse(c, 'Dn');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 2, DN: 0 });
    // CU and CD are independent edge memories
    c.write('Up', 0);
    c.write('Dn', 0);
    scans(c);
    c.write('Up', 1);
    c.write('Dn', 1);
    scans(c);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 2, CU: 1, CD: 1 });
  });

  it('an up-wrap followed by a down-wrap cancels the overflow', () => {
    const c = load(setup());
    c.write('C1.ACC', DINT_MAX);
    c.setMode('RUN');
    pulse(c, 'Up');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MIN, OV: 1, UN: 0 });
    pulse(c, 'Dn');
    expect(ctr(c, 'C1')).toMatchObject({ ACC: DINT_MAX, OV: 0, UN: 0 });
  });
});

describe('RES', () => {
  it('resets a TIMER: ACC = 0, EN = TT = DN = 0, PRE unchanged', () => {
    const c = run({ tags: [bool('Go', 1), bool('Rst'), timer('T1')], rungs: ['XIC Go TON T1 100 0 ;', 'XIC Rst RES T1 ;'] });
    scans(c, 15);
    expect(c.read('T1')).toEqual({ PRE: 100, ACC: 100, EN: 1, TT: 0, DN: 1 });
    c.write('Rst', 1);
    scans(c);
    expect(c.read('T1')).toEqual({ PRE: 100, ACC: 0, EN: 0, TT: 0, DN: 0 });
  });

  it('resets a COUNTER: ACC = 0, CU = CD = DN = OV = UN = 0, PRE unchanged', () => {
    const c = load({ tags: [bool('Rst'), counter('C1')], rungs: ['XIC Rst RES C1 ;'] });
    c.write('C1', { PRE: 9, ACC: 12, CU: 1, CD: 1, DN: 1, OV: 1, UN: 1 });
    c.setMode('RUN');
    scans(c, 2);
    expect(c.read('C1')).toEqual({ PRE: 9, ACC: 12, CU: 1, CD: 1, DN: 1, OV: 1, UN: 1 });
    c.write('Rst', 1);
    scans(c);
    expect(c.read('C1')).toEqual({ PRE: 9, ACC: 0, CU: 0, CD: 0, DN: 0, OV: 0, UN: 0 });
  });

  it('resets a CONTROL: POS = 0 and all status bits cleared, LEN unchanged', () => {
    const c = load({ tags: [bool('Rst'), control('Ctl')], rungs: ['XIC Rst RES Ctl ;'] });
    c.write('Ctl', { LEN: 8, POS: 5, EN: 1, EU: 1, DN: 1, EM: 1, ER: 1, UL: 1, IN: 1, FD: 1 });
    c.setMode('RUN');
    c.write('Rst', 1);
    scans(c);
    expect(c.read('Ctl')).toEqual({ LEN: 8, POS: 0, EN: 0, EU: 0, DN: 0, EM: 0, ER: 0, UL: 0, IN: 0, FD: 0 });
  });

  it('does nothing while the rung is false', () => {
    const c = load({ tags: [bool('Rst'), counter('C1'), timer('T1')], rungs: ['XIC Rst RES C1 ;', 'XIC Rst RES T1 ;'] });
    c.write('C1', { ACC: 4, DN: 1, OV: 1 });
    c.write('T1', { ACC: 40, DN: 1 });
    c.setMode('RUN');
    scans(c, 3);
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 4, DN: 1, OV: 1 });
    expect(c.read('T1')).toMatchObject({ ACC: 40, DN: 1 });
  });

  it('clearing CU lets a CTU whose rung is held true count again', () => {
    const c = run({ tags: [bool('Up'), bool('Rst'), counter('C1')], rungs: ['XIC Up CTU C1 10 0 ;', 'XIC Rst RES C1 ;'] });
    pulse(c, 'Up', 3);
    expect(c.readNumber('C1.ACC')).toBe(3);
    c.write('Rst', 1);
    scans(c); // CTU (held true) sees CU = 1: no count; RES then clears ACC and CU
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 0, CU: 0 });
    c.write('Rst', 0);
    scans(c); // CU was cleared, rung still true: counts once
    expect(ctr(c, 'C1')).toMatchObject({ ACC: 1, CU: 1 });
    scans(c, 3);
    expect(c.readNumber('C1.ACC')).toBe(1);
  });

  it('passes the rung condition through', () => {
    const c = run({ tags: [bool('Rst'), timer('T1'), bool('Out')], rungs: ['XIC Rst RES T1 OTE Out ;'] });
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('Rst', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });

  it('resets array elements (direct and indirect) and UDT members', () => {
    const c = load({
      dataTypes: [{ name: 'Cell', members: [{ name: 'Tm', dataType: 'TIMER' }, { name: 'Ct', dataType: 'COUNTER' }] }],
      tags: [bool('Rst'), dint('Idx', 1), arr('Tmrs', 'TIMER', [3]), arr('Ctrs', 'COUNTER', [3]), { name: 'K1', dataType: 'Cell' }],
      rungs: ['XIC Rst RES Tmrs[2] ;', 'XIC Rst RES Ctrs[Idx] ;', 'XIC Rst RES K1.Tm ;', 'XIC Rst RES K1.Ct ;'],
    });
    c.write('Tmrs[1].ACC', 11);
    c.write('Tmrs[2].ACC', 22);
    c.write('Ctrs[0].ACC', 5);
    c.write('Ctrs[1].ACC', 6);
    c.write('K1.Tm.ACC', 7);
    c.write('K1.Ct.ACC', 8);
    c.setMode('RUN');
    c.write('Rst', 1);
    scans(c);
    expect(c.readNumber('Tmrs[1].ACC')).toBe(11);
    expect(c.readNumber('Tmrs[2].ACC')).toBe(0);
    expect(c.readNumber('Ctrs[0].ACC')).toBe(5);
    expect(c.readNumber('Ctrs[1].ACC')).toBe(0);
    expect(c.readNumber('K1.Tm.ACC')).toBe(0);
    expect(c.readNumber('K1.Ct.ACC')).toBe(0);
  });

  it('accepts the paren form', () => {
    const c = load({ tags: [bool('Rst', 1), counter('C1')], rungs: ['XIC(Rst)RES(C1);'] });
    c.write('C1.ACC', 3);
    c.setMode('RUN');
    scans(c);
    expect(c.readNumber('C1.ACC')).toBe(0);
  });

  it('reports verify errors for operands that are not TIMER, COUNTER or CONTROL', () => {
    const tags = [dint('D1'), bool('B1'), arr('Tmrs', 'TIMER', [2]), { name: 'K', dataType: 'TIMER', constant: true }, { name: 'U1', dataType: 'Box' }];
    const dataTypes = [{ name: 'Box', members: [{ name: 'X', dataType: 'DINT' }] }];
    const msg = /TIMER, COUNTER or CONTROL required/;
    expect(errorText({ tags, dataTypes, rungs: ['RES D1 ;'] })).toMatch(/Operand 0: Invalid data type: 'D1' is DINT; TIMER, COUNTER or CONTROL required/);
    expect(errorText({ tags, dataTypes, rungs: ['RES B1 ;'] })).toMatch(msg);
    expect(errorText({ tags, dataTypes, rungs: ['RES Tmrs ;'] })).toMatch(msg);
    expect(errorText({ tags, dataTypes, rungs: ['RES U1 ;'] })).toMatch(/'U1' is Box; TIMER, COUNTER or CONTROL required/);
    expect(errorText({ tags, dataTypes, rungs: ['RES 5 ;'] })).toMatch(/Operand 0: Immediate value not allowed/);
    expect(errorText({ tags, dataTypes, rungs: ['RES ? ;'] })).toMatch(/Operand 0: Missing operand/);
    expect(errorText({ tags, dataTypes, rungs: ['RES Nope ;'] })).toMatch(/Undefined tag 'Nope'/);
    expect(errorText({ tags, dataTypes, rungs: ['RES K ;'] })).toMatch(/'K' is read-only/);
    expect(errorText({ tags, dataTypes, rungs: ['RES Tmrs[1] ;'] })).toBe('');
  });
});
