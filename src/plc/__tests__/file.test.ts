import { describe, it, expect } from 'vitest';
import { run, load, scans, bool, dint, real, int, control, timer, arr, verifyErrors, type LadderSetup } from './helpers';
import { getInstruction, type Controller, type UDTDef } from '../index';

/** Pulse a BOOL tag: one scan true, one scan false. */
function pulse(c: Controller, tag: string, n = 1): void {
  for (let i = 0; i < n; i++) {
    c.write(tag, 1);
    scans(c);
    c.write(tag, 0);
    scans(c);
  }
}

/** Read bit k of a DINT array (bit k is bit k%32 of element floor(k/32)). */
function bitOf(c: Controller, array: string, k: number): number {
  return (c.readNumber(`${array}[${k >>> 5}]`) >>> (k & 31)) & 1;
}

/** Go to Run and execute one scan with every input false (clears the FIFO/LIFO prescan edge bits). */
function start(setup: LadderSetup): Controller {
  const c = run(setup);
  scans(c);
  return c;
}

function errorText(setup: LadderSetup): string {
  return verifyErrors(setup)
    .map((e) => e.message)
    .join('\n');
}

/** Deterministic PRNG for the model comparison tests. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

describe('File/Shift instruction metadata', () => {
  it('registers BSL, BSR, FFL, FFU, LFL, LFU as File/Shift output boxes', () => {
    const titles: Record<string, string> = {
      BSL: 'Bit Shift Left',
      BSR: 'Bit Shift Right',
      FFL: 'FIFO Load',
      FFU: 'FIFO Unload',
      LFL: 'LIFO Load',
      LFU: 'LIFO Unload',
    };
    for (const [m, title] of Object.entries(titles)) {
      const d = getInstruction(m)!;
      expect(d, m).toBeDefined();
      expect(d.category).toBe('File/Shift');
      expect(d.title).toBe(title);
      expect(d.kind).toBe('output');
      expect(d.box).toBe(true);
    }
    expect(getInstruction('BSL')!.operands.map((o) => o.name)).toEqual(['Array', 'Control', 'Source Bit', 'Length']);
    expect(getInstruction('FFL')!.operands.map((o) => o.name)).toEqual(['Source', 'FIFO', 'Control', 'Length', 'Position']);
    expect(getInstruction('FFU')!.operands.map((o) => o.name)).toEqual(['FIFO', 'Dest', 'Control', 'Length', 'Position']);
    expect(getInstruction('LFL')!.operands.map((o) => o.name)).toEqual(['Source', 'LIFO', 'Control', 'Length', 'Position']);
    expect(getInstruction('LFU')!.operands.map((o) => o.name)).toEqual(['LIFO', 'Dest', 'Control', 'Length', 'Position']);
  });
});

// ============================================================================= BSL / BSR

describe('BSL - Bit Shift Left', () => {
  const setup = (rung = 'XIC Go BSL Bits[0] Ctl Src 40 ;', bits: number[] = [0, 0, 0]): LadderSetup => ({
    tags: [bool('Go'), bool('Src'), arr('Bits', 'DINT', [3], bits), control('Ctl')],
    rungs: [rung],
  });

  it('shifts 40 bits across two DINTs; UL gets bit 39; bits beyond LEN untouched', () => {
    // bit 0 and bit 31 set in Bits[0]; bit 39 (= LEN-1) and bit 40 (beyond LEN) set in Bits[1]
    const c = run(setup(undefined, [0x80000001 | 0, 0x180, 0x12345678]));
    c.write('Src', 1);
    pulse(c, 'Go');
    expect(c.readNumber('Bits[0]')).toBe(3); // source into bit 0, old bit 0 -> bit 1
    expect(c.readNumber('Bits[1]')).toBe(0x101); // old bit 31 -> bit 32; bit 40 untouched; old bit 39 shifted out
    expect(c.readNumber('Bits[2]')).toBe(0x12345678);
    expect(c.readBool('Ctl.UL')).toBe(true);
  });

  it('sets EN/DN and POS = LEN on the shift; rung false clears EN/DN/ER/POS but retains UL', () => {
    const c = run(setup(undefined, [0, 0x80, 0]));
    c.write('Go', 1);
    scans(c);
    expect(c.readBool('Ctl.EN')).toBe(true);
    expect(c.readBool('Ctl.DN')).toBe(true);
    expect(c.readBool('Ctl.ER')).toBe(false);
    expect(c.readNumber('Ctl.POS')).toBe(40);
    expect(c.readNumber('Ctl.LEN')).toBe(40);
    expect(c.readBool('Ctl.UL')).toBe(true);
    c.write('Go', 0);
    scans(c);
    expect(c.readBool('Ctl.EN')).toBe(false);
    expect(c.readBool('Ctl.DN')).toBe(false);
    expect(c.readNumber('Ctl.POS')).toBe(0);
    expect(c.readBool('Ctl.UL')).toBe(true);
  });

  it('shifts the source bit in on every false->true transition', () => {
    const c = run(setup());
    c.write('Src', 1);
    pulse(c, 'Go');
    c.write('Src', 0);
    pulse(c, 'Go');
    c.write('Src', 1);
    pulse(c, 'Go');
    // shifted in 1, 0, 1 -> bits 2..0 = 1 0 1
    expect(c.readNumber('Bits[0]')).toBe(0b101);
  });

  it('is edge-triggered: holding the rung true shifts only once', () => {
    const c = run(setup(undefined, [1, 0, 0]));
    c.write('Go', 1);
    scans(c, 5);
    expect(c.readNumber('Bits[0]')).toBe(2);
    c.write('Go', 0);
    scans(c);
    c.write('Go', 1);
    scans(c, 3);
    expect(c.readNumber('Bits[0]')).toBe(4);
  });

  it('handles bit 31 (the DINT goes negative) and carries it out as UL with LEN 32', () => {
    const c = run(setup('XIC Go BSL Bits[0] Ctl Src 32 ;', [0x40000000, 0, 0]));
    pulse(c, 'Go');
    expect(c.readNumber('Bits[0]')).toBe(-2147483648);
    expect(c.readBool('Ctl.UL')).toBe(false);
    pulse(c, 'Go');
    expect(c.readNumber('Bits[0]')).toBe(0);
    expect(c.readBool('Ctl.UL')).toBe(true);
    expect(c.readNumber('Bits[1]')).toBe(0);
  });

  it('moves bit 31 into bit 32 of the next element and keeps a full -1 word consistent', () => {
    const c = run(setup('XIC Go BSL Bits[0] Ctl Src 64 ;', [-1, 0, 0]));
    pulse(c, 'Go');
    expect(c.readNumber('Bits[0]')).toBe(-2); // 0xFFFFFFFE
    expect(c.readNumber('Bits[1]')).toBe(1);
    c.write('Src', 1);
    pulse(c, 'Go');
    expect(c.readNumber('Bits[0]')).toBe(-3); // 0xFFFFFFFD
    expect(c.readNumber('Bits[1]')).toBe(3);
  });

  it('uses the live .LEN when it is changed at run time', () => {
    const c = run(setup(undefined, [0x80, 0, 0]));
    c.write('Ctl.LEN', 8);
    c.write('Go', 1);
    scans(c);
    // bit 7 is bit LEN-1: it is shifted out to UL and nothing moves into bit 8
    expect(c.readNumber('Bits[0]')).toBe(0);
    expect(c.readBool('Ctl.UL')).toBe(true);
    expect(c.readNumber('Ctl.POS')).toBe(8);
    c.write('Go', 0);
    scans(c);
    c.write('Bits[0]', 0x1ff);
    pulse(c, 'Go');
    // bits 0..7 shifted (bit 7 out), bit 8 untouched
    expect(c.readNumber('Bits[0]')).toBe(0x1fe);
  });

  it('LEN 0: sets DN without shifting', () => {
    const c = run(setup(undefined, [5, 0, 0]));
    c.write('Ctl.LEN', 0);
    c.write('Go', 1);
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.readNumber('Bits[0]')).toBe(5);
    expect(c.readBool('Ctl.DN')).toBe(true);
  });

  it('LEN larger than the array faults the controller (Type 4 Code 20) and sets ER', () => {
    const c = run(setup('XIC Go BSL Bits[0] Ctl Src 97 ;'));
    c.write('Go', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.type).toBe(4);
    expect(c.majorFault?.code).toBe(20);
    expect(c.majorFault?.instruction).toBe('BSL');
    expect(c.majorFault?.rung).toBe(0);
    expect(c.readBool('Ctl.ER')).toBe(true);
  });

  it('LEN = 32 x available elements is allowed (no fault)', () => {
    const c = run(setup('XIC Go BSL Bits[0] Ctl Src 96 ;', [0, 0, 1 << 31]));
    c.write('Src', 1);
    pulse(c, 'Go');
    expect(c.mode).toBe('RUN');
    expect(c.readBool('Ctl.UL')).toBe(true);
    expect(c.readNumber('Bits[0]')).toBe(1);
    expect(c.readNumber('Bits[2]')).toBe(0);
  });

  it('negative LEN written at run time faults (Type 4 Code 20)', () => {
    const c = run(setup());
    c.write('Ctl.LEN', -1);
    c.write('Go', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.type).toBe(4);
    expect(c.majorFault?.code).toBe(20);
  });

  it('a start element of Bits[1] shifts from element 1 and counts only the remaining elements', () => {
    const c = run(setup('XIC Go BSL Bits[1] Ctl Src 64 ;', [7, 0x80000000 | 0, 0]));
    c.write('Src', 1);
    pulse(c, 'Go');
    expect(c.readNumber('Bits[0]')).toBe(7);
    expect(c.readNumber('Bits[1]')).toBe(1);
    expect(c.readNumber('Bits[2]')).toBe(1);
    expect(c.mode).toBe('RUN');

    const f = run(setup('XIC Go BSL Bits[1] Ctl Src 65 ;'));
    f.write('Go', 1);
    scans(f);
    expect(f.mode).toBe('FAULTED');
    expect(f.majorFault?.code).toBe(20);
  });

  it('accepts a whole DINT array and a single DINT as the array operand', () => {
    const c = run({
      tags: [bool('Go'), bool('Src', 1), arr('Bits', 'DINT', [2]), dint('Word', 0x40000000), control('C1'), control('C2')],
      rungs: ['XIC Go BSL Bits C1 Src 33 ;', 'XIC Go BSL Word C2 Src 32 ;'],
    });
    pulse(c, 'Go', 2);
    expect(c.readNumber('Bits[0]')).toBe(3);
    expect(c.readNumber('Word')).toBe(3); // bit 30 -> 31 -> out
    expect(c.readBool('C2.UL')).toBe(true);
  });

  it('prescan clears EN, DN, ER and POS (a true rung shifts on the first scan)', () => {
    const c = run({
      tags: [bool('Go', 1), bool('Src', 1), arr('Bits', 'DINT', [1]), { name: 'Ctl', dataType: 'CONTROL', value: { EN: 1, DN: 1, ER: 1, POS: 9 } }],
      rungs: ['XIC Go BSL Bits[0] Ctl Src 8 ;'],
    });
    expect(c.readBool('Ctl.EN')).toBe(false);
    expect(c.readBool('Ctl.DN')).toBe(false);
    expect(c.readBool('Ctl.ER')).toBe(false);
    expect(c.readNumber('Ctl.POS')).toBe(0);
    scans(c);
    expect(c.readNumber('Bits[0]')).toBe(1);
    scans(c, 3);
    expect(c.readNumber('Bits[0]')).toBe(1);
  });

  it('paren form parses and works the same', () => {
    const c = run({ tags: [bool('Go'), bool('Src', 1), arr('Bits', 'DINT', [2]), control('Ctl')], rungs: ['XIC(Go)BSL(Bits[0],Ctl,Src,40);'] });
    pulse(c, 'Go', 3);
    expect(c.readNumber('Bits[0]')).toBe(7);
  });

  it('matches a bit-by-bit model for random data and lengths', () => {
    const rnd = lcg(12345);
    for (const len of [1, 5, 31, 32, 33, 40, 63, 64, 65, 95, 96]) {
      const init = [rnd() | 0, rnd() | 0, rnd() | 0];
      const c = run({
        tags: [bool('Go'), bool('Src'), arr('Bits', 'DINT', [3], init), control('Ctl')],
        rungs: [`XIC Go BSL Bits[0] Ctl Src ${len} ;`],
      });
      const model: number[] = [];
      for (let k = 0; k < 96; k++) model.push((init[k >>> 5] >>> (k & 31)) & 1);
      for (let step = 0; step < 5; step++) {
        const src = rnd() & 1;
        c.write('Src', src);
        pulse(c, 'Go');
        const ul = model[len - 1];
        for (let k = len - 1; k >= 1; k--) model[k] = model[k - 1];
        model[0] = src;
        expect(c.readNumber('Ctl.UL'), `len ${len} step ${step} UL`).toBe(ul);
        for (let k = 0; k < 96; k++) expect(bitOf(c, 'Bits', k), `len ${len} step ${step} bit ${k}`).toBe(model[k]);
      }
    }
  });
});

describe('BSR - Bit Shift Right', () => {
  const setup = (rung = 'XIC Go BSR Bits[0] Ctl Src 40 ;', bits: number[] = [0, 0, 0]): LadderSetup => ({
    tags: [bool('Go'), bool('Src'), arr('Bits', 'DINT', [3], bits), control('Ctl')],
    rungs: [rung],
  });

  it('shifts 40 bits toward bit 0 across two DINTs; source enters bit LEN-1; UL gets bit 0', () => {
    // bit 0 and bit 1 set; bit 32 set; bit 40 (beyond LEN) set
    const c = run(setup(undefined, [3, 0x101, 0x55]));
    c.write('Src', 1);
    c.write('Go', 1);
    scans(c);
    expect(c.readBool('Ctl.UL')).toBe(true); // old bit 0
    // old bit 1 -> bit 0, old bit 32 -> bit 31 (negative DINT)
    expect(c.readNumber('Bits[0]')).toBe((0x80000001 | 0));
    // source -> bit 39 (0x80), bit 40 untouched (0x100)
    expect(c.readNumber('Bits[1]')).toBe(0x180);
    expect(c.readNumber('Bits[2]')).toBe(0x55);
    expect(c.readNumber('Ctl.POS')).toBe(40);
    expect(c.readBool('Ctl.DN')).toBe(true);
  });

  it('handles bit 31 within a single DINT (LEN 32) and is edge-triggered', () => {
    const c = run(setup('XIC Go BSR Bits[0] Ctl Src 32 ;', [0x80000000 | 0, 0, 0]));
    c.write('Go', 1);
    scans(c, 4);
    expect(c.readNumber('Bits[0]')).toBe(0x40000000);
    c.write('Src', 1);
    c.write('Go', 0);
    scans(c);
    c.write('Go', 1);
    scans(c);
    expect(c.readNumber('Bits[0]')).toBe((0xa0000000 | 0));
    expect(c.readBool('Ctl.UL')).toBe(false);
  });

  it('uses the live .LEN and leaves bits >= LEN untouched', () => {
    const c = run(setup(undefined, [0xff01, 0, 0]));
    c.write('Ctl.LEN', 8);
    c.write('Src', 1);
    pulse(c, 'Go');
    // bits 0..7 = 0x01 -> UL = 1, bits become 0x80 (source at bit 7); bits 8..15 untouched
    expect(c.readNumber('Bits[0]')).toBe(0xff80);
    expect(c.readBool('Ctl.UL')).toBe(true);
  });

  it('LEN too big faults (Type 4 Code 20)', () => {
    const c = run(setup('XIC Go BSR Bits[2] Ctl Src 33 ;'));
    c.write('Go', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.type).toBe(4);
    expect(c.majorFault?.code).toBe(20);
    expect(c.majorFault?.instruction).toBe('BSR');
    expect(c.readBool('Ctl.ER')).toBe(true);
  });

  it('matches a bit-by-bit model for random data and lengths', () => {
    const rnd = lcg(777);
    for (const len of [1, 2, 31, 32, 33, 40, 64, 65, 96]) {
      const init = [rnd() | 0, rnd() | 0, rnd() | 0];
      const c = run({
        tags: [bool('Go'), bool('Src'), arr('Bits', 'DINT', [3], init), control('Ctl')],
        rungs: [`XIC Go BSR Bits[0] Ctl Src ${len} ;`],
      });
      const model: number[] = [];
      for (let k = 0; k < 96; k++) model.push((init[k >>> 5] >>> (k & 31)) & 1);
      for (let step = 0; step < 5; step++) {
        const src = rnd() & 1;
        c.write('Src', src);
        pulse(c, 'Go');
        const ul = model[0];
        for (let k = 0; k < len - 1; k++) model[k] = model[k + 1];
        model[len - 1] = src;
        expect(c.readNumber('Ctl.UL'), `len ${len} step ${step} UL`).toBe(ul);
        for (let k = 0; k < 96; k++) expect(bitOf(c, 'Bits', k), `len ${len} step ${step} bit ${k}`).toBe(model[k]);
      }
    }
  });
});

describe('Bit shift register: reject tracking on a conveyor', () => {
  it('a reject seen at the sensor reaches the ejector position after N encoder pulses', () => {
    const EJECT_AT = 37; // crosses the DINT boundary
    const c = run({
      tags: [bool('Pulse'), bool('RejectSensor'), bool('Ejector'), arr('Track', 'DINT', [2]), control('TrackCtl')],
      rungs: [
        'XIC Pulse BSL Track[0] TrackCtl RejectSensor 64 ;',
        `XIC Track[${EJECT_AT >>> 5}].${EJECT_AT & 31} OTE Ejector ;`,
      ],
    });
    // A reject part is under the sensor on the first pulse: it enters at position 0.
    c.write('RejectSensor', 1);
    pulse(c, 'Pulse');
    c.write('RejectSensor', 0);
    expect(bitOf(c, 'Track', 0)).toBe(1);
    for (let n = 1; n <= EJECT_AT; n++) {
      expect(c.readBool('Ejector'), `before pulse ${n}`).toBe(false);
      pulse(c, 'Pulse');
      // after n more pulses the reject bit is at position n, and only there
      expect(bitOf(c, 'Track', n), `pulse ${n}`).toBe(1);
      expect(bitOf(c, 'Track', n - 1)).toBe(0);
    }
    expect(c.readBool('Ejector')).toBe(true);
    pulse(c, 'Pulse');
    expect(c.readBool('Ejector')).toBe(false);
  });

  it('tracks several parts at once (good, reject, reject, good)', () => {
    const c = run({
      tags: [bool('Pulse'), bool('RejectSensor'), arr('Track', 'DINT', [1]), control('TrackCtl')],
      rungs: ['XIC Pulse BSL Track[0] TrackCtl RejectSensor 16 ;'],
    });
    for (const r of [0, 1, 1, 0]) {
      c.write('RejectSensor', r);
      pulse(c, 'Pulse');
    }
    // first part is at position 3, last at position 0
    expect(c.readNumber('Track[0]')).toBe(0b0110);
    pulse(c, 'Pulse', 12);
    // the first reject (position 2 -> 14) is still inside the 16-bit register, the second at 13
    expect(c.readNumber('Track[0]')).toBe(0b0110 << 12);
    pulse(c, 'Pulse', 2);
    // the first reject fell off the end through UL on the 2nd pulse (pos 15 -> out)
    expect(c.readNumber('Track[0]')).toBe(1 << 15);
    expect(c.readBool('TrackCtl.UL')).toBe(true);
  });
});

// ============================================================================= FIFO / LIFO

describe('FFL / FFU - FIFO', () => {
  const fifo = (len = 3, size = 5, extra: Partial<LadderSetup> = {}): LadderSetup => ({
    tags: [bool('Load'), bool('Unload'), dint('Src'), dint('Dst', -1), arr('Fifo', 'DINT', [size]), control('Ctl'), ...(extra.tags ?? [])],
    rungs: extra.rungs ?? [`XIC Load FFL Src Fifo[0] Ctl ${len} 0 ;`, `XIC Unload FFU Fifo[0] Dst Ctl ${len} 0 ;`],
  });

  const loadValue = (c: Controller, v: number) => {
    c.write('Src', v);
    pulse(c, 'Load');
  };

  it('download applies Length/Position to the CONTROL tag', () => {
    const c = load({ tags: [dint('Src'), arr('Fifo', 'DINT', [8]), control('Ctl')], rungs: ['FFL Src Fifo[0] Ctl 6 2 ;'] });
    expect(c.mode).toBe('PROGRAM');
    expect(c.readNumber('Ctl.LEN')).toBe(6);
    expect(c.readNumber('Ctl.POS')).toBe(2);
    const b = load({ tags: [bool('Src'), arr('Bits', 'DINT', [2]), control('Ctl')], rungs: ['BSL Bits[0] Ctl Src 40 ;'] });
    expect(b.readNumber('Ctl.LEN')).toBe(40);
  });

  it('loads at .POS and unloads in first-in first-out order', () => {
    const c = start(fifo());
    loadValue(c, 10);
    loadValue(c, 20);
    loadValue(c, 30);
    expect(c.read('Fifo')).toEqual([10, 20, 30, 0, 0]);
    expect(c.readNumber('Ctl.POS')).toBe(3);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(10);
    expect(c.read('Fifo')).toEqual([20, 30, 0, 0, 0]);
    expect(c.readNumber('Ctl.POS')).toBe(2);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(20);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(30);
    expect(c.readNumber('Ctl.POS')).toBe(0);
  });

  it('.DN when full (further loads are ignored) and .EM when empty (unload leaves Dest unchanged)', () => {
    const c = start(fifo());
    scans(c);
    expect(c.readBool('Ctl.EM')).toBe(true);
    expect(c.readBool('Ctl.DN')).toBe(false);
    loadValue(c, 1);
    expect(c.readBool('Ctl.EM')).toBe(false);
    loadValue(c, 2);
    expect(c.readBool('Ctl.DN')).toBe(false);
    loadValue(c, 3);
    expect(c.readBool('Ctl.DN')).toBe(true);
    loadValue(c, 4);
    expect(c.readNumber('Ctl.POS')).toBe(3);
    expect(c.read('Fifo')).toEqual([1, 2, 3, 0, 0]);
    expect(c.mode).toBe('RUN');
    pulse(c, 'Unload', 3);
    expect(c.readNumber('Dst')).toBe(3);
    expect(c.readBool('Ctl.EM')).toBe(true);
    expect(c.readBool('Ctl.DN')).toBe(false);
    c.write('Dst', 99);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(99);
    expect(c.readNumber('Ctl.POS')).toBe(0);
  });

  it('refreshes .DN/.EM on every execution, even with a false rung', () => {
    const c = start(fifo());
    c.write('Ctl.POS', 3);
    scans(c);
    expect(c.readBool('Ctl.DN')).toBe(true);
    expect(c.readBool('Ctl.EM')).toBe(false);
    c.write('Ctl.POS', 0);
    scans(c);
    expect(c.readBool('Ctl.DN')).toBe(false);
    expect(c.readBool('Ctl.EM')).toBe(true);
  });

  it('unload shifts all LEN elements and clears the last one; elements beyond LEN are untouched', () => {
    const c = start(fifo(3, 5, { tags: [] }));
    c.write('Fifo', [0, 0, 0, 77, 88]);
    loadValue(c, 5);
    loadValue(c, 6);
    loadValue(c, 7);
    pulse(c, 'Unload');
    expect(c.read('Fifo')).toEqual([6, 7, 0, 77, 88]);
    // the whole LEN is shifted, not only POS elements
    c.write('Fifo[2]', 42);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(6);
    expect(c.read('Fifo')).toEqual([7, 42, 0, 77, 88]);
  });

  it('is edge-triggered: a held load/unload rung acts once (.EN / .EU)', () => {
    const c = start(fifo());
    c.write('Src', 8);
    c.write('Load', 1);
    scans(c, 4);
    expect(c.readNumber('Ctl.POS')).toBe(1);
    expect(c.readBool('Ctl.EN')).toBe(true);
    c.write('Load', 0);
    scans(c);
    expect(c.readBool('Ctl.EN')).toBe(false);
    c.write('Load', 1);
    scans(c);
    expect(c.readNumber('Ctl.POS')).toBe(2);
    c.write('Unload', 1);
    scans(c, 4);
    expect(c.readNumber('Ctl.POS')).toBe(1);
    expect(c.readBool('Ctl.EU')).toBe(true);
    c.write('Unload', 0);
    scans(c);
    expect(c.readBool('Ctl.EU')).toBe(false);
  });

  it('prescan sets .EN/.EU so rungs already true at Run entry do not load or unload', () => {
    const c = run({
      tags: [bool('Load', 1), bool('Unload', 1), dint('Src', 5), dint('Dst'), arr('Fifo', 'DINT', [4], [1, 2, 0, 0]), control('Ctl')],
      rungs: ['XIC Load FFL Src Fifo[0] Ctl 4 2 ;', 'XIC Unload FFU Fifo[0] Dst Ctl 4 2 ;'],
    });
    expect(c.readBool('Ctl.EN')).toBe(true);
    expect(c.readBool('Ctl.EU')).toBe(true);
    scans(c, 3);
    expect(c.readNumber('Ctl.POS')).toBe(2);
    expect(c.read('Fifo')).toEqual([1, 2, 0, 0]);
    expect(c.readNumber('Dst')).toBe(0);
    c.write('Load', 0);
    scans(c);
    c.write('Load', 1);
    scans(c);
    expect(c.read('Fifo')).toEqual([1, 2, 5, 0]);
  });

  it('FFL and FFU on the same scan sharing one CONTROL: load then unload', () => {
    const c = start(fifo(4, 4));
    loadValue(c, 1);
    loadValue(c, 2);
    c.write('Src', 3);
    c.write('Load', 1);
    c.write('Unload', 1);
    scans(c);
    expect(c.readNumber('Dst')).toBe(1);
    expect(c.read('Fifo')).toEqual([2, 3, 0, 0]);
    expect(c.readNumber('Ctl.POS')).toBe(2);
    expect(c.readBool('Ctl.EN')).toBe(true);
    expect(c.readBool('Ctl.EU')).toBe(true);
  });

  it('the load and unload edges are independent (EN vs EU)', () => {
    const c = start(fifo(4, 4));
    c.write('Src', 1);
    c.write('Load', 1);
    scans(c);
    // unload rung goes true while load is held: unload happens, no second load
    c.write('Unload', 1);
    scans(c);
    expect(c.readNumber('Dst')).toBe(1);
    expect(c.readNumber('Ctl.POS')).toBe(0);
    expect(c.readBool('Ctl.EM')).toBe(true);
  });

  it('uses the live .LEN and .POS', () => {
    const c = start(fifo(3, 5));
    c.write('Ctl.LEN', 5);
    c.write('Ctl.POS', 4);
    loadValue(c, 9);
    expect(c.read('Fifo')).toEqual([0, 0, 0, 0, 9]);
    expect(c.readBool('Ctl.DN')).toBe(true);
    pulse(c, 'Unload');
    expect(c.read('Fifo')).toEqual([0, 0, 0, 9, 0]);
    expect(c.readNumber('Ctl.POS')).toBe(4);
  });

  it('a start element other than 0 limits the available elements', () => {
    const c = start({
      tags: [bool('Load'), dint('Src', 4), arr('Fifo', 'DINT', [5]), control('Ctl')],
      rungs: ['XIC Load FFL Src Fifo[2] Ctl 3 0 ;'],
    });
    pulse(c, 'Load');
    expect(c.read('Fifo')).toEqual([0, 0, 4, 0, 0]);
    c.write('Ctl.LEN', 4);
    pulse(c, 'Load');
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.code).toBe(20);
  });

  it('.LEN larger than the array faults on load (Type 4 Code 20, .ER set)', () => {
    const c = start(fifo(6, 5));
    c.write('Load', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.type).toBe(4);
    expect(c.majorFault?.code).toBe(20);
    expect(c.majorFault?.instruction).toBe('FFL');
    expect(c.readBool('Ctl.ER')).toBe(true);
  });

  it('negative .POS faults on load', () => {
    const c = start(fifo());
    c.write('Ctl.POS', -1);
    pulse(c, 'Load');
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.type).toBe(4);
    expect(c.majorFault?.code).toBe(20);
  });

  it('a full FIFO (POS >= LEN) does not load and does not fault, even when LEN exceeds the array', () => {
    const c = start(fifo(3, 5));
    c.write('Ctl.LEN', 10);
    c.write('Ctl.POS', 10);
    pulse(c, 'Load');
    expect(c.mode).toBe('RUN');
    expect(c.readBool('Ctl.DN')).toBe(true);
  });

  it('.LEN larger than the array faults on unload (Type 4 Code 20)', () => {
    const c = start(fifo(3, 5));
    loadValue(c, 1);
    c.write('Ctl.LEN', 6);
    pulse(c, 'Unload');
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.code).toBe(20);
    expect(c.majorFault?.instruction).toBe('FFU');
    expect(c.readBool('Ctl.ER')).toBe(true);
  });

  it('REAL FIFO with a DINT source (conversion) and DINT dest from a REAL FIFO (round half to even)', () => {
    const c = start({
      tags: [bool('Load'), bool('Unload'), dint('Src', 7), real('RSrc', 2.5), dint('Dst'), arr('Fifo', 'REAL', [3]), control('Ctl'), control('Ctl2'), arr('Ints', 'DINT', [3])],
      rungs: [
        'XIC Load FFL Src Fifo[0] Ctl 3 0 ;',
        'XIC Unload FFU Fifo[0] Dst Ctl 3 0 ;',
        'XIC Load FFL RSrc Ints[0] Ctl2 3 0 ;',
      ],
    });
    pulse(c, 'Load');
    c.write('Src', -3);
    c.write('RSrc', 3.5);
    pulse(c, 'Load');
    expect(c.read('Fifo')).toEqual([7, -3, 0]);
    expect(c.read('Ints')).toEqual([2, 4, 0]);
    c.write('Fifo[0]', 1.5);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(2);
  });

  it('INT FIFO keeps the element type range', () => {
    const c = start({
      tags: [bool('Load'), dint('Src', 70000), arr('Fifo', 'INT', [2]), control('Ctl')],
      rungs: ['XIC Load FFL Src Fifo[0] Ctl 2 0 ;'],
    });
    pulse(c, 'Load');
    expect(c.readNumber('Fifo[0]')).toBe(4464); // 70000 wraps into INT
    expect(c.mode).toBe('RUN');
  });

  it('an immediate source loads the literal value', () => {
    const c = start({ tags: [bool('Load'), arr('Fifo', 'DINT', [2]), control('Ctl')], rungs: ['XIC Load FFL 42 Fifo[0] Ctl 2 0 ;'] });
    pulse(c, 'Load');
    expect(c.readNumber('Fifo[0]')).toBe(42);
  });

  it('structure (UDT) FIFO: copies whole structures and clears every member of the last element', () => {
    const dataTypes: UDTDef[] = [
      {
        name: 'Part',
        members: [
          { name: 'Id', dataType: 'DINT' },
          { name: 'Weight', dataType: 'REAL' },
          { name: 'Ok', dataType: 'BOOL' },
          { name: 'Hist', dataType: 'INT', dims: [2] },
        ],
      },
    ];
    const c = start({
      dataTypes,
      tags: [
        bool('Load'),
        bool('Unload'),
        { name: 'In', dataType: 'Part' },
        { name: 'Out', dataType: 'Part' },
        arr('Parts', 'Part', [3]),
        control('Ctl'),
      ],
      rungs: ['XIC Load FFL In Parts[0] Ctl 3 0 ;', 'XIC Unload FFU Parts[0] Out Ctl 3 0 ;'],
    });
    c.write('In', { Id: 1, Weight: 1.5, Ok: 1, Hist: [3, 4] });
    pulse(c, 'Load');
    c.write('In', { Id: 2, Weight: 2.5, Ok: 0, Hist: [5, 6] });
    pulse(c, 'Load');
    c.write('In', { Id: 3, Weight: 3.5, Ok: 1, Hist: [7, 8] });
    pulse(c, 'Load');
    // the load is a copy: changing the source afterwards does not change the FIFO
    c.write('In.Id', 99);
    scans(c);
    expect(c.read('Parts[0]')).toEqual({ Id: 1, Weight: 1.5, Ok: 1, Hist: [3, 4] });
    expect(c.readBool('Ctl.DN')).toBe(true);
    pulse(c, 'Unload');
    expect(c.read('Out')).toEqual({ Id: 1, Weight: 1.5, Ok: 1, Hist: [3, 4] });
    expect(c.read('Parts')).toEqual([
      { Id: 2, Weight: 2.5, Ok: 0, Hist: [5, 6] },
      { Id: 3, Weight: 3.5, Ok: 1, Hist: [7, 8] },
      { Id: 0, Weight: 0, Ok: 0, Hist: [0, 0] },
    ]);
    pulse(c, 'Unload');
    expect(c.readNumber('Out.Id')).toBe(2);
    expect(c.readNumber('Ctl.POS')).toBe(1);
  });

  it('structure FIFO elements stay the same objects (references bound to Parts[1] keep working)', () => {
    const c = start({
      dataTypes: [{ name: 'Part', members: [{ name: 'Id', dataType: 'DINT' }, { name: 'Flag', dataType: 'BOOL' }] }],
      tags: [bool('Load'), bool('Unload'), bool('Lamp'), { name: 'In', dataType: 'Part' }, { name: 'Out', dataType: 'Part' }, arr('Parts', 'Part', [3]), control('Ctl')],
      rungs: ['XIC Load FFL In Parts[0] Ctl 3 0 ;', 'XIC Unload FFU Parts[0] Out Ctl 3 0 ;', 'XIC Parts[1].Flag OTE Lamp ;'],
    });
    for (const flag of [0, 0, 1]) {
      c.write('In.Flag', flag);
      pulse(c, 'Load');
    }
    expect(c.readBool('Lamp')).toBe(false);
    pulse(c, 'Unload');
    // Parts[1] now holds the old Parts[2] (Flag 1); the compiled XIC still sees Parts[1]
    expect(c.readBool('Lamp')).toBe(true);
    expect(c.readNumber('Ctl.POS')).toBe(2);
  });
});

describe('LFL / LFU - LIFO', () => {
  const lifo = (len = 3, size = 4): LadderSetup => ({
    tags: [bool('Load'), bool('Unload'), dint('Src'), dint('Dst'), arr('Stack', 'DINT', [size]), control('Ctl')],
    rungs: [`XIC Load LFL Src Stack[0] Ctl ${len} 0 ;`, `XIC Unload LFU Stack[0] Dst Ctl ${len} 0 ;`],
  });

  it('unloads in last-in first-out order and clears the unloaded element', () => {
    const c = start(lifo());
    for (const v of [1, 2, 3]) {
      c.write('Src', v);
      pulse(c, 'Load');
    }
    expect(c.read('Stack')).toEqual([1, 2, 3, 0]);
    expect(c.readBool('Ctl.DN')).toBe(true);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(3);
    expect(c.read('Stack')).toEqual([1, 2, 0, 0]);
    expect(c.readNumber('Ctl.POS')).toBe(2);
    expect(c.readBool('Ctl.DN')).toBe(false);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(2);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(1);
    expect(c.read('Stack')).toEqual([0, 0, 0, 0]);
    expect(c.readBool('Ctl.EM')).toBe(true);
    c.write('Dst', 55);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(55);
    expect(c.readNumber('Ctl.POS')).toBe(0);
  });

  it('a full LIFO ignores further loads', () => {
    const c = start(lifo(2, 4));
    for (const v of [1, 2, 3]) {
      c.write('Src', v);
      pulse(c, 'Load');
    }
    expect(c.read('Stack')).toEqual([1, 2, 0, 0]);
    expect(c.readNumber('Ctl.POS')).toBe(2);
  });

  it('interleaved loads and unloads behave as a stack; LFL + LFU on the same scan', () => {
    const c = start(lifo(4, 4));
    c.write('Src', 1);
    pulse(c, 'Load');
    c.write('Src', 2);
    pulse(c, 'Load');
    c.write('Src', 3);
    c.write('Load', 1);
    c.write('Unload', 1);
    scans(c);
    // load runs first (rung 0), then the unload takes the value just pushed
    expect(c.readNumber('Dst')).toBe(3);
    expect(c.read('Stack')).toEqual([1, 2, 0, 0]);
    expect(c.readNumber('Ctl.POS')).toBe(2);
  });

  it('prescan sets .EN/.EU (no load/unload on the first scan)', () => {
    const c = run({
      tags: [bool('Load', 1), bool('Unload', 1), dint('Src', 9), dint('Dst'), arr('Stack', 'DINT', [3], [4, 0, 0]), control('Ctl')],
      rungs: ['XIC Load LFL Src Stack[0] Ctl 3 1 ;', 'XIC Unload LFU Stack[0] Dst Ctl 3 1 ;'],
    });
    scans(c, 2);
    expect(c.read('Stack')).toEqual([4, 0, 0]);
    expect(c.readNumber('Dst')).toBe(0);
    expect(c.readNumber('Ctl.POS')).toBe(1);
  });

  it('.LEN or .POS beyond the array faults on unload (Type 4 Code 20)', () => {
    const c = start(lifo(3, 4));
    c.write('Ctl.POS', 5);
    c.write('Ctl.LEN', 4);
    pulse(c, 'Unload');
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.type).toBe(4);
    expect(c.majorFault?.code).toBe(20);
    expect(c.majorFault?.instruction).toBe('LFU');
  });

  it('structure LIFO', () => {
    const c = start({
      dataTypes: [{ name: 'Box', members: [{ name: 'Code', dataType: 'DINT' }, { name: 'Mass', dataType: 'REAL' }] }],
      tags: [bool('Load'), bool('Unload'), { name: 'In', dataType: 'Box' }, { name: 'Out', dataType: 'Box' }, arr('Stack', 'Box', [2]), control('Ctl')],
      rungs: ['XIC Load LFL In Stack[0] Ctl 2 0 ;', 'XIC Unload LFU Stack[0] Out Ctl 2 0 ;'],
    });
    c.write('In', { Code: 1, Mass: 0.5 });
    pulse(c, 'Load');
    c.write('In', { Code: 2, Mass: 1.25 });
    pulse(c, 'Load');
    pulse(c, 'Unload');
    expect(c.read('Out')).toEqual({ Code: 2, Mass: 1.25 });
    expect(c.read('Stack')).toEqual([
      { Code: 1, Mass: 0.5 },
      { Code: 0, Mass: 0 },
    ]);
  });
});

// ============================================================================= verify errors

describe('File/Shift verify errors', () => {
  const base = [bool('Go'), bool('Src'), dint('Val'), dint('Out'), arr('Bits', 'DINT', [2]), arr('Flags', 'BOOL', [64]), arr('Fifo', 'DINT', [4]), control('Ctl'), timer('T1'), int('IntTag')];

  it('rejects a non-CONTROL control operand', () => {
    expect(errorText({ tags: base, rungs: ['XIC Go BSL Bits[0] T1 Src 8 ;'] })).toMatch(/'T1' is TIMER; CONTROL required/);
    expect(errorText({ tags: base, rungs: ['XIC Go FFL Val Fifo[0] Val 4 0 ;'] })).toMatch(/'Val' is DINT; CONTROL required/);
    expect(errorText({ tags: base, rungs: ['XIC Go FFU Fifo[0] Out T1 4 0 ;'] })).toMatch(/CONTROL required/);
  });

  it('rejects a BOOL array (or a non-DINT array) as the BSL/BSR array', () => {
    expect(errorText({ tags: base, rungs: ['XIC Go BSL Flags[0] Ctl Src 8 ;'] })).toMatch(/'Flags\[0\]' is BOOL; DINT required/);
    expect(errorText({ tags: base, rungs: ['XIC Go BSR Flags Ctl Src 8 ;'] })).toMatch(/BOOL; DINT required/);
    expect(errorText({ tags: base, rungs: ['XIC Go BSL IntTag Ctl Src 8 ;'] })).toMatch(/'IntTag' is INT; DINT required/);
    expect(errorText({ tags: base, rungs: ['XIC Go BSL Bits[0].3 Ctl Src 8 ;'] })).toMatch(/BOOL; DINT required/);
  });

  it('requires a BOOL source bit and an immediate Length', () => {
    expect(errorText({ tags: base, rungs: ['XIC Go BSL Bits[0] Ctl Val 8 ;'] })).toMatch(/'Val' is DINT; BOOL required/);
    expect(errorText({ tags: base, rungs: ['XIC Go BSL Bits[0] Ctl Src Val ;'] })).toMatch(/Immediate value required/);
    expect(errorText({ tags: base, rungs: ['XIC Go BSL Bits[0] Ctl Src -1 ;'] })).toMatch(/less than the minimum 0/);
    expect(errorText({ tags: base, rungs: ['XIC Go FFL Val Fifo[0] Ctl 0 0 ;'] })).toMatch(/less than the minimum 1/);
    expect(errorText({ tags: base, rungs: ['XIC Go FFL Val Fifo[0] Ctl 4 -1 ;'] })).toMatch(/less than the minimum 0/);
    expect(errorText({ tags: base, rungs: ['XIC Go FFU Fifo[0] Out Ctl 2.5 0 ;'] })).toMatch(/Integer immediate value required/);
  });

  it('reports missing operands (spaced and paren forms)', () => {
    expect(errorText({ tags: base, rungs: ['XIC Go BSL Bits[0] Ctl Src ;'] })).toMatch(/BSL, Operand 3: Missing operand/);
    expect(errorText({ tags: base, rungs: ['XIC Go BSL(Bits[0],Ctl,Src);'] })).toMatch(/BSL expects 4 operand\(s\), found 3/);
    expect(errorText({ tags: base, rungs: ['XIC Go FFL(Val,Fifo[0],?,4,0);'] })).toMatch(/FFL, Operand 2: Missing operand/);
    expect(errorText({ tags: base, rungs: ['XIC Go FFU Fifo[0] Out Ctl 4 ;'] })).toMatch(/FFU, Operand 4: Missing operand/);
  });

  it('rejects incompatible FIFO source / dest types', () => {
    const dataTypes: UDTDef[] = [
      { name: 'A', members: [{ name: 'X', dataType: 'DINT' }] },
      { name: 'B', members: [{ name: 'X', dataType: 'DINT' }] },
    ];
    const tags = [...base, { name: 'Sa', dataType: 'A' }, { name: 'Sb', dataType: 'B' }, arr('As', 'A', [3])];
    // struct into DINT FIFO
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go FFL Sa Fifo[0] Ctl 4 0 ;'] })).toMatch(/Source 'Sa' is A; SINT, INT, DINT or REAL is required/);
    // different structure type
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go FFL Sb As[0] Ctl 3 0 ;'] })).toMatch(/Source 'Sb' is B; A is required/);
    // number into a structure FIFO
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go LFL 5 As[0] Ctl 3 0 ;'] })).toMatch(/Source '5' is DINT; A is required/);
    // dest of a different type / literal dest / BOOL dest
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go FFU As[0] Out Ctl 3 0 ;'] })).toMatch(/Dest 'Out' is DINT; A is required/);
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go FFU Fifo[0] 5 Ctl 4 0 ;'] })).toMatch(/Immediate value not allowed/);
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go LFU Fifo[0] Go Ctl 4 0 ;'] })).toMatch(/Dest 'Go' is BOOL/);
    // whole array as source
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go FFL Bits Fifo[0] Ctl 4 0 ;'] })).toMatch(/Source 'Bits' is an array of DINT; a single element is required/);
    // BOOL FIFO array
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go FFL Val Flags[0] Ctl 4 0 ;'] })).toMatch(/'Flags\[0\]' is BOOL/);
    // matching structure types verify cleanly
    expect(errorText({ dataTypes, tags, rungs: ['XIC Go FFL Sa As[0] Ctl 3 0 ;', 'XIC Go FFU As[0] Sa Ctl 3 0 ;'] })).toBe('');
  });

  it('rejects a literal as the array operand and read-only (constant) tags', () => {
    expect(errorText({ tags: base, rungs: ['XIC Go BSL 5 Ctl Src 8 ;'] })).toMatch(/Immediate value not allowed/);
    const tags = [...base, { name: 'KBits', dataType: 'DINT', dims: [2], constant: true }, { name: 'KCtl', dataType: 'CONTROL', constant: true }];
    expect(errorText({ tags, rungs: ['XIC Go BSL KBits[0] Ctl Src 8 ;'] })).toMatch(/'KBits\[0\]' is read-only/);
    expect(errorText({ tags, rungs: ['XIC Go BSL Bits[0] KCtl Src 8 ;'] })).toMatch(/'KCtl' is read-only/);
  });
});

describe('File/Shift indirect operands', () => {
  it('BSL with an indirect start element and an indirect CONTROL element', () => {
    const c = run({
      tags: [bool('Go'), bool('Src', 1), dint('Idx', 1), arr('Bits', 'DINT', [3]), arr('Ctls', 'CONTROL', [3])],
      rungs: ['XIC Go BSL Bits[Idx] Ctls[Idx] Src 32 ;'],
    });
    pulse(c, 'Go');
    expect(c.read('Bits')).toEqual([0, 1, 0]);
    expect(c.readBool('Ctls[1].UL')).toBe(false);
    c.write('Idx', 2);
    c.write('Ctls[2].LEN', 32);
    pulse(c, 'Go', 2);
    expect(c.read('Bits')).toEqual([0, 1, 3]);
    c.write('Idx', 3);
    c.write('Go', 1);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.type).toBe(4);
    expect(c.majorFault?.code).toBe(20);
  });

  it('download applies Length to the CONTROL element selected by the subscript at download', () => {
    const c = load({
      tags: [bool('Src'), dint('Idx', 2), arr('Bits', 'DINT', [1]), arr('Ctls', 'CONTROL', [3])],
      rungs: ['BSL Bits[0] Ctls[Idx] Src 12 ;'],
    });
    expect(c.readNumber('Ctls[2].LEN')).toBe(12);
    expect(c.readNumber('Ctls[0].LEN')).toBe(0);
  });

  it('FFL/FFU with an indirect FIFO start element', () => {
    const c = start({
      tags: [bool('Load'), bool('Unload'), dint('Src'), dint('Dst'), dint('Lane', 0), arr('Fifo', 'DINT', [6]), control('Ctl')],
      rungs: ['XIC Load FFL Src Fifo[Lane] Ctl 3 0 ;', 'XIC Unload FFU Fifo[Lane] Dst Ctl 3 0 ;'],
    });
    c.write('Lane', 3);
    c.write('Src', 5);
    pulse(c, 'Load');
    c.write('Src', 6);
    pulse(c, 'Load');
    expect(c.read('Fifo')).toEqual([0, 0, 0, 5, 6, 0]);
    pulse(c, 'Unload');
    expect(c.readNumber('Dst')).toBe(5);
    expect(c.read('Fifo')).toEqual([0, 0, 0, 6, 0, 0]);
    c.write('Lane', 4); // only 2 elements left from Fifo[4]: LEN 3 is too long
    pulse(c, 'Load');
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault?.code).toBe(20);
  });
});

describe('File/Shift scan cost', () => {
  it('a 200-rung program of shift registers and FIFOs scans quickly', () => {
    const tags = [bool('Go'), bool('Src', 1), dint('Val', 3), dint('Out')];
    const rungs: string[] = [];
    for (let i = 0; i < 50; i++) {
      tags.push(arr(`B${i}`, 'DINT', [4]), control(`CB${i}`), control(`CR${i}`), arr(`F${i}`, 'DINT', [16]), control(`CF${i}`));
      rungs.push(`XIC Go BSL B${i}[0] CB${i} Src 128 ;`);
      rungs.push(`XIC Go BSR B${i}[0] CR${i} Src 100 ;`);
      rungs.push(`XIC Go FFL Val F${i}[0] CF${i} 16 0 ;`);
      rungs.push(`XIO Go FFU F${i}[0] Out CF${i} 16 0 ;`);
    }
    const c = run({ tags, rungs });
    // warm up, then measure toggling scans (every scan has an edge)
    for (let i = 0; i < 200; i++) {
      c.write('Go', i & 1);
      scans(c);
    }
    const t0 = performance.now();
    const N = 500;
    for (let i = 0; i < N; i++) {
      c.write('Go', i & 1);
      scans(c);
    }
    const perScanMs = (performance.now() - t0) / N;
    expect(c.mode).toBe('RUN');
    expect(perScanMs).toBeLessThan(1);
  });
});
