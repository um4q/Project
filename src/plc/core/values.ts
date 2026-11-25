/**
 * Runtime value model and Logix numeric conversion rules.
 *
 * - Atomic values are JS numbers. BOOL is 0/1. SINT/INT/DINT are signed
 *   integers of the matching width. REAL is IEEE single precision (Math.fround).
 * - Structures are plain objects keyed by canonical member name.
 * - Arrays are flat JS arrays (row-major); their dimensions live in type info.
 *
 * Containers (struct objects / arrays) are never replaced after creation, only
 * mutated, so compiled operand references can bind to them directly.
 */
import type { AtomicTypeName, DataType, StructType, TypeRegistry } from './datatypes';

export type AtomicValue = number;
export type StructValue = { [member: string]: Value };
export type ArrayValue = Value[];
export type Value = AtomicValue | StructValue | ArrayValue;

export interface TypeInfo {
  type: DataType;
  /** Array dimensions, or null for a scalar */
  dims: number[] | null;
}

export const DINT_MIN = -2147483648;
export const DINT_MAX = 2147483647;

const RANGE: Record<Exclude<AtomicTypeName, 'REAL' | 'BOOL'>, [number, number]> = {
  SINT: [-128, 127],
  INT: [-32768, 32767],
  DINT: [DINT_MIN, DINT_MAX],
};

/** Round half to even (banker's rounding), as Logix does when converting REAL to an integer. */
export function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Wrap any integer-valued number into the signed range of the integer type. */
export function wrapInt(t: 'SINT' | 'INT' | 'DINT', n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) < 2 ** 52) {
    // exact path: reduce modulo 2^32 then sign-extend
    const m = ((n % 4294967296) + 4294967296) % 4294967296;
    const v32 = m | 0;
    if (t === 'DINT') return v32;
    if (t === 'INT') return (v32 << 16) >> 16;
    return (v32 << 24) >> 24;
  }
  const big = BigInt(Math.trunc(n));
  const bits = t === 'DINT' ? 32 : t === 'INT' ? 16 : 8;
  return Number(BigInt.asIntN(bits, big));
}

export interface ConvertResult {
  value: number;
  overflow: boolean;
}

/**
 * Convert a numeric value into the representation of the destination type,
 * following Logix rules:
 *  - to BOOL: zero -> 0, anything else -> 1
 *  - REAL -> integer: round half to even; out of range overflows (wraps, flags)
 *  - integer -> narrower integer: keeps the low bits, flags overflow
 *  - to REAL: single precision
 */
export function convert(t: AtomicTypeName, v: number): ConvertResult {
  switch (t) {
    case 'BOOL':
      return { value: v !== 0 && !Number.isNaN(v) ? 1 : 0, overflow: false };
    case 'REAL': {
      const f = Math.fround(v);
      return { value: f, overflow: Number.isFinite(v) && !Number.isFinite(f) };
    }
    default: {
      if (Number.isNaN(v)) return { value: 0, overflow: true };
      const n = Number.isInteger(v) ? v : roundHalfEven(v);
      const [lo, hi] = RANGE[t];
      if (n >= lo && n <= hi) return { value: n === 0 ? 0 : n, overflow: false };
      return { value: wrapInt(t, n), overflow: true };
    }
  }
}

/** Fast conversion without overflow reporting. */
export function convertValue(t: AtomicTypeName, v: number): number {
  return convert(t, v).value;
}

/** Create the default value for a type (and optional array dims). */
export function createValue(reg: TypeRegistry, type: DataType, dims: number[] | null | undefined): Value {
  if (dims && dims.length > 0) {
    const n = dims.reduce((a, x) => a * x, 1);
    const arr: Value[] = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = createValue(reg, type, null);
    return arr;
  }
  if (type.kind === 'atomic') return 0;
  return createStruct(reg, type);
}

function createStruct(reg: TypeRegistry, s: StructType): StructValue {
  const obj: StructValue = {};
  for (const m of s.members) {
    const mt = reg.get(m.dataType);
    if (!mt) {
      obj[m.name] = 0;
      continue;
    }
    if (m.dims && m.dims.length) obj[m.name] = createValue(reg, mt, m.dims);
    else if (mt.kind === 'atomic') obj[m.name] = m.defaultValue !== undefined ? convertValue(mt.name, m.defaultValue) : 0;
    else obj[m.name] = createStruct(reg, mt);
  }
  return obj;
}

/** Flatten nested arrays (used for initial values given as nested lists). */
function flatten(v: unknown): unknown[] {
  if (!Array.isArray(v)) return [v];
  const out: unknown[] = [];
  for (const x of v) {
    if (Array.isArray(x)) out.push(...flatten(x));
    else out.push(x);
  }
  return out;
}

/**
 * Apply an initial value (from a project file) onto an existing value container.
 * Returns a list of problems (ignored members, bad values) - never throws.
 */
export function applyInitialValue(
  reg: TypeRegistry,
  info: TypeInfo,
  target: { holder: any; key: string | number },
  init: unknown,
  problems: string[],
  path: string,
): void {
  if (init === undefined || init === null) return;
  const { type, dims } = info;
  const cur = target.holder[target.key];
  if (dims && dims.length) {
    if (!Array.isArray(init)) {
      problems.push(`${path}: expected an array value`);
      return;
    }
    const flat = flatten(init);
    const arr = cur as Value[];
    const n = Math.min(arr.length, flat.length);
    for (let i = 0; i < n; i++) applyInitialValue(reg, { type, dims: null }, { holder: arr, key: i }, flat[i], problems, `${path}[${i}]`);
    return;
  }
  if (type.kind === 'atomic') {
    let num: number;
    if (typeof init === 'boolean') num = init ? 1 : 0;
    else if (typeof init === 'number') num = init;
    else if (typeof init === 'string' && init.trim() !== '' && !Number.isNaN(Number(init))) num = Number(init);
    else {
      problems.push(`${path}: invalid ${type.name} value ${JSON.stringify(init)}`);
      return;
    }
    target.holder[target.key] = convertValue(type.name, num);
    return;
  }
  if (typeof init !== 'object' || Array.isArray(init)) {
    problems.push(`${path}: expected a structure value for ${type.name}`);
    return;
  }
  const obj = cur as StructValue;
  for (const [k, v] of Object.entries(init as Record<string, unknown>)) {
    const m = type.memberIndex.get(k.toLowerCase());
    if (!m) {
      problems.push(`${path}: ${type.name} has no member '${k}'`);
      continue;
    }
    const mt = reg.get(m.dataType);
    if (!mt) continue;
    applyInitialValue(reg, { type: mt, dims: m.dims && m.dims.length ? m.dims : null }, { holder: obj, key: m.name }, v, problems, `${path}.${m.name}`);
  }
}

/** Deep copy a value (structures and arrays). Atomic values are returned as-is. */
export function cloneValue(v: Value): Value {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.map(cloneValue);
  const out: StructValue = {};
  for (const k of Object.keys(v)) out[k] = cloneValue(v[k]);
  return out;
}

/**
 * Copy `src` into the existing container `dst` in place (same shape assumed).
 * Used by COP/FLL/JSR parameter passing so references stay valid.
 */
export function copyInto(dst: StructValue | Value[], src: StructValue | Value[]): void {
  if (Array.isArray(dst)) {
    const s = src as Value[];
    const n = Math.min(dst.length, s.length);
    for (let i = 0; i < n; i++) {
      const sv = s[i];
      if (typeof sv === 'number' || typeof dst[i] === 'number') dst[i] = typeof sv === 'number' ? sv : dst[i];
      else copyInto(dst[i] as StructValue, sv as StructValue);
    }
    return;
  }
  const s = src as StructValue;
  for (const k of Object.keys(dst)) {
    if (!(k in s)) continue;
    const sv = s[k];
    const dv = dst[k];
    if (typeof dv === 'number') {
      if (typeof sv === 'number') dst[k] = sv;
    } else if (typeof sv !== 'number') copyInto(dv as StructValue, sv as StructValue);
  }
}

/** Element count of an array with the given dims. */
export function elementCount(dims: number[] | null | undefined): number {
  if (!dims || dims.length === 0) return 1;
  return dims.reduce((a, x) => a * x, 1);
}

/** Size in bytes of an atomic type (Logix memory layout). */
export function atomicSize(t: AtomicTypeName): number {
  switch (t) {
    case 'BOOL':
    case 'SINT':
      return 1;
    case 'INT':
      return 2;
    default:
      return 4;
  }
}

export function typeInfoToString(info: TypeInfo): string {
  const base = info.type.name;
  return info.dims && info.dims.length ? `${base}[${info.dims.join(',')}]` : base;
}

/** Shape equality of two TypeInfos (for struct copy compatibility). */
export function sameType(a: TypeInfo, b: TypeInfo): boolean {
  if (a.type !== b.type) return false;
  const ad = a.dims ?? [];
  const bd = b.dims ?? [];
  return ad.length === bd.length && ad.every((x, i) => x === bd[i]);
}
