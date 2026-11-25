import { describe, it, expect } from 'vitest';
import { run, scans, verifyErrors, bool, dint, int, sint, real, control, arr } from './helpers';

describe('regression: Logix numeric rules', () => {
  it('NUM-1: SQR with integer Source and integer Dest truncates (REAL Source rounds)', () => {
    const c = run({
      tags: [dint('A', 3), dint('B', 8), dint('C', 99), int('I', 15), real('R', 3), dint('D1'), dint('D2'), dint('D3'), int('D4'), dint('D5')],
      rungs: ['SQR(A,D1);', 'SQR(B,D2);', 'SQR(C,D3);', 'SQR(I,D4);', 'SQR(R,D5);'],
    });
    scans(c);
    expect(c.readNumber('D1')).toBe(1); // 1.732
    expect(c.readNumber('D2')).toBe(2); // 2.828
    expect(c.readNumber('D3')).toBe(9); // 9.950
    expect(c.readNumber('D4')).toBe(3); // 3.873
    expect(c.readNumber('D5')).toBe(2); // REAL source: rounded
  });

  it('NUM-2: AND/OR/XOR/MVM zero-fill a smaller integer operand when integer types are mixed', () => {
    const c = run({
      tags: [sint('S', -1), int('I', -1), dint('D1'), dint('D2'), dint('D3'), dint('D4'), dint('X')],
      rungs: ['AND(S,16#FFFF,D1);', 'OR(I,0,D2);', 'XOR(S,0,D3);', 'MVM(S,16#FFFF,D4);', 'MVM(-1,I,X);'],
    });
    scans(c);
    expect(c.readNumber('D1')).toBe(0xff);
    expect(c.readNumber('D2')).toBe(0xffff);
    expect(c.readNumber('D3')).toBe(0xff);
    expect(c.readNumber('D4')).toBe(0xff);
    expect(c.readNumber('X')).toBe(0xffff);
  });

  it('NUM-3: FFU/LFU enabled on an empty queue return 0 to Dest', () => {
    const c = run({
      tags: [arr('F', 'DINT', [5]), arr('G', 'DINT', [5]), dint('D', 77), dint('E', 88), control('C'), control('L'), bool('U')],
      rungs: ['XIC(U)FFU(F,D,C,5,0);', 'XIC(U)LFU(G,E,L,5,0);'],
    });
    scans(c);
    c.write('U', 1);
    scans(c);
    expect(c.readBool('C.EM')).toBe(true);
    expect(c.readBool('L.EM')).toBe(true);
    expect(c.readNumber('C.POS')).toBe(0);
    expect(c.readNumber('L.POS')).toBe(0);
    expect(c.readNumber('D')).toBe(0);
    expect(c.readNumber('E')).toBe(0);
  });

  it('NUM-4: FLL with an atomic Source 0 clears a structure array (TIMER[])', () => {
    const setup = { tags: [arr('T', 'TIMER', [3]), bool('Go')], rungs: ['XIC(Go)FLL(0,T[0],3);'] };
    expect(verifyErrors(setup).map((e) => e.message)).toEqual([]);
    const c = run(setup);
    c.write('T[0].PRE', 500);
    c.write('T[1].ACC', 7);
    c.write('T[2].DN', 1);
    c.write('Go', 1);
    scans(c);
    for (let i = 0; i < 3; i++) {
      expect(c.readNumber(`T[${i}].PRE`)).toBe(0);
      expect(c.readNumber(`T[${i}].ACC`)).toBe(0);
      expect(c.readBool(`T[${i}].DN`)).toBe(false);
    }
  });

  it('NUM-5: COP/FLL reject BOOL array operands at verify', () => {
    const tags = [dint('D', 0xff), arr('B', 'BOOL', [32])];
    expect(verifyErrors({ tags, rungs: ['COP(D,B[0],32);'] }).length).toBeGreaterThan(0);
    expect(verifyErrors({ tags, rungs: ['COP(B[0],D,1);'] }).length).toBeGreaterThan(0);
    expect(verifyErrors({ tags, rungs: ['FLL(1,B[0],32);'] }).length).toBeGreaterThan(0);
  });

  it('NUM-6: integer ADD sets S:C on a carry out of bit 31', () => {
    const c = run({ tags: [dint('A', -1), dint('D')], rungs: ['ADD(A,1,D);'] });
    scans(c);
    expect(c.readNumber('D')).toBe(0);
    expect(c.readNumber('S:Z')).toBe(1);
    expect(c.readNumber('S:C')).toBe(1);
  });

  it('NUM-7: CPT FRD converts 8-digit BCD values whose top digit is 8 or 9', () => {
    const c = run({
      tags: [dint('B', 0x99999999 | 0), dint('D1'), dint('D2')],
      rungs: ['CPT(D1,FRD(B));', 'CPT(D2,FRD(TOD(87654321)));'],
    });
    scans(c);
    expect(c.readNumber('D1')).toBe(99999999);
    expect(c.readNumber('D2')).toBe(87654321);
  });
});
