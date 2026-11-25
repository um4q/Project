import { describe, it, expect } from 'vitest';
import { run, load, scans, bool, dint, arr, timer } from './helpers';
import { Controller, newProject, ladderProject, type ProjectDef, type ProgramDef, type TaskDef, type TagDef, type RoutineDef, type ModuleDef } from '../index';

const rll = (name: string, ...rungs: string[]): RoutineDef => ({ name, type: 'RLL', rungs: rungs.map((text) => ({ text })) });

const prog = (name: string, rungs: string[], opts: { tags?: TagDef[]; routines?: RoutineDef[] } = {}): ProgramDef => ({
  name,
  mainRoutine: 'MainRoutine',
  tags: opts.tags ?? [],
  routines: [rll('MainRoutine', ...rungs), ...(opts.routines ?? [])],
});

function project(opts: { tags?: TagDef[]; tasks: TaskDef[]; programs: ProgramDef[]; modules?: ModuleDef[]; scanPeriodMs?: number }): ProjectDef {
  const p = newProject('Test');
  p.tags = opts.tags ?? [];
  p.modules = opts.modules ?? [];
  p.tasks = opts.tasks;
  p.programs = opts.programs;
  if (opts.scanPeriodMs) p.controller.scanPeriodMs = opts.scanPeriodMs;
  return p;
}

const mainTask = (programs: string[], extra: Partial<TaskDef> = {}): TaskDef => ({ name: 'MainTask', type: 'CONTINUOUS', programs, ...extra });
const periodic = (name: string, periodMs: number, programs: string[], priority?: number, extra: Partial<TaskDef> = {}): TaskDef => ({
  name,
  type: 'PERIODIC',
  periodMs,
  priority,
  programs,
  ...extra,
});

function start(def: ProjectDef): Controller {
  const c = new Controller();
  const r = c.download(def);
  if (!r.ok) throw new Error('Download failed:\n' + r.errors.map((e) => e.message).join('\n'));
  expect(c.setMode('RUN')).toBeNull();
  return c;
}

const IO = [
  { slot: 1, catalog: 'LX-IQ16' },
  { slot: 2, catalog: 'LX-OB16' },
];

describe('scan cycle: input image, logic, output image', () => {
  it('the input image is read at the start of each scan (field changes are not seen until then)', () => {
    const c = run({ modules: IO, tags: [bool('Seen')], rungs: ['XIC Local:1:I.Data.3 OTE Seen ;'] });
    c.io.setInput(1, 3, true);
    expect(c.io.getInput(1, 3)).toBe(true);
    expect(c.readBool('Local:1:I.Data.3')).toBe(false);
    scans(c);
    expect(c.readBool('Local:1:I.Data.3')).toBe(true);
    expect(c.readBool('Seen')).toBe(true);
    c.io.setInput(1, 3, false);
    expect(c.readBool('Local:1:I.Data.3')).toBe(true);
    scans(c);
    expect(c.readBool('Seen')).toBe(false);
  });

  it('an input tag written by logic is overwritten by the next input scan', () => {
    const c = run({
      modules: IO,
      tags: [bool('Poke'), bool('SeenBefore'), bool('SeenAfter')],
      rungs: ['XIC Local:1:I.Data.3 OTE SeenBefore ;', 'XIC Poke OTL Local:1:I.Data.3 ;', 'XIC Local:1:I.Data.3 OTE SeenAfter ;'],
    });
    c.write('Poke', 1);
    scans(c);
    expect(c.readBool('SeenBefore')).toBe(false);
    expect(c.readBool('SeenAfter')).toBe(true);
    expect(c.readBool('Local:1:I.Data.3')).toBe(true);
    c.write('Poke', 0);
    scans(c);
    // the field point is off: the image was refreshed at the start of the scan
    expect(c.readBool('SeenBefore')).toBe(false);
    expect(c.readBool('SeenAfter')).toBe(false);
    expect(c.readBool('Local:1:I.Data.3')).toBe(false);
  });

  it('outputs are written to the field at the end of the scan', () => {
    const c = run({ modules: IO, tags: [bool('A'), bool('Off')], rungs: ['XIC A OTE Local:2:O.Data.1 ;', 'OTE Local:2:O.Data.2 ;', 'XIC Off OTE Local:2:O.Data.2 ;'] });
    c.write('A', 1);
    expect(c.io.getOutput(2, 1)).toBe(false);
    scans(c);
    expect(c.io.getOutput(2, 1)).toBe(true);
    // the field gets the final state of the image (last rung wins)
    expect(c.io.getOutput(2, 2)).toBe(false);
    // a tag write between scans reaches the field only at the end of the next scan
    c.write('A', 0);
    c.write('Local:2:O.Data.5', 1);
    expect(c.io.getOutput(2, 1)).toBe(true);
    expect(c.io.getOutput(2, 5)).toBe(false);
    scans(c);
    expect(c.io.getOutput(2, 1)).toBe(false);
    expect(c.io.getOutput(2, 5)).toBe(true);
    expect(c.io.getOutputWord(2)).toBe(1 << 5);
  });

  it('the output module readback arrives with the next input scan', () => {
    const c = run({ modules: IO, rungs: ['OTE Local:2:O.Data.1 ;'] });
    scans(c);
    expect(c.io.getOutput(2, 1)).toBe(true);
    expect(c.readBool('Local:2:I.Data.1')).toBe(false);
    scans(c);
    expect(c.readBool('Local:2:I.Data.1')).toBe(true);
  });

  it('rungs execute in order: a later rung sees an earlier rung result in the same scan', () => {
    const c = run({ tags: [bool('A', 1), bool('B'), bool('C')], rungs: ['XIC A OTE B ;', 'XIC B OTE C ;'] });
    scans(c);
    expect(c.readBool('C')).toBe(true);
    const d = run({ tags: [bool('A', 1), bool('B'), bool('C')], rungs: ['XIC B OTE C ;', 'XIC A OTE B ;'] });
    scans(d);
    expect(d.readBool('B')).toBe(true);
    expect(d.readBool('C')).toBe(false);
    scans(d);
    expect(d.readBool('C')).toBe(true);
  });

  it('programs in a task execute in the listed order', () => {
    const tags = [bool('Go', 1), bool('Mid'), bool('Back'), bool('P1SawBack'), bool('P2SawMid')];
    const programs = [prog('P1', ['XIC Go OTE Mid ;', 'XIC Back OTE P1SawBack ;']), prog('P2', ['XIC Mid OTE P2SawMid ;', 'XIC Mid OTE Back ;'])];
    const c = start(project({ tags, tasks: [mainTask(['P1', 'P2'])], programs }));
    scans(c);
    expect(c.readBool('P2SawMid')).toBe(true);
    expect(c.readBool('P1SawBack')).toBe(false);
    scans(c);
    expect(c.readBool('P1SawBack')).toBe(true);

    const d = start(project({ tags, tasks: [mainTask(['P2', 'P1'])], programs }));
    scans(d);
    expect(d.readBool('Mid')).toBe(true);
    expect(d.readBool('P2SawMid')).toBe(false);
    scans(d);
    expect(d.readBool('P2SawMid')).toBe(true);
  });

  it('an inhibited program is not scanned', () => {
    const p2 = prog('P2', ['OTL P2Ran ;']);
    p2.inhibited = true;
    const c = start(project({ tags: [bool('P1Ran'), bool('P2Ran')], tasks: [mainTask(['P1', 'P2'])], programs: [prog('P1', ['OTL P1Ran ;']), p2] }));
    scans(c, 3);
    expect(c.readBool('P1Ran')).toBe(true);
    expect(c.readBool('P2Ran')).toBe(false);
  });
});

describe('first scan flag S:FS', () => {
  const setup = () => ({
    tags: [bool('FsNow'), bool('FsSeen'), bool('FsInSub')],
    rungs: ['XIC S:FS OTE FsNow ;', 'XIC S:FS OTL FsSeen ;', 'JSR(Sub,0);'],
    routines: [rll('Sub', 'XIC S:FS OTE FsInSub ;')],
  });

  it('is true only on the first scan after Program -> Run', () => {
    const c = run(setup());
    scans(c);
    expect(c.readBool('FsNow')).toBe(true);
    expect(c.readBool('FsInSub')).toBe(true);
    // outside a scan the flag reads 0
    expect(c.readNumber('S:FS')).toBe(0);
    scans(c);
    expect(c.readBool('FsNow')).toBe(false);
    expect(c.readBool('FsInSub')).toBe(false);
    expect(c.readBool('FsSeen')).toBe(true);
    scans(c, 10);
    expect(c.readBool('FsNow')).toBe(false);
  });

  it('is true again on the first scan after Program -> Run again', () => {
    const c = run(setup());
    scans(c, 3);
    c.write('FsSeen', 0);
    expect(c.setMode('PROGRAM')).toBeNull();
    scans(c, 3);
    expect(c.readBool('FsSeen')).toBe(false);
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(c.readBool('FsNow')).toBe(true);
    expect(c.readBool('FsSeen')).toBe(true);
    scans(c);
    expect(c.readBool('FsNow')).toBe(false);
  });

  it('is set on the first scan of every program (each program, each task)', () => {
    const c = start(
      project({
        tags: [bool('Fs1'), bool('Fs2'), bool('FsP')],
        tasks: [mainTask(['P1', 'P2']), periodic('Per', 30, ['P3'])],
        programs: [prog('P1', ['XIC S:FS OTE Fs1 ;']), prog('P2', ['XIC S:FS OTE Fs2 ;']), prog('P3', ['XIC S:FS OTE FsP ;'])],
      }),
    );
    scans(c);
    expect(c.readBool('Fs1')).toBe(true);
    expect(c.readBool('Fs2')).toBe(true);
    expect(c.readBool('FsP')).toBe(true);
    c.advance(100);
    expect(c.readBool('Fs1')).toBe(false);
    expect(c.readBool('Fs2')).toBe(false);
    expect(c.readBool('FsP')).toBe(false);
  });

  it('is set again on the first scan after a fault is cleared and the controller returns to Run', () => {
    const c = run({
      tags: [bool('FsNow'), arr('Bits', 'BOOL', [32]), dint('Idx'), bool('X')],
      rungs: ['XIC S:FS OTE FsNow ;', 'XIC Bits[Idx] OTE X ;'],
    });
    scans(c, 2);
    c.write('Idx', 40);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    c.clearFault();
    c.write('Idx', 0);
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(c.readBool('FsNow')).toBe(true);
  });
});

describe('prescan', () => {
  it('clears OTE outputs in every program and task without executing any logic', () => {
    const c = new Controller();
    const def = project({
      tags: [bool('A', 1), bool('O1', 1), bool('O2', 1), bool('OSub', 1), bool('L')],
      tasks: [mainTask(['P1']), periodic('Per', 50, ['P2'])],
      programs: [prog('P1', ['XIC A OTE O1 ;', 'XIC A OTL L ;', 'JSR(Sub,0);'], { routines: [rll('Sub', 'XIC A OTE OSub ;')] }), prog('P2', ['XIC A OTE O2 ;'])],
    });
    expect(c.download(def).ok).toBe(true);
    expect(c.setMode('RUN')).toBeNull();
    expect(c.readBool('O1')).toBe(false);
    expect(c.readBool('O2')).toBe(false);
    expect(c.readBool('OSub')).toBe(false);
    // prescan is not a logic scan
    expect(c.readBool('L')).toBe(false);
    expect(c.stats.scans).toBe(0);
    scans(c);
    expect(c.readBool('O1')).toBe(true);
    expect(c.readBool('L')).toBe(true);
  });

  it('setMode(RUN) while already running does not prescan again', () => {
    const c = run({ tags: [bool('A'), bool('B')], rungs: ['XIC A OTE B ;'] });
    scans(c);
    c.write('B', 1);
    expect(c.setMode('RUN')).toBeNull();
    expect(c.readBool('B')).toBe(true);
  });
});

describe('download and verify', () => {
  const good = () => ladderProject({ tags: [bool('A'), bool('B')], rungs: ['XIC A OTE B ;'] });

  it('download is only allowed in Program mode (blocked in Run)', () => {
    const c = run({ tags: [bool('A', 1), bool('B')], rungs: ['XIC A OTE B ;'] });
    scans(c);
    const before = c.project;
    const res = c.download(ladderProject({ tags: [bool('A'), bool('C')], rungs: ['XIC A OTE C ;'] }));
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/Program mode/);
    expect(c.mode).toBe('RUN');
    expect(c.project).toBe(before);
    // the running project is unaffected
    c.write('A', 0);
    scans(c);
    expect(c.readBool('B')).toBe(false);
    expect(c.setMode('PROGRAM')).toBeNull();
    expect(c.download(good()).ok).toBe(true);
  });

  it('a project with verify errors is not downloaded and the previous project stays loaded', () => {
    const c = new Controller();
    const bad = ladderProject({ tags: [bool('A')], rungs: ['XIC A OTE Missing ;'] });
    const r1 = c.download(bad);
    expect(r1.ok).toBe(false);
    expect(r1.errors.length).toBeGreaterThan(0);
    expect(c.project).toBeNull();
    expect(c.setMode('RUN')).toMatch(/No project/);

    expect(c.download(good()).ok).toBe(true);
    const loaded = c.project;
    const r2 = c.download(bad);
    expect(r2.ok).toBe(false);
    expect(c.project).toBe(loaded);
    expect(c.setMode('RUN')).toBeNull();
    c.write('A', 1);
    scans(c);
    expect(c.readBool('B')).toBe(true);
  });

  it('download works from Faulted mode: the fault is cleared and the controller is in Program mode', () => {
    const c = run({ tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 99), bool('X')], rungs: ['XIC Bits[Idx] OTE X ;'] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.download(good()).ok).toBe(true);
    expect(c.mode).toBe('PROGRAM');
    expect(c.majorFault).toBeNull();
  });

  it('the downloaded project is a snapshot (later edits to the definition do not leak in)', () => {
    const c = new Controller();
    const def = good();
    expect(c.download(def).ok).toBe(true);
    def.programs[0].routines[0] = rll('MainRoutine', 'XIO A OTE B ;');
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(c.readBool('B')).toBe(false);
  });

  it('download returns warnings without blocking (unscheduled program)', () => {
    const def = project({ tags: [bool('A')], tasks: [mainTask(['P1'])], programs: [prog('P1', ['OTE A ;']), prog('Spare', ['NOP ;'])] });
    const c = new Controller();
    const r = c.download(def);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/Spare/);
  });

  it('verify reports every error with its program / routine / rung / element / operand location', () => {
    const c = new Controller();
    const def = ladderProject({
      tags: [bool('A'), bool('B')],
      rungs: ['XIC A OTE B ;', 'NOP ;', 'XIC A [XIC B ,XIO A ] OTE Nope ;', 'JSR(Sub,0);'],
      routines: [rll('Sub', 'XIC Ghost OTE B ;')],
    });
    const r = c.verify(def);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
    const main = r.errors.find((e) => e.routine === 'MainRoutine')!;
    expect(main).toMatchObject({ severity: 'error', program: 'MainProgram', routine: 'MainRoutine', rung: 2, element: 4, operand: 0 });
    expect(main.message).toMatch(/^Rung 2, OTE, Operand 0: Undefined tag 'Nope'/);
    const sub = r.errors.find((e) => e.routine === 'Sub')!;
    expect(sub).toMatchObject({ program: 'MainProgram', routine: 'Sub', rung: 0, element: 0, operand: 0 });
    expect(sub.message).toMatch(/Undefined tag 'Ghost'/);
    // verify has no side effects
    expect(c.project).toBeNull();
    expect(c.mode).toBe('PROGRAM');
  });

  it('verify reports tag, task and program configuration errors', () => {
    const c = new Controller();
    const def = project({
      tags: [bool('A'), bool('A'), { name: 'BadType', dataType: 'NOPE' }],
      tasks: [mainTask(['P1']), { name: 'T2', type: 'CONTINUOUS', programs: ['P2'] }, periodic('T3', 0, ['Ghost'])],
      programs: [prog('P1', ['OTE A ;']), prog('P2', ['NOP ;'])],
    });
    const msgs = c
      .verify(def)
      .errors.map((e) => e.message)
      .join('\n');
    expect(msgs).toMatch(/Duplicate tag 'A'/);
    expect(msgs).toMatch(/Undefined data type 'NOPE'/);
    expect(msgs).toMatch(/Only one continuous task/);
    expect(msgs).toMatch(/period > 0/);
    expect(msgs).toMatch(/unknown program 'Ghost'/);
  });
});

describe('controller modes', () => {
  it('Run requires a downloaded project', () => {
    const c = new Controller();
    expect(c.mode).toBe('PROGRAM');
    expect(c.setMode('RUN')).toMatch(/No project/);
    expect(c.mode).toBe('PROGRAM');
  });

  it('Program <-> Run', () => {
    const c = load({ tags: [bool('B')], rungs: ['OTE B ;'] });
    expect(c.mode).toBe('PROGRAM');
    expect(c.setMode('RUN')).toBeNull();
    expect(c.mode).toBe('RUN');
    expect(c.setMode('PROGRAM')).toBeNull();
    expect(c.mode).toBe('PROGRAM');
    scans(c, 3);
    expect(c.readBool('B')).toBe(false);
    expect(c.stats.scans).toBe(0);
  });

  it('Faulted: cannot go to Run or Program until the fault is cleared; clearFault goes to Program', () => {
    const c = run({ tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 50), bool('X')], rungs: ['XIC Bits[Idx] OTE X ;'] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.setMode('RUN')).toMatch(/Clear the major fault/);
    expect(c.mode).toBe('FAULTED');
    expect(c.setMode('PROGRAM')).toMatch(/Clear the major fault/);
    expect(c.mode).toBe('FAULTED');
    // a faulted controller does not scan
    scans(c, 5);
    expect(c.mode).toBe('FAULTED');
    c.clearFault();
    expect(c.mode).toBe('PROGRAM');
    expect(c.majorFault).toBeNull();
    c.write('Idx', 1);
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(c.mode).toBe('RUN');
  });

  it('clearFault is a no-op when not faulted', () => {
    const c = run({ rungs: ['NOP ;'] });
    c.clearFault();
    expect(c.mode).toBe('RUN');
  });

  it('listeners are notified of mode changes, downloads and faults', () => {
    const c = new Controller();
    let n = 0;
    const off = c.subscribe(() => n++);
    c.download(ladderProject({ tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 50), bool('X')], rungs: ['XIC Bits[Idx] OTE X ;'] }));
    const afterDownload = n;
    expect(afterDownload).toBeGreaterThan(0);
    c.setMode('RUN');
    expect(n).toBeGreaterThan(afterDownload);
    const afterRun = n;
    c.scan();
    expect(c.mode).toBe('FAULTED');
    expect(n).toBeGreaterThan(afterRun);
    off();
    const final = n;
    c.clearFault();
    expect(n).toBe(final);
  });

  it('field outputs are off in Program mode (tag values are kept)', () => {
    const c = run({ modules: IO, rungs: ['OTE Local:2:O.Data.0 ;', 'OTE Local:2:O.Data.7 ;'] });
    scans(c);
    expect(c.io.getOutputWord(2)).toBe(0x81);
    expect(c.setMode('PROGRAM')).toBeNull();
    // immediately de-energized
    expect(c.io.getOutputWord(2)).toBe(0);
    scans(c, 3);
    expect(c.io.getOutputWord(2)).toBe(0);
    expect(c.readBool('Local:2:O.Data.0')).toBe(true);
    // writing an output tag in Program mode does not reach the field
    c.write('Local:2:O.Data.3', 1);
    scans(c);
    expect(c.io.getOutput(2, 3)).toBe(false);
    expect(c.setMode('RUN')).toBeNull();
    scans(c);
    expect(c.io.getOutputWord(2)).toBe(0x89);
  });

  it('field outputs are off in Faulted mode', () => {
    const c = run({
      modules: IO,
      tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 0), bool('X')],
      rungs: ['OTE Local:2:O.Data.0 ;', 'XIC Bits[Idx] OTE X ;'],
    });
    scans(c);
    expect(c.io.getOutput(2, 0)).toBe(true);
    c.write('Idx', 32);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.io.getOutput(2, 0)).toBe(false);
    scans(c, 3);
    expect(c.io.getOutput(2, 0)).toBe(false);
  });
});

describe('virtual time and scan counting', () => {
  it('advance(100) with a 10 ms scan period runs 10 continuous scans', () => {
    const c = run({ rungs: ['NOP ;'] });
    expect(c.time).toBe(0);
    c.advance(100);
    expect(c.stats.scans).toBe(10);
    expect(c.time).toBe(100);
    expect(c.runtime!.now).toBe(100);
  });

  it('scan() runs exactly one scan and advances time by one scan period', () => {
    const c = run({ rungs: ['NOP ;'] });
    c.scan();
    expect(c.stats.scans).toBe(1);
    expect(c.time).toBe(10);
    scans(c, 4);
    expect(c.stats.scans).toBe(5);
    expect(c.time).toBe(50);
  });

  it('uses the project scan period', () => {
    const c = run({ rungs: ['NOP ;'], scanPeriodMs: 5 });
    c.advance(100);
    expect(c.stats.scans).toBe(20);
    c.scan();
    expect(c.time).toBe(105);
    expect(c.stats.scans).toBe(21);
  });

  it('partial advances accumulate: scans are due every period regardless of step size', () => {
    const c = run({ rungs: ['NOP ;'] });
    c.advance(15);
    expect(c.stats.scans).toBe(2); // t = 0, 10
    for (let i = 0; i < 5; i++) c.advance(1); // [15, 20)
    expect(c.stats.scans).toBe(2);
    c.advance(1); // [20, 21)
    expect(c.stats.scans).toBe(3);
    c.advance(15); // [21, 36): t = 30
    expect(c.stats.scans).toBe(4);
    for (let i = 0; i < 64; i++) c.advance(1); // [36, 100): t = 40 .. 90
    expect(c.stats.scans).toBe(10);
    expect(c.time).toBe(100);
  });

  it('time advances but nothing scans in Program mode; Run restarts the scan counter', () => {
    const c = load({ rungs: ['NOP ;'] });
    c.advance(1000);
    expect(c.time).toBe(1000);
    expect(c.stats.scans).toBe(0);
    expect(c.setMode('RUN')).toBeNull();
    c.advance(30);
    expect(c.stats.scans).toBe(3);
    expect(c.time).toBe(1030);
  });
});

describe('periodic tasks', () => {
  /** Step the controller in 10 ms slices; return the slice indices where the bit got set. */
  function runsOf(c: Controller, bit: string, slices: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < slices; i++) {
      c.write(bit, 0);
      c.advance(10);
      if (c.readBool(bit)) out.push(i);
    }
    return out;
  }

  it('a periodic task runs once per period while the continuous task keeps scanning', () => {
    const c = start(
      project({
        tags: [bool('PerRan'), bool('MainRan')],
        tasks: [mainTask(['Main']), periodic('Per', 50, ['PerProg'], 5)],
        programs: [prog('Main', ['OTL MainRan ;']), prog('PerProg', ['OTL PerRan ;'])],
      }),
    );
    const runs = runsOf(c, 'PerRan', 30);
    expect(runs.length).toBeGreaterThanOrEqual(5);
    expect(runs.length).toBeLessThanOrEqual(6);
    for (let k = 1; k < runs.length; k++) expect(runs[k] - runs[k - 1]).toBe(5);
    expect(runs[0]).toBeLessThan(5);
    expect(c.stats.scans).toBe(30);
    expect(c.readBool('MainRan')).toBe(true);
  });

  it('a period that is not a multiple of the continuous scan period', () => {
    const c = start(
      project({
        tags: [bool('PerRan')],
        tasks: [mainTask(['Main']), periodic('Per', 25, ['PerProg'])],
        programs: [prog('Main', ['NOP ;']), prog('PerProg', ['OTL PerRan ;'])],
      }),
    );
    const runs = runsOf(c, 'PerRan', 20);
    // runs at t0, t0+25, t0+50 ...: slice index = floor(t / 10)
    const t0 = runs[0] * 10;
    expect(runs).toEqual(runs.map((_, k) => Math.floor((t0 + 25 * k) / 10)));
    expect(runs.length).toBeGreaterThanOrEqual(7);
  });

  it('tasks due at the same time run in priority order (lower number first), then the continuous task', () => {
    const c = start(
      project({
        tags: [bool('HiFirst'), bool('LoFirst'), bool('HiDone'), bool('LoDone'), bool('MainFirst')],
        // listed in the "wrong" order on purpose
        tasks: [mainTask(['Main']), periodic('Lo', 20, ['LoProg'], 10), periodic('Hi', 20, ['HiProg'], 5)],
        programs: [
          prog('Main', ['XIO HiDone OTL MainFirst ;']),
          prog('LoProg', ['XIO HiDone OTL LoFirst ;', 'OTL LoDone ;']),
          prog('HiProg', ['XIO LoDone OTL HiFirst ;', 'OTL HiDone ;']),
        ],
      }),
    );
    c.advance(10);
    expect(c.readBool('HiDone')).toBe(true);
    expect(c.readBool('LoDone')).toBe(true);
    expect(c.readBool('HiFirst')).toBe(true);
    expect(c.readBool('LoFirst')).toBe(false);
    expect(c.readBool('MainFirst')).toBe(false);
  });

  it('an inhibited task does not run', () => {
    const c = start(
      project({
        tags: [bool('PerRan')],
        tasks: [mainTask(['Main']), periodic('Per', 20, ['PerProg'], 5, { inhibited: true })],
        programs: [prog('Main', ['NOP ;']), prog('PerProg', ['OTL PerRan ;'])],
      }),
    );
    c.advance(200);
    expect(c.readBool('PerRan')).toBe(false);
    expect(c.stats.scans).toBe(20);
  });

  it('a periodic task watchdog fault names the periodic task', () => {
    const c = start(
      project({
        tags: [bool('X')],
        tasks: [mainTask(['Main']), periodic('Fast', 20, ['FastProg'], 3, { watchdogMs: 5 })],
        programs: [prog('Main', ['NOP ;']), prog('FastProg', ['LBL(Spin) NOP ;', 'JMP(Spin);'])],
      }),
    );
    c.advance(50);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 6, code: 1, task: 'Fast', program: 'FastProg' });
  });
});

describe('programs and tag scope', () => {
  it('program-scope tags with the same name are independent; controller tags are shared', () => {
    const c = start(
      project({
        tags: [bool('Shared', 1), bool('Flag')],
        tasks: [mainTask(['P1', 'P2'])],
        programs: [
          prog('P1', ['XIC Shared OTE Flag ;'], { tags: [bool('Flag')] }),
          prog('P2', ['XIO Shared OTE Flag ;', 'XIC Shared OTE Mine ;'], { tags: [bool('Flag', 1), bool('Mine')] }),
        ],
      }),
    );
    scans(c);
    expect(c.readBool('Flag', 'P1')).toBe(true);
    expect(c.readBool('Flag', 'P2')).toBe(false);
    // program tags shadow the controller tag of the same name
    expect(c.readBool('Flag')).toBe(false);
    expect(c.readBool('Mine', 'P2')).toBe(true);
    // a program sees controller tags through its scope
    expect(c.readBool('Shared', 'P2')).toBe(true);
    expect(() => c.readBool('Mine')).toThrow(/Undefined tag/);
    expect(() => c.readBool('Mine', 'P1')).toThrow(/Undefined tag/);
  });

  it("a program cannot reference another program's tags", () => {
    const c = new Controller();
    const r = c.verify(
      project({
        tasks: [mainTask(['P1', 'P2'])],
        programs: [prog('P1', ['OTE OnlyP1 ;'], { tags: [bool('OnlyP1')] }), prog('P2', ['XIC OnlyP1 OTE OnlyP1 ;'])],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ program: 'P2' });
    expect(r.errors[0].message).toMatch(/Undefined tag 'OnlyP1'/);
  });
});

describe('upload', () => {
  it('returns null before any download', () => {
    expect(new Controller().upload()).toBeNull();
  });

  it('returns the project with the current tag values (controller and program scope)', () => {
    const c = run({
      tags: [bool('Go', 1), bool('Run'), dint('W'), arr('Bits', 'BOOL', [32]), timer('T1'), { name: 'Alias1', dataType: '', alias: 'Run' }],
      programTags: [bool('Local1')],
      rungs: ['XIC Go OTE Run ;', 'XIC Go OTE W.4 ;', 'XIC Go OTE Bits[2] ;', 'XIC Go OTE Local1 ;'],
    });
    scans(c);
    c.write('T1.ACC', 1234);
    const def = c.upload()!;
    const tag = (name: string) => def.tags!.find((t) => t.name === name)!;
    expect(tag('Run').value).toBe(1);
    expect(tag('W').value).toBe(16);
    expect((tag('Bits').value as number[])[2]).toBe(1);
    expect((tag('Bits').value as number[]).length).toBe(32);
    expect(tag('T1').value).toMatchObject({ ACC: 1234 });
    expect(def.programs[0].tags!.find((t) => t.name === 'Local1')!.value).toBe(1);
    // alias tags carry no value of their own
    expect(tag('Alias1').value).toBeUndefined();
    // the upload is a copy
    (tag('Bits').value as number[])[2] = 0;
    expect(c.readBool('Bits[2]')).toBe(true);
    // an uploaded project can be downloaded again and keeps the values
    expect(c.setMode('PROGRAM')).toBeNull();
    const d = new Controller();
    expect(d.download(c.upload()!).ok).toBe(true);
    expect(d.readNumber('T1.ACC')).toBe(1234);
    expect(d.readNumber('W')).toBe(16);
  });
});

describe('major faults', () => {
  it('an array subscript fault records type, code, task, program, routine, rung, element and instruction', () => {
    const c = run({
      tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 0), bool('Gate'), bool('Out')],
      rungs: ['NOP ;', 'XIO Gate XIC Bits[Idx] OTE Out ;'],
    });
    scans(c, 3);
    expect(c.mode).toBe('RUN');
    const t = c.time;
    c.write('Idx', 32);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    const f = c.majorFault!;
    expect(f).toMatchObject({
      type: 4,
      code: 20,
      major: true,
      task: 'MainTask',
      program: 'MainProgram',
      routine: 'MainRoutine',
      rung: 1,
      element: 1,
      instruction: 'XIC',
      time: t,
    });
    expect(f.message).toMatch(/Array subscript/);
    expect(c.faultLog[c.faultLog.length - 1]).toEqual(f);
  });

  it('a negative subscript also faults', () => {
    const c = run({ tags: [arr('Bits', 'BOOL', [32]), dint('Idx', -1), bool('Out')], rungs: ['XIC Bits[Idx] OTE Out ;'] });
    scans(c);
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, rung: 0, instruction: 'XIC' });
  });

  it('a task watchdog fault (Type 6 Code 1) names the task', () => {
    const c = run({ tags: [bool('X')], rungs: ['LBL(Loop) OTE X ;', 'JMP(Loop);'] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 6, code: 1, task: 'MainTask', major: true });
    expect(c.majorFault!.message).toMatch(/watchdog/i);
  });

  it('a watchdog fault never points at an element outside the faulted rung or at an instruction that did not run', () => {
    // When the watchdog trips at the top of rung 0, the last element executed was JMP (element 3 of rung 1).
    const c = run({ tags: [bool('A', 1)], rungs: ['LBL(Loop) NOP ;', 'XIC A XIC A XIC A JMP(Loop);'] });
    scans(c);
    const f = c.majorFault!;
    expect(f).toMatchObject({ type: 6, code: 1 });
    const st = c.ladderState('MainProgram', 'MainRoutine')!;
    if (f.element !== undefined) {
      expect(f.rung).toBeDefined();
      expect(f.element).toBeLessThan(st.power[f.rung!].length);
    }
    // the record must not name an instruction that is not at (rung, element)
    if (f.instruction !== undefined) {
      expect(f.element).toBeDefined();
      expect(f.rung).toBe(1);
      expect(f.instruction).toBe('JMP');
    }
  });

  it('a long but finite loop within the watchdog budget does not fault', () => {
    const rungs = ['LBL(Top) NOP ;'];
    for (let i = 0; i < 20; i++) rungs.push(`XIC B${i} OTL B${i + 1} ;`);
    rungs.push('OTL B0 ;', 'XIO B20 JMP(Top);');
    const tags = Array.from({ length: 21 }, (_, i) => bool(`B${i}`));
    const c = run({ tags, rungs });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.readBool('B20')).toBe(true);
  });

  it('faultLog keeps a bounded history, most recent last', () => {
    const c = run({ tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 40), bool('X')], rungs: ['XIC Bits[Idx] OTE X ;'] });
    for (let k = 0; k < 20; k++) {
      scans(c);
      expect(c.mode).toBe('FAULTED');
      c.clearFault();
      expect(c.setMode('RUN')).toBeNull();
    }
    expect(c.faultLog.length).toBe(16);
    expect(c.faultLog.every((f) => f.major && f.type === 4 && f.code === 20)).toBe(true);
    const times = c.faultLog.map((f) => f.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // clearing the fault keeps the history
    expect(c.majorFault).toBeNull();
  });
});
