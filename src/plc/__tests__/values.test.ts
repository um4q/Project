/**
 * Core value model: Logix numeric conversion, default values, initial values,
 * deep copy and in-place copy.
 */
import { describe, it, expect } from 'vitest';
import {
  convert,
  convertValue,
  roundHalfEven,
  wrapInt,
  createValue,
  applyInitialValue,
  cloneValue,
  copyInto,
  elementCount,
  atomicSize,
  typeInfoToString,
  sameType,
  TypeRegistry,
  DINT_MIN,
  DINT_MAX,
  type AtomicTypeName,
  type DataType,
  type StructValue,
  type Value,
  type UDTDef,
} from '../index';

const reg = () => new TypeRegistry();

function typeOf(r: TypeRegistry, name: string): DataType {
  const t = r.get(name);
  if (!t) throw new Error(`no type ${name}`);
  return t;
}

/** Apply an initial value to a fresh value of the given type. */
function init(r: TypeRegistry, typeName: string, dims: number[] | null, value: unknown, path = 'T') {
  const type = typeOf(r, typeName);
  const holder = { value: createValue(r, type, dims) };
  const original = holder.value;
  const problems: string[] = [];
  applyInitialValue(r, { type, dims }, { holder, key: 'value' }, value, problems, path);
  return { value: holder.value, problems, sameContainer: holder.value === original };
}

// ============================================================================ roundHalfEven

describe('roundHalfEven', () => {
  it.each([
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [4.5, 4],
    [-0.5, 0],
    [-1.5, -2],
    [-2.5, -2],
    [-3.5, -4],
    [-4.5, -4],
    [2.4, 2],
    [2.6, 3],
    [-2.4, -2],
    [-2.6, -3],
    [2.5000001, 3],
    [-2.5000001, -3],
    [0.49999999999999994, 0],
    [7, 7],
    [-7, -7],
    [1e15 + 0.5, 1e15],
    [1e15 + 1.5, 1e15 + 2],
    [1e300, 1e300],
  ])('roundHalfEven(%s) = %s', (x, expected) => {
    expect(roundHalfEven(x)).toBe(expected);
  });

  it('-0.5 rounds to positive zero (even)', () => {
    expect(Object.is(roundHalfEven(-0.5), 0)).toBe(true);
  });

  it('passes non-finite values through', () => {
    expect(roundHalfEven(Infinity)).toBe(Infinity);
    expect(roundHalfEven(-Infinity)).toBe(-Infinity);
    expect(Number.isNaN(roundHalfEven(NaN))).toBe(true);
  });
});

// ============================================================================ wrapInt

describe('wrapInt', () => {
  it.each<[number, number]>([
    [0, 0],
    [DINT_MAX, DINT_MAX],
    [DINT_MIN, DINT_MIN],
    [2147483648, DINT_MIN],
    [-2147483649, DINT_MAX],
    [4294967295, -1],
    [4294967296, 0],
    [4294967297, 1],
    [-4294967297, -1],
    [2 ** 52 - 1, -1],
    [1e20, 1661992960],
    [2 ** 53 + 2, 2],
    [-(2 ** 53) - 2, -2],
    [2 ** 63 + 2 ** 31, DINT_MIN],
    [-(2 ** 63), 0],
  ])('DINT %s -> %s', (n, expected) => {
    expect(wrapInt('DINT', n)).toBe(expected);
  });

  it.each<[number, number]>([
    [32767, 32767],
    [32768, -32768],
    [65535, -1],
    [65536, 0],
    [-32768, -32768],
    [-32769, 32767],
    [70000, 4464],
    [2 ** 53 + 2, 2],
  ])('INT %s -> %s', (n, expected) => {
    expect(wrapInt('INT', n)).toBe(expected);
  });

  it.each<[number, number]>([
    [127, 127],
    [128, -128],
    [200, -56],
    [255, -1],
    [256, 0],
    [300, 44],
    [-128, -128],
    [-129, 127],
    [-256, 0],
    [2 ** 53 + 2, 2],
    [-(2 ** 53) - 2, -2],
  ])('SINT %s -> %s', (n, expected) => {
    expect(wrapInt('SINT', n)).toBe(expected);
  });

  it('maps non-finite values to 0', () => {
    for (const t of ['SINT', 'INT', 'DINT'] as const) {
      expect(wrapInt(t, NaN)).toBe(0);
      expect(wrapInt(t, Infinity)).toBe(0);
      expect(wrapInt(t, -Infinity)).toBe(0);
    }
  });
});

// ============================================================================ convert

describe('convert to BOOL', () => {
  it.each<[number, number]>([
    [0, 0],
    [-0, 0],
    [1, 1],
    [5, 1],
    [-1, 1],
    [0.001, 1],
    [-0.001, 1],
    [DINT_MIN, 1],
    [Infinity, 1],
    [-Infinity, 1],
    [NaN, 0],
  ])('%s -> %s, never overflows', (v, expected) => {
    expect(convert('BOOL', v)).toEqual({ value: expected, overflow: false });
  });
});

describe('convert to REAL (single precision)', () => {
  it('rounds to IEEE single precision', () => {
    expect(convert('REAL', 0.1).value).toBe(Math.fround(0.1));
    expect(convert('REAL', 0.1).value).not.toBe(0.1);
    expect(convert('REAL', 1 / 3).value).toBe(Math.fround(1 / 3));
    expect(convert('REAL', 16777217)).toEqual({ value: 16777216, overflow: false });
    expect(convert('REAL', 123456789)).toEqual({ value: 123456792, overflow: false });
    expect(convert('REAL', 2.5)).toEqual({ value: 2.5, overflow: false });
  });

  it('flags overflow when a finite value exceeds the REAL range', () => {
    expect(convert('REAL', 1e39)).toEqual({ value: Infinity, overflow: true });
    expect(convert('REAL', -1e39)).toEqual({ value: -Infinity, overflow: true });
    expect(convert('REAL', 3.4028236e38)).toEqual({ value: Infinity, overflow: true });
  });

  it('does not flag the largest REAL values', () => {
    const r = convert('REAL', 3.4e38);
    expect(r.overflow).toBe(false);
    expect(Number.isFinite(r.value)).toBe(true);
    expect(convert('REAL', -3.4e38).overflow).toBe(false);
  });

  it('underflows tiny values to zero without overflow', () => {
    expect(convert('REAL', 1e-50)).toEqual({ value: 0, overflow: false });
  });

  it('keeps NaN as NaN', () => {
    expect(Number.isNaN(convert('REAL', NaN).value)).toBe(true);
  });
});

describe('convert REAL -> integer: round half to even', () => {
  it.each<[AtomicTypeName, number, number]>([
    ['DINT', 0.5, 0],
    ['DINT', 1.5, 2],
    ['DINT', 2.5, 2],
    ['DINT', 3.5, 4],
    ['DINT', -0.5, 0],
    ['DINT', -1.5, -2],
    ['DINT', -2.5, -2],
    ['DINT', -3.5, -4],
    ['DINT', 1.4999, 1],
    ['DINT', -1.4999, -1],
    ['DINT', 2.5000001, 3],
    ['DINT', -0.6, -1],
    ['INT', 100.5, 100],
    ['INT', 101.5, 102],
    ['INT', -100.5, -100],
    ['SINT', 10.5, 10],
    ['SINT', 11.5, 12],
    ['SINT', -10.5, -10],
    ['SINT', 127.4, 127],
    ['SINT', -128.5, -128],
    ['INT', -32768.5, -32768],
    ['DINT', -2147483648.5, DINT_MIN],
    ['DINT', 2147483646.5, 2147483646],
  ])('%s(%s) = %s without overflow', (t, v, expected) => {
    expect(convert(t, v)).toEqual({ value: expected, overflow: false });
  });

  it('never produces negative zero', () => {
    expect(Object.is(convert('DINT', -0.5).value, 0)).toBe(true);
    expect(Object.is(convert('DINT', -0.4).value, 0)).toBe(true);
    expect(Object.is(convert('DINT', -0).value, 0)).toBe(true);
    expect(Object.is(convert('SINT', -0).value, 0)).toBe(true);
    expect(Object.is(convert('INT', -0.2).value, 0)).toBe(true);
  });

  it.each<[AtomicTypeName, number, number]>([
    ['SINT', 127.5, -128],
    ['INT', 32767.5, -32768],
    ['DINT', 2147483647.5, DINT_MIN],
  ])('%s(%s) rounds out of range: wraps to %s and flags overflow', (t, v, expected) => {
    expect(convert(t, v)).toEqual({ value: expected, overflow: true });
  });
});

describe('convert integer overflow', () => {
  it.each<[AtomicTypeName, number]>([
    ['SINT', -128],
    ['SINT', 127],
    ['INT', -32768],
    ['INT', 32767],
    ['DINT', DINT_MIN],
    ['DINT', DINT_MAX],
  ])('%s boundary %s is not an overflow', (t, v) => {
    expect(convert(t, v)).toEqual({ value: v, overflow: false });
  });

  it.each<[AtomicTypeName, number, number]>([
    ['SINT', 128, -128],
    ['SINT', 200, -56],
    ['SINT', -129, 127],
    ['SINT', 1000, -24],
    ['INT', 32768, -32768],
    ['INT', 40000, -25536],
    ['INT', -32769, 32767],
    ['INT', 65536, 0],
    ['DINT', 2147483648, DINT_MIN],
    ['DINT', 3000000000, -1294967296],
    ['DINT', -2147483649, DINT_MAX],
    ['DINT', 4294967296, 0],
  ])('%s(%s) wraps to %s and flags overflow', (t, v, expected) => {
    expect(convert(t, v)).toEqual({ value: expected, overflow: true });
  });

  it('big floats wrap modulo 2^n and flag overflow', () => {
    expect(convert('DINT', 1e20)).toEqual({ value: 1661992960, overflow: true });
    expect(convert('DINT', 1.5e10)).toEqual({ value: 2115098112, overflow: true });
    expect(convert('DINT', -1.5e10)).toEqual({ value: -2115098112, overflow: true });
    expect(convert('INT', 1e10)).toEqual({ value: -7168, overflow: true });
    expect(convert('SINT', 1e10)).toEqual({ value: 0, overflow: true });
    expect(convert('DINT', 2 ** 53)).toEqual({ value: 0, overflow: true });
  });

  it('NaN and infinities convert to 0 with overflow', () => {
    for (const t of ['SINT', 'INT', 'DINT'] as const) {
      expect(convert(t, NaN)).toEqual({ value: 0, overflow: true });
      expect(convert(t, Infinity)).toEqual({ value: 0, overflow: true });
      expect(convert(t, -Infinity)).toEqual({ value: 0, overflow: true });
    }
  });

  it('convertValue returns the converted value only', () => {
    expect(convertValue('SINT', 200)).toBe(-56);
    expect(convertValue('DINT', 2.5)).toBe(2);
    expect(convertValue('BOOL', 7)).toBe(1);
    expect(convertValue('REAL', 0.1)).toBe(Math.fround(0.1));
  });
});

// ============================================================================ createValue

describe('createValue', () => {
  it('atomic types default to 0', () => {
    const r = reg();
    for (const t of ['BOOL', 'SINT', 'INT', 'DINT', 'REAL']) expect(createValue(r, typeOf(r, t), null)).toBe(0);
  });

  it('TIMER has PRE ACC EN TT DN, all 0', () => {
    const r = reg();
    const v = createValue(r, typeOf(r, 'TIMER'), null) as StructValue;
    expect(Object.keys(v)).toEqual(['PRE', 'ACC', 'EN', 'TT', 'DN']);
    expect(v).toEqual({ PRE: 0, ACC: 0, EN: 0, TT: 0, DN: 0 });
  });

  it('COUNTER has PRE ACC CU CD DN OV UN, all 0', () => {
    const r = reg();
    const v = createValue(r, typeOf(r, 'COUNTER'), null) as StructValue;
    expect(Object.keys(v)).toEqual(['PRE', 'ACC', 'CU', 'CD', 'DN', 'OV', 'UN']);
    expect(Object.values(v).every((x) => x === 0)).toBe(true);
  });

  it('CONTROL has LEN POS EN EU DN EM ER UL IN FD, all 0', () => {
    const r = reg();
    const v = createValue(r, typeOf(r, 'CONTROL'), null) as StructValue;
    expect(Object.keys(v)).toEqual(['LEN', 'POS', 'EN', 'EU', 'DN', 'EM', 'ER', 'UL', 'IN', 'FD']);
    expect(Object.values(v).every((x) => x === 0)).toBe(true);
  });

  it('FBD_TIMER: EnableIn defaults to 1, everything else 0', () => {
    const r = reg();
    const v = createValue(r, typeOf(r, 'FBD_TIMER'), null) as StructValue;
    expect(v.EnableIn).toBe(1);
    for (const [k, x] of Object.entries(v)) if (k !== 'EnableIn') expect(x, k).toBe(0);
    expect(Object.keys(v)).toEqual(expect.arrayContaining(['TimerEnable', 'PRE', 'Reset', 'EnableOut', 'ACC', 'EN', 'TT', 'DN', 'Status']));
  });

  it('FBD_COUNTER and MOVING_STD_DEV defaults', () => {
    const r = reg();
    const c = createValue(r, typeOf(r, 'FBD_COUNTER'), null) as StructValue;
    expect(c.EnableIn).toBe(1);
    expect(c.ACC).toBe(0);
    const m = createValue(r, typeOf(r, 'MOVING_STD_DEV'), null) as StructValue;
    expect(m.EnableIn).toBe(1);
    expect(m.SampleEnable).toBe(1);
    expect(m.NumberOfSamples).toBe(1);
    expect(m.Out).toBe(0);
  });

  it('type names are case-insensitive', () => {
    const r = reg();
    expect(r.get('timer')).toBe(r.get('TIMER'));
    expect(r.get('Dint')).toBe(r.get('DINT'));
    expect(r.get('fbd_timer')?.kind).toBe('struct');
  });

  it('arrays are flat, row-major, with one element per position', () => {
    const r = reg();
    expect(createValue(r, typeOf(r, 'DINT'), [5])).toEqual([0, 0, 0, 0, 0]);
    const a3 = createValue(r, typeOf(r, 'BOOL'), [2, 3, 4]) as Value[];
    expect(a3).toHaveLength(24);
    expect(a3.every((x) => x === 0)).toBe(true);
    expect(createValue(r, typeOf(r, 'REAL'), [])).toBe(0);
  });

  it('arrays of structures get distinct element objects', () => {
    const r = reg();
    const ts = createValue(r, typeOf(r, 'TIMER'), [3]) as StructValue[];
    expect(ts).toHaveLength(3);
    expect(ts[0]).not.toBe(ts[1]);
    ts[0].ACC = 5;
    expect(ts[1].ACC).toBe(0);
    expect(ts[2].ACC).toBe(0);
  });

  it('UDTs: nested structures, array members and member default values', () => {
    const r = reg();
    const defs: UDTDef[] = [
      {
        name: 'Line',
        members: [
          { name: 'M', dataType: 'Motor', dims: [2] },
          { name: 'Count', dataType: 'DINT', defaultValue: 5 },
        ],
      },
      {
        name: 'Motor',
        members: [
          { name: 'Run', dataType: 'BOOL', defaultValue: 7 },
          { name: 'Speed', dataType: 'REAL', defaultValue: 0.1 },
          { name: 'Gain', dataType: 'SINT', defaultValue: 200 },
          { name: 'Faults', dataType: 'DINT', dims: [4] },
          { name: 'Tmr', dataType: 'TIMER' },
        ],
      },
    ];
    expect(r.defineUDTs(defs)).toEqual([]);
    const v = createValue(r, typeOf(r, 'Line'), null) as StructValue;
    expect(v.Count).toBe(5);
    const m = v.M as StructValue[];
    expect(m).toHaveLength(2);
    expect(m[0]).not.toBe(m[1]);
    expect(m[0].Run).toBe(1); // BOOL default converted
    expect(m[0].Speed).toBe(Math.fround(0.1)); // REAL default single precision
    expect(m[0].Gain).toBe(-56); // SINT default converted
    expect(m[0].Faults).toEqual([0, 0, 0, 0]);
    expect(m[0].Tmr).toEqual({ PRE: 0, ACC: 0, EN: 0, TT: 0, DN: 0 });
    expect(m[0].Tmr).not.toBe(m[1].Tmr);
    expect(m[0].Faults).not.toBe(m[1].Faults);
  });

  it('arrays of UDTs initialise every element with the member defaults', () => {
    const r = reg();
    expect(r.defineUDTs([{ name: 'Cfg', members: [{ name: 'Gain', dataType: 'DINT', defaultValue: 3 }] }])).toEqual([]);
    const a = createValue(r, typeOf(r, 'Cfg'), [2, 2]) as StructValue[];
    expect(a.map((x) => x.Gain)).toEqual([3, 3, 3, 3]);
  });
});

// ============================================================================ applyInitialValue

describe('applyInitialValue: atomic', () => {
  const r = reg();
  it.each<[string, unknown, number]>([
    ['DINT', 42, 42],
    ['DINT', -7, -7],
    ['DINT', 2.5, 2],
    ['DINT', 3.5, 4],
    ['DINT', true, 1],
    ['DINT', false, 0],
    ['DINT', '17', 17],
    ['DINT', ' -3 ', -3],
    ['BOOL', 5, 1],
    ['BOOL', true, 1],
    ['BOOL', 0, 0],
    ['BOOL', '1', 1],
    ['SINT', 300, 44],
    ['INT', -32769, 32767],
    ['REAL', 0.1, Math.fround(0.1)],
    ['REAL', '2.5', 2.5],
  ])('%s initial %j -> %s', (t, value, expected) => {
    const res = init(r, t, null, value);
    expect(res.problems).toEqual([]);
    expect(res.value).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['DINT', 'abc'],
    ['DINT', ''],
    ['BOOL', 'true'],
    ['DINT', [1]],
    ['DINT', { a: 1 }],
  ])('%s initial %j is reported and leaves the value at 0', (t, value) => {
    const res = init(r, t, null, value, 'MyTag');
    expect(res.value).toBe(0);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toMatch(/^MyTag: invalid/);
  });

  it('null / undefined are ignored', () => {
    expect(init(r, 'DINT', null, null)).toMatchObject({ value: 0, problems: [] });
    expect(init(r, 'DINT', null, undefined)).toMatchObject({ value: 0, problems: [] });
  });
});

describe('applyInitialValue: arrays', () => {
  const r = reg();
  it('flat list', () => {
    const res = init(r, 'DINT', [4], [1, 2, 3, 4]);
    expect(res.problems).toEqual([]);
    expect(res.value).toEqual([1, 2, 3, 4]);
    expect(res.sameContainer).toBe(true);
  });

  it('nested lists are flattened row-major', () => {
    expect(init(r, 'DINT', [2, 3], [[1, 2, 3], [4, 5, 6]]).value).toEqual([1, 2, 3, 4, 5, 6]);
    expect(init(r, 'INT', [2, 2, 2], [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]).value).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // a 2-D array can also be given as one flat list
    expect(init(r, 'DINT', [2, 3], [1, 2, 3, 4, 5, 6]).value).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a shorter list fills the first elements and leaves the rest at 0', () => {
    expect(init(r, 'DINT', [5], [9, 8]).value).toEqual([9, 8, 0, 0, 0]);
  });

  it('elements are converted to the element type', () => {
    expect(init(r, 'SINT', [3], [127, 128, 2.5]).value).toEqual([127, -128, 2]);
    expect(init(r, 'BOOL', [3], [true, 0, 9]).value).toEqual([1, 0, 1]);
  });

  it('a bad element is reported with its index and the other elements still apply', () => {
    const res = init(r, 'DINT', [3], [1, 'x', 3], 'Arr');
    expect(res.value).toEqual([1, 0, 3]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toMatch(/^Arr\[1\]: invalid DINT/);
  });

  it('a scalar for an array is reported', () => {
    const res = init(r, 'DINT', [3], 5, 'Arr');
    expect(res.value).toEqual([0, 0, 0]);
    expect(res.problems).toEqual(['Arr: expected an array value']);
  });

  it('arrays of structures take a list of partial member objects', () => {
    const res = init(r, 'TIMER', [3], [{ PRE: 100 }, { ACC: 7, DN: true }]);
    expect(res.problems).toEqual([]);
    const v = res.value as StructValue[];
    expect(v[0]).toEqual({ PRE: 100, ACC: 0, EN: 0, TT: 0, DN: 0 });
    expect(v[1]).toEqual({ PRE: 0, ACC: 7, EN: 0, TT: 0, DN: 1 });
    expect(v[2]).toEqual({ PRE: 0, ACC: 0, EN: 0, TT: 0, DN: 0 });
  });
});

describe('applyInitialValue: structures', () => {
  it('partial structure: unspecified members keep their defaults', () => {
    const r = reg();
    const res = init(r, 'TIMER', null, { PRE: 1000 });
    expect(res.problems).toEqual([]);
    expect(res.value).toEqual({ PRE: 1000, ACC: 0, EN: 0, TT: 0, DN: 0 });
    expect(res.sameContainer).toBe(true);
  });

  it('member names are case-insensitive and stored under the canonical name', () => {
    const r = reg();
    const res = init(r, 'TIMER', null, { pre: 5, Dn: true, acc: 2.5 });
    expect(res.problems).toEqual([]);
    expect(res.value).toEqual({ PRE: 5, ACC: 2, EN: 0, TT: 0, DN: 1 });
    expect(Object.keys(res.value as object)).toEqual(['PRE', 'ACC', 'EN', 'TT', 'DN']);
  });

  it('unknown members are reported, valid members still apply', () => {
    const r = reg();
    const res = init(r, 'COUNTER', null, { PRE: 3, Bogus: 1 }, 'Cnt');
    expect((res.value as StructValue).PRE).toBe(3);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toMatch(/Cnt: COUNTER has no member 'Bogus'/);
    expect(res.value).not.toHaveProperty('Bogus');
  });

  it('bad member values are reported with the member path', () => {
    const r = reg();
    const res = init(r, 'TIMER', null, { PRE: 'soon' }, 'T1');
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toMatch(/^T1\.PRE: invalid DINT value/);
  });

  it('a non-object for a structure is reported', () => {
    const r = reg();
    expect(init(r, 'TIMER', null, 5, 'T1').problems).toEqual(['T1: expected a structure value for TIMER']);
    expect(init(r, 'TIMER', null, [1, 2], 'T1').problems).toEqual(['T1: expected a structure value for TIMER']);
  });

  it('nested UDTs with array members, partial at every level', () => {
    const r = reg();
    expect(
      r.defineUDTs([
        { name: 'Motor', members: [{ name: 'Run', dataType: 'BOOL' }, { name: 'Faults', dataType: 'DINT', dims: [3] }, { name: 'Tmr', dataType: 'TIMER' }] },
        { name: 'Line', members: [{ name: 'M', dataType: 'Motor', dims: [2] }, { name: 'Count', dataType: 'DINT' }] },
      ]),
    ).toEqual([]);
    const res = init(r, 'Line', null, { count: 4, M: [{ Faults: [1, 2] }, { run: 1, Tmr: { PRE: 50 } }] }, 'L');
    expect(res.problems).toEqual([]);
    const v = res.value as StructValue;
    expect(v.Count).toBe(4);
    const m = v.M as StructValue[];
    expect(m[0]).toEqual({ Run: 0, Faults: [1, 2, 0], Tmr: { PRE: 0, ACC: 0, EN: 0, TT: 0, DN: 0 } });
    expect(m[1]).toEqual({ Run: 1, Faults: [0, 0, 0], Tmr: { PRE: 50, ACC: 0, EN: 0, TT: 0, DN: 0 } });
  });

  it('deep problems carry the full path', () => {
    const r = reg();
    r.defineUDTs([{ name: 'Motor', members: [{ name: 'Faults', dataType: 'DINT', dims: [3] }] }]);
    const res = init(r, 'Motor', [2], [{}, { Faults: [0, 'x'], Nope: 1 }], 'Mtr');
    expect(res.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^Mtr\[1\]\.Faults\[1\]: invalid DINT/), expect.stringMatching(/^Mtr\[1\]: Motor has no member 'Nope'/)]));
    expect(res.problems).toHaveLength(2);
  });
});

// ============================================================================ cloneValue / copyInto

describe('cloneValue', () => {
  it('returns atomic values unchanged', () => {
    expect(cloneValue(5)).toBe(5);
    expect(cloneValue(-0.5)).toBe(-0.5);
  });

  it('deep copies structures and arrays', () => {
    const src: StructValue = { A: 1, Arr: [1, 2, 3], Sub: { X: 1, Ts: [{ PRE: 1 }, { PRE: 2 }] } };
    const c = cloneValue(src) as StructValue;
    expect(c).toEqual(src);
    expect(c).not.toBe(src);
    expect(c.Arr).not.toBe(src.Arr);
    expect(c.Sub).not.toBe(src.Sub);
    expect((c.Sub as StructValue).Ts).not.toBe((src.Sub as StructValue).Ts);
    ((c.Sub as StructValue).Ts as StructValue[])[1].PRE = 99;
    (c.Arr as number[])[0] = 42;
    expect(((src.Sub as StructValue).Ts as StructValue[])[1].PRE).toBe(2);
    expect((src.Arr as number[])[0]).toBe(1);
  });
});

describe('copyInto', () => {
  it('copies values in place and keeps every container identity', () => {
    const r = reg();
    r.defineUDTs([{ name: 'Motor', members: [{ name: 'Run', dataType: 'BOOL' }, { name: 'Faults', dataType: 'DINT', dims: [3] }, { name: 'Tmr', dataType: 'TIMER' }] }]);
    const t = typeOf(r, 'Motor');
    const dst = createValue(r, t, null) as StructValue;
    const dstFaults = dst.Faults;
    const dstTmr = dst.Tmr;
    const src = createValue(r, t, null) as StructValue;
    src.Run = 1;
    (src.Faults as number[])[2] = 7;
    (src.Tmr as StructValue).ACC = 33;
    copyInto(dst, src);
    expect(dst).toEqual(src);
    expect(dst.Faults).toBe(dstFaults);
    expect(dst.Tmr).toBe(dstTmr);
    expect(dst.Faults).not.toBe(src.Faults);
    // later changes to the source do not leak into the destination
    (src.Tmr as StructValue).ACC = 1;
    expect((dst.Tmr as StructValue).ACC).toBe(33);
  });

  it('arrays of structures are copied element-wise in place', () => {
    const dst: StructValue[] = [{ PRE: 0, ACC: 0 }, { PRE: 0, ACC: 0 }];
    const e0 = dst[0];
    copyInto(dst, [{ PRE: 5, ACC: 6 }, { PRE: 7, ACC: 8 }]);
    expect(dst).toEqual([{ PRE: 5, ACC: 6 }, { PRE: 7, ACC: 8 }]);
    expect(dst[0]).toBe(e0);
  });

  it('copies min(length) elements of arrays of different length', () => {
    const dst = [0, 0, 0];
    copyInto(dst, [1, 2]);
    expect(dst).toEqual([1, 2, 0]);
    const dst2 = [0, 0];
    copyInto(dst2, [1, 2, 3, 4]);
    expect(dst2).toEqual([1, 2]);
  });

  it('ignores source members the destination does not have and keeps missing ones', () => {
    const dst: StructValue = { A: 1, B: 2 };
    copyInto(dst, { A: 10, C: 30 } as StructValue);
    expect(dst).toEqual({ A: 10, B: 2 });
  });
});

// ============================================================================ small helpers

describe('type helpers', () => {
  it('elementCount', () => {
    expect(elementCount(null)).toBe(1);
    expect(elementCount(undefined)).toBe(1);
    expect(elementCount([])).toBe(1);
    expect(elementCount([7])).toBe(7);
    expect(elementCount([2, 3, 4])).toBe(24);
  });

  it('atomicSize follows the Logix memory layout', () => {
    expect(atomicSize('BOOL')).toBe(1);
    expect(atomicSize('SINT')).toBe(1);
    expect(atomicSize('INT')).toBe(2);
    expect(atomicSize('DINT')).toBe(4);
    expect(atomicSize('REAL')).toBe(4);
  });

  it('typeInfoToString and sameType', () => {
    const r = reg();
    const dint = typeOf(r, 'DINT');
    expect(typeInfoToString({ type: dint, dims: null })).toBe('DINT');
    expect(typeInfoToString({ type: dint, dims: [2, 3] })).toBe('DINT[2,3]');
    expect(sameType({ type: dint, dims: [2, 3] }, { type: dint, dims: [2, 3] })).toBe(true);
    expect(sameType({ type: dint, dims: [2, 3] }, { type: dint, dims: [3, 2] })).toBe(false);
    expect(sameType({ type: dint, dims: null }, { type: dint, dims: [1] })).toBe(false);
    expect(sameType({ type: dint, dims: null }, { type: typeOf(r, 'REAL'), dims: null })).toBe(false);
  });
});
