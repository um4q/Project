import { describe, it, expect } from 'vitest';
import { run, load, scans, bool, verifyErrors, type LadderSetup } from './helpers';
import { Controller, ladderProject, MODULE_CATALOG, catalogEntry, scaleToEngineering, scaleToSignal, type ModuleDef, type TagDef } from '../index';

const alias = (name: string, target: string): TagDef => ({ name, dataType: '', alias: target });

/** The training rack used throughout: DI slot 1, DO slot 2, AI slot 5, AO slot 6. */
const RACK: ModuleDef[] = [
  { slot: 1, catalog: 'LX-IQ16', name: 'Inputs' },
  { slot: 2, catalog: 'LX-OB16', name: 'Outputs' },
  {
    slot: 5,
    catalog: 'LX-IF4',
    name: 'Analog_In',
    channels: [
      { range: '0-10V', lowEng: 0, highEng: 100, units: '%' },
      { range: '0-5V', lowEng: 30, highEng: 33, units: 'mm' },
      { range: '1-5V', lowEng: 0, highEng: 100, units: '%' },
      { range: '4-20mA', lowEng: 0, highEng: 250, units: 'kPa' },
    ],
  },
  {
    slot: 6,
    catalog: 'LX-OF2',
    name: 'Analog_Out',
    channels: [
      { range: '0-10V', lowEng: 0, highEng: 100, units: '%' },
      { range: '4-20mA', lowEng: 0, highEng: 50, units: 'Hz' },
    ],
  },
];

const rack = (extra: Partial<LadderSetup> = {}): LadderSetup => ({ modules: RACK, rungs: ['NOP ;'], ...extra });

describe('module catalog', () => {
  it('has the four training modules', () => {
    expect(MODULE_CATALOG.map((m) => m.catalog)).toEqual(['LX-IQ16', 'LX-OB16', 'LX-IF4', 'LX-OF2']);
    expect(catalogEntry('lx-iq16')?.kind).toBe('DI');
    expect(catalogEntry('LX-OB16')?.kind).toBe('DO');
    expect(catalogEntry('LX-IF4')?.size).toBe(4);
    expect(catalogEntry('LX-OF2')?.size).toBe(2);
    expect(catalogEntry('LX-NOPE')).toBeUndefined();
  });

  it('creates Local:<slot>:I / :O tags for each module', () => {
    const c = load(rack());
    expect(c.read('Local:1:I')).toMatchObject({ Data: 0, Fault: 0 });
    expect(c.read('Local:2:O')).toMatchObject({ Data: 0 });
    expect(c.read('Local:2:I')).toMatchObject({ Data: 0 });
    // no field signal: 0 V is in range for 0-10 V / 0-5 V but under range for 1-5 V and 4-20 mA
    expect(c.read('Local:5:I')).toMatchObject({
      Ch0Data: 0,
      Ch1Data: 30,
      Ch2Data: 0,
      Ch3Data: 0,
      Ch0Underrange: 0,
      Ch1Underrange: 0,
      Ch2Underrange: 1,
      Ch3Underrange: 1,
      Ch0Overrange: 0,
    });
    expect(c.read('Local:6:O')).toMatchObject({ Ch0Data: 0, Ch1Data: 0 });
    expect(() => c.read('Local:1:O')).toThrow(/Undefined tag/);
    expect(() => c.read('Local:3:I')).toThrow(/Undefined tag/);
  });

  it('referencing a connection the module does not have is a verify error', () => {
    const msgs = verifyErrors(rack({ rungs: ['XIC Local:1:I.Data.0 OTE Local:1:O.Data.0 ;', 'XIC Local:3:I.Data.0 OTE Local:2:O.Data.0 ;'] }))
      .map((e) => e.message)
      .join('\n');
    expect(msgs).toMatch(/Undefined tag 'Local:1:O'/);
    expect(msgs).toMatch(/Undefined tag 'Local:3:I'/);
  });
});

describe('digital inputs (LX-IQ16, slot 1)', () => {
  it('Local:1:I.Data bits follow the field after a scan', () => {
    const c = run(rack());
    for (let n = 0; n < 16; n++) {
      c.io.setInputWord(1, 0);
      c.io.setInput(1, n, true);
      expect(c.io.getInput(1, n)).toBe(true);
      scans(c);
      expect(c.readNumber('Local:1:I.Data')).toBe(1 << n);
      for (let k = 0; k < 16; k++) expect(c.readBool(`Local:1:I.Data.${k}`)).toBe(k === n);
    }
    c.io.setInputWord(1, 0xffff);
    scans(c);
    expect(c.readNumber('Local:1:I.Data')).toBe(0xffff);
    c.io.setInput(1, 7, false);
    scans(c);
    expect(c.readNumber('Local:1:I.Data')).toBe(0xff7f);
  });

  it('only 16 points are transferred', () => {
    const c = run(rack());
    c.io.setInputWord(1, 0x7fffffff);
    scans(c);
    expect(c.readNumber('Local:1:I.Data')).toBe(0xffff);
  });

  it('logic examines field inputs through the input image', () => {
    const c = run(rack({ tags: [bool('Seen')], rungs: ['XIC Local:1:I.Data.9 OTE Seen ;'] }));
    c.io.setInput(1, 9, true);
    scans(c);
    expect(c.readBool('Seen')).toBe(true);
  });

  it('the input image keeps updating in Program mode', () => {
    const c = load(rack());
    c.io.setInput(1, 2, true);
    c.advance(10);
    expect(c.readBool('Local:1:I.Data.2')).toBe(true);
  });

  it('field state is kept across a re-download with the same module in the slot', () => {
    const c = load(rack());
    c.io.setInput(1, 4, true);
    expect(c.download(ladderProject(rack())).ok).toBe(true);
    expect(c.io.getInput(1, 4)).toBe(true);
    expect(c.readBool('Local:1:I.Data.4')).toBe(true);
  });
});

describe('aliases to I/O', () => {
  const setup = () =>
    rack({
      tags: [alias('Start', 'Local:1:I.Data.6'), alias('Motor', 'Local:2:O.Data.0'), alias('InWord', 'Local:1:I.Data'), bool('Seen')],
      programTags: [alias('StopPB', 'Local:1:I.Data.7')],
      rungs: ['XIC Start XIO StopPB OTE Motor ;', 'XIC InWord.6 OTE Seen ;'],
    });

  it('aliases read and write the I/O points', () => {
    const c = run(setup());
    scans(c);
    expect(c.io.getOutput(2, 0)).toBe(false);
    c.io.setInput(1, 6, true);
    scans(c);
    expect(c.readBool('Start')).toBe(true);
    expect(c.readBool('Seen')).toBe(true);
    expect(c.readBool('Motor')).toBe(true);
    expect(c.readBool('Local:2:O.Data.0')).toBe(true);
    expect(c.io.getOutput(2, 0)).toBe(true);
    c.io.setInput(1, 7, true);
    scans(c);
    expect(c.readBool('StopPB', 'MainProgram')).toBe(true);
    expect(c.io.getOutput(2, 0)).toBe(false);
  });

  it('writing an alias writes its target', () => {
    const c = run(rack({ tags: [alias('Lamp', 'Local:2:O.Data.9')] }));
    c.write('Lamp', 1);
    scans(c);
    expect(c.readBool('Local:2:O.Data.9')).toBe(true);
    expect(c.io.getOutput(2, 9)).toBe(true);
  });

  it('an alias to a missing I/O point is a verify error', () => {
    const msgs = verifyErrors(rack({ tags: [alias('Ghost', 'Local:4:I.Data.0')] }))
      .map((e) => e.message)
      .join('\n');
    expect(msgs).toMatch(/Ghost/);
    expect(msgs).toMatch(/Undefined tag 'Local:4:I'/);
  });
});

describe('digital outputs (LX-OB16, slot 2)', () => {
  it('Local:2:O.Data bits drive the field only in Run', () => {
    const c = load(rack());
    c.write('Local:2:O.Data', 0xa5);
    c.advance(10);
    expect(c.io.getOutputWord(2)).toBe(0);
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(c.io.getOutputWord(2)).toBe(0xa5);
    for (let n = 0; n < 16; n++) expect(c.io.getOutput(2, n)).toBe(((0xa5 >> n) & 1) === 1);
    expect(c.setMode('PROGRAM')).toBeNull();
    expect(c.io.getOutputWord(2)).toBe(0);
    // tag value kept
    expect(c.readNumber('Local:2:O.Data')).toBe(0xa5);
  });

  it('only 16 points reach the field', () => {
    const c = run(rack());
    c.write('Local:2:O.Data', 0x1ffff);
    scans(c);
    expect(c.io.getOutputWord(2)).toBe(0xffff);
  });

  it('OTE on output points', () => {
    const c = run(rack({ tags: [bool('A')], rungs: ['XIC A OTE Local:2:O.Data.15 ;', 'XIO A OTE Local:2:O.Data.14 ;'] }));
    scans(c);
    expect(c.io.getOutput(2, 15)).toBe(false);
    expect(c.io.getOutput(2, 14)).toBe(true);
    c.write('A', 1);
    scans(c);
    expect(c.io.getOutput(2, 15)).toBe(true);
    expect(c.io.getOutput(2, 14)).toBe(false);
  });
});

describe('analog inputs (LX-IF4, slot 5)', () => {
  const ai = (c: Controller, ch: number) => c.readNumber(`Local:5:I.Ch${ch}Data`);
  const under = (c: Controller, ch: number) => c.readBool(`Local:5:I.Ch${ch}Underrange`);
  const over = (c: Controller, ch: number) => c.readBool(`Local:5:I.Ch${ch}Overrange`);

  function reading(ch: number, signal: number): { value: number; under: boolean; over: boolean } {
    const c = run(rack());
    c.io.setAnalogInput(5, ch, signal);
    scans(c);
    return { value: ai(c, ch), under: under(c, ch), over: over(c, ch) };
  }

  it.each([
    [0, 0, 0],
    [0, 5, 50],
    [0, 10, 100],
    [0, 2.5, 25],
  ])('0-10 V -> 0..100 %%: %s %s V -> %s', (ch, sig, eng) => {
    const r = reading(ch, sig);
    expect(r.value).toBeCloseTo(eng, 4);
    expect(r.under).toBe(false);
    expect(r.over).toBe(false);
  });

  it.each([
    [0, 30],
    [1, 30.6],
    [2.5, 31.5],
    [4, 32.4],
    [5, 33],
  ])('0-5 V gauging head -> 30.0..33.0 mm: %s V -> %s mm', (sig, mm) => {
    const r = reading(1, sig);
    expect(r.value).toBeCloseTo(mm, 4);
    expect(r.under || r.over).toBe(false);
  });

  it.each([
    [1, 0],
    [2, 25],
    [3, 50],
    [5, 100],
  ])('1-5 V -> 0..100 %%: %s V -> %s', (sig, eng) => {
    const r = reading(2, sig);
    expect(r.value).toBeCloseTo(eng, 4);
    expect(r.under || r.over).toBe(false);
  });

  it.each([
    [4, 0],
    [8, 62.5],
    [12, 125],
    [20, 250],
  ])('4-20 mA -> 0..250 kPa: %s mA -> %s', (sig, eng) => {
    const r = reading(3, sig);
    expect(r.value).toBeCloseTo(eng, 4);
    expect(r.under || r.over).toBe(false);
  });

  it('values are REAL (single precision)', () => {
    const r = reading(1, 1);
    expect(r.value).toBe(Math.fround(30.6));
  });

  it('under range: flag set and value clamped to the low engineering value', () => {
    expect(reading(0, -1)).toEqual({ value: 0, under: true, over: false });
    expect(reading(1, -0.5)).toEqual({ value: 30, under: true, over: false });
    expect(reading(2, 0.5)).toEqual({ value: 0, under: true, over: false });
    expect(reading(2, 0)).toEqual({ value: 0, under: true, over: false });
    // 0 mA on a 4-20 mA loop = open wire
    expect(reading(3, 0)).toEqual({ value: 0, under: true, over: false });
    expect(reading(3, 3.5)).toEqual({ value: 0, under: true, over: false });
  });

  it('over range: flag set and value clamped to the high engineering value', () => {
    expect(reading(0, 10.5)).toEqual({ value: 100, under: false, over: true });
    expect(reading(1, 5.5)).toEqual({ value: 33, under: false, over: true });
    expect(reading(2, 6)).toEqual({ value: 100, under: false, over: true });
    expect(reading(3, 21)).toEqual({ value: 250, under: false, over: true });
  });

  it('flags clear when the signal returns into range and logic can use them', () => {
    const c = run(rack({ tags: [bool('WireBreak')], rungs: ['XIC Local:5:I.Ch3Underrange OTE WireBreak ;'] }));
    c.io.setAnalogInput(5, 3, 12);
    scans(c);
    expect(c.readBool('WireBreak')).toBe(false);
    c.io.setAnalogInput(5, 3, 0);
    scans(c);
    // the flag is read at the start of the scan, so logic sees it in the same scan
    expect(c.readBool('WireBreak')).toBe(true);
    c.io.setAnalogInput(5, 3, 4);
    scans(c);
    expect(c.readBool('WireBreak')).toBe(false);
    expect(under(c, 3)).toBe(false);
  });

  it('setAnalogInputEng converts an engineering value to the signal', () => {
    const c = run(rack());
    c.io.setAnalogInputEng(5, 1, 31.5);
    c.io.setAnalogInputEng(5, 3, 125);
    scans(c);
    expect(c.io.slot(5)!.analogIn[1]).toBeCloseTo(2.5, 6);
    expect(c.io.slot(5)!.analogIn[3]).toBeCloseTo(12, 6);
    expect(ai(c, 1)).toBeCloseTo(31.5, 4);
    expect(ai(c, 3)).toBeCloseTo(125, 3);
  });

  it('channel configuration and defaults', () => {
    const c = load({
      modules: [
        { slot: 5, catalog: 'LX-IF4', channels: [{ range: '0-5V', lowEng: 30, highEng: 33, units: 'mm' }] },
        { slot: 7, catalog: 'LX-IF4' },
      ],
      rungs: ['NOP ;'],
    });
    expect(c.io.channelConfig(5, 0)).toMatchObject({ range: '0-5V', lowEng: 30, highEng: 33, units: 'mm' });
    // unconfigured channels default to 0-10 V = 0..10
    expect(c.io.channelConfig(5, 1)).toMatchObject({ range: '0-10V', lowEng: 0, highEng: 10 });
    expect(c.io.channelConfig(7, 3)).toMatchObject({ range: '0-10V', lowEng: 0, highEng: 10 });
    expect(c.setMode('RUN')).toBeNull();
    c.io.setAnalogInput(7, 2, 7.5);
    scans(c);
    expect(c.readNumber('Local:7:I.Ch2Data')).toBeCloseTo(7.5, 5);
  });

  it('bipolar range and reverse-acting scaling', () => {
    expect(scaleToEngineering({ range: '-10-10V', lowEng: -100, highEng: 100 }, -10).value).toBeCloseTo(-100, 6);
    expect(scaleToEngineering({ range: '-10-10V', lowEng: -100, highEng: 100 }, 0).value).toBeCloseTo(0, 6);
    expect(scaleToEngineering({ range: '-10-10V', lowEng: -100, highEng: 100 }, 5).value).toBeCloseTo(50, 6);
    // reverse acting: 4 mA = 100, 20 mA = 0
    expect(scaleToEngineering({ range: '4-20mA', lowEng: 100, highEng: 0 }, 8).value).toBeCloseTo(75, 6);
    expect(scaleToSignal({ range: '4-20mA', lowEng: 100, highEng: 0 }, 75).value).toBeCloseTo(8, 6);
  });

  it('analog input values update in Program mode too', () => {
    const c = load(rack());
    c.io.setAnalogInput(5, 0, 4);
    c.advance(10);
    expect(ai(c, 0)).toBeCloseTo(40, 4);
  });
});

describe('analog outputs (LX-OF2, slot 6)', () => {
  it('scales engineering values to the output signal in Run', () => {
    const c = run(rack());
    c.write('Local:6:O.Ch0Data', 25);
    c.write('Local:6:O.Ch1Data', 25);
    scans(c);
    expect(c.io.getAnalogOutput(6, 0)).toBeCloseTo(2.5, 5);
    expect(c.io.getAnalogOutput(6, 1)).toBeCloseTo(12, 5);
    c.write('Local:6:O.Ch0Data', 100);
    c.write('Local:6:O.Ch1Data', 0);
    scans(c);
    expect(c.io.getAnalogOutput(6, 0)).toBeCloseTo(10, 5);
    expect(c.io.getAnalogOutput(6, 1)).toBeCloseTo(4, 5);
    expect(c.readBool('Local:6:I.Ch0Overrange')).toBe(false);
    expect(c.readBool('Local:6:I.Ch1Underrange')).toBe(false);
  });

  it('clamps out-of-range values and reports them', () => {
    const c = run(rack());
    c.write('Local:6:O.Ch0Data', 150);
    c.write('Local:6:O.Ch1Data', -10);
    scans(c);
    expect(c.io.getAnalogOutput(6, 0)).toBe(10);
    expect(c.io.getAnalogOutput(6, 1)).toBe(4);
    expect(c.readBool('Local:6:I.Ch0Overrange')).toBe(true);
    expect(c.readBool('Local:6:I.Ch0Underrange')).toBe(false);
    expect(c.readBool('Local:6:I.Ch1Underrange')).toBe(true);
    c.write('Local:6:O.Ch0Data', 50);
    c.write('Local:6:O.Ch1Data', 50);
    scans(c);
    expect(c.readBool('Local:6:I.Ch0Overrange')).toBe(false);
    expect(c.readBool('Local:6:I.Ch1Underrange')).toBe(false);
    expect(c.io.getAnalogOutput(6, 1)).toBeCloseTo(20, 5);
  });

  it('outputs go to the low end of the signal range outside Run', () => {
    const c = run(rack());
    c.write('Local:6:O.Ch0Data', 80);
    c.write('Local:6:O.Ch1Data', 40);
    scans(c);
    expect(c.io.getAnalogOutput(6, 0)).toBeCloseTo(8, 5);
    expect(c.setMode('PROGRAM')).toBeNull();
    expect(c.io.getAnalogOutput(6, 0)).toBe(0);
    expect(c.io.getAnalogOutput(6, 1)).toBe(4);
    c.advance(20);
    expect(c.io.getAnalogOutput(6, 0)).toBe(0);
    expect(c.readNumber('Local:6:O.Ch0Data')).toBe(80);
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(c.io.getAnalogOutput(6, 1)).toBeCloseTo(4 + (40 / 50) * 16, 5);
  });
});

describe('module configuration errors', () => {
  const errs = (modules: ModuleDef[]) => verifyErrors({ modules, rungs: ['NOP ;'] });

  it('duplicate slot', () => {
    const e = errs([
      { slot: 1, catalog: 'LX-IQ16' },
      { slot: 1, catalog: 'LX-OB16' },
    ]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ slot: 1, severity: 'error' });
    expect(e[0].message).toMatch(/Slot 1 is used by more than one module/);
  });

  it('unknown catalog number', () => {
    const e = errs([{ slot: 3, catalog: 'LX-NOPE' }]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ slot: 3 });
    expect(e[0].message).toMatch(/Unknown module catalog number 'LX-NOPE'/);
  });

  it('slot 0 is the controller; slots must be 1..30 integers', () => {
    expect(errs([{ slot: 0, catalog: 'LX-IQ16' }])[0].message).toMatch(/Slot 0 is invalid/);
    expect(errs([{ slot: 31, catalog: 'LX-IQ16' }])[0].message).toMatch(/Slot 31 is invalid/);
    expect(errs([{ slot: -1, catalog: 'LX-IQ16' }])[0].message).toMatch(/invalid/);
    expect(errs([{ slot: 2.5, catalog: 'LX-IQ16' }])[0].message).toMatch(/invalid/);
    expect(errs([{ slot: 30, catalog: 'LX-IQ16' }])).toEqual([]);
  });

  it('analog channel configuration errors', () => {
    const tooMany = errs([{ slot: 6, catalog: 'LX-OF2', channels: [0, 1, 2].map(() => ({ range: '0-10V' as const, lowEng: 0, highEng: 10 })) }]);
    expect(tooMany.map((e) => e.message).join('\n')).toMatch(/only 2 channels/);
    const badRange = errs([{ slot: 5, catalog: 'LX-IF4', channels: [{ range: '0-24V' as never, lowEng: 0, highEng: 10 }] }]);
    expect(badRange.map((e) => e.message).join('\n')).toMatch(/unknown range '0-24V'/);
    const flat = errs([{ slot: 5, catalog: 'LX-IF4', channels: [{ range: '0-10V', lowEng: 5, highEng: 5 }] }]);
    expect(flat.map((e) => e.message).join('\n')).toMatch(/must be different/);
  });

  it('a project with module errors cannot be downloaded', () => {
    const c = new Controller();
    const r = c.download(ladderProject({ modules: [{ slot: 0, catalog: 'LX-IQ16' }], rungs: ['NOP ;'] }));
    expect(r.ok).toBe(false);
    expect(c.project).toBeNull();
  });
});

describe('I/O forces', () => {
  const setup = () =>
    rack({
      tags: [alias('Start', 'Local:1:I.Data.6'), alias('Motor', 'Local:2:O.Data.0'), alias('PlainAlias', 'Plain'), bool('Plain'), bool('Seen3'), bool('Drive')],
      rungs: ['XIC Local:1:I.Data.3 OTE Seen3 ;', 'XIC Start OTE Motor ;', 'XIC Drive OTE Local:2:O.Data.4 ;'],
    });

  it('an input force has no effect until forces are enabled, then logic sees the forced value regardless of the field', () => {
    const c = run(setup());
    expect(c.io.addForce('Local:1:I.Data.3', 1)).toBeNull();
    expect(c.io.hasForces).toBe(true);
    expect(c.io.forcesActive).toBe(false);
    scans(c);
    expect(c.readBool('Seen3')).toBe(false);
    expect(c.readBool('Local:1:I.Data.3')).toBe(false);

    c.io.forcesEnabled = true;
    scans(c);
    expect(c.readBool('Local:1:I.Data.3')).toBe(true);
    expect(c.readBool('Seen3')).toBe(true);
    // the field itself is not changed by a force
    expect(c.io.getInput(1, 3)).toBe(false);

    // force OFF while the field is ON
    c.io.setInput(1, 3, true);
    expect(c.io.addForce('Local:1:I.Data.3', 0)).toBeNull();
    expect(c.io.listForces()).toEqual([{ path: 'Local:1:I.Data.3', value: 0 }]);
    scans(c);
    expect(c.readBool('Seen3')).toBe(false);

    // disabling forces returns control to the field
    c.io.forcesEnabled = false;
    scans(c);
    expect(c.readBool('Seen3')).toBe(true);
  });

  it('a force on an input only affects the forced bit', () => {
    const c = run(setup());
    c.io.forcesEnabled = true;
    c.io.addForce('Local:1:I.Data.3', 1);
    c.io.setInput(1, 0, true);
    c.io.setInput(1, 15, true);
    scans(c);
    expect(c.readNumber('Local:1:I.Data')).toBe(0x8009);
  });

  it('forcing via an alias name forces the I/O point (canonical path)', () => {
    const c = run(setup());
    c.io.forcesEnabled = true;
    expect(c.io.addForce('Start', 1)).toBeNull();
    expect(c.io.listForces()).toEqual([{ path: 'Local:1:I.Data.6', value: 1 }]);
    scans(c);
    expect(c.readBool('Start')).toBe(true);
    expect(c.io.getOutput(2, 0)).toBe(true);
    // names are case-insensitive and resolve to the same point (replaces, not duplicates)
    expect(c.io.addForce('local:1:i.data.6', 0)).toBeNull();
    expect(c.io.listForces()).toEqual([{ path: 'Local:1:I.Data.6', value: 0 }]);
  });

  it('output forces override logic and appear on the field', () => {
    const c = run(setup());
    c.io.forcesEnabled = true;
    expect(c.io.addForce('Local:2:O.Data.4', 1)).toBeNull();
    scans(c);
    expect(c.readBool('Drive')).toBe(false);
    expect(c.io.getOutput(2, 4)).toBe(true);
    expect(c.readBool('Local:2:O.Data.4')).toBe(true);
    // force OFF while logic drives it ON
    c.write('Drive', 1);
    c.io.addForce('Local:2:O.Data.4', 0);
    scans(c, 2);
    expect(c.io.getOutput(2, 4)).toBe(false);
    // other outputs still follow logic
    c.io.setInput(1, 6, true);
    scans(c);
    expect(c.io.getOutput(2, 0)).toBe(true);
    expect(c.io.getOutput(2, 4)).toBe(false);
  });

  it('forcing an output through its alias', () => {
    const c = run(setup());
    c.io.forcesEnabled = true;
    expect(c.io.addForce('Motor', 1)).toBeNull();
    scans(c);
    expect(c.io.getOutput(2, 0)).toBe(true);
  });

  it('forced output bits still drive the field in Program mode', () => {
    const c = run(setup());
    c.io.forcesEnabled = true;
    c.io.addForce('Local:2:O.Data.4', 1);
    scans(c);
    expect(c.setMode('PROGRAM')).toBeNull();
    c.advance(10);
    expect(c.io.getOutput(2, 4)).toBe(true);
    // unforced outputs are off
    expect(c.io.getOutput(2, 0)).toBe(false);
  });

  it('a forced output word drives the field in Program mode like forced output bits do', () => {
    const c = load(setup());
    c.io.forcesEnabled = true;
    expect(c.io.addForce('Local:2:O.Data', 0x0f)).toBeNull();
    c.advance(10);
    expect(c.io.getOutputWord(2)).toBe(0x0f);
  });

  it('a forced analog output drives the field in Program mode like forced digital outputs do', () => {
    const c = load(setup());
    c.io.forcesEnabled = true;
    expect(c.io.addForce('Local:6:O.Ch0Data', 50)).toBeNull();
    c.advance(10);
    expect(c.io.getAnalogOutput(6, 0)).toBeCloseTo(5, 5);
  });

  it('whole-word and analog forces in Run', () => {
    const c = run(setup());
    c.io.forcesEnabled = true;
    expect(c.io.addForce('Local:1:I.Data', 0x0f0f)).toBeNull();
    expect(c.io.addForce('Local:5:I.Ch0Data', 42.5)).toBeNull();
    expect(c.io.addForce('Local:6:O.Ch0Data', 50)).toBeNull();
    c.write('Local:6:O.Ch0Data', 10);
    scans(c);
    expect(c.readNumber('Local:1:I.Data')).toBe(0x0f0f);
    expect(c.readBool('Seen3')).toBe(true);
    expect(c.readNumber('Local:5:I.Ch0Data')).toBe(42.5);
    expect(c.io.getAnalogOutput(6, 0)).toBeCloseTo(5, 5);
  });

  it('forcing a non-I/O tag is rejected', () => {
    const c = run(setup());
    expect(c.io.addForce('Plain', 1)).toMatch(/only module I\/O can be forced/);
    expect(c.io.addForce('PlainAlias', 1)).toMatch(/only module I\/O can be forced/);
    expect(c.io.addForce('Nope', 1)).toMatch(/Undefined tag 'Nope'/);
    expect(c.io.addForce('Local:1:I', 1)).toMatch(/not an I\/O point/);
    expect(c.io.addForce('Local:1:I.Data.[', 1)).not.toBeNull();
    expect(c.io.listForces()).toEqual([]);
    expect(c.io.hasForces).toBe(false);
  });

  it('forcing before a project is downloaded is rejected', () => {
    expect(new Controller().io.addForce('Local:1:I.Data.0', 1)).toMatch(/no project/i);
  });

  it('removeForce (by path or alias) and clearForces', () => {
    const c = run(setup());
    c.io.forcesEnabled = true;
    c.io.addForce('Local:1:I.Data.3', 1);
    c.io.addForce('Start', 1);
    c.io.addForce('Local:2:O.Data.4', 1);
    expect(c.io.listForces()).toHaveLength(3);
    scans(c);
    expect(c.readBool('Seen3')).toBe(true);

    c.io.removeForce('Local:1:I.Data.3');
    expect(c.io.listForces().map((f) => f.path)).toEqual(['Local:1:I.Data.6', 'Local:2:O.Data.4']);
    scans(c);
    expect(c.readBool('Seen3')).toBe(false);

    c.io.removeForce('Start');
    expect(c.io.listForces().map((f) => f.path)).toEqual(['Local:2:O.Data.4']);
    scans(c);
    expect(c.io.getOutput(2, 0)).toBe(false);

    // removing something that is not forced is harmless
    c.io.removeForce('Local:1:I.Data.9');
    expect(c.io.listForces()).toHaveLength(1);

    c.io.clearForces();
    expect(c.io.listForces()).toEqual([]);
    expect(c.io.hasForces).toBe(false);
    expect(c.io.forcesActive).toBe(false);
    scans(c);
    expect(c.io.getOutput(2, 4)).toBe(false);
  });

  it('forcesActive indicator: forces installed AND enabled', () => {
    const c = run(setup());
    expect(c.io.forcesActive).toBe(false);
    expect(c.forcesActive).toBe(false);
    c.io.forcesEnabled = true;
    expect(c.io.forcesActive).toBe(false);
    c.io.addForce('Local:1:I.Data.1', 1);
    expect(c.io.forcesActive).toBe(true);
    expect(c.forcesActive).toBe(true);
    c.io.forcesEnabled = false;
    expect(c.io.forcesActive).toBe(false);
    expect(c.forcesActive).toBe(false);
    c.io.forcesEnabled = true;
    c.io.removeForce('Local:1:I.Data.1');
    expect(c.forcesActive).toBe(false);
  });

  it('forces apply in Program mode to the input image', () => {
    const c = load(setup());
    c.io.forcesEnabled = true;
    c.io.addForce('Local:1:I.Data.3', 1);
    c.advance(10);
    expect(c.readBool('Local:1:I.Data.3')).toBe(true);
  });
});
