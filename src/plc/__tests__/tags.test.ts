/**
 * Tag database and operand references: scopes, names, arrays, bit access,
 * UDTs, aliases, status flags, constants - both through the Controller and
 * directly through TagDatabase + compileRef.
 */
import { describe, it, expect } from 'vitest';
import { run, load, scans, verifyErrors, bool, dint, sint, int, real, arr, timer, type LadderSetup } from './helpers';
import {
  Runtime,
  TagDatabase,
  TypeRegistry,
  Scope,
  compileRef,
  isRefError,
  compileExpr,
  parseTagPath,
  validateName,
  walkRung,
  parseRung,
  PlcMajorFault,
  FAULT,
  DINT_MIN,
  DINT_MAX,
  MAX_NAME_LENGTH,
  type TagDef,
  type TagProblem,
  type Ref,
  type AtomicRef,
  type RefResult,
  type ModuleDef,
  type UDTDef,
  type StructValue,
} from '../index';
import type { RefCompileEnv } from '../core/refs';

// ----------------------------------------------------------------------------- direct helpers

interface Db {
  rt: Runtime;
  db: TagDatabase;
  problems: TagProblem[];
  add(def: TagDef, scope?: Scope): ReturnType<TagDatabase['createTag']>;
  resolve(text: string, scope?: Scope): RefResult;
  ref(text: string, scope?: Scope): Ref;
  atomic(text: string, scope?: Scope): AtomicRef;
  err(text: string, scope?: Scope): string;
}

function makeDb(udts: UDTDef[] = []): Db {
  const rt = new Runtime();
  const db = new TagDatabase(rt);
  const udtErrors = db.types.defineUDTs(udts);
  if (udtErrors.length) throw new Error(udtErrors.join('\n'));
  const problems: TagProblem[] = [];
  const resolve = (text: string, scope: Scope = db.controller): RefResult => {
    const errors: string[] = [];
    const env: RefCompileEnv = {
      rt,
      compileIndex: (e) => {
        const n = errors.length;
        const ce = compileExpr(e, { rt, resolve: (p, t) => compileRef(scope, p, t, env), error: (m) => errors.push(m) });
        if (errors.length > n || ce.cls === 'REAL') return null;
        return ce.eval;
      },
    };
    return compileRef(scope, parseTagPath(text), text, env);
  };
  const ref = (text: string, scope?: Scope): Ref => {
    const r = resolve(text, scope);
    if (isRefError(r)) throw new Error(r.error);
    return r;
  };
  return {
    rt,
    db,
    problems,
    add: (def, scope = db.controller) => db.createTag(scope, def, problems),
    resolve,
    ref,
    atomic(text, scope) {
      const r = ref(text, scope);
      if (r.kind !== 'atomic') throw new Error(`${text} is not atomic`);
      return r;
    },
    err(text, scope) {
      const r = resolve(text, scope);
      if (!isRefError(r)) throw new Error(`expected '${text}' to fail`);
      return r.error;
    },
  };
}

function value(d: Db, name: string, scope?: Scope): unknown {
  return (scope ?? d.db.controller).own(name)!.holder.value;
}

/** Run fn and return the PlcMajorFault it throws. */
function majorFault(fn: () => unknown): PlcMajorFault {
  try {
    fn();
  } catch (e) {
    if (e instanceof PlcMajorFault) return e;
    throw e;
  }
  throw new Error('expected a major fault');
}

const messages = (setup: LadderSetup) => verifyErrors(setup).map((e) => e.message);
const allMessages = (setup: LadderSetup) => messages(setup).join('\n');

const IQ16: ModuleDef = { slot: 1, catalog: 'LX-IQ16' };

const MOTOR_UDTS: UDTDef[] = [
  // Line is defined before Motor on purpose (forward reference)
  {
    name: 'Line',
    description: 'A conveyor line',
    members: [
      { name: 'M', dataType: 'Motor', dims: [2] },
      { name: 'Count', dataType: 'DINT' },
    ],
  },
  {
    name: 'Motor',
    members: [
      { name: 'Run', dataType: 'BOOL' },
      { name: 'Speed', dataType: 'REAL' },
      { name: 'Faults', dataType: 'DINT', dims: [4] },
      { name: 'Tmr', dataType: 'TIMER' },
    ],
  },
];

// ============================================================================ names

describe('tag names', () => {
  it.each(['1Abc', '9', 'A__B', 'Abc_', '_', 'AND', 'and', 'Not', 'MOD', 'if', 'END_IF', 'TRUE', 'false', 'A-B', 'A B', 'A.B', 'Tag$', 'Ä', '', 'A'.repeat(41)])(
    'rejects %j',
    (name) => {
      expect(validateName(name, 'Tag name')).not.toBeNull();
      const d = makeDb();
      expect(d.add({ name, dataType: 'DINT' })).toBeNull();
      expect(d.problems).toHaveLength(1);
      expect(d.db.controller.tags.size).toBe(0);
    },
  );

  it.each(['A', 'a1_b2', '_Start', '_1', 'Motor_1_Run', 'A'.repeat(40), 'Andy', 'Iffy', 'NOTE', 'Timer', 'DINT'])('accepts %j', (name) => {
    expect(validateName(name)).toBeNull();
    const d = makeDb();
    expect(d.add({ name, dataType: 'DINT' })).not.toBeNull();
    expect(d.problems).toEqual([]);
  });

  it('limits names to 40 characters', () => {
    expect(MAX_NAME_LENGTH).toBe(40);
    expect(validateName('A'.repeat(41))).toMatch(/longer than 40/);
  });

  it('gives specific messages', () => {
    expect(validateName('1Abc', 'Tag name')).toMatch(/Tag name '1Abc' contains invalid characters/);
    expect(validateName('A__B')).toMatch(/consecutive underscores/);
    expect(validateName('Abc_')).toMatch(/end with an underscore/);
    expect(validateName('XOR')).toMatch(/reserved word/);
    expect(validateName('')).toMatch(/empty/);
  });

  it('invalid tag names are verify errors', () => {
    const m = allMessages({ tags: [dint('2Fast'), dint('Bad__Name'), dint('Trailing_'), dint('OR')], rungs: [] });
    expect(m).toMatch(/'2Fast'/);
    expect(m).toMatch(/'Bad__Name'/);
    expect(m).toMatch(/'Trailing_'/);
    expect(m).toMatch(/'OR' is a reserved word/);
  });
});

// ============================================================================ scopes

describe('controller and program scope', () => {
  it('names are case-insensitive and case-preserving', () => {
    const d = makeDb();
    d.add({ name: 'MotorRun', dataType: 'BOOL' });
    d.add(timer('MyTmr'));
    expect(d.db.controller.lookup('MOTORRUN')!.name).toBe('MotorRun');
    expect(d.db.controller.own('motorrun')!.key).toBe('motorrun');
    expect(d.atomic('motorRUN').canonical).toBe('MotorRun');
    expect(d.atomic('mytmr.acc').canonical).toBe('MyTmr.ACC');
    expect(d.atomic('MYTMR.dn').canonical).toBe('MyTmr.DN');
  });

  it('duplicate names in one scope are rejected case-insensitively; the first tag is kept', () => {
    const d = makeDb();
    expect(d.add(dint('Count'))).not.toBeNull();
    expect(d.add({ name: 'COUNT', dataType: 'REAL' })).toBeNull();
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0].message).toMatch(/Duplicate tag 'COUNT'/);
    expect(d.db.controller.own('count')!.type!.name).toBe('DINT');
  });

  it('a program tag may reuse a controller tag name and shadows it in that program', () => {
    const d = makeDb();
    const p = d.db.addProgramScope('Prog');
    d.add(dint('X', 1));
    d.add(dint('Y', 2));
    d.add(dint('X', 10), p);
    expect(d.problems).toEqual([]);
    expect(d.atomic('X', p).get()).toBe(10);
    expect(d.atomic('X').get()).toBe(1);
    // names not defined in the program fall back to the controller scope
    expect(d.atomic('y', p).get()).toBe(2);
    expect(d.atomic('Y', p).tag!.scope.kind).toBe('controller');
    // another program does not see Prog's tags
    const q = d.db.addProgramScope('Other');
    expect(d.atomic('X', q).get()).toBe(1);
  });

  it('duplicates inside a program scope are rejected', () => {
    const d = makeDb();
    const p = d.db.addProgramScope('Prog');
    d.add(dint('A'), p);
    expect(d.add(dint('a'), p)).toBeNull();
    expect(d.problems[0]).toMatchObject({ scope: 'Prog', tag: 'a' });
  });

  it('scope() resolves program names case-insensitively and throws for unknown programs', () => {
    const d = makeDb();
    const p = d.db.addProgramScope('MainProgram');
    expect(d.db.scope('mainprogram')).toBe(p);
    expect(d.db.scope()).toBe(d.db.controller);
    expect(d.db.addProgramScope('MAINPROGRAM')).toBe(p);
    expect(() => d.db.scope('Nope')).toThrow(/Unknown program/);
  });

  it('at run time a program tag shadows the controller tag of the same name', () => {
    const c = run({
      tags: [bool('In'), bool('X')],
      programTags: [bool('X')],
      rungs: ['XIC In OTE X ;'],
    });
    c.write('In', 1);
    scans(c);
    expect(c.readBool('X', 'MainProgram')).toBe(true);
    expect(c.readBool('X')).toBe(false);
  });

  it('operands in rungs are case-insensitive', () => {
    const c = run({ tags: [bool('StartPB'), bool('MotorRun')], rungs: ['xic startpb ote MOTORRUN ;'] });
    c.write('STARTPB', true);
    scans(c);
    expect(c.readBool('motorrun')).toBe(true);
    expect(c.compiledProject!.db.controller.own('MOTORRUN')!.name).toBe('MotorRun');
  });

  it('duplicate tags and undefined types are verify errors; download is blocked', () => {
    const setup: LadderSetup = { tags: [bool('A'), bool('a'), { name: 'B', dataType: 'NOTYPE' }], rungs: ['XIC A OTE A ;'] };
    const m = allMessages(setup);
    expect(m).toMatch(/Duplicate tag 'a'/);
    expect(m).toMatch(/Undefined data type 'NOTYPE'/);
    expect(() => load(setup)).toThrow(/Download failed/);
  });

  it('initial value problems are reported for the tag', () => {
    const m = allMessages({ tags: [{ name: 'T1', dataType: 'TIMER', value: { PRE: 5, Bogus: 1 } }], rungs: [] });
    expect(m).toMatch(/Tag 'T1'.*TIMER has no member 'Bogus'/);
  });
});

// ============================================================================ arrays

describe('arrays', () => {
  it('dimensions 1..3 are accepted; more than 3 and non-positive sizes are rejected', () => {
    const d = makeDb();
    expect(d.add(arr('A1', 'DINT', [5]))).not.toBeNull();
    expect(d.add(arr('A2', 'DINT', [3, 5]))).not.toBeNull();
    expect(d.add(arr('A3', 'DINT', [2, 3, 4]))).not.toBeNull();
    expect(d.problems).toEqual([]);
    expect(d.add(arr('A4', 'DINT', [2, 2, 2, 2]))).toBeNull();
    expect(d.add(arr('Z', 'DINT', [0]))).toBeNull();
    expect(d.add(arr('N', 'DINT', [-1]))).toBeNull();
    expect(d.add(arr('F', 'DINT', [2.5]))).toBeNull();
    expect(d.problems.map((p) => p.message)).toEqual([
      'Arrays support at most 3 dimensions',
      'Array dimensions must be positive integers',
      'Array dimensions must be positive integers',
      'Array dimensions must be positive integers',
    ]);
  });

  it('> 3 dimensions is a verify error', () => {
    expect(allMessages({ tags: [arr('A4', 'BOOL', [2, 2, 2, 2])], rungs: [] })).toMatch(/at most 3 dimensions/);
  });

  it('multi-dimensional subscripts are row-major: Arr[1,2,3] of [2,3,4] is flat index 23', () => {
    const d = makeDb();
    d.add(arr('A3', 'DINT', [2, 3, 4]));
    d.add(arr('A2', 'DINT', [3, 5]));
    const r = d.atomic('A3[1,2,3]');
    r.set(7);
    expect((value(d, 'A3') as number[])[23]).toBe(7);
    expect(r.element!.index()).toBe(23);
    expect(r.element!.length).toBe(24);
    d.atomic('A3[0,1,2]').set(5);
    expect((value(d, 'A3') as number[])[6]).toBe(5);
    d.atomic('A2[1,0]').set(9);
    expect((value(d, 'A2') as number[])[5]).toBe(9);
    d.atomic('A2[2,4]').set(3);
    expect((value(d, 'A2') as number[])[14]).toBe(3);
  });

  it('a whole array is an array reference', () => {
    const d = makeDb();
    d.add(arr('A3', 'DINT', [2, 3, 4]));
    const r = d.ref('A3');
    expect(r.kind).toBe('array');
    if (r.kind === 'array') expect(r.length).toBe(24);
    expect(r.info.dims).toEqual([2, 3, 4]);
  });

  it.each([
    ['Arr[4]', /subscript 4 is out of range \(0\.\.3\)/],
    ['Arr[-1]', /subscript -1 is out of range/],
    ['A3[2,0,0]', /out of range \(0\.\.1\)/],
    ['A3[0,3,0]', /out of range \(0\.\.2\)/],
    ['A3[0,0,4]', /out of range \(0\.\.3\)/],
  ])('constant subscript %s out of range is a compile error', (text, re) => {
    const d = makeDb();
    d.add(arr('Arr', 'DINT', [4]));
    d.add(arr('A3', 'DINT', [2, 3, 4]));
    expect(d.err(text)).toMatch(re);
  });

  it('a constant subscript out of range is a verify error and blocks download', () => {
    const setup: LadderSetup = { tags: [arr('Flags', 'BOOL', [4]), bool('Out')], rungs: ['XIC Flags[4] OTE Out ;'] };
    expect(allMessages(setup)).toMatch(/Rung 0, XIC, Operand 0: 'Flags\[4\]': array subscript 4 is out of range \(0\.\.3\)/);
    expect(() => load(setup)).toThrow(/Download failed/);
  });

  it('a constant subscript out of range is a verify error even when mixed with a tag subscript', () => {
    // Arr[5,Idx]: the first subscript is a constant and can never be valid for DINT[3,5]
    const setup: LadderSetup = { tags: [arr('A2', 'DINT', [3, 5]), dint('Idx'), bool('Out')], rungs: ['XIC A2[5,Idx].0 OTE Out ;'] };
    expect(allMessages(setup)).toMatch(/out of range/);
  });

  it('subscript count must match the dimensions', () => {
    const d = makeDb();
    d.add(arr('Arr', 'DINT', [4]));
    d.add(arr('A2', 'DINT', [3, 5]));
    d.add(dint('D'));
    expect(d.err('Arr[1,2]')).toMatch(/expected 1 subscript\(s\), found 2/);
    expect(d.err('A2[1]')).toMatch(/expected 2 subscript\(s\), found 1/);
    expect(d.err('D[0]')).toMatch(/DINT is not an array/);
  });

  it('a REAL subscript is rejected', () => {
    const d = makeDb();
    d.add(arr('Arr', 'DINT', [4]));
    d.add(real('R'));
    expect(d.err('Arr[1.0]')).toMatch(/must be an integer/);
    expect(allMessages({ tags: [arr('Flags', 'BOOL', [4]), real('R'), bool('Out')], rungs: ['XIC Flags[R] OTE Out ;'] })).toMatch(/integer/);
  });

  it('dynamic subscripts follow the index tag at run time', () => {
    const d = makeDb();
    d.add(arr('Arr', 'DINT', [4], [10, 11, 12, 13]));
    d.add(dint('Idx', 2));
    const r = d.atomic('Arr[Idx]');
    expect(r.isStatic).toBe(false);
    expect(r.get()).toBe(12);
    d.atomic('Idx').set(0);
    expect(r.get()).toBe(10);
    r.set(99);
    expect(value(d, 'Arr')).toEqual([99, 11, 12, 13]);
    expect(r.element!.index()).toBe(0);
  });

  it('expression subscripts Arr[Idx+1] and Arr[Idx*2-1]', () => {
    const d = makeDb();
    d.add(arr('Arr', 'DINT', [4], [10, 11, 12, 13]));
    d.add(dint('Idx', 1));
    expect(d.atomic('Arr[Idx+1]').get()).toBe(12);
    expect(d.atomic('Arr[Idx*2-1]').get()).toBe(11);
    expect(d.atomic('Arr[Idx + Idx + 1]').get()).toBe(13);
  });

  it('dynamic subscript out of range -> major fault type 4 code 20', () => {
    const d = makeDb();
    d.add(arr('Arr', 'DINT', [4]));
    d.add(dint('Idx', 4));
    const r = d.atomic('Arr[Idx]');
    const f = majorFault(() => r.get());
    expect([f.type, f.code]).toEqual([4, 20]);
    d.atomic('Idx').set(-1);
    expect(majorFault(() => r.set(1)).code).toBe(20);
    expect(FAULT.ARRAY_SUBSCRIPT).toMatchObject({ type: 4, code: 20 });
  });

  it('each dimension is bounds-checked separately (A2[0,5] of [3,5] faults although flat 5 exists)', () => {
    const d = makeDb();
    d.add(arr('A2', 'DINT', [3, 5]));
    d.add(dint('I', 0));
    d.add(dint('J', 5));
    const r = d.atomic('A2[I,J]');
    expect(majorFault(() => r.get()).code).toBe(20);
    d.atomic('J').set(4);
    d.atomic('I').set(2);
    r.set(8);
    expect((value(d, 'A2') as number[])[14]).toBe(8);
    const mixed = d.atomic('A2[1,J]');
    expect(mixed.get()).toBe(0);
    d.atomic('J').set(-1);
    expect(majorFault(() => mixed.get()).code).toBe(20);
  });

  it('BOOL arrays hold BOOL elements', () => {
    const d = makeDb();
    d.add(arr('Flags', 'BOOL', [32]));
    const r = d.atomic('Flags[5]');
    expect(r.atype).toBe('BOOL');
    r.set(7);
    expect((value(d, 'Flags') as number[])[5]).toBe(1);
    expect(d.err('Flags[5].0')).toMatch(/bit access requires a SINT, INT or DINT \(found BOOL\)/);
  });
});

describe('arrays at run time', () => {
  it('Arr[Idx] moves with the index tag', () => {
    const c = run({ tags: [arr('Flags', 'BOOL', [4], [0, 0, 1, 0]), dint('Idx'), bool('Out')], rungs: ['XIC Flags[Idx] OTE Out ;'] });
    scans(c);
    expect(c.readBool('Out')).toBe(false);
    c.write('Idx', 2);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    expect(c.mode).toBe('RUN');
  });

  it('expression subscript Flags[Idx+1] at run time', () => {
    const c = run({ tags: [arr('Flags', 'BOOL', [4], [0, 0, 0, 1]), dint('Idx', 2), bool('Out')], rungs: ['XIC Flags[Idx+1] OTE Out ;'] });
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    c.write('Idx', 3);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20 });
  });

  it('dynamic subscript out of range faults the controller with type 4 code 20 and the location', () => {
    const rung1 = 'XIC Go [XIC Flags[Idx] ,XIC Spare ] OTE Out ;';
    const c = run({
      tags: [arr('Flags', 'BOOL', [4]), dint('Idx', 1), bool('Go', 1), bool('Spare'), bool('Out'), bool('Other')],
      rungs: ['XIC Go OTE Other ;', rung1],
    });
    scans(c);
    expect(c.mode).toBe('RUN');
    c.write('Idx', 4);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    const f = c.majorFault!;
    expect(f).toMatchObject({ type: 4, code: 20, major: true, task: 'MainTask', program: 'MainProgram', routine: 'MainRoutine', rung: 1, element: 2, instruction: 'XIC' });
    expect(f.message).toMatch(/Array subscript/);
    // the faulting element id is the pre-order id walkRung assigns
    const ids: string[] = [];
    walkRung(parseRung(rung1).elements, (el, info) => {
      if (info.id === f.element && el.kind === 'instr') ids.push(`${el.mnemonic} ${el.operands[0]}`);
    });
    expect(ids).toEqual(['XIC Flags[Idx]']);
    expect(c.faultLog).toHaveLength(1);
    // no more scanning while faulted
    c.write('Idx', 0);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.setMode('RUN')).toMatch(/Clear the major fault/);
    c.clearFault();
    expect(c.mode).toBe('PROGRAM');
    expect(c.majorFault).toBeNull();
  });

  it('a negative dynamic subscript faults too', () => {
    const c = run({ tags: [arr('Flags', 'BOOL', [4]), dint('Idx', -1), bool('Out')], rungs: ['XIC Flags[Idx] OTE Out ;'] });
    scans(c);
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, rung: 0, element: 0 });
  });

  it('an OTE with a false rung still writes its element, so a bad subscript faults', () => {
    const c = run({ tags: [arr('Flags', 'BOOL', [4]), dint('Idx', 1), bool('In')], rungs: ['XIC In OTE Flags[Idx] ;'] });
    scans(c);
    expect(c.mode).toBe('RUN');
    c.write('Idx', 9);
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, task: 'MainTask', rung: 0, element: 1, instruction: 'OTE' });
  });

  it('a bad subscript met during prescan faults on going to Run, with the rung/element location', () => {
    // prescan clears the OTE's bit, which needs Flags[Idx]
    const c = load({ tags: [arr('Flags', 'BOOL', [4]), bool('Other'), dint('Idx', 9), bool('In')], rungs: ['XIC In OTE Other ;', 'XIC In OTE Flags[Idx] ;'] });
    // setMode reports the prescan fault
    expect(c.setMode('RUN')).toMatch(/Major fault during prescan: Type 4 Code 20/);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, program: 'MainProgram', routine: 'MainRoutine', rung: 1, element: 1, instruction: 'OTE' });
  });

  it('a prescan fault on a later Program -> Run also reports the rung/element location', () => {
    const c = run({ tags: [arr('Flags', 'BOOL', [4]), bool('Other'), dint('Idx', 1), bool('In')], rungs: ['XIC In OTE Flags[Idx] ;', 'XIC In OTE Other ;'] });
    scans(c); // the last element executed is rung 1, element 1
    c.setMode('PROGRAM');
    c.write('Idx', 9);
    c.setMode('RUN');
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, rung: 0, element: 1, instruction: 'OTE' });
  });

  it('a tag named S does not hide the S:FS status flag', () => {
    const c = run({ tags: [sint('S'), bool('Out')], rungs: ['XIC S:FS OTE S.7 ;', 'XIC S.7 OTE Out ;'] });
    scans(c);
    expect(c.readNumber('S')).toBe(-128);
    expect(c.readBool('Out')).toBe(true);
    expect(c.readBool('s:fs')).toBe(false);
  });

  it('multi-dimensional BOOL array written by a rung lands at the row-major index', () => {
    const c = run({ tags: [bool('Src', 1), arr('B3', 'BOOL', [2, 3, 4])], rungs: ['XIC Src OTE B3[1,2,3] ;'] });
    scans(c);
    const v = c.read('B3') as number[];
    expect(v[23]).toBe(1);
    expect(v.reduce((a, x) => a + x, 0)).toBe(1);
    expect(c.readBool('B3[1,2,3]')).toBe(true);
  });

  it('Controller.write / read on arrays and elements', () => {
    const c = run({ tags: [arr('A2', 'DINT', [2, 3])], rungs: [] });
    c.write('A2', [[1, 2, 3], [4, 5, 6]]);
    expect(c.read('A2')).toEqual([1, 2, 3, 4, 5, 6]);
    c.write('A2[1,1]', 50);
    expect(c.readNumber('A2[1,1]')).toBe(50);
    // read returns a copy
    const copy = c.read('A2') as number[];
    copy[0] = 999;
    expect(c.readNumber('A2[0,0]')).toBe(1);
    expect(() => c.read('A2[2,0]')).toThrow(/out of range/);
    expect(() => c.read('Nope')).toThrow(/Undefined tag/);
  });
});

// ============================================================================ bit access

describe('bit access', () => {
  it('DINT bits 0..31; bit 31 makes the DINT negative', () => {
    const d = makeDb();
    d.add(dint('D'));
    d.atomic('D.0').set(1);
    expect(value(d, 'D')).toBe(1);
    d.atomic('D.31').set(1);
    expect(value(d, 'D')).toBe(DINT_MIN + 1);
    expect(d.atomic('D.31').get()).toBe(1);
    d.atomic('D.0').set(0);
    expect(value(d, 'D')).toBe(DINT_MIN);
    d.atomic('D.31').set(0);
    expect(value(d, 'D')).toBe(0);
    expect(d.atomic('D.5').atype).toBe('BOOL');
    expect(d.err('D.32')).toMatch(/bit 32 is out of range for DINT \(0\.\.31\)/);
  });

  it('clearing bit 31 of -1 gives DINT_MAX; reading bits of negative values', () => {
    const d = makeDb();
    d.add(dint('D', -1));
    d.atomic('D.31').set(0);
    expect(value(d, 'D')).toBe(DINT_MAX);
    d.atomic('D').set(DINT_MIN);
    expect(d.atomic('D.31').get()).toBe(1);
    expect(d.atomic('D.30').get()).toBe(0);
  });

  it('SINT.7 is the sign bit', () => {
    const d = makeDb();
    d.add(sint('S'));
    d.atomic('S.7').set(1);
    expect(value(d, 'S')).toBe(-128);
    d.atomic('S.0').set(1);
    expect(value(d, 'S')).toBe(-127);
    d.atomic('S.0').set(0);
    d.atomic('S.7').set(0);
    expect(value(d, 'S')).toBe(0);
    d.atomic('S').set(-1);
    for (let b = 0; b < 8; b++) expect(d.atomic(`S.${b}`).get()).toBe(1);
    d.atomic('S').set(-128);
    expect(d.atomic('S.7').get()).toBe(1);
    expect(d.atomic('S.6').get()).toBe(0);
    expect(d.err('S.8')).toMatch(/bit 8 is out of range for SINT \(0\.\.7\)/);
  });

  it('INT.15 is the sign bit', () => {
    const d = makeDb();
    d.add(int('I'));
    d.atomic('I.15').set(1);
    expect(value(d, 'I')).toBe(-32768);
    d.atomic('I.14').set(1);
    expect(value(d, 'I')).toBe(-16384);
    d.atomic('I').set(-2);
    expect(d.atomic('I.0').get()).toBe(0);
    expect(d.atomic('I.15').get()).toBe(1);
    d.atomic('I.15').set(0);
    expect(value(d, 'I')).toBe(32766);
    expect(d.err('I.16')).toMatch(/bit 16 is out of range for INT \(0\.\.15\)/);
  });

  it('bit access is rejected on REAL, BOOL, structures and arrays without a subscript', () => {
    const d = makeDb();
    d.add(real('R'));
    d.add(bool('B'));
    d.add(timer('T'));
    d.add(arr('Arr', 'DINT', [4]));
    expect(d.err('R.0')).toMatch(/bit access requires a SINT, INT or DINT \(found REAL\)/);
    expect(d.err('B.0')).toMatch(/found BOOL/);
    expect(d.err('T.0')).toMatch(/found TIMER/);
    expect(d.err('Arr.0')).toMatch(/needs a subscript/);
    // a bit of a DINT member of a structure is fine
    expect(d.atomic('T.ACC.3').atype).toBe('BOOL');
  });

  it('a bit has no members', () => {
    const d = makeDb();
    d.add(dint('D'));
    expect(d.err('D.0.Foo')).toMatch(/a bit cannot have members/);
    expect(() => parseTagPath('D.0.1')).toThrow(/Invalid bit number/);
  });

  it('indirect bit Dint.[Idx]', () => {
    const d = makeDb();
    d.add(dint('D', 8));
    d.add(dint('Idx', 3));
    const r = d.atomic('D.[Idx]');
    expect(r.isStatic).toBe(false);
    expect(r.get()).toBe(1);
    d.atomic('Idx').set(31);
    expect(r.get()).toBe(0);
    r.set(1);
    expect(value(d, 'D')).toBe(DINT_MIN + 8);
    d.atomic('Idx').set(32);
    expect(majorFault(() => r.get())).toMatchObject({ type: 4, code: 20 });
    d.atomic('Idx').set(-1);
    expect(majorFault(() => r.set(1))).toMatchObject({ type: 4, code: 20 });
    // expression bit index
    d.atomic('Idx').set(1);
    expect(d.atomic('D.[Idx+2]').get()).toBe(1);
  });

  it('indirect bit on SINT respects width 8 and the sign', () => {
    const d = makeDb();
    d.add(sint('S'));
    d.add(dint('Idx', 7));
    const r = d.atomic('S.[Idx]');
    r.set(1);
    expect(value(d, 'S')).toBe(-128);
    d.atomic('Idx').set(8);
    expect(majorFault(() => r.get()).code).toBe(20);
  });

  it('bit of an array element Data[0].3 and Data[Idx].[B]', () => {
    const d = makeDb();
    d.add(arr('Data', 'DINT', [3], [8, 0, 0]));
    d.add(dint('Idx', 2));
    d.add(dint('B', 4));
    expect(d.atomic('Data[0].3').get()).toBe(1);
    expect(d.atomic('Data[0].3').canonical).toBe('Data[0].3');
    d.atomic('Data[Idx].[B]').set(1);
    expect(value(d, 'Data')).toEqual([8, 0, 16]);
    d.atomic('Data[1].31').set(1);
    expect((value(d, 'Data') as number[])[1]).toBe(DINT_MIN);
  });

  it('bit instructions on DINT/SINT/INT bits at run time', () => {
    const c = run({
      tags: [bool('In'), dint('D'), sint('S'), int('I'), dint('Idx', 31), dint('W')],
      rungs: ['XIC In OTE D.31 OTE S.7 OTE I.15 OTE W.[Idx] ;'],
    });
    c.write('In', 1);
    scans(c);
    expect(c.readNumber('D')).toBe(DINT_MIN);
    expect(c.readNumber('S')).toBe(-128);
    expect(c.readNumber('I')).toBe(-32768);
    expect(c.readNumber('W')).toBe(DINT_MIN);
    expect(c.readBool('D.31')).toBe(true);
    c.write('In', 0);
    scans(c);
    expect([c.readNumber('D'), c.readNumber('S'), c.readNumber('I'), c.readNumber('W')]).toEqual([0, 0, 0, 0]);
  });

  it('XIC on a bit of an array element at run time', () => {
    const c = run({ tags: [arr('Data', 'DINT', [2]), bool('Out')], rungs: ['XIC Data[1].3 OTE Out ;'] });
    c.write('Data[1]', 8);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    c.write('Data[1].3', 0);
    expect(c.readNumber('Data[1]')).toBe(0);
    scans(c);
    expect(c.readBool('Out')).toBe(false);
  });

  it('indirect bit index out of range at run time faults with type 4 code 20', () => {
    const c = run({ tags: [dint('W'), dint('Idx', 32), bool('Out')], rungs: ['XIC W.[Idx] OTE Out ;'] });
    scans(c);
    expect(c.mode).toBe('FAULTED');
    expect(c.majorFault).toMatchObject({ type: 4, code: 20, instruction: 'XIC' });
  });

  it('bit access errors are verify errors', () => {
    const m = allMessages({
      tags: [real('R'), bool('B'), dint('D'), bool('Out')],
      rungs: ['XIC R.0 OTE Out ;', 'XIC B.0 OTE Out ;', 'XIC D.32 OTE Out ;'],
    });
    expect(m).toMatch(/Rung 0.*found REAL/);
    expect(m).toMatch(/Rung 1.*found BOOL/);
    expect(m).toMatch(/Rung 2.*bit 32 is out of range/);
  });
});

// ============================================================================ structures / UDTs

describe('structures and UDTs', () => {
  it('UDT members, nested UDTs and arrays inside UDTs', () => {
    const d = makeDb(MOTOR_UDTS);
    d.add({ name: 'L', dataType: 'Line' });
    expect(d.problems).toEqual([]);
    const run1 = d.atomic('L.M[1].Run');
    run1.set(1);
    const v = value(d, 'L') as StructValue;
    expect(((v.M as StructValue[])[1] as StructValue).Run).toBe(1);
    d.atomic('L.M[0].Faults[2].5').set(1);
    expect(((v.M as StructValue[])[0].Faults as number[])[2]).toBe(32);
    expect(d.atomic('l.m[0].tmr.dn').canonical).toBe('L.M[0].Tmr.DN');
    expect(d.atomic('L.M[1].Speed').atype).toBe('REAL');
    const m0 = d.ref('L.M[0]');
    expect(m0.kind).toBe('struct');
    if (m0.kind === 'struct') {
      expect(m0.stype.name).toBe('Motor');
      expect(m0.get()).toBe((v.M as StructValue[])[0]);
    }
    expect(d.ref('L.M').kind).toBe('array');
    expect(d.ref('L.M[0].Tmr').kind).toBe('struct');
  });

  it('dynamic subscripts inside a UDT path', () => {
    const d = makeDb(MOTOR_UDTS);
    d.add({ name: 'L', dataType: 'Line' });
    d.add(dint('I', 1));
    d.add(dint('J', 3));
    const r = d.atomic('L.M[I].Faults[J]');
    r.set(42);
    expect(((((value(d, 'L') as StructValue).M as StructValue[])[1]).Faults as number[])[3]).toBe(42);
    d.atomic('J').set(4);
    expect(majorFault(() => r.get()).code).toBe(20);
  });

  it('member access errors', () => {
    const d = makeDb(MOTOR_UDTS);
    d.add({ name: 'L', dataType: 'Line' });
    d.add(dint('D'));
    d.add(timer('T'));
    d.add(arr('Ts', 'TIMER', [2]));
    expect(d.err('D.Foo')).toMatch(/'Foo' is not a member of DINT/);
    expect(d.err('T.Bogus')).toMatch(/'Bogus' is not a member of TIMER/);
    expect(d.err('Ts.ACC')).toMatch(/array 'Ts' needs a subscript before '\.ACC'/);
    expect(d.err('L.M.Run')).toMatch(/needs a subscript/);
    expect(d.err('L.M[0,1]')).toMatch(/expected 1 subscript\(s\), found 2/);
    expect(d.err('L.M[2]')).toMatch(/out of range \(0\.\.1\)/);
    expect(d.err('L.Count[0]')).toMatch(/not an array/);
    expect(d.err('Nope.X')).toMatch(/Undefined tag 'Nope'/);
  });

  it('member access errors are verify errors', () => {
    const m = allMessages({
      tags: [dint('D'), arr('Flags', 'BOOL', [4]), timer('T'), bool('Out')],
      rungs: ['XIC D.Foo OTE Out ;', 'XIC Flags OTE Out ;', 'XIC Flags[1,2] OTE Out ;', 'XIC T OTE Out ;', 'XIC T.ACC OTE Out ;'],
    });
    expect(m).toMatch(/Rung 0.*'Foo' is not a member of DINT/);
    expect(m).toMatch(/Rung 1.*'Flags' is an array of BOOL; BOOL required/);
    expect(m).toMatch(/Rung 2.*expected 1 subscript/);
    expect(m).toMatch(/Rung 3.*'T' is TIMER; BOOL required/);
    expect(m).toMatch(/Rung 4.*'T.ACC' is DINT; BOOL required/);
  });

  it('UDT ladder logic at run time', () => {
    const c = run({
      dataTypes: MOTOR_UDTS,
      tags: [{ name: 'L', dataType: 'Line', value: { M: [{}, { Run: 1 }] } }],
      rungs: ['XIC L.M[1].Run OTE L.M[0].Faults[2].5 ;'],
    });
    scans(c);
    expect(c.readNumber('L.M[0].Faults[2]')).toBe(32);
    c.write('L', { M: [{}, { Run: 0 }] });
    scans(c);
    expect(c.readNumber('L.M[0].Faults[2]')).toBe(0);
    c.write('L.M[0].Tmr', { PRE: 500 });
    expect(c.readNumber('L.M[0].Tmr.PRE')).toBe(500);
    expect(() => c.write('L.M[0]', { Nope: 1 })).toThrow(/no member 'Nope'/);
  });

  it('UDT definition errors: recursion, unknown member type, duplicate member, duplicate type', () => {
    const r = new TypeRegistry();
    const errs = r.defineUDTs([
      { name: 'Self', members: [{ name: 'Me', dataType: 'Self' }] },
      { name: 'A', members: [{ name: 'B', dataType: 'B' }] },
      { name: 'B', members: [{ name: 'A', dataType: 'A', dims: [2] }] },
      { name: 'Unknown', members: [{ name: 'X', dataType: 'NoSuchType' }] },
      { name: 'Dup', members: [{ name: 'Val', dataType: 'DINT' }, { name: 'VAL', dataType: 'REAL' }] },
      { name: 'Good', members: [{ name: 'X', dataType: 'DINT' }] },
      { name: 'GOOD', members: [{ name: 'Y', dataType: 'DINT' }] },
      { name: 'Timer', members: [{ name: 'Y', dataType: 'DINT' }] },
      { name: 'Multi', members: [{ name: 'Y', dataType: 'DINT', dims: [2, 2] }] },
      { name: 'ZeroDim', members: [{ name: 'Y', dataType: 'DINT', dims: [0] }] },
      { name: 'UsesBad', members: [{ name: 'U', dataType: 'Unknown' }] },
    ]);
    const all = errs.join('\n');
    expect(all).toMatch(/'Self' contains itself \(Self -> Self\)/);
    expect(all).toMatch(/contains itself \((A -> B -> A|B -> A -> B)\)/);
    expect(all).toMatch(/'Unknown': member 'X' has unknown data type 'NoSuchType'/);
    expect(all).toMatch(/'Dup': duplicate member 'VAL'/);
    expect(all).toMatch(/'GOOD' is already defined/);
    expect(all).toMatch(/'Timer' is already defined/);
    expect(all).toMatch(/'Multi': member 'Y' must have a single positive array dimension/);
    expect(all).toMatch(/'ZeroDim': member 'Y' must have a single positive array dimension/);
    // invalid types are not registered, valid ones are
    for (const n of ['Self', 'A', 'B', 'Unknown', 'Dup', 'Multi', 'ZeroDim', 'UsesBad']) expect(r.has(n), n).toBe(false);
    expect(r.get('good')?.kind).toBe('struct');
    expect((r.get('Good') as { members: { name: string }[] }).members.map((m) => m.name)).toEqual(['X']);
    // the builtin TIMER is untouched
    expect((r.get('TIMER') as { origin: string }).origin).toBe('builtin');
  });

  it('UDT and member names must be valid identifiers', () => {
    const r = new TypeRegistry();
    const errs = r.defineUDTs([
      { name: '1Bad', members: [{ name: 'X', dataType: 'DINT' }] },
      { name: 'Ok', members: [{ name: 'bad name', dataType: 'DINT' }, { name: 'Two__Under', dataType: 'BOOL' }] },
    ]);
    expect(errs.join('\n')).toMatch(/1Bad/);
    expect(errs.join('\n')).toMatch(/bad name/);
    expect(errs.join('\n')).toMatch(/Two__Under/);
    expect(r.has('1Bad')).toBe(false);
    expect(r.has('Ok')).toBe(false);
  });

  it('UDT errors are verify errors and tags of a failed UDT are undefined', () => {
    const m = allMessages({ dataTypes: [{ name: 'Loop', members: [{ name: 'L', dataType: 'Loop' }] }], tags: [{ name: 'X', dataType: 'Loop' }], rungs: [] });
    expect(m).toMatch(/contains itself/);
    expect(m).toMatch(/Undefined data type 'Loop'/);
  });
});

// ============================================================================ aliases

describe('alias tags', () => {
  const ioSetup = (extra: Partial<LadderSetup> = {}): LadderSetup => ({
    modules: [IQ16],
    tags: [{ name: 'Start', dataType: 'BOOL', alias: 'Local:1:I.Data.8', description: 'Start push button' }, bool('Run')],
    rungs: ['XIC Start OTE Run ;'],
    ...extra,
  });

  it('alias to an I/O point follows the input image', () => {
    const c = run(ioSetup());
    scans(c);
    expect(c.readBool('Run')).toBe(false);
    c.io.setInput(1, 8, true);
    scans(c);
    expect(c.readBool('Start')).toBe(true);
    expect(c.readBool('Local:1:I.Data.8')).toBe(true);
    expect(c.readNumber('Local:1:I.Data')).toBe(256);
    expect(c.readBool('Run')).toBe(true);
    c.io.setInput(1, 8, false);
    scans(c);
    expect(c.readBool('Run')).toBe(false);
  });

  it('alias metadata: resolved type, description, canonical target, named tag', () => {
    const c = load(ioSetup());
    const db = c.compiledProject!.db;
    const tag = db.controller.own('start')!;
    expect(tag.isAlias).toBe(true);
    expect(tag.description).toBe('Start push button');
    expect(tag.type!.name).toBe('BOOL');
    const r = compileRef(db.controller, parseTagPath('START'), 'START', { rt: c.runtime!, compileIndex: () => null });
    if (isRefError(r)) throw new Error(r.error);
    expect(r.canonical).toBe('Local:1:I.Data.8');
    expect(r.text).toBe('START');
    expect(r.namedTag!.name).toBe('Start');
    expect(r.tag!.name).toBe('Local:1:I');
    expect(r.isIO).toBe(true);
    expect(r.tag!.module).toMatchObject({ slot: 1, connection: 'I', catalog: 'LX-IQ16' });
  });

  it('alias to a word with bit access through the alias', () => {
    const c = run({
      modules: [IQ16],
      tags: [{ name: 'InWord', dataType: '', alias: 'Local:1:I.Data' }, bool('Out')],
      rungs: ['XIC InWord.3 OTE Out ;'],
    });
    c.io.setInput(1, 3, true);
    scans(c);
    expect(c.readBool('Out')).toBe(true);
    expect(c.readNumber('InWord')).toBe(8);
  });

  it('alias to an alias', () => {
    const c = run({
      modules: [IQ16],
      tags: [{ name: 'Start', dataType: 'BOOL', alias: 'Local:1:I.Data.8' }, { name: 'StartPB', dataType: 'BOOL', alias: 'Start' }, bool('Run')],
      rungs: ['XIC StartPB OTE Run ;'],
    });
    c.io.setInput(1, 8, true);
    scans(c);
    expect(c.readBool('Run')).toBe(true);
    const db = c.compiledProject!.db;
    const r = compileRef(db.controller, parseTagPath('StartPB'), 'StartPB', { rt: c.runtime!, compileIndex: () => null });
    if (isRefError(r)) throw new Error(r.error);
    expect(r.canonical).toBe('Local:1:I.Data.8');
    expect(r.namedTag!.name).toBe('StartPB');
  });

  it('program-scope alias to a controller tag; writes go to the target', () => {
    const c = run({
      tags: [bool('In'), bool('Motor')],
      programTags: [{ name: 'LocalMotor', dataType: 'BOOL', alias: 'Motor', description: 'Program alias' }],
      rungs: ['XIC In OTE LocalMotor ;'],
    });
    c.write('In', 1);
    scans(c);
    expect(c.readBool('Motor')).toBe(true);
    expect(c.readBool('LocalMotor', 'MainProgram')).toBe(true);
    expect(() => c.read('LocalMotor')).toThrow(/Undefined tag/);
    expect(c.compiledProject!.db.scope('MainProgram').own('LocalMotor')!.description).toBe('Program alias');
  });

  it('program-scope alias resolves to the program tag when it shadows a controller tag', () => {
    const c = run({
      tags: [bool('In'), bool('X')],
      programTags: [bool('X'), { name: 'AX', dataType: 'BOOL', alias: 'X' }],
      rungs: ['XIC In OTE AX ;'],
    });
    c.write('In', 1);
    scans(c);
    expect(c.readBool('X', 'MainProgram')).toBe(true);
    expect(c.readBool('X')).toBe(false);
  });

  it('alias to an array element and to a structure member', () => {
    const c = run({
      tags: [arr('Data', 'DINT', [4]), timer('T'), { name: 'Third', dataType: '', alias: 'Data[2]' }, { name: 'Done', dataType: '', alias: 'T.DN' }, bool('In')],
      rungs: ['XIC In OTE Third.0 OTE Done ;'],
    });
    c.write('In', 1);
    scans(c);
    expect(c.readNumber('Data[2]')).toBe(1);
    expect(c.readBool('T.DN')).toBe(true);
  });

  it('invalid alias targets are verify errors', () => {
    const m = allMessages({
      modules: [IQ16],
      tags: [
        dint('Idx'),
        real('R'),
        arr('Arr', 'BOOL', [4]),
        { name: 'ToNothing', dataType: 'BOOL', alias: 'NoSuchTag' },
        { name: 'BadBit', dataType: 'BOOL', alias: 'Local:1:I.Data.32' },
        { name: 'BadSyntax', dataType: 'BOOL', alias: 'Local:1:I.Data..3' },
        { name: 'Dynamic', dataType: 'BOOL', alias: 'Arr[Idx]' },
        { name: 'RealBit', dataType: 'BOOL', alias: 'R.0' },
        { name: 'NoSlot', dataType: 'BOOL', alias: 'Local:5:I.Data.0' },
      ],
      rungs: [],
    });
    expect(m).toMatch(/Alias 'ToNothing'.*Undefined tag 'NoSuchTag'/);
    expect(m).toMatch(/Alias 'BadBit'.*bit 32 is out of range/);
    expect(m).toMatch(/Alias 'BadSyntax'.*invalid target/);
    expect(m).toMatch(/Alias 'Dynamic'.*must not use tag subscripts/);
    expect(m).toMatch(/Alias 'RealBit'.*bit access requires/);
    expect(m).toMatch(/Alias 'NoSlot'.*Undefined tag 'Local:5:I'/);
  });

  it('circular aliases are verify errors', () => {
    const m = allMessages({
      tags: [{ name: 'A1', dataType: 'BOOL', alias: 'A2' }, { name: 'A2', dataType: 'BOOL', alias: 'A1' }, { name: 'Me', dataType: 'BOOL', alias: 'Me' }],
      rungs: [],
    });
    expect(m).toMatch(/Alias 'A1'.*circular/);
    expect(m).toMatch(/Alias 'Me'.*circular/);
  });

  it('a controller alias cannot see program tags', () => {
    const m = allMessages({ tags: [{ name: 'CA', dataType: 'BOOL', alias: 'PTag' }], programTags: [bool('PTag')], rungs: [] });
    expect(m).toMatch(/Alias 'CA'.*Undefined tag 'PTag'/);
  });

  it('using an alias whose target is invalid also fails verify of the rung', () => {
    const errs = verifyErrors({ tags: [{ name: 'Ghost', dataType: 'BOOL', alias: 'Nothing' }, bool('Out')], rungs: ['XIC Ghost OTE Out ;'] });
    expect(errs.some((e) => e.rung === 0 && /Nothing/.test(e.message))).toBe(true);
  });
});

// ============================================================================ status flags

describe('status flags', () => {
  it('compileRef: S:FS is read-only, S:N S:Z S:V S:C S:MINOR read the runtime status', () => {
    const d = makeDb();
    const fs = d.atomic('S:FS');
    expect(fs.writable).toBe(false);
    expect(fs.atype).toBe('BOOL');
    d.rt.status.FS = 1;
    expect(fs.get()).toBe(1);
    fs.set(0);
    expect(d.rt.status.FS).toBe(1);
    for (const f of ['N', 'Z', 'V', 'C', 'MINOR'] as const) {
      const r = d.atomic(`S:${f}`);
      expect(r.writable, f).toBe(true);
      expect(r.canonical).toBe(`S:${f}`);
      expect(r.get()).toBe(0);
      d.rt.status[f] = 1;
      expect(r.get()).toBe(1);
      r.set(0);
      expect(d.rt.status[f]).toBe(0);
    }
    expect(d.atomic('s:z').canonical).toBe('S:Z');
  });

  it('S:Z, S:N, S:V and S:MINOR reflect setArith and minor faults', () => {
    const d = makeDb();
    const z = d.atomic('S:Z');
    const n = d.atomic('S:N');
    const v = d.atomic('S:V');
    const minor = d.atomic('S:MINOR');
    d.rt.setArith(0, false);
    expect([z.get(), n.get(), v.get(), minor.get()]).toEqual([1, 0, 0, 0]);
    d.rt.setArith(-5, false);
    expect([z.get(), n.get(), v.get(), minor.get()]).toEqual([0, 1, 0, 0]);
    d.rt.setArith(3, true);
    expect([z.get(), n.get(), v.get(), minor.get()]).toEqual([0, 0, 1, 1]);
    expect(d.rt.minorFaults[0]).toMatchObject({ type: 4, code: 4, major: false });
  });

  it('unknown flags and members of flags are errors', () => {
    const d = makeDb();
    expect(d.err('S:XYZ')).toMatch(/Undefined status flag 'S:XYZ'/);
    expect(d.err('S:N.0')).toMatch(/has no members/);
  });

  it('S:FS is true only on the first scan after Program -> Run', () => {
    const c = run({ tags: [bool('FirstOnly'), bool('Seen')], rungs: ['XIC S:FS OTE FirstOnly ;', 'XIC S:FS OTL Seen ;'] });
    scans(c);
    expect(c.readBool('FirstOnly')).toBe(true);
    expect(c.readBool('Seen')).toBe(true);
    expect(c.readBool('S:FS')).toBe(false); // cleared after the scan
    scans(c);
    expect(c.readBool('FirstOnly')).toBe(false);
    scans(c, 5);
    expect(c.readBool('FirstOnly')).toBe(false);
    c.setMode('PROGRAM');
    c.write('Seen', 0);
    c.setMode('RUN');
    scans(c);
    expect(c.readBool('FirstOnly')).toBe(true);
    expect(c.readBool('Seen')).toBe(true);
  });

  it('writing S:FS is a verify error; S:N may be written', () => {
    expect(allMessages({ tags: [bool('In')], rungs: ['XIC In OTE S:FS ;'] })).toMatch(/'S:FS' is read-only/);
    expect(allMessages({ tags: [bool('In')], rungs: ['XIC In OTL S:FS ;'] })).toMatch(/read-only/);
    expect(verifyErrors({ tags: [bool('In')], rungs: ['XIC In OTE S:N ;'] })).toEqual([]);
    const c = run({ tags: [bool('In', 1)], rungs: ['XIC In OTE S:N ;'] });
    scans(c);
    expect(c.runtime!.status.N).toBe(1);
  });
});

// ============================================================================ constants and writability

describe('constant tags', () => {
  it('constant tags are read-only for logic', () => {
    const tags: TagDef[] = [bool('In'), { name: 'K', dataType: 'BOOL', constant: true, value: 1 }, { name: 'KD', dataType: 'DINT', constant: true, value: 5 }, { name: 'KT', dataType: 'TIMER', constant: true }, bool('Out')];
    expect(allMessages({ tags, rungs: ['XIC In OTE K ;'] })).toMatch(/'K' is read-only/);
    expect(allMessages({ tags, rungs: ['XIC In OTL K ;'] })).toMatch(/'K' is read-only/);
    expect(allMessages({ tags, rungs: ['XIC In OTU K ;'] })).toMatch(/'K' is read-only/);
    expect(allMessages({ tags, rungs: ['XIC In OTE KD.0 ;'] })).toMatch(/'KD.0' is read-only/);
    expect(allMessages({ tags, rungs: ['XIC In OTE KT.DN ;'] })).toMatch(/'KT.DN' is read-only/);
    // reading a constant is fine
    expect(verifyErrors({ tags, rungs: ['XIC K XIC KD.2 XIO KT.DN OTE Out ;'] })).toEqual([]);
    const c = run({ tags, rungs: ['XIC K XIC KD.2 XIO KT.DN OTE Out ;'] });
    scans(c);
    expect(c.readBool('Out')).toBe(true);
  });

  it('constant-ness through aliases', () => {
    const d = makeDb();
    d.add({ name: 'K', dataType: 'DINT', constant: true });
    d.add(dint('V'));
    d.add({ name: 'AliasOfK', dataType: '', alias: 'K' });
    d.add({ name: 'ConstAlias', dataType: '', alias: 'V', constant: true });
    expect(d.atomic('K').writable).toBe(false);
    expect(d.atomic('AliasOfK').writable).toBe(false);
    expect(d.atomic('ConstAlias').writable).toBe(false);
    expect(d.atomic('ConstAlias.3').writable).toBe(false);
    expect(d.atomic('V').writable).toBe(true);
  });
});

// ============================================================================ storage details

describe('atomic storage through refs', () => {
  it('setters apply Logix conversion and report overflow', () => {
    const d = makeDb();
    d.add(sint('S'));
    d.add(int('I'));
    d.add(dint('D'));
    d.add(real('R'));
    d.add(bool('B'));
    expect(d.atomic('S').set(200)).toBe(true);
    expect(value(d, 'S')).toBe(-56);
    expect(d.atomic('I').set(2.5)).toBe(false);
    expect(value(d, 'I')).toBe(2);
    expect(d.atomic('D').set(2147483648)).toBe(true);
    expect(value(d, 'D')).toBe(DINT_MIN);
    expect(d.atomic('D').set(-3.5)).toBe(false);
    expect(value(d, 'D')).toBe(-4);
    expect(d.atomic('R').set(0.1)).toBe(false);
    expect(value(d, 'R')).toBe(Math.fround(0.1));
    expect(d.atomic('R').set(1e39)).toBe(true);
    expect(d.atomic('B').set(-3)).toBe(false);
    expect(value(d, 'B')).toBe(1);
    d.atomic('B').set(NaN);
    expect(value(d, 'B')).toBe(0);
  });

  it('dynamic element setters apply the same conversion', () => {
    const d = makeDb();
    d.add(arr('SA', 'SINT', [2]));
    d.add(dint('Idx', 1));
    const r = d.atomic('SA[Idx]');
    expect(r.set(128)).toBe(true);
    expect(value(d, 'SA')).toEqual([0, -128]);
  });

  it('a DINT never stores negative zero', () => {
    const d = makeDb();
    d.add(dint('D'));
    d.atomic('D').set(-0);
    expect(Object.is(value(d, 'D'), 0)).toBe(true);
    const c = run({ tags: [dint('D2')], rungs: [] });
    c.write('D2', -0);
    expect(Object.is(c.readNumber('D2'), 0)).toBe(true);
  });

  it('Controller.write converts booleans and rejects objects for atomic tags', () => {
    const c = run({ tags: [bool('B'), dint('D'), timer('T')], rungs: [] });
    c.write('B', true);
    expect(c.readNumber('B')).toBe(1);
    c.write('D', false);
    expect(c.readNumber('D')).toBe(0);
    expect(() => c.write('D', { a: 1 })).toThrow(/atomic/);
    expect(() => c.write('T', 5)).toThrow(/expected a structure/);
    c.write('t', { pre: 1500, dn: true });
    expect(c.read('T')).toEqual({ PRE: 1500, ACC: 0, EN: 0, TT: 0, DN: 1 });
    expect(() => c.readNumber('T')).toThrow(/not an atomic/);
  });
});
