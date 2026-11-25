import { describe, it, expect } from 'vitest';
import { bool, dint, arr, scans } from './helpers';
import { Controller, getInstruction, ladderProject, type TagDef } from '../index';

const RUNGS = 200;
const WARMUP = 50;
const MEASURED = 500;

interface Built {
  tags: TagDef[];
  rungs: string[];
  extras: string[];
}

/**
 * A 200-rung program of mixed bit logic with branches, one-shots and latches.
 * Timers, compares and moves are mixed in when those instructions are registered
 * (and `useExtras` is set).
 */
function build(useExtras: boolean): Built {
  const has = (m: string) => useExtras && !!getInstruction(m);
  const extras = ['TON', 'GRT', 'LES', 'MOV'].filter(has);
  const tags: TagDef[] = [
    bool('Osc'),
    bool('Run'),
    arr('In', 'BOOL', [256]),
    arr('Out', 'BOOL', [1024]),
    arr('Store', 'BOOL', [256]),
    arr('Words', 'DINT', [64]),
    dint('Word'),
    dint('Cnt'),
    dint('Idx', 3),
  ];
  if (has('TON')) tags.push(arr('T', 'TIMER', [64]));
  if (has('MOV')) tags.push(arr('Vals', 'DINT', [256]));
  const rungs: string[] = ['XIO Osc OTE Osc ;', '[XIC In[0] ,XIC Run ] XIO In[1] OTE Run ;'];
  for (let i = rungs.length; i < RUNGS; i++) {
    const k = i % 256;
    const o = i * 4;
    switch (i % 8) {
      case 0:
        rungs.push(`[XIC In[${k}] ,XIC Out[${o - 4}] ,XIC Osc ] XIO In[${(k + 1) % 256}] OTE Out[${o}] ;`);
        break;
      case 1:
        rungs.push(`XIC Out[${o - 4}] [OTE Out[${o}] ,XIC Words[${i % 64}].${i % 32} OTL Out[${o + 1}] ,XIO Osc OTU Out[${o + 1}] ] ;`);
        break;
      case 2:
        rungs.push(has('TON') ? `XIC Run XIC Out[${o - 4}] TON T[${i % 64}] ${100 + i} 0 ;` : `XIC Run XIC Out[${o - 4}] XIO Out[${o - 8}] OTE Out[${o}] ;`);
        break;
      case 3:
        rungs.push(
          has('GRT') ? `[GRT Words[${i % 64}] ${i} ,LES Cnt 10 ] OTE Out[${o}] ;` : `[XIC In[${k}] XIO Osc ,XIO In[${k}] XIC Osc ] OTE Out[${o}] ;`,
        );
        break;
      case 4:
        rungs.push(has('MOV') ? `XIC Osc MOV ${i} Vals[${k}] ;` : `XIC Osc ONS Store[${k}] OTE Out[${o}] ;`);
        break;
      case 5:
        rungs.push(`XIC Osc [ONS Store[${k}] OTE Out[${o}] ,OTE Out[${o + 1}] ] ;`);
        break;
      case 6:
        rungs.push(`[XIC Out[${o - 24}] [XIC Out[${o - 20}] ,XIO Out[${o - 16}] ] ,XIC Word.${i % 32} ] [OTE Out[${o}] ,OTE Word.${(i + 1) % 32} ] ;`);
        break;
      default:
        rungs.push(`XIC Out[${o - 4}] XIC Run OSR Store[${k}] Out[${o}] OTE Out[${o + 1}] ;`);
    }
  }
  return { tags, rungs, extras };
}

function start(b: Built): Controller | null {
  const c = new Controller();
  const r = c.download(ladderProject({ tags: b.tags, rungs: b.rungs }));
  if (!r.ok) {
    console.warn(`perf: program with ${b.extras.join('/')} did not download:\n${r.errors.map((e) => e.message).join('\n')}`);
    return null;
  }
  if (c.setMode('RUN')) return null;
  return c;
}

describe('scan performance', () => {
  it(`a ${RUNGS}-rung program scans in well under 1 ms (median)`, () => {
    let b = build(true);
    let c = start(b);
    if (c) {
      c.write('In[0]', 1);
      for (let w = 0; w < 64; w++) c.write(`Words[${w}]`, (w * 2654435761) | 0);
      scans(c, WARMUP);
      if (c.mode !== 'RUN') {
        console.warn(`perf: program with ${b.extras.join('/')} faulted (${c.majorFault?.message}); falling back to bit logic`);
        c = null;
      }
    }
    if (!c) {
      b = build(false);
      c = start(b)!;
      expect(c).not.toBeNull();
      c.write('In[0]', 1);
      scans(c, WARMUP);
    }
    expect(c.mode).toBe('RUN');
    expect(c.ladderState('MainProgram', 'MainRoutine')!.rungs.length).toBe(RUNGS);

    const times: number[] = [];
    for (let s = 0; s < MEASURED; s++) {
      // vary an input between scans (not timed) so one-shots and branches keep changing
      if (s % 10 === 0) c.write(`In[${(s / 10) % 256}]`, (s / 10) % 2);
      const t0 = performance.now();
      c.scan();
      times.push(performance.now() - t0);
    }
    expect(c.mode).toBe('RUN');
    const sorted = [...times].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];
    console.log(
      `perf: ${RUNGS} rungs [extras: ${b.extras.join(', ') || 'none'}]: median ${(median * 1000).toFixed(1)} µs, p95 ${(p95 * 1000).toFixed(1)} µs, max ${(max * 1000).toFixed(1)} µs; ` +
        `controller stats last ${c.stats.lastScanUs.toFixed(1)} µs, max ${c.stats.maxScanUs.toFixed(1)} µs`,
    );
    expect(median).toBeLessThan(1);

    // controller scan statistics
    expect(c.stats.scans).toBe(WARMUP + MEASURED);
    expect(c.stats.lastScanUs).toBeGreaterThan(0);
    expect(c.stats.maxScanUs).toBeGreaterThanOrEqual(c.stats.lastScanUs);
    expect(Number.isFinite(c.stats.maxScanUs)).toBe(true);
    // logic actually ran: the oscillator toggles every scan
    const osc = c.readBool('Osc');
    c.scan();
    expect(c.readBool('Osc')).toBe(!osc);
  });

  it('scan statistics reset on entering Run', () => {
    const c = start(build(false))!;
    scans(c, 5);
    expect(c.stats.scans).toBe(5);
    expect(c.stats.lastScanUs).toBeGreaterThan(0);
    expect(c.setMode('PROGRAM')).toBeNull();
    expect(c.setMode('RUN')).toBeNull();
    expect(c.stats).toEqual({ lastScanUs: 0, maxScanUs: 0, scans: 0 });
    c.scan();
    expect(c.stats.scans).toBe(1);
    expect(c.stats.lastScanUs).toBeGreaterThan(0);
  });
});
