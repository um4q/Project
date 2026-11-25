/**
 * Program fault routines and the Controller Fault Handler.
 */
import { describe, it, expect } from 'vitest';
import { Controller, ladderProject } from '../index';
import { arr, bool, dint } from './helpers';

describe('program fault routine and Controller Fault Handler', () => {
  it('SPEC-4: a program fault routine and the Controller Fault Handler run on a major fault; missing ones are verify errors', () => {
    const p = ladderProject({
      tags: [arr('Arr', 'DINT', [4]), dint('Idx', 0), dint('D'), bool('FaultRan'), bool('HandlerRan')],
      rungs: ['MOV Arr[Idx] D ;'],
      routines: [{ name: 'Fault', type: 'RLL', rungs: [{ text: 'OTL FaultRan ;' }] }],
    });
    p.programs[0].faultRoutine = 'Fault';
    p.programs.push({ name: 'FaultHandler', mainRoutine: 'Main', routines: [{ name: 'Main', type: 'RLL', rungs: [{ text: 'OTL HandlerRan ;' }] }] });
    p.faultHandler = 'FaultHandler';

    const c = new Controller();
    const res = c.download(p);
    expect(res.errors).toEqual([]);
    expect(c.setMode('RUN')).toBeNull();
    c.scan();
    expect(c.mode).toBe('RUN');
    c.write('Idx', 9);
    c.scan();
    // neither handler can clear the fault (no SSV), so the controller still faults with the original record
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, program: 'MainProgram', routine: 'MainRoutine', rung: 0, instruction: 'MOV' });
    expect(c.readBool('FaultRan')).toBe(true);
    expect(c.readBool('HandlerRan')).toBe(true);

    // a fault routine or fault handler that does not exist is a verify error
    const bad = ladderProject({ tags: [dint('D')], rungs: ['NOP ;'] });
    bad.programs[0].faultRoutine = 'Nope';
    bad.faultHandler = 'NoProgram';
    const v = new Controller().verify(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.message).join('\n')).toMatch(/Nope/);
    expect(v.errors.map((e) => e.message).join('\n')).toMatch(/NoProgram/);
  });
});
