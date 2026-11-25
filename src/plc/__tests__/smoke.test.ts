import { describe, it, expect } from 'vitest';
import { run, scans, bool, verifyErrors } from './helpers';

describe('engine smoke test', () => {
  it('runs a start/stop seal-in rung', () => {
    const c = run({
      tags: [bool('Start'), bool('Stop', 1), bool('Run')],
      rungs: ['[XIC Start ,XIC Run ] XIC Stop OTE Run ;'],
    });
    scans(c);
    expect(c.readBool('Run')).toBe(false);
    c.write('Start', 1);
    scans(c);
    expect(c.readBool('Run')).toBe(true);
    c.write('Start', 0);
    scans(c, 3);
    expect(c.readBool('Run')).toBe(true);
    c.write('Stop', 0);
    scans(c);
    expect(c.readBool('Run')).toBe(false);
  });

  it('reports undefined tags at verify', () => {
    const errs = verifyErrors({ rungs: ['XIC Nope OTE AlsoNope ;'] });
    expect(errs.map((e) => e.message).join('\n')).toMatch(/Undefined tag 'Nope'/);
  });
});
