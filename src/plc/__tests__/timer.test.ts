import { describe, it, expect } from 'vitest';
import { run, load, scans, bool, dint, timer, counter, arr, verifyErrors } from './helpers';
import { getInstruction, type Controller } from '../index';

type Tmr = { PRE: number; ACC: number; EN: number; TT: number; DN: number };
const tmr = (c: Controller, path: string): Tmr => c.read(path) as Tmr;
const errorText = (setup: Parameters<typeof verifyErrors>[0]) =>
  verifyErrors(setup)
    .map((e) => e.message)
    .join('\n');

describe('timer instruction metadata', () => {
  it.each([
    ['TON', 'Timer On Delay'],
    ['TOF', 'Timer Off Delay'],
    ['RTO', 'Retentive Timer On'],
  ])('%s is a Timer/Counter output box with Timer, Preset, Accum operands', (m, title) => {
    const d = getInstruction(m)!;
    expect(d).toBeDefined();
    expect(d.category).toBe('Timer/Counter');
    expect(d.title).toBe(title);
    expect(d.kind).toBe('output');
    expect(d.box).toBe(true);
    expect(d.operands.map((o) => o.name)).toEqual(['Timer', 'Preset', 'Accum']);
    expect(d.operands.map((o) => o.kind)).toEqual(['timer', 'immediate', 'immediate']);
  });
});

describe('TON', () => {
  const setup = (pre = 1000, go = 1) => ({
    tags: [bool('Go', go), timer('T1'), bool('Out')],
    rungs: [`XIC Go TON T1 ${pre} 0 ;`, 'XIC T1.DN OTE Out ;'],
  });

  it('applies the literal preset and accum to the tag at download', () => {
    const c = load({ tags: [timer('T1')], rungs: ['TON T1 1500 0 ;'] });
    expect(c.readNumber('T1.PRE')).toBe(1500);
    expect(c.readNumber('T1.ACC')).toBe(0);
  });

  it('accumulates whole milliseconds and sets DN on the scan where elapsed >= PRE', () => {
    const c = run(setup(1000));
    // First true scan (t = 0): timing starts, no time added yet
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 0, EN: 1, TT: 1, DN: 0 });
    // scan k runs at t = 10 * (k - 1)
    for (let k = 2; k <= 100; k++) {
      scans(c);
      expect(c.readNumber('T1.ACC')).toBe(10 * (k - 1));
      expect(c.readBool('T1.TT')).toBe(true);
      expect(c.readBool('T1.DN')).toBe(false);
    }
    expect(c.readNumber('T1.ACC')).toBe(990);
    scans(c); // scan 101 at t = 1000
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 1000, EN: 1, TT: 0, DN: 1 });
    expect(c.readBool('Out')).toBe(true);
    scans(c, 20);
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 1000, EN: 1, TT: 0, DN: 1 });
  });

  it('reaches DN with a preset that is not a multiple of the scan period (ACC clamps to PRE)', () => {
    const c = run(setup(25));
    scans(c, 3); // t = 0, 10, 20 -> ACC 20
    expect(c.readNumber('T1.ACC')).toBe(20);
    expect(c.readBool('T1.DN')).toBe(false);
    scans(c); // t = 30 -> 30 >= 25
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 25, DN: 1, TT: 0 });
  });

  it('resets EN, TT, DN and ACC when the rung goes false (while timing and after done)', () => {
    const c = run(setup(1000));
    scans(c, 51);
    expect(c.readNumber('T1.ACC')).toBe(500);
    c.write('Go', 0);
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 0, EN: 0, TT: 0, DN: 0 });

    c.write('Go', 1);
    scans(c, 101);
    expect(c.readBool('T1.DN')).toBe(true);
    c.write('Go', 0);
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 0, EN: 0, TT: 0, DN: 0 });
    expect(c.readBool('Out')).toBe(false);
  });

  it('restarts from 0 when re-enabled (the enable scan adds no time)', () => {
    const c = run(setup(1000));
    scans(c, 30);
    c.write('Go', 0);
    scans(c, 7);
    c.write('Go', 1);
    scans(c);
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 0, EN: 1, TT: 1, DN: 0 });
    scans(c);
    expect(c.readNumber('T1.ACC')).toBe(10);
  });

  it('PRE = 0 is done on the first true scan', () => {
    const c = run(setup(0));
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 0, ACC: 0, EN: 1, TT: 0, DN: 1 });
  });

  it('uses the live .PRE at run time (lowering it while timing finishes the timer)', () => {
    const c = run(setup(1000));
    scans(c, 11);
    expect(c.readNumber('T1.ACC')).toBe(100);
    c.write('T1.PRE', 50);
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 50, ACC: 50, EN: 1, TT: 0, DN: 1 });
  });

  it('uses the live .PRE at run time (raising it while timing extends the delay)', () => {
    const c = run(setup(100));
    scans(c, 6);
    c.write('T1.PRE', 200);
    scans(c, 14); // ACC 190
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 190, TT: 1, DN: 0 });
    scans(c);
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 200, TT: 0, DN: 1 });
  });

  it('keeps DN (and ACC) when .PRE is raised after the timer is done', () => {
    const c = run(setup(100));
    scans(c, 11);
    expect(c.readBool('T1.DN')).toBe(true);
    c.write('T1.PRE', 500);
    scans(c, 5);
    expect(tmr(c, 'T1')).toEqual({ PRE: 500, ACC: 100, EN: 1, TT: 0, DN: 1 });
  });

  it('passes the rung condition through', () => {
    const c = run({ tags: [bool('Go'), timer('T1'), bool('Out')], rungs: ['XIC Go TON T1 1000 0 OTE Out ;'] });
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('Go', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });

  it('accepts the paren form', () => {
    const c = run({ tags: [bool('Go', 1), timer('T1')], rungs: ['XIC(Go)TON(T1,200,0);'] });
    expect(c.readNumber('T1.PRE')).toBe(200);
    scans(c, 21);
    expect(c.readBool('T1.DN')).toBe(true);
  });

  it('keeps the fractional remainder of non-integer scan periods (2.5 ms)', () => {
    const c = run({ ...setup(1000), scanPeriodMs: 2.5 });
    for (let k = 1; k <= 40; k++) {
      scans(c);
      // scan k runs at t = 2.5 * (k - 1); ACC is the whole ms elapsed since the start
      expect(c.readNumber('T1.ACC')).toBe(Math.floor(2.5 * (k - 1)));
    }
  });

  it('prescan clears EN, TT, DN and ACC; a rung true at Run entry starts timing from 0', () => {
    const c = load(setup(1000));
    c.write('T1', { ACC: 700, EN: 1, TT: 1, DN: 1 });
    expect(c.setMode('RUN')).toBeNull();
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 0, EN: 0, TT: 0, DN: 0 });
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 0, EN: 1, TT: 1, DN: 0 });
    scans(c, 100);
    expect(c.readBool('T1.DN')).toBe(true);
  });

  it('does not count Program-mode time after going back to Run', () => {
    const c = run(setup(1000));
    scans(c, 50);
    expect(c.setMode('PROGRAM')).toBeNull();
    c.advance(5000);
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 0, TT: 1, DN: 0 });
  });

  it('a negative .PRE while timing is a major fault (type 4, code 34)', () => {
    const c = load(setup(1000));
    c.write('T1.PRE', -1);
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 34, major: true, routine: 'MainRoutine', rung: 0, instruction: 'TON' });
  });

  it('a negative .ACC while timing is a major fault (type 4, code 34)', () => {
    const c = run(setup(1000));
    scans(c, 5);
    c.write('T1.ACC', -5);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 34 });
  });

  it('a negative .PRE does not fault while the rung is false (the timer is not timing)', () => {
    const c = load(setup(1000, 0));
    c.write('T1.PRE', -1);
    c.setMode('RUN');
    scans(c, 5);
    expect(c.mode).toBe('RUN');
    expect(tmr(c, 'T1')).toEqual({ PRE: -1, ACC: 0, EN: 0, TT: 0, DN: 0 });
  });

  it('times an element of a TIMER array without touching the other elements', () => {
    const c = run({ tags: [bool('Go', 1), arr('Tmrs', 'TIMER', [4])], rungs: ['XIC Go TON Tmrs[2] 100 0 ;'] });
    expect(c.readNumber('Tmrs[2].PRE')).toBe(100);
    scans(c, 10);
    expect(tmr(c, 'Tmrs[2]')).toMatchObject({ ACC: 90, EN: 1, TT: 1, DN: 0 });
    scans(c);
    expect(tmr(c, 'Tmrs[2]')).toMatchObject({ ACC: 100, TT: 0, DN: 1 });
    for (const i of [0, 1, 3]) expect(tmr(c, `Tmrs[${i}]`)).toEqual({ PRE: 0, ACC: 0, EN: 0, TT: 0, DN: 0 });
  });

  it('times an indirectly addressed array element (Tmrs[Idx])', () => {
    const c = run({ tags: [bool('Go', 1), dint('Idx', 3), arr('Tmrs', 'TIMER', [4])], rungs: ['XIC Go TON Tmrs[Idx] 50 0 ;'] });
    expect(c.readNumber('Tmrs[3].PRE')).toBe(50);
    scans(c, 6);
    expect(tmr(c, 'Tmrs[3]')).toMatchObject({ ACC: 50, DN: 1 });
    expect(tmr(c, 'Tmrs[0]').EN).toBe(0);
  });

  it('times a TIMER member of a UDT', () => {
    const c = run({
      dataTypes: [{ name: 'Station', members: [{ name: 'Delay', dataType: 'TIMER' }, { name: 'Busy', dataType: 'BOOL' }] }],
      tags: [bool('Go', 1), { name: 'S1', dataType: 'Station' }],
      rungs: ['XIC Go TON S1.Delay 30 0 ;', 'XIC S1.Delay.DN OTE S1.Busy ;'],
    });
    expect(c.readNumber('S1.Delay.PRE')).toBe(30);
    scans(c, 3);
    expect(c.readBool('S1.Busy')).toBe(false);
    scans(c);
    expect(tmr(c, 'S1.Delay')).toMatchObject({ ACC: 30, DN: 1 });
    expect(c.readBool('S1.Busy')).toBe(true);
  });

  it('reports verify errors for bad operands', () => {
    const tags = [timer('T1'), dint('D1'), counter('C1'), dint('PreTag', 100)];
    expect(errorText({ tags, rungs: ['TON D1 1000 0 ;'] })).toMatch(/Operand 0: Invalid data type: 'D1' is DINT; TIMER required/);
    expect(errorText({ tags, rungs: ['TON C1 1000 0 ;'] })).toMatch(/'C1' is COUNTER; TIMER required/);
    expect(errorText({ tags, rungs: ['TON 5 1000 0 ;'] })).toMatch(/Operand 0: Immediate value not allowed; TIMER tag required/);
    expect(errorText({ tags, rungs: ['TON Nope 1000 0 ;'] })).toMatch(/Undefined tag 'Nope'/);
    expect(errorText({ tags, rungs: ['TON T1 PreTag 0 ;'] })).toMatch(/Operand 1: Immediate value required/);
    expect(errorText({ tags, rungs: ['TON T1 1000 PreTag ;'] })).toMatch(/Operand 2: Immediate value required/);
    expect(errorText({ tags, rungs: ['TON T1 ? 0 ;'] })).toMatch(/Operand 1: Missing operand/);
    expect(errorText({ tags, rungs: ['TON(T1,,0);'] })).toMatch(/Operand 1: Missing operand/);
    expect(errorText({ tags, rungs: ['TON(T1,1000);'] })).toMatch(/expects 3 operand/);
    expect(errorText({ tags, rungs: ['TON T1 -5 0 ;'] })).toMatch(/Operand 1: Value -5 is less than the minimum 0/);
    expect(errorText({ tags, rungs: ['TON T1 1000 -1 ;'] })).toMatch(/Operand 2: Value -1 is less than the minimum 0/);
    expect(errorText({ tags, rungs: ['TON T1 1.5 0 ;'] })).toMatch(/Operand 1: Integer immediate value required/);
    expect(errorText({ tags, rungs: ['TON T1 2147483648 0 ;'] })).toMatch(/Operand 1: Value 2147483648 is greater than the maximum/);
    expect(errorText({ tags, rungs: ['TON T1 1000 0 ;'] })).toBe('');
  });

  it('rejects a constant TIMER tag', () => {
    const errs = errorText({ tags: [{ name: 'K', dataType: 'TIMER', constant: true }], rungs: ['TON K 100 0 ;'] });
    expect(errs).toMatch(/Operand 0: 'K' is read-only/);
  });
});

describe('TOF', () => {
  const setup = (pre = 500, go = 0) => ({
    tags: [bool('Go', go), timer('T1'), bool('Out')],
    rungs: [`XIC Go TOF T1 ${pre} 0 ;`, 'XIC T1.DN OTE Out ;'],
  });

  it('prescan clears EN, TT, DN and sets ACC = PRE', () => {
    const c = load(setup(500));
    c.write('T1', { EN: 1, TT: 1, DN: 1, ACC: 3 });
    c.setMode('RUN');
    expect(tmr(c, 'T1')).toEqual({ PRE: 500, ACC: 500, EN: 0, TT: 0, DN: 0 });
    // rung false on the first scan: stays off, no timing
    scans(c, 10);
    expect(tmr(c, 'T1')).toEqual({ PRE: 500, ACC: 500, EN: 0, TT: 0, DN: 0 });
    expect(c.readBool('Out')).toBe(false);
  });

  it('rung true: EN = DN = 1, TT = 0, ACC = 0', () => {
    const c = run(setup(500, 1));
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 500, ACC: 0, EN: 1, TT: 0, DN: 1 });
    expect(c.readBool('Out')).toBe(true);
  });

  it('keeps DN for PRE ms after the rung goes false, timing with TT', () => {
    const c = run(setup(500, 1));
    scans(c, 3);
    c.write('Go', 0);
    scans(c); // first false scan: timing starts
    expect(tmr(c, 'T1')).toEqual({ PRE: 500, ACC: 0, EN: 0, TT: 1, DN: 1 });
    for (let k = 2; k <= 50; k++) {
      scans(c);
      expect(c.readNumber('T1.ACC')).toBe(10 * (k - 1));
      expect(c.readBool('T1.TT')).toBe(true);
      expect(c.readBool('T1.DN')).toBe(true);
    }
    expect(c.readNumber('T1.ACC')).toBe(490);
    scans(c); // 500 ms after the first false scan
    expect(tmr(c, 'T1')).toEqual({ PRE: 500, ACC: 500, EN: 0, TT: 0, DN: 0 });
    expect(c.readBool('Out')).toBe(false);
    scans(c, 10);
    expect(tmr(c, 'T1')).toEqual({ PRE: 500, ACC: 500, EN: 0, TT: 0, DN: 0 });
  });

  it('re-triggers when the rung goes true during the off-delay', () => {
    const c = run(setup(500, 1));
    scans(c);
    c.write('Go', 0);
    scans(c, 31);
    expect(c.readNumber('T1.ACC')).toBe(300);
    c.write('Go', 1);
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 500, ACC: 0, EN: 1, TT: 0, DN: 1 });
    c.write('Go', 0);
    scans(c, 50);
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 490, TT: 1, DN: 1 });
    scans(c);
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 500, TT: 0, DN: 0 });
  });

  it('PRE = 0 drops DN on the first false scan', () => {
    const c = run(setup(0, 1));
    scans(c);
    expect(c.readBool('T1.DN')).toBe(true);
    c.write('Go', 0);
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 0, ACC: 0, EN: 0, TT: 0, DN: 0 });
  });

  it('uses the live .PRE at run time', () => {
    const c = run(setup(500, 1));
    scans(c);
    c.write('Go', 0);
    scans(c, 11);
    expect(c.readNumber('T1.ACC')).toBe(100);
    c.write('T1.PRE', 50);
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 50, ACC: 50, EN: 0, TT: 0, DN: 0 });
  });

  it('a negative .PRE during the off-delay is a major fault (type 4, code 34)', () => {
    const c = run(setup(500, 1));
    scans(c);
    c.write('T1.PRE', -10);
    scans(c, 3); // rung true: not timing, no fault
    expect(c.mode).toBe('RUN');
    c.write('Go', 0);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 34, instruction: 'TOF', rung: 0 });
  });

  it('times a TIMER array element and a UDT member', () => {
    const c = run({
      dataTypes: [{ name: 'Valve', members: [{ name: 'Off', dataType: 'TIMER' }] }],
      tags: [bool('Go', 1), arr('Tmrs', 'TIMER', [3]), { name: 'V', dataType: 'Valve' }],
      rungs: ['XIC Go TOF Tmrs[2] 40 0 ;', 'XIC Go TOF V.Off 20 0 ;'],
    });
    scans(c);
    c.write('Go', 0);
    scans(c, 3);
    expect(tmr(c, 'V.Off')).toMatchObject({ ACC: 20, DN: 0 });
    expect(tmr(c, 'Tmrs[2]')).toMatchObject({ ACC: 20, DN: 1, TT: 1 });
    scans(c, 2);
    expect(tmr(c, 'Tmrs[2]')).toMatchObject({ ACC: 40, DN: 0, TT: 0 });
  });

  it('reports verify errors for bad operands', () => {
    const tags = [timer('T1'), dint('D1')];
    expect(errorText({ tags, rungs: ['TOF D1 500 0 ;'] })).toMatch(/TIMER required/);
    expect(errorText({ tags, rungs: ['TOF T1 D1 0 ;'] })).toMatch(/Operand 1: Immediate value required/);
    expect(errorText({ tags, rungs: ['TOF T1 500 ? ;'] })).toMatch(/Operand 2: Missing operand/);
  });
});

describe('RTO', () => {
  const setup = (pre = 1000, go = 1, accum = 0) => ({
    tags: [bool('Go', go), bool('Rst'), timer('T1')],
    rungs: [`XIC Go RTO T1 ${pre} ${accum} ;`, 'XIC Rst RES T1 ;'],
  });

  it('times like TON while the rung is true', () => {
    const c = run(setup(100));
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 100, ACC: 0, EN: 1, TT: 1, DN: 0 });
    scans(c, 9);
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 90, TT: 1, DN: 0 });
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 100, ACC: 100, EN: 1, TT: 0, DN: 1 });
  });

  it('retains ACC while the rung is false and resumes when it goes true again', () => {
    const c = run(setup(1000));
    scans(c, 30);
    expect(c.readNumber('T1.ACC')).toBe(290);
    c.write('Go', 0);
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 290, EN: 0, TT: 0, DN: 0 });
    scans(c, 25);
    expect(c.readNumber('T1.ACC')).toBe(290);
    c.write('Go', 1);
    scans(c); // re-enable scan adds no time (the false period is not counted)
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 290, EN: 1, TT: 1, DN: 0 });
    scans(c, 71); // + 710 ms
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 1000, EN: 1, TT: 0, DN: 1 });
  });

  it('retains DN and ACC after the rung goes false', () => {
    const c = run(setup(50));
    scans(c, 6);
    expect(c.readBool('T1.DN')).toBe(true);
    c.write('Go', 0);
    scans(c, 5);
    expect(tmr(c, 'T1')).toEqual({ PRE: 50, ACC: 50, EN: 0, TT: 0, DN: 1 });
  });

  it('is reset only by RES', () => {
    const c = run(setup(1000));
    scans(c, 41);
    c.write('Go', 0);
    c.write('Rst', 1);
    scans(c);
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 0, EN: 0, TT: 0, DN: 0 });
    c.write('Rst', 0);
    c.write('Go', 1);
    scans(c, 2);
    expect(c.readNumber('T1.ACC')).toBe(10);
  });

  it('RES while the rung is true restarts timing from 0', () => {
    const c = run(setup(1000));
    scans(c, 21);
    expect(c.readNumber('T1.ACC')).toBe(200);
    c.write('Rst', 1);
    scans(c); // RTO times to 210, then RES (rung 1) clears it
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 0, EN: 0, TT: 0, DN: 0 });
    c.write('Rst', 0);
    scans(c); // enable transition: restart, no time added
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 0, EN: 1, TT: 1 });
    scans(c);
    expect(c.readNumber('T1.ACC')).toBe(10);
  });

  it('applies the literal accum at download and continues from it', () => {
    const c = load(setup(1000, 1, 250));
    expect(c.readNumber('T1.ACC')).toBe(250);
    c.setMode('RUN');
    expect(c.readNumber('T1.ACC')).toBe(250);
    scans(c, 2);
    expect(c.readNumber('T1.ACC')).toBe(260);
  });

  it('prescan clears EN and TT and leaves ACC and DN unchanged', () => {
    const c = load(setup(1000));
    c.write('T1', { ACC: 400, EN: 1, TT: 1, DN: 1 });
    c.setMode('RUN');
    expect(tmr(c, 'T1')).toEqual({ PRE: 1000, ACC: 400, EN: 0, TT: 0, DN: 1 });

    const c2 = load(setup(1000));
    c2.write('T1', { ACC: 400, EN: 1, TT: 1, DN: 0 });
    c2.setMode('RUN');
    expect(tmr(c2, 'T1')).toEqual({ PRE: 1000, ACC: 400, EN: 0, TT: 0, DN: 0 });
    scans(c2); // rung true at Run entry: resumes from the retained ACC
    expect(tmr(c2, 'T1')).toEqual({ PRE: 1000, ACC: 400, EN: 1, TT: 1, DN: 0 });
  });

  it('does not count Program-mode time (retained ACC resumes after Run)', () => {
    const c = run(setup(1000));
    scans(c, 31);
    expect(c.readNumber('T1.ACC')).toBe(300);
    c.setMode('PROGRAM');
    c.advance(10_000);
    c.setMode('RUN');
    scans(c);
    expect(tmr(c, 'T1')).toMatchObject({ ACC: 300, TT: 1, DN: 0 });
    scans(c);
    expect(c.readNumber('T1.ACC')).toBe(310);
  });

  it('a negative .ACC while timing is a major fault (type 4, code 34)', () => {
    const c = load(setup(1000));
    c.write('T1.ACC', -1);
    c.setMode('RUN');
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 34, instruction: 'RTO' });
  });

  it('times a TIMER array element and a UDT member', () => {
    const c = run({
      dataTypes: [{ name: 'Pump', members: [{ name: 'RunTime', dataType: 'TIMER' }] }],
      tags: [bool('Go', 1), arr('Tmrs', 'TIMER', [3]), { name: 'P', dataType: 'Pump' }],
      rungs: ['XIC Go RTO Tmrs[1] 1000 0 ;', 'XIC Go RTO P.RunTime 1000 0 ;'],
    });
    scans(c, 5);
    c.write('Go', 0);
    scans(c, 5);
    expect(tmr(c, 'Tmrs[1]')).toMatchObject({ ACC: 40, EN: 0 });
    expect(tmr(c, 'P.RunTime')).toMatchObject({ ACC: 40, EN: 0 });
  });

  it('reports verify errors for bad operands', () => {
    const tags = [timer('T1'), counter('C1'), dint('D1')];
    expect(errorText({ tags, rungs: ['RTO C1 1000 0 ;'] })).toMatch(/TIMER required/);
    expect(errorText({ tags, rungs: ['RTO T1 1000 D1 ;'] })).toMatch(/Operand 2: Immediate value required/);
    expect(errorText({ tags, rungs: ['RTO(T1,1000,?);'] })).toMatch(/Operand 2: Missing operand/);
  });
});
