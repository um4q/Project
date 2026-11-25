/**
 * Regression tests from the Stage 1 robustness review: each it() asserts the
 * correct behaviour for an input that used to hang, throw or misbehave.
 */
import { describe, it, expect } from 'vitest';
import { run, scans, bool, dint } from './helpers';
import { Controller, ladderProject, parseRoutineText, NeutralParseError } from '../index';

/** Limit the number of task scans so a runaway scheduling loop fails the test instead of hanging it. */
function limitTaskRuns(c: Controller, max = 100): () => number {
  const anyC = c as any;
  const orig = anyC.runTask.bind(c);
  let calls = 0;
  anyC.runTask = (t: unknown) => {
    if (++calls > max) throw new Error('runaway scheduling loop');
    return orig(t);
  };
  return () => calls;
}

describe('regression: robustness', () => {
  it('ROB-1: a JMP pending on the caller rung does not leak into a subroutine called later on that rung', () => {
    const sub = (extra: string[]) => [{ text: 'ADD S 1 S ;' }, { text: 'ADD S 10 S ;' }, ...extra.map((text) => ({ text }))];
    // Sub without the label: must not fault
    const c = run({
      tags: [dint('N'), dint('S'), bool('On', 1)],
      rungs: ['XIC On JMP Skip JSR Sub 0 ;', 'ADD N 1 N ;', 'LBL Skip NOP ;'],
      routines: [{ name: 'Sub', type: 'RLL', rungs: sub([]) }],
    });
    scans(c);
    expect(c.majorFault).toBeNull();
    expect(c.mode).toBe('RUN');
    expect(c.readNumber('N')).toBe(0); // main took its own jump
    expect([0, 11]).toContain(c.readNumber('S')); // Sub skipped or ran normally
    // Sub with a label of the same name: must not jump inside Sub
    const d = run({
      tags: [dint('N'), dint('S'), bool('On', 1)],
      rungs: ['XIC On JMP Skip JSR Sub 0 ;', 'ADD N 1 N ;', 'LBL Skip NOP ;'],
      routines: [{ name: 'Sub', type: 'RLL', rungs: sub(['LBL Skip ADD S 100 S ;']) }],
    });
    scans(d);
    expect(d.mode).toBe('RUN');
    expect(d.readNumber('N')).toBe(0);
    expect([0, 111]).toContain(d.readNumber('S'));
  });

  it('ROB-2: RET ends the subroutine even when a JMP is true on the same rung', () => {
    const c = run({
      tags: [dint('S'), bool('On', 1)],
      rungs: ['JSR Sub 0 ;'],
      routines: [{ name: 'Sub', type: 'RLL', rungs: [{ text: 'XIC On [RET ,JMP L ] ;' }, { text: 'ADD S 1 S ;' }, { text: 'LBL L ADD S 10 S ;' }, { text: 'ADD S 100 S ;' }] }],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.readNumber('S')).toBe(0);
  });

  it('ROB-3: advance() with NaN / Infinity / negative ms returns and keeps virtual time finite and non-decreasing', () => {
    for (const bad of [NaN, Infinity, -50]) {
      const c = run({ tags: [dint('N')], rungs: ['ADD N 1 N ;'] });
      scans(c); // time 10
      const calls = limitTaskRuns(c);
      try {
        c.advance(bad);
      } catch (e) {
        expect((e as Error).message).not.toBe('runaway scheduling loop');
      }
      expect(calls()).toBeLessThanOrEqual(1);
      expect(Number.isFinite(c.time)).toBe(true);
      expect(c.time).toBeGreaterThanOrEqual(10);
    }
    // Program mode: a NaN must not poison virtual time
    const p = new Controller();
    expect(p.download(ladderProject({ tags: [dint('N')], rungs: ['NOP ;'] })).ok).toBe(true);
    try {
      p.advance(NaN);
    } catch {
      /* rejecting is fine */
    }
    expect(Number.isFinite(p.time)).toBe(true);
  });

  it('ROB-4: verify rejects task timing values outside the Logix ranges (scan period, periodic period, watchdog)', () => {
    const base = () => ladderProject({ tags: [dint('N')], rungs: ['ADD N 1 N ;'] });
    const p1 = base();
    p1.controller.scanPeriodMs = 0; // would hang advance()
    expect(new Controller().verify(p1).errors.length).toBeGreaterThan(0);

    const p2 = base();
    p2.tasks.push({ name: 'Per', type: 'PERIODIC', periodMs: 1e-12, programs: ['P2'] }); // below 0.1 ms: hangs advance()
    p2.programs.push({ name: 'P2', mainRoutine: 'R', routines: [{ name: 'R', type: 'RLL', rungs: [{ text: 'NOP ;' }] }] });
    expect(new Controller().verify(p2).errors.length).toBeGreaterThan(0);

    const p3 = base();
    p3.tasks[0].watchdogMs = 0; // below 1 ms: faults every scan
    expect(new Controller().verify(p3).errors.length).toBeGreaterThan(0);

    const p4 = base();
    p4.tasks[0].watchdogMs = NaN; // disables the watchdog
    expect(new Controller().verify(p4).errors.length).toBeGreaterThan(0);
  });

  it('ROB-5: an oversized array gives a verify error instead of a RangeError out of verify()', () => {
    const def = ladderProject({ tags: [{ name: 'A', dataType: 'DINT', dims: [100000, 100000] }], rungs: ['NOP ;'] });
    let errors: unknown[] = [];
    expect(() => {
      errors = new Controller().verify(def).errors;
    }).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('ROB-9: a 0.1 ms / 1.2 ms period runs exactly the scans due in [now, now + ms)', () => {
    const c = run({ tags: [dint('N')], rungs: ['ADD N 1 N ;'], scanPeriodMs: 0.1 });
    c.advance(1); // scans at 0, 0.1, ... 0.9
    expect(c.readNumber('N')).toBe(10);
    const d = run({ tags: [dint('N')], rungs: ['ADD N 1 N ;'], scanPeriodMs: 1.2 });
    d.advance(3.6); // scans at 0, 1.2, 2.4
    expect(d.readNumber('N')).toBe(3);
  });

  it('ROB-10: deeply nested branches give a clean parse / verify error, not a RangeError', () => {
    const nest = (depth: number) => '['.repeat(depth) + 'XIC A' + ' ,XIC A ]'.repeat(depth) + ' OTE B ;';
    const text = nest(1500);
    let res: { ok: boolean } | undefined;
    expect(() => {
      res = new Controller().download(ladderProject({ tags: [bool('A', 1), bool('B')], rungs: [text] }));
    }).not.toThrow();
    expect(res!.ok).toBe(false);
    let err: unknown;
    try {
      parseRoutineText(nest(8000));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NeutralParseError);
  });

  it('ROB-11: io point numbers outside the module do not alias onto other points', () => {
    const c = run({ modules: [{ slot: 1, catalog: 'LX-IQ16' }], rungs: ['NOP ;'] });
    try {
      c.io.setInput(1, 32, true);
    } catch {
      /* rejecting is fine */
    }
    scans(c);
    expect(c.readBool('Local:1:I.Data.0')).toBe(false);
    expect(c.io.getInput(1, 0)).toBe(false);
    c.io.setInput(1, 0, true);
    expect(c.io.getInput(1, 32)).toBe(false);
  });
});
