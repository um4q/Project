import { describe, it, expect } from 'vitest';
import { run, load, scans, bool, dint, int, sint, real, arr, verifyErrors, type LadderSetup } from './helpers';
import { getInstruction, walkRung, type Controller, type LadderElement } from '../index';

const IO_MODULES = [
  { slot: 1, catalog: 'LX-IQ16' },
  { slot: 2, catalog: 'LX-OB16' },
];

const errorText = (setup: LadderSetup) =>
  verifyErrors(setup)
    .map((e) => e.message)
    .join('\n');

/** Power flow of one rung keyed by a readable label ("XIC A", "branch@1"). */
function powerByLabel(c: Controller, rung: number, routine = 'MainRoutine'): Record<string, number> {
  const st = c.ladderState('MainProgram', routine)!;
  const out: Record<string, number> = {};
  walkRung(st.rungs[rung].elements, (el: LadderElement, info) => {
    const label = el.kind === 'branch' ? `branch@${info.id}` : `${el.mnemonic} ${el.operands.join(',')}`;
    out[label] = st.power[rung][info.id];
  });
  return out;
}

describe('bit instruction metadata', () => {
  it.each([
    ['XIC', 'Examine If Closed', 'input', false, ['Data Bit']],
    ['XIO', 'Examine If Open', 'input', false, ['Data Bit']],
    ['OTE', 'Output Energize', 'output', false, ['Data Bit']],
    ['OTL', 'Output Latch', 'output', false, ['Data Bit']],
    ['OTU', 'Output Unlatch', 'output', false, ['Data Bit']],
    ['ONS', 'One Shot', 'input', false, ['Storage Bit']],
    ['OSR', 'One Shot Rising', 'output', true, ['Storage Bit', 'Output Bit']],
    ['OSF', 'One Shot Falling', 'output', true, ['Storage Bit', 'Output Bit']],
  ] as const)('%s: %s', (m, title, kind, box, operands) => {
    const d = getInstruction(m)!;
    expect(d).toBeDefined();
    expect(d.category).toBe('Bit');
    expect(d.title).toBe(title);
    expect(d.kind).toBe(kind);
    expect(d.box).toBe(box);
    expect(d.operands.map((o) => o.name)).toEqual([...operands]);
  });

  it('mnemonics are case-insensitive in rung text', () => {
    const c = run({ tags: [bool('A', 1), bool('B')], rungs: ['xic A ote B ;'] });
    scans(c);
    expect(c.readBool('B')).toBe(true);
  });
});

describe('XIC / XIO', () => {
  it('examine a BOOL tag', () => {
    const c = run({ tags: [bool('A'), bool('Closed'), bool('Open')], rungs: ['XIC A OTE Closed ;', 'XIO A OTE Open ;'] });
    scans(c);
    expect(c.readBool('Closed')).toBe(false);
    expect(c.readBool('Open')).toBe(true);
    c.write('A', 1);
    scans(c);
    expect(c.readBool('Closed')).toBe(true);
    expect(c.readBool('Open')).toBe(false);
  });

  it('examine bits of DINT, INT and SINT tags (including the sign bit)', () => {
    const c = run({
      tags: [dint('W', 32), dint('Neg', -2147483648), int('I16', -32768), sint('S8', -128), bool('B5'), bool('B4'), bool('B31'), bool('B30'), bool('I15'), bool('S7')],
      rungs: ['XIC W.5 OTE B5 ;', 'XIC W.4 OTE B4 ;', 'XIC Neg.31 OTE B31 ;', 'XIC Neg.30 OTE B30 ;', 'XIC I16.15 OTE I15 ;', 'XIC S8.7 OTE S7 ;'],
    });
    scans(c);
    expect(c.readBool('B5')).toBe(true);
    expect(c.readBool('B4')).toBe(false);
    expect(c.readBool('B31')).toBe(true);
    expect(c.readBool('B30')).toBe(false);
    expect(c.readBool('I15')).toBe(true);
    expect(c.readBool('S7')).toBe(true);
  });

  it('XIO on an integer bit', () => {
    const c = run({ tags: [dint('W', 1), bool('Out0'), bool('Out1')], rungs: ['XIO W.0 OTE Out0 ;', 'XIO W.1 OTE Out1 ;'] });
    scans(c);
    expect(c.readBool('Out0')).toBe(false);
    expect(c.readBool('Out1')).toBe(true);
  });

  it('examine BOOL array elements and bits of DINT array elements', () => {
    const bits = new Array(32).fill(0);
    bits[3] = 1;
    const c = run({
      tags: [arr('Bits', 'BOOL', [32], bits), arr('Words', 'DINT', [4], [0, 8, 0, 0]), bool('E3'), bool('E4'), bool('W13'), bool('W12')],
      rungs: ['XIC Bits[3] OTE E3 ;', 'XIC Bits[4] OTE E4 ;', 'XIC Words[1].3 OTE W13 ;', 'XIC Words[1].2 OTE W12 ;'],
    });
    scans(c);
    expect(c.readBool('E3')).toBe(true);
    expect(c.readBool('E4')).toBe(false);
    expect(c.readBool('W13')).toBe(true);
    expect(c.readBool('W12')).toBe(false);
  });

  it('examine array elements with a tag subscript and an indirect bit number', () => {
    const c = run({
      tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 0), dint('W', 0), dint('Bit', 0), bool('Out'), bool('OutW')],
      rungs: ['XIC Bits[Idx] OTE Out ;', 'XIC W.[Bit] OTE OutW ;'],
    });
    c.write('Bits[7]', 1);
    c.write('W', 1 << 9);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    expect(c.readBool('OutW')).toBe(false);
    c.write('Idx', 7);
    c.write('Bit', 9);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    expect(c.readBool('OutW')).toBe(true);
  });

  it('examine I/O points (module input image)', () => {
    const c = run({
      modules: IO_MODULES,
      tags: [bool('In0'), bool('NotIn15')],
      rungs: ['XIC Local:1:I.Data.0 OTE In0 ;', 'XIO Local:1:I.Data.15 OTE NotIn15 ;'],
    });
    scans(c);
    expect(c.readBool('In0')).toBe(false);
    expect(c.readBool('NotIn15')).toBe(true);
    c.io.setInput(1, 0, true);
    c.io.setInput(1, 15, true);
    scans(c);
    expect(c.readBool('In0')).toBe(true);
    expect(c.readBool('NotIn15')).toBe(false);
  });

  it('a conditional instruction does not evaluate its operand when rung-condition-in is false', () => {
    // Idx is out of range: evaluating Bits[Idx] would raise a major fault.
    const c = run({
      tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 99), bool('Gate', 1), bool('Out')],
      rungs: ['XIO Gate XIC Bits[Idx] OTE Out ;', 'XIO Gate XIO Bits[Idx] OTE Out ;'],
    });
    scans(c, 3);
    expect(c.mode).toBe('RUN');
    c.write('Gate', 0);
    scans(c);
    expect(c.mode).toBe('FAULTED');
  });

  it('an out-of-range indirect bit number faults (Type 4 Code 20)', () => {
    const c = run({ tags: [dint('W'), dint('Bit', 32), bool('Out')], rungs: ['XIC W.[Bit] OTE Out ;'] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20 });
  });
});

describe('OTE', () => {
  it('false execution clears the bit', () => {
    const c = run({ tags: [bool('A'), bool('B')], rungs: ['XIC A OTE B ;'] });
    c.write('B', 1);
    scans(c);
    expect(c.readBool('B')).toBe(false);
    c.write('A', 1);
    scans(c);
    expect(c.readBool('B')).toBe(true);
    c.write('A', 0);
    scans(c);
    expect(c.readBool('B')).toBe(false);
  });

  it('an OTE with no conditions is always energized', () => {
    const c = run({ tags: [bool('B')], rungs: ['OTE B ;'] });
    scans(c);
    expect(c.readBool('B')).toBe(true);
  });

  it('writes integer bits without disturbing the other bits, including the sign bit', () => {
    const c = run({
      tags: [bool('A'), dint('W', 0x0f0), dint('D'), int('I16'), sint('S8')],
      rungs: ['XIC A OTE W.4 ;', 'XIC A OTE W.31 ;', 'XIC A OTE I16.15 ;', 'XIC A OTE S8.7 ;', 'XIO A OTE D.0 ;'],
    });
    scans(c);
    expect(c.readNumber('W')).toBe(0x0e0);
    expect(c.readNumber('D')).toBe(1);
    c.write('A', 1);
    scans(c);
    expect(c.readNumber('W')).toBe((0x0f0 | 0x80000000) | 0);
    expect(c.readNumber('W')).toBeLessThan(0);
    expect(c.readNumber('I16')).toBe(-32768);
    expect(c.readNumber('S8')).toBe(-128);
    expect(c.readNumber('D')).toBe(0);
    c.write('A', 0);
    scans(c);
    expect(c.readNumber('W')).toBe(0x0e0);
    expect(c.readNumber('I16')).toBe(0);
    expect(c.readNumber('S8')).toBe(0);
  });

  it('writes BOOL array elements and I/O output points', () => {
    const c = run({
      modules: IO_MODULES,
      tags: [bool('A'), arr('Bits', 'BOOL', [32])],
      rungs: ['XIC A OTE Bits[5] ;', 'XIC A OTE Local:2:O.Data.3 ;'],
    });
    c.write('A', 1);
    scans(c);
    expect(c.readBool('Bits[5]')).toBe(true);
    expect(c.readBool('Bits[4]')).toBe(false);
    expect(c.readBool('Local:2:O.Data.3')).toBe(true);
    expect(c.io.getOutput(2, 3)).toBe(true);
  });

  it('two OTEs on the same bit: the last rung wins', () => {
    const c = run({ tags: [bool('A', 1), bool('B'), bool('X')], rungs: ['XIC A OTE X ;', 'XIC B OTE X ;'] });
    scans(c);
    expect(c.readBool('X')).toBe(false);
    c.write('B', 1);
    c.write('A', 0);
    scans(c);
    expect(c.readBool('X')).toBe(true);
  });

  it('prescan clears OTE bits on entering Run', () => {
    const c = load({ tags: [bool('A'), bool('B'), dint('W')], rungs: ['XIC A OTE B ;', 'XIC A OTE W.2 ;'] });
    c.write('B', 1);
    c.write('W', 0x7);
    expect(c.setMode('RUN')).toBeNull();
    // no scan yet: prescan alone cleared the OTE targets
    expect(c.readBool('B')).toBe(false);
    expect(c.readNumber('W')).toBe(0x3);
  });
});

describe('OTL / OTU', () => {
  it('latch and unlatch only act on a true rung', () => {
    const c = run({ tags: [bool('Set'), bool('Reset'), bool('L')], rungs: ['XIC Set OTL L ;', 'XIC Reset OTU L ;'] });
    scans(c);
    expect(c.readBool('L')).toBe(false);
    c.write('Set', 1);
    scans(c);
    expect(c.readBool('L')).toBe(true);
    c.write('Set', 0);
    scans(c, 3);
    expect(c.readBool('L')).toBe(true);
    c.write('Reset', 1);
    scans(c);
    expect(c.readBool('L')).toBe(false);
    c.write('Reset', 0);
    scans(c, 3);
    expect(c.readBool('L')).toBe(false);
  });

  it('when both rungs are true, the later instruction wins', () => {
    const c = run({ tags: [bool('Set', 1), bool('Reset', 1), bool('L')], rungs: ['XIC Set OTL L ;', 'XIC Reset OTU L ;'] });
    scans(c);
    expect(c.readBool('L')).toBe(false);
    const d = run({ tags: [bool('Set', 1), bool('Reset', 1), bool('L')], rungs: ['XIC Reset OTU L ;', 'XIC Set OTL L ;'] });
    scans(d);
    expect(d.readBool('L')).toBe(true);
  });

  it('OTL/OTU targets are retentive across Program -> Run (not cleared by prescan) while OTE targets are cleared', () => {
    const c = run({
      tags: [bool('Go'), bool('L'), bool('U', 1), bool('O')],
      rungs: ['XIC Go OTL L ;', 'XIO U OTU U ;', 'XIC Go OTE O ;'],
    });
    c.write('Go', 1);
    scans(c);
    expect(c.readBool('L')).toBe(true);
    expect(c.readBool('O')).toBe(true);
    expect(c.readBool('U')).toBe(true);
    c.write('Go', 0);
    expect(c.setMode('PROGRAM')).toBeNull();
    scans(c, 2);
    // Program mode does not touch tag values
    expect(c.readBool('L')).toBe(true);
    expect(c.readBool('O')).toBe(true);
    expect(c.setMode('RUN')).toBeNull();
    expect(c.readBool('L')).toBe(true);
    expect(c.readBool('U')).toBe(true);
    expect(c.readBool('O')).toBe(false);
    scans(c);
    expect(c.readBool('L')).toBe(true);
  });

  it('latch an integer bit and an I/O output point', () => {
    const c = run({
      modules: IO_MODULES,
      tags: [bool('Set'), bool('Reset'), dint('W')],
      rungs: ['XIC Set [OTL W.31 ,OTL Local:2:O.Data.15 ] ;', 'XIC Reset [OTU W.31 ,OTU Local:2:O.Data.15 ] ;'],
    });
    c.write('Set', 1);
    scans(c);
    c.write('Set', 0);
    scans(c);
    expect(c.readNumber('W')).toBe(-2147483648);
    expect(c.io.getOutput(2, 15)).toBe(true);
    c.write('Reset', 1);
    scans(c);
    expect(c.readNumber('W')).toBe(0);
    expect(c.io.getOutput(2, 15)).toBe(false);
  });
});

describe('ONS', () => {
  const setup = (input = 0): LadderSetup => ({
    tags: [bool('In', input), bool('Store'), bool('Pulse'), bool('Count1'), bool('Count2')],
    rungs: [
      'XIC In ONS Store OTE Pulse ;',
      // a crude two-pulse detector: Count1 on the first pulse, Count2 on the second
      'XIC Pulse XIC Count1 OTL Count2 ;',
      'XIC Pulse OTL Count1 ;',
    ],
  });

  it('produces a single-scan pulse on a false-to-true transition', () => {
    const c = run(setup());
    scans(c);
    expect(c.readBool('Pulse')).toBe(false);
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Pulse')).toBe(true);
    expect(c.readBool('Store')).toBe(true);
    scans(c);
    expect(c.readBool('Pulse')).toBe(false);
    expect(c.readBool('Store')).toBe(true);
    scans(c, 5);
    expect(c.readBool('Pulse')).toBe(false);
    expect(c.readBool('Count1')).toBe(true);
    expect(c.readBool('Count2')).toBe(false);
    c.write('In', 0);
    scans(c);
    expect(c.readBool('Pulse')).toBe(false);
    expect(c.readBool('Store')).toBe(false);
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Pulse')).toBe(true);
    expect(c.readBool('Count2')).toBe(true);
  });

  it('prescan sets the storage bit so a rung already true at Run entry does not pulse', () => {
    const c = load(setup(1));
    c.write('Store', 0);
    expect(c.setMode('RUN')).toBeNull();
    expect(c.readBool('Store')).toBe(true);
    scans(c);
    expect(c.readBool('Pulse')).toBe(false);
    expect(c.readBool('Count1')).toBe(false);
  });

  it('a rung false at Run entry pulses on its first true scan', () => {
    const c = run(setup(0));
    scans(c);
    expect(c.readBool('Store')).toBe(false);
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Pulse')).toBe(true);
  });

  it('ONS gates only the instructions after it; preceding conditions feed its rung-condition-in', () => {
    const c = run({
      tags: [bool('A'), bool('B'), bool('S'), bool('Before'), bool('After')],
      rungs: ['XIC A [OTE Before ,XIC B ONS S OTE After ] ;'],
    });
    c.write('B', 1);
    scans(c, 2);
    expect(c.readBool('After')).toBe(false);
    c.write('A', 1);
    scans(c);
    expect(c.readBool('Before')).toBe(true);
    expect(c.readBool('After')).toBe(true);
    scans(c);
    expect(c.readBool('Before')).toBe(true);
    expect(c.readBool('After')).toBe(false);
  });

  it('uses an integer bit as the storage bit', () => {
    const c = run({ tags: [bool('In'), dint('Store'), bool('Pulse')], rungs: ['XIC In ONS Store.4 OTE Pulse ;'] });
    scans(c);
    expect(c.readNumber('Store')).toBe(0);
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Pulse')).toBe(true);
    expect(c.readNumber('Store')).toBe(16);
  });
});

describe('OSR', () => {
  const setup = (input = 0): LadderSetup => ({
    tags: [bool('In', input), bool('Store'), bool('Out'), bool('Rco')],
    rungs: ['XIC In OSR Store Out OTE Rco ;'],
  });

  it('sets the output bit for exactly one scan on a rising edge', () => {
    const c = run(setup());
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    expect(c.readBool('Store')).toBe(false);
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    expect(c.readBool('Store')).toBe(true);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    expect(c.readBool('Store')).toBe(true);
    c.write('In', 0);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    expect(c.readBool('Store')).toBe(false);
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });

  it('passes rung-condition-in through (an output instruction, not a pulse gate)', () => {
    const c = run(setup());
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Rco')).toBe(true);
    scans(c);
    expect(c.readBool('Rco')).toBe(true);
    c.write('In', 0);
    scans(c);
    expect(c.readBool('Rco')).toBe(false);
  });

  it('prescan sets the storage bit and clears the output bit', () => {
    const c = load(setup(1));
    c.write('Store', 0);
    c.write('Out', 1);
    expect(c.setMode('RUN')).toBeNull();
    expect(c.readBool('Store')).toBe(true);
    expect(c.readBool('Out')).toBe(false);
    scans(c);
    // already true at Run entry: no pulse
    expect(c.readBool('Out')).toBe(false);
  });
});

describe('OSF', () => {
  const setup = (input = 0): LadderSetup => ({
    tags: [bool('In', input), bool('Store'), bool('Out'), bool('Rco')],
    rungs: ['XIC In OSF Store Out OTE Rco ;'],
  });

  it('sets the output bit for exactly one scan on a falling edge', () => {
    const c = run(setup());
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    expect(c.readBool('Store')).toBe(true);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('In', 0);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    expect(c.readBool('Store')).toBe(false);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    scans(c, 3);
    expect(c.readBool('Out')).toBe(false);
  });

  it('passes rung-condition-in through', () => {
    const c = run(setup(1));
    scans(c);
    expect(c.readBool('Rco')).toBe(true);
    c.write('In', 0);
    scans(c);
    expect(c.readBool('Rco')).toBe(false);
  });

  it('prescan clears the storage and output bits (no false pulse when the rung is false at Run entry)', () => {
    const c = load(setup(0));
    c.write('Store', 1);
    c.write('Out', 1);
    expect(c.setMode('RUN')).toBeNull();
    expect(c.readBool('Store')).toBe(false);
    expect(c.readBool('Out')).toBe(false);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
  });

  it('a rung true at Run entry pulses when it later goes false', () => {
    const c = run(setup(1));
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('In', 0);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });
});

describe('rung power flow', () => {
  it('multiple outputs in series all receive the same rung condition', () => {
    const c = run({ tags: [bool('A'), bool('B'), bool('C'), bool('D')], rungs: ['XIC A OTE B OTE C OTL D ;'] });
    scans(c);
    expect([c.readBool('B'), c.readBool('C'), c.readBool('D')]).toEqual([false, false, false]);
    c.write('A', 1);
    scans(c);
    expect([c.readBool('B'), c.readBool('C'), c.readBool('D')]).toEqual([true, true, true]);
    c.write('A', 0);
    scans(c);
    expect([c.readBool('B'), c.readBool('C'), c.readBool('D')]).toEqual([false, false, true]);
  });

  it('an output followed by an input: XIC A OTE B XIC C OTE D', () => {
    const c = run({ tags: [bool('A'), bool('B'), bool('C'), bool('D')], rungs: ['XIC A OTE B XIC C OTE D ;'] });
    for (const [a, cc] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      c.write('A', a);
      c.write('C', cc);
      scans(c);
      expect(c.readBool('B')).toBe(a === 1);
      expect(c.readBool('D')).toBe(a === 1 && cc === 1);
    }
  });

  it('parallel output branches each receive the rung condition', () => {
    const c = run({
      tags: [bool('A'), bool('B'), bool('C'), bool('D'), bool('E'), bool('F')],
      rungs: ['XIC A [OTE B ,OTE C ,XIC D OTE E ] OTE F ;'],
    });
    c.write('A', 1);
    scans(c);
    expect([c.readBool('B'), c.readBool('C'), c.readBool('E'), c.readBool('F')]).toEqual([true, true, false, true]);
    c.write('D', 1);
    scans(c);
    expect(c.readBool('E')).toBe(true);
    c.write('A', 0);
    scans(c);
    expect([c.readBool('B'), c.readBool('C'), c.readBool('E'), c.readBool('F')]).toEqual([false, false, false, false]);
  });

  it('nested branches: OR of legs, AND in series', () => {
    // F = A AND (B OR (C AND (D OR NOT E)))
    const c = run({
      tags: [bool('A'), bool('B'), bool('C'), bool('D'), bool('E'), bool('F')],
      rungs: ['XIC A [XIC B ,XIC C [XIC D ,XIO E ] ] OTE F ;'],
    });
    for (let m = 0; m < 32; m++) {
      const [a, b, cc, d, e] = [0, 1, 2, 3, 4].map((k) => (m >> k) & 1);
      c.write('A', a);
      c.write('B', b);
      c.write('C', cc);
      c.write('D', d);
      c.write('E', e);
      scans(c);
      const expected = !!a && (!!b || (!!cc && (!!d || !e)));
      expect(c.readBool('F'), `A=${a} B=${b} C=${cc} D=${d} E=${e}`).toBe(expected);
    }
  });

  it('every leg of a branch executes even when an earlier leg is true (no short-circuit)', () => {
    const c = run({ tags: [bool('A', 1), bool('X'), bool('Y'), bool('Z')], rungs: ['[XIC A OTE X ,XIC A OTE Y ] OTE Z ;'] });
    scans(c);
    expect([c.readBool('X'), c.readBool('Y'), c.readBool('Z')]).toEqual([true, true, true]);
  });

  it('the power-flow array matches walkRung element ids', () => {
    const c = run({
      tags: [bool('A', 1), bool('B', 0), bool('C', 1), bool('D', 0), bool('E', 0), bool('F')],
      rungs: ['XIC A [XIC B ,XIC C [XIC D ,XIO E ] ] OTE F ;', 'XIC B OTE D ;'],
    });
    const st = c.ladderState('MainProgram', 'MainRoutine')!;
    expect(st).toBeDefined();
    expect(st.power[0].length).toBe(walkRung(st.rungs[0].elements, () => {}));
    expect(st.power[0].length).toBe(8);
    // prescan leaves no power flow
    expect([...st.power[0]]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    scans(c);
    expect(powerByLabel(c, 0)).toEqual({
      'XIC A': 1,
      'branch@1': 1,
      'XIC B': 0,
      'XIC C': 1,
      'branch@4': 1,
      'XIC D': 0,
      'XIO E': 1,
      'OTE F': 1,
    });
    expect(powerByLabel(c, 1)).toEqual({ 'XIC B': 0, 'OTE D': 0 });
    expect(st.rungIn[0]).toBe(1);
    expect(st.rungIn[1]).toBe(1);

    c.write('A', 0);
    c.write('E', 1);
    scans(c);
    const pf = powerByLabel(c, 0);
    // A false: everything downstream is false; XIO E sees a false rung-condition-in
    expect(Object.values(pf).every((v) => v === 0)).toBe(true);

    c.write('A', 1);
    c.write('B', 1);
    scans(c);
    expect(powerByLabel(c, 0)).toEqual({
      'XIC A': 1,
      'branch@1': 1,
      'XIC B': 1,
      'XIC C': 1,
      'branch@4': 0,
      'XIC D': 0,
      'XIO E': 0,
      'OTE F': 1,
    });
  });

  it('the power-flow of an output is its rung-condition-out', () => {
    const c = run({ tags: [bool('A', 1), bool('B'), bool('C')], rungs: ['XIC A OTE B XIC C OTE B ;'] });
    scans(c);
    const pf = c.ladderState('MainProgram', 'MainRoutine')!.power[0];
    expect([...pf]).toEqual([1, 1, 0, 0]);
  });
});

describe('bit instruction verify errors', () => {
  const tags = [bool('A'), bool('B'), bool('C'), dint('W'), real('R')];

  it('a rung must end with an output instruction', () => {
    const errs = verifyErrors({ tags, rungs: ['XIC A OTE B ;', 'XIC A XIO B ;'] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ rung: 1, routine: 'MainRoutine', program: 'MainProgram' });
    expect(errs[0].message).toMatch(/must end with an output/i);
  });

  it('a rung ending in ONS (an input instruction) is an error', () => {
    expect(errorText({ tags, rungs: ['XIC A ONS B ;'] })).toMatch(/must end with an output/i);
  });

  it('a branch at the end of the rung must end with outputs on every leg', () => {
    expect(errorText({ tags, rungs: ['XIC A [OTE B ,XIC C ] ;'] })).toMatch(/must end with an output/i);
  });

  it('unknown instruction', () => {
    const errs = verifyErrors({ tags, rungs: ['XIC A FOO B OTE C ;'] });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toMatch(/Unknown instruction 'FOO'/);
    expect(errs[0]).toMatchObject({ rung: 0, element: 1 });
    expect(errorText({ tags, rungs: ['XIC(A)BAR(B)OTE(C);'] })).toMatch(/Unknown instruction 'BAR'/);
  });

  it('wrong operand count', () => {
    const e1 = verifyErrors({ tags, rungs: ['XIC(A,B)OTE(C);'] });
    expect(e1).toHaveLength(1);
    expect(e1[0].message).toMatch(/XIC expects 1 operand/);
    expect(e1[0]).toMatchObject({ rung: 0, element: 0 });
    expect(errorText({ tags, rungs: ['XIC(A)OTE();'] })).toMatch(/OTE expects 1 operand/);
    expect(errorText({ tags, rungs: ['XIC(A)OSR(B);'] })).toMatch(/OSR expects 2 operand/);
    expect(errorText({ tags, rungs: ['XIC(A)OSF(A,B,C);'] })).toMatch(/OSF expects 2 operand/);
  });

  it('missing operand in spaced form', () => {
    const errs = verifyErrors({ tags, rungs: ['XIC A OTE ? ;'] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ rung: 0, element: 1, operand: 0 });
    expect(errs[0].message).toMatch(/Missing operand/);
  });

  it('operand type errors: non-BOOL tag, immediate, undefined tag, read-only status flag', () => {
    expect(errorText({ tags, rungs: ['XIC W OTE B ;'] })).toMatch(/BOOL required/);
    expect(errorText({ tags, rungs: ['XIC R.1 OTE B ;'] })).toMatch(/bit access requires/i);
    expect(errorText({ tags, rungs: ['XIC 1 OTE B ;'] })).toMatch(/Immediate value not allowed/);
    expect(errorText({ tags, rungs: ['XIC A OTE W.32 ;'] })).toMatch(/out of range/);
    expect(errorText({ tags, rungs: ['XIC Nope OTE B ;'] })).toMatch(/Undefined tag 'Nope'/);
    expect(errorText({ tags, rungs: ['XIC A OTE S:FS ;'] })).toMatch(/read-only/);
  });

  it('a project with verify errors cannot be downloaded', () => {
    expect(() => load({ tags, rungs: ['XIC A ;'] })).toThrow(/Download failed/);
  });

  it('paren form and spaced form compile to the same behaviour', () => {
    const c = run({ tags: [bool('A'), bool('B'), bool('C'), bool('D')], rungs: ['[XIC(A),XIC(B)]XIO(C)OTE(D);'] });
    c.write('B', 1);
    scans(c);
    expect(c.readBool('D')).toBe(true);
    c.write('C', 1);
    scans(c);
    expect(c.readBool('D')).toBe(false);
  });
});
