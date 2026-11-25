import { describe, it, expect } from 'vitest';
import { run, load, scans, bool, dint, real, timer, arr, verifyErrors, type LadderSetup } from './helpers';
import { FAULT, getInstruction, type RoutineDef } from '../index';

const rll = (name: string, ...rungs: string[]): RoutineDef => ({ name, type: 'RLL', rungs: rungs.map((text) => ({ text })) });

const errorText = (setup: LadderSetup) =>
  verifyErrors(setup)
    .map((e) => e.message)
    .join('\n');

describe('program control metadata', () => {
  it.each([
    ['JSR', 'Jump to Subroutine', true],
    ['SBR', 'Subroutine', true],
    ['RET', 'Return from Subroutine', true],
    ['JMP', 'Jump to Label', false],
    ['LBL', 'Label', false],
    ['MCR', 'Master Control Reset', false],
    ['AFI', 'Always False', false],
    ['NOP', 'No Operation', false],
  ] as const)('%s: %s', (m, title, box) => {
    const d = getInstruction(m)!;
    expect(d).toBeDefined();
    expect(d.category).toBe('Program Control');
    expect(d.title).toBe(title);
    expect(d.box).toBe(box);
  });

  it('JSR, RET, JMP and MCR are outputs; AFI is an input', () => {
    expect(getInstruction('JSR')!.kind).toBe('output');
    expect(getInstruction('RET')!.kind).toBe('output');
    expect(getInstruction('JMP')!.kind).toBe('output');
    expect(getInstruction('MCR')!.kind).toBe('output');
    expect(getInstruction('AFI')!.kind).toBe('input');
  });
});

describe('JSR / SBR / RET', () => {
  it('JSR with no parameters executes the subroutine (spaced and paren forms)', () => {
    const c = run({
      tags: [bool('A'), bool('B'), bool('C')],
      rungs: ['JSR Sub 0 ;', 'JSR(Sub2,0);'],
      routines: [rll('Sub', 'XIC A OTE B ;'), rll('Sub2', 'XIC A OTE C ;')],
    });
    scans(c);
    expect(c.readBool('B')).toBe(false);
    c.write('A', 1);
    scans(c);
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('C')).toBe(true);
  });

  it('the subroutine runs at the point of the JSR (rungs after the JSR see its results)', () => {
    const c = run({
      tags: [bool('A', 1), bool('SubOut'), bool('Before'), bool('After')],
      rungs: ['XIC SubOut OTE Before ;', 'JSR(Sub,0);', 'XIC SubOut OTE After ;'],
      routines: [rll('Sub', 'XIC A OTE SubOut ;')],
    });
    scans(c);
    expect(c.readBool('Before')).toBe(false);
    expect(c.readBool('After')).toBe(true);
    scans(c);
    expect(c.readBool('Before')).toBe(true);
  });

  it('JSR on a false rung does not execute the routine (its outputs hold their last state)', () => {
    const c = run({
      tags: [bool('En', 1), bool('A', 1), bool('B'), bool('Always')],
      rungs: ['XIC En JSR(Sub,0);'],
      routines: [rll('Sub', 'XIC A OTE B ;', 'OTE Always ;')],
    });
    scans(c);
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('Always')).toBe(true);
    c.write('En', 0);
    c.write('A', 0);
    scans(c, 3);
    // not executed -> OTE B is not false-executed
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('Always')).toBe(true);
    c.write('En', 1);
    scans(c);
    expect(c.readBool('B')).toBe(false);
  });

  it('JSR passes rung-condition-in through to the instructions after it', () => {
    const c = run({
      tags: [bool('En'), bool('After')],
      rungs: ['XIC En JSR(Sub,0) OTE After ;'],
      routines: [rll('Sub', 'NOP ;')],
    });
    scans(c);
    expect(c.readBool('After')).toBe(false);
    c.write('En', 1);
    scans(c);
    expect(c.readBool('After')).toBe(true);
  });

  it('routines that are never called are neither executed nor prescanned', () => {
    const c = run({
      tags: [bool('Set', 0), bool('Held', 1)],
      rungs: ['NOP ;'],
      routines: [rll('Orphan', 'OTE Set ;', 'XIC Set OTE Held ;')],
    });
    // not prescanned: OTE Held keeps its initial 1
    expect(c.readBool('Held')).toBe(true);
    scans(c, 3);
    expect(c.readBool('Set')).toBe(false);
    expect(c.readBool('Held')).toBe(true);
  });

  it('a JSR-called routine is prescanned (its OTEs are cleared on entering Run) even if the JSR rung is false', () => {
    const c = load({
      tags: [bool('En', 0), bool('B')],
      rungs: ['XIC En JSR(Sub,0);'],
      routines: [rll('Sub', 'OTE B ;')],
    });
    c.write('B', 1);
    expect(c.setMode('RUN')).toBeNull();
    expect(c.readBool('B')).toBe(false);
  });

  it('passes a BOOL input parameter and returns a BOOL', () => {
    const c = run({
      tags: [bool('In'), bool('Out')],
      programTags: [bool('P'), bool('Work')],
      rungs: ['JSR(Sub,1,In,Out);'],
      routines: [rll('Sub', 'SBR(P);', 'XIO P OTE Work ;', 'RET(Work);')],
    });
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
  });

  it('passes DINT input parameters and return parameters by value', () => {
    const c = run({
      tags: [dint('X', 7), dint('Y', -3), dint('R1'), dint('R2')],
      programTags: [dint('P1'), dint('P2')],
      rungs: ['JSR(Sub,2,X,Y,R1,R2);'],
      routines: [rll('Sub', 'SBR(P1,P2);', 'RET(P2,P1);')],
    });
    scans(c);
    expect(c.readNumber('R1')).toBe(-3);
    expect(c.readNumber('R2')).toBe(7);
    expect(c.readNumber('P1', 'MainProgram')).toBe(7);
    expect(c.readNumber('P2', 'MainProgram')).toBe(-3);
    // inputs are copies: the caller's tags are unchanged
    expect(c.readNumber('X')).toBe(7);
    expect(c.readNumber('Y')).toBe(-3);
  });

  it('passes REAL values', () => {
    const c = run({
      tags: [real('X', 1.25), real('R')],
      programTags: [real('P')],
      rungs: ['JSR(Sub,1,X,R);'],
      routines: [rll('Sub', 'SBR(P);', 'RET(P);')],
    });
    scans(c);
    expect(c.readNumber('R')).toBe(1.25);
  });

  it('converts between REAL and DINT parameters (round half to even)', () => {
    const c = run({
      tags: [real('X', 2.5), real('R'), dint('D', 7), real('RD'), real('X2', 3.5), dint('R3'), real('X3', -2.5), dint('R4')],
      programTags: [dint('PI'), real('PR')],
      rungs: ['JSR(ToInt,1,X,R);', 'JSR(ToReal,1,D,RD);', 'JSR(ToInt,1,X2,R3);', 'JSR(ToInt,1,X3,R4);'],
      routines: [rll('ToInt', 'SBR(PI);', 'RET(PI);'), rll('ToReal', 'SBR(PR);', 'RET(PR);')],
    });
    scans(c);
    // 2.5 -> DINT 2 -> REAL 2.0
    expect(c.readNumber('R')).toBe(2);
    expect(c.readNumber('RD')).toBe(7);
    // 3.5 -> 4 (half to even), -2.5 -> -2
    expect(c.readNumber('R3')).toBe(4);
    expect(c.readNumber('R4')).toBe(-2);
  });

  it('accepts immediate values as input and RET parameters', () => {
    const c = run({
      tags: [dint('R'), dint('R2'), dint('R3')],
      programTags: [dint('P')],
      rungs: ['JSR(Echo,1,42,R);', 'JSR(Const,0,R2);', 'JSR(ConstReal,0,R3);'],
      routines: [rll('Echo', 'SBR(P);', 'RET(P);'), rll('Const', 'RET(-17);'), rll('ConstReal', 'RET(2.5);')],
    });
    scans(c);
    expect(c.readNumber('R')).toBe(42);
    expect(c.readNumber('R2')).toBe(-17);
    expect(c.readNumber('R3')).toBe(2);
  });

  it('passes structures by value (deep copy)', () => {
    const c = run({
      tags: [{ name: 'T1', dataType: 'TIMER', value: { PRE: 1500, ACC: 200, DN: 1 } }, timer('TOut')],
      programTags: [timer('PT')],
      rungs: ['JSR(Sub,1,T1,TOut);'],
      routines: [rll('Sub', 'SBR(PT);', 'RET(PT);')],
    });
    scans(c);
    expect(c.read('TOut')).toMatchObject({ PRE: 1500, ACC: 200, DN: 1 });
    c.write('PT.ACC', 5, 'MainProgram');
    expect(c.readNumber('T1.ACC')).toBe(200);
    expect(c.readNumber('TOut.ACC')).toBe(200);
  });

  it('a subroutine that ends without executing RET leaves the return parameters untouched', () => {
    const c = run({
      tags: [dint('X', 5), dint('R', 99), bool('Now')],
      programTags: [dint('P')],
      rungs: ['JSR(Sub,1,X,R);'],
      routines: [rll('Sub', 'SBR(P);', 'XIC Now RET(P);')],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.readNumber('R')).toBe(99);
    c.write('Now', 1);
    scans(c);
    expect(c.readNumber('R')).toBe(5);
  });

  it('nested JSR (three levels) passes values down and back up', () => {
    const c = run({
      tags: [dint('X', 11), dint('R'), bool('InSub1'), bool('InSub2')],
      programTags: [dint('A1'), dint('R1'), dint('A2')],
      rungs: ['JSR(Sub1,1,X,R);'],
      routines: [
        rll('Sub1', 'SBR(A1);', 'OTE InSub1 ;', 'JSR(Sub2,1,A1,R1);', 'RET(R1);'),
        rll('Sub2', 'SBR(A2);', 'OTE InSub2 ;', 'RET(A2);'),
      ],
    });
    scans(c);
    expect(c.readBool('InSub1')).toBe(true);
    expect(c.readBool('InSub2')).toBe(true);
    expect(c.readNumber('R')).toBe(11);
    expect(c.mode).toBe('RUN');
  });

  it('RET exits the routine early: rungs after an executed RET are not scanned', () => {
    const c = run({
      tags: [bool('Early'), bool('Cond', 1), bool('B'), bool('A')],
      rungs: ['JSR(Sub,0);'],
      routines: [rll('Sub', 'OTE A ;', 'XIC Early RET();', 'XIC Cond OTE B ;')],
    });
    scans(c);
    expect(c.readBool('B')).toBe(true);
    c.write('Early', 1);
    c.write('Cond', 0);
    scans(c, 2);
    // rung 2 not executed: B keeps its state even though Cond is false
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('A')).toBe(true);
    c.write('Early', 0);
    scans(c);
    expect(c.readBool('B')).toBe(false);
  });

  it('RET in a subroutine only ends that subroutine, not the caller', () => {
    const c = run({
      tags: [bool('After')],
      rungs: ['JSR(Sub,0);', 'OTE After ;'],
      routines: [rll('Sub', 'RET();', 'NOP ;')],
    });
    scans(c);
    expect(c.readBool('After')).toBe(true);
  });

  it('a false RET does not return', () => {
    const c = run({
      tags: [bool('Early'), bool('B')],
      rungs: ['JSR(Sub,0);'],
      routines: [rll('Sub', 'XIC Early RET();', 'OTE B ;')],
    });
    scans(c);
    expect(c.readBool('B')).toBe(true);
  });

  it('the same subroutine can be called several times per scan with different parameters', () => {
    const c = run({
      tags: [dint('R1'), dint('R2')],
      programTags: [dint('P')],
      rungs: ['JSR(Echo,1,1,R1);', 'JSR(Echo,1,2,R2);'],
      routines: [rll('Echo', 'SBR(P);', 'RET(P);')],
    });
    scans(c);
    expect(c.readNumber('R1')).toBe(1);
    expect(c.readNumber('R2')).toBe(2);
  });

  it('after the subroutine returns, a fault in the caller is reported in the caller routine', () => {
    const c = run({
      tags: [arr('Bits', 'BOOL', [32]), dint('Idx', 0), bool('X')],
      rungs: ['JSR(Sub,0);', 'XIC Bits[Idx] OTE X ;'],
      routines: [rll('Sub', 'NOP ;', 'NOP ;', 'NOP ;', 'NOP ;')],
    });
    scans(c);
    c.write('Idx', 32);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, program: 'MainProgram', routine: 'MainRoutine', rung: 1, instruction: 'XIC' });
  });

  it('a fault inside a subroutine is reported in that subroutine', () => {
    const c = run({
      tags: [arr('Bits', 'BOOL', [32]), dint('Idx', -1), bool('X')],
      rungs: ['NOP ;', 'JSR(Sub,0);'],
      routines: [rll('Sub', 'NOP ;', 'NOP ;', 'XIC Bits[Idx] OTE X ;')],
    });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, program: 'MainProgram', routine: 'Sub', rung: 2, element: 0, instruction: 'XIC' });
  });
});

describe('JSR / SBR / RET verify and runtime errors', () => {
  it('JSR to a routine that does not exist is a verify error', () => {
    expect(errorText({ rungs: ['JSR(Missing,0);'] })).toMatch(/Routine 'Missing' does not exist/);
  });

  it('JSR without the input parameter count is a verify error', () => {
    expect(errorText({ rungs: ['JSR(Sub);'], routines: [rll('Sub', 'NOP ;')] })).toMatch(/JSR/);
  });

  it('JSR input count larger than the parameters given is a verify error', () => {
    expect(errorText({ tags: [dint('X')], rungs: ['JSR(Sub,2,X);'], routines: [rll('Sub', 'SBR(P1,P2);')], programTags: [dint('P1'), dint('P2')] })).toMatch(
      /Input parameter count 2/,
    );
  });

  it('JSR input parameter count different from the SBR parameter count is a verify error', () => {
    const base = { tags: [dint('X'), dint('Y')], programTags: [dint('P1'), dint('P2')] };
    const e1 = verifyErrors({ ...base, rungs: ['JSR(Sub,1,X);'], routines: [rll('Sub', 'SBR(P1,P2);')] });
    expect(e1.map((e) => e.message).join('\n')).toMatch(/passes 1 input parameter\(s\) but SBR in 'Sub' has 2/);
    expect(e1[0]).toMatchObject({ program: 'MainProgram', routine: 'MainRoutine', rung: 0 });
    expect(errorText({ ...base, rungs: ['JSR(Sub,2,X,Y);'], routines: [rll('Sub', 'SBR(P1);')] })).toMatch(/passes 2 input/);
    expect(errorText({ ...base, rungs: ['JSR(Sub,0);'], routines: [rll('Sub', 'SBR(P1);')] })).toMatch(/passes 0 input/);
    // input parameters but no SBR to receive them
    expect(errorText({ ...base, rungs: ['JSR(Sub,1,X);'], routines: [rll('Sub', 'NOP ;')] })).toMatch(/no SBR instruction/);
    // the check also applies inside branches and in subroutines calling subroutines
    expect(errorText({ ...base, rungs: ['[JSR(Sub,1,X) ,NOP ] ;'], routines: [rll('Sub', 'SBR(P1,P2);')] })).toMatch(/passes 1 input/);
    expect(errorText({ ...base, rungs: ['JSR(Sub,0);'], routines: [rll('Sub', 'JSR(Sub2,1,X);'), rll('Sub2', 'SBR(P1,P2);')] })).toMatch(/passes 1 input/);
  });

  it('SBR must be the first instruction of the first rung', () => {
    expect(errorText({ programTags: [dint('P')], rungs: ['JSR(Sub,0);'], routines: [rll('Sub', 'NOP ;', 'SBR(P);')] })).toMatch(/SBR must be the first/);
    expect(errorText({ programTags: [dint('P')], tags: [bool('A')], rungs: ['JSR(Sub,0);'], routines: [rll('Sub', 'XIC A SBR(P);')] })).toMatch(/SBR must be the first/);
  });

  it('JSR return parameters must be writable tags', () => {
    expect(errorText({ rungs: ['JSR(Sub,0,5);'], routines: [rll('Sub', 'RET(1);')] })).toMatch(/Immediate value not allowed/);
  });

  it('a RET that returns a different number of values than the JSR expects faults at run time (Type 4 Code 31)', () => {
    const c = run({
      tags: [dint('R1'), dint('A', 1), dint('B', 2)],
      rungs: ['JSR(Sub,0,R1);'],
      routines: [rll('Sub', 'RET(A,B);')],
    });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: FAULT.JSR_PARAMS.type, code: FAULT.JSR_PARAMS.code });
  });

  it('a RET with no values for a JSR that expects a return value faults', () => {
    const c = run({ tags: [dint('R1')], rungs: ['JSR(Sub,0,R1);'], routines: [rll('Sub', 'RET();')] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 31 });
  });

  it('passing a structure into an atomic SBR parameter faults at run time (Type 4 Code 31)', () => {
    const c = run({
      tags: [timer('T1')],
      programTags: [dint('P')],
      rungs: ['JSR(Sub,1,T1);'],
      routines: [rll('Sub', 'SBR(P);')],
    });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 31, routine: 'Sub' });
  });

  it('returning an atomic value into a structure return parameter faults at run time', () => {
    const c = run({ tags: [timer('T1'), dint('A', 3)], rungs: ['JSR(Sub,0,T1);'], routines: [rll('Sub', 'RET(A);')] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 31 });
  });

  it('unbounded recursion hits the nesting limit and faults (does not hang prescan or the scan)', () => {
    const c = run({ tags: [bool('Go', 1)], rungs: ['JSR(Sub,0);'], routines: [rll('Sub', 'XIC Go JSR(Sub,0);')] });
    // prescan of a recursive routine terminates
    expect(c.mode).toBe('RUN');
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: FAULT.NESTING.type, code: FAULT.NESTING.code, routine: 'Sub' });
  });

  it('mutual recursion also faults', () => {
    const c = run({ rungs: ['JSR(A1,0);'], routines: [rll('A1', 'JSR(B1,0);'), rll('B1', 'JSR(A1,0);')] });
    expect(c.mode).toBe('RUN');
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault!.type).toBe(4);
  });

  it('bounded recursion below the limit is allowed', () => {
    // Sub calls itself while Bits[k] chain lets it; depth 5
    const c = run({
      tags: [arr('Lvl', 'BOOL', [32])],
      rungs: ['JSR(Sub,0);'],
      routines: [
        rll(
          'Sub',
          'XIC Lvl[3] OTL Lvl[4] ;',
          'XIC Lvl[2] OTL Lvl[3] ;',
          'XIC Lvl[1] OTL Lvl[2] ;',
          'XIC Lvl[0] OTL Lvl[1] ;',
          'OTL Lvl[0] ;',
          'XIO Lvl[4] JSR(Sub,0);',
        ),
      ],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    expect(c.readBool('Lvl[4]')).toBe(true);
  });
});

describe('JMP / LBL', () => {
  it('a true JMP skips forward to the label; skipped rungs keep their outputs as they were', () => {
    const c = run({
      tags: [bool('Skip'), bool('A', 1), bool('B'), bool('C', 1), bool('D'), bool('E')],
      rungs: ['XIC Skip JMP(Over);', 'XIC A OTE B ;', 'XIC A OTE E ;', 'LBL(Over) XIC C OTE D ;'],
    });
    scans(c);
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('E')).toBe(true);
    expect(c.readBool('D')).toBe(true);
    c.write('Skip', 1);
    c.write('A', 0);
    c.write('C', 0);
    scans(c, 2);
    // rungs 1-2 skipped: OTE not false-executed
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('E')).toBe(true);
    // the label rung itself executes
    expect(c.readBool('D')).toBe(false);
    c.write('Skip', 0);
    scans(c);
    expect(c.readBool('B')).toBe(false);
  });

  it('skipped rungs are not evaluated at all (no fault from a bad subscript)', () => {
    const c = run({
      tags: [bool('Skip', 1), arr('Bits', 'BOOL', [32]), dint('Idx', 100), bool('X')],
      rungs: ['XIC Skip JMP(Over);', 'XIC Bits[Idx] OTE X ;', 'LBL(Over) NOP ;'],
    });
    scans(c, 2);
    expect(c.mode).toBe('RUN');
    c.write('Skip', 0);
    scans(c);
    expect(c.mode).toBe('FAULTED');
  });

  it('the rest of the JMP rung still executes and labels are case-insensitive', () => {
    const c = run({
      tags: [bool('Skip', 1), bool('Also'), bool('B')],
      rungs: ['XIC Skip [JMP(over) ,OTE Also ] ;', 'OTE B ;', 'LBL(OVER) NOP ;'],
    });
    scans(c);
    expect(c.readBool('Also')).toBe(true);
    expect(c.readBool('B')).toBe(false);
  });

  it('a backward JMP re-executes rungs within the same scan', () => {
    const c = run({
      tags: [bool('Pass1'), bool('Pass2')],
      rungs: ['LBL(Top) XIC Pass1 OTL Pass2 ;', 'OTL Pass1 ;', 'XIO Pass2 JMP(Top);'],
    });
    scans(c);
    // without the backward jump Pass2 would only be set on the second scan
    expect(c.readBool('Pass2')).toBe(true);
    expect(c.mode).toBe('RUN');
  });

  it('an endless backward JMP loop trips the task watchdog (Type 6 Code 1)', () => {
    const c = run({ tags: [bool('X')], rungs: ['LBL(Loop) OTE X ;', 'JMP(Loop);'] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 6, code: 1, task: 'MainTask', program: 'MainProgram', major: true });
  });

  it('an endless JMP loop inside a subroutine also trips the watchdog', () => {
    const c = run({ rungs: ['JSR(Sub,0);'], routines: [rll('Sub', 'LBL(L1) NOP ;', 'JMP(L1);')] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 6, code: 1, routine: 'Sub' });
  });

  it('labels are local to a routine', () => {
    const c = run({
      tags: [bool('B'), bool('C')],
      rungs: ['JSR(Sub,0);', 'OTE B ;', 'LBL(Here) NOP ;'],
      routines: [rll('Sub', 'JMP(Here);', 'OTE C ;', 'LBL(Here) NOP ;')],
    });
    scans(c);
    expect(c.readBool('C')).toBe(false);
    expect(c.readBool('B')).toBe(true);
  });

  it('JMP to a missing label is a verify error', () => {
    const errs = verifyErrors({ tags: [bool('A')], rungs: ['XIC A JMP(Nowhere);', 'OTE A ;'] });
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/label 'Nowhere' does not exist/i);
    expect(errs[0]).toMatchObject({ rung: 0, element: 1 });
  });

  it('JMP to a label in another routine is a verify error', () => {
    expect(errorText({ rungs: ['JMP(There);', 'JSR(Sub,0);'], routines: [rll('Sub', 'LBL(There) NOP ;')] })).toMatch(/label 'There' does not exist/i);
  });

  it('duplicate labels in a routine are a verify error', () => {
    const errs = verifyErrors({ tags: [bool('A'), bool('B')], rungs: ['LBL(X) OTE A ;', 'LBL(x) OTE B ;'] });
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/already used/);
    expect(errs[0].rung).toBe(1);
  });

  it('the same label name in two routines is allowed', () => {
    expect(verifyErrors({ rungs: ['LBL(X) JSR(Sub,0);'], routines: [rll('Sub', 'LBL(X) NOP ;')] })).toEqual([]);
  });

  it('LBL must be the first instruction of the rung', () => {
    const errs = verifyErrors({ tags: [bool('A'), bool('B')], rungs: ['XIC A LBL(X) OTE B ;'] });
    expect(errs.map((e) => e.message).join('\n')).toMatch(/LBL must be the first instruction/);
    expect(errorText({ tags: [bool('A'), bool('B')], rungs: ['[LBL(X) ,XIC A ] OTE B ;'] })).toMatch(/LBL must be the first instruction/);
  });

  it('an invalid label name is a verify error', () => {
    expect(errorText({ rungs: ['JMP(1abc);', 'LBL(1abc) NOP ;'] })).toMatch(/invalid characters|Label/);
  });
});

describe('MCR', () => {
  const setup = (zone: number): LadderSetup => ({
    tags: [bool('Zone', zone), bool('A', 1), bool('B'), bool('L'), bool('After'), bool('Rco')],
    rungs: ['XIC Zone MCR ;', 'XIC A OTE B ;', 'XIC A OTL L ;', 'MCR ;', 'XIC A OTE After ;'],
  });

  it('a true MCR zone runs normally', () => {
    const c = run(setup(1));
    scans(c);
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('L')).toBe(true);
    expect(c.readBool('After')).toBe(true);
  });

  it('a false MCR zone forces OTE outputs off but leaves OTL bits alone', () => {
    const c = run(setup(0));
    c.write('B', 1);
    scans(c);
    expect(c.readBool('B')).toBe(false);
    // rung-condition false: OTL does not latch
    expect(c.readBool('L')).toBe(false);
    // rungs after the ending MCR are unaffected
    expect(c.readBool('After')).toBe(true);

    c.write('Zone', 1);
    scans(c);
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('L')).toBe(true);

    c.write('Zone', 0);
    scans(c);
    expect(c.readBool('B')).toBe(false);
    // a latched bit stays latched in a false zone
    expect(c.readBool('L')).toBe(true);
  });

  it('rungs inside a false zone are scanned with a false rung-condition-in', () => {
    const c = run(setup(0));
    scans(c);
    const st = c.ladderState('MainProgram', 'MainRoutine')!;
    expect([...st.rungIn]).toEqual([1, 0, 0, 0, 1]);
    c.write('Zone', 1);
    scans(c);
    expect([...st.rungIn]).toEqual([1, 1, 1, 1, 1]);
  });

  it('a JSR inside a false zone does not call the subroutine', () => {
    const c = run({
      tags: [bool('Zone', 0), bool('SubRan')],
      rungs: ['XIC Zone MCR ;', 'JSR(Sub,0);', 'MCR ;'],
      routines: [rll('Sub', 'OTL SubRan ;')],
    });
    scans(c);
    expect(c.readBool('SubRan')).toBe(false);
    c.write('Zone', 1);
    scans(c);
    expect(c.readBool('SubRan')).toBe(true);
  });

  it('a zone without an ending MCR extends to the end of the routine and does not leak into the next scan', () => {
    const c = run({
      tags: [bool('Zone', 0), bool('B'), bool('First')],
      rungs: ['OTE First ;', 'XIC Zone MCR ;', 'OTE B ;'],
    });
    scans(c);
    expect(c.readBool('B')).toBe(false);
    expect(c.readBool('First')).toBe(true);
    scans(c);
    expect(c.readBool('First')).toBe(true);
  });

  it('a false zone in a subroutine does not affect the caller after the JSR', () => {
    const c = run({
      tags: [bool('Zone', 0), bool('After')],
      rungs: ['JSR(Sub,0);', 'OTE After ;'],
      routines: [rll('Sub', 'XIC Zone MCR ;', 'NOP ;')],
    });
    scans(c);
    expect(c.readBool('After')).toBe(true);
  });
});

describe('AFI / NOP', () => {
  it('AFI disables a rung (its OTEs are false-executed)', () => {
    const c = run({ tags: [bool('A', 1), bool('B')], rungs: ['AFI XIC A OTE B ;'] });
    c.write('B', 1);
    scans(c);
    expect(c.readBool('B')).toBe(false);
  });

  it('AFI on one leg of a branch only disables that leg', () => {
    const c = run({ tags: [bool('A'), bool('B')], rungs: ['[AFI ,XIC A ] OTE B ;'] });
    scans(c);
    expect(c.readBool('B')).toBe(false);
    c.write('A', 1);
    scans(c);
    expect(c.readBool('B')).toBe(true);
  });

  it('AFI() paren form', () => {
    const c = run({ tags: [bool('B')], rungs: ['AFI()OTE(B);'] });
    scans(c);
    expect(c.readBool('B')).toBe(false);
  });

  it('NOP passes rung-condition-in', () => {
    const c = run({ tags: [bool('A'), bool('B'), bool('C')], rungs: ['NOP OTE B ;', 'XIC A NOP OTE C ;', 'NOP ;'] });
    scans(c);
    expect(c.readBool('B')).toBe(true);
    expect(c.readBool('C')).toBe(false);
    c.write('A', 1);
    scans(c);
    expect(c.readBool('C')).toBe(true);
  });
});
