/**
 * Operand references: a tag path compiled into fast accessor closures.
 *
 * Static paths bind directly to the (holder, key) slot of the value. Paths with
 * tag/expression subscripts are evaluated at run time with bounds checking
 * (Type 4 Code 20 major fault when out of range).
 */
import { bitWidth, isIntegerType, type AtomicTypeName, type DataType, type StructType } from './datatypes';
import { FAULT } from './faults';
import { DINT_MAX, DINT_MIN, convert, wrapInt, type StructValue, type TypeInfo, type Value } from './values';
import { STATUS_FLAG_NAMES, type Runtime } from './runtime';
import type { Scope, Tag } from './tags';
import { formatPath, type Expr, type PathSeg, type TagPath } from '../expr/ast';
import { parseTagPath, ParseError } from '../expr/parser';

interface RefBase {
  /** Operand text as written */
  text: string;
  /** Canonical resolved path (aliases expanded) */
  canonical: string;
  /** Root tag (after alias resolution); null for status flags / literals */
  tag: Tag | null;
  /** The tag named in the operand (may be an alias) */
  namedTag: Tag | null;
  info: TypeInfo;
  writable: boolean;
  /** True if the root tag is a module I/O tag */
  isIO: boolean;
  /** True if all subscripts are constant */
  isStatic: boolean;
  /** When the last path segment is an array subscript: the array element context */
  element?: ElementContext;
}

export interface ElementContext {
  /** The array containing the element */
  array: () => Value[];
  /** Flat index of the element */
  index: () => number;
  /** Total flat length of the array */
  length: number;
}

export interface AtomicRef extends RefBase {
  kind: 'atomic';
  atype: AtomicTypeName;
  get(): number;
  /** Store with Logix conversion. Returns true on overflow. */
  set(v: number): boolean;
  isConst: boolean;
}

export interface StructRef extends RefBase {
  kind: 'struct';
  stype: StructType;
  get(): StructValue;
}

export interface ArrayRef extends RefBase {
  kind: 'array';
  get(): Value[];
  /** Flat element count */
  length: number;
}

export type Ref = AtomicRef | StructRef | ArrayRef;
export type RefResult = Ref | { error: string };

export function isRefError(r: RefResult): r is { error: string } {
  return 'error' in r;
}

export interface RefCompileEnv {
  rt: Runtime;
  /** Compile a subscript expression to a DINT-valued function. Return null on error (and report it). */
  compileIndex(e: Expr): (() => number) | null;
}

/** Literal constant as an AtomicRef. */
export function constRef(value: number, isReal: boolean, text?: string): AtomicRef {
  const v = isReal ? Math.fround(value) : value;
  const atype: AtomicTypeName = isReal ? 'REAL' : 'DINT';
  return {
    kind: 'atomic',
    atype,
    text: text ?? String(value),
    canonical: text ?? String(value),
    tag: null,
    namedTag: null,
    info: { type: { kind: 'atomic', name: atype }, dims: null },
    writable: false,
    isIO: false,
    isStatic: true,
    isConst: true,
    get: () => v,
    set: () => false,
  };
}

/** Build a setter for an atomic slot that applies Logix conversion. */
export function atomicSetter(t: AtomicTypeName, holder: () => any, key: () => string | number): (v: number) => boolean {
  switch (t) {
    case 'BOOL':
      return (v) => {
        holder()[key()] = v !== 0 && v === v ? 1 : 0;
        return false;
      };
    case 'REAL':
      return (v) => {
        const f = Math.fround(v);
        holder()[key()] = f;
        return f === Infinity || f === -Infinity ? Number.isFinite(v) : false;
      };
    case 'DINT':
      return (v) => {
        if ((v | 0) === v) {
          holder()[key()] = v | 0; // also turns -0 into 0
          return false;
        }
        const r = convert('DINT', v);
        holder()[key()] = r.value;
        return r.overflow;
      };
    default:
      return (v) => {
        const r = convert(t, v);
        holder()[key()] = r.value;
        return r.overflow;
      };
  }
}

function staticSetter(t: AtomicTypeName, h: any, k: string | number): (v: number) => boolean {
  switch (t) {
    case 'BOOL':
      return (v) => {
        h[k] = v !== 0 && v === v ? 1 : 0;
        return false;
      };
    case 'REAL':
      return (v) => {
        const f = Math.fround(v);
        h[k] = f;
        return f === Infinity || f === -Infinity ? Number.isFinite(v) : false;
      };
    case 'DINT':
      return (v) => {
        if ((v | 0) === v) {
          h[k] = v | 0; // also turns -0 into 0
          return false;
        }
        const r = convert('DINT', v);
        h[k] = r.value;
        return r.overflow;
      };
    default:
      return (v) => {
        const r = convert(t, v);
        h[k] = r.value;
        return r.overflow;
      };
  }
}

const MAX_ALIAS_DEPTH = 8;

/**
 * Resolve an operand path in a scope.
 */
export function compileRef(scope: Scope, path: TagPath, text: string, env: RefCompileEnv, aliasDepth = 0): RefResult {
  // System status flags S:FS, S:N, ...
  const baseUpper = path.base.toUpperCase();
  if (baseUpper.startsWith('S:')) {
    const flag = baseUpper.slice(2);
    const name = STATUS_FLAG_NAMES.find((f) => f === flag);
    if (!name) return { error: `Undefined status flag '${path.base}'` };
    if (path.segs.length) return { error: `Status flag '${path.base}' has no members` };
    const st = env.rt.status;
    return {
      kind: 'atomic',
      atype: 'BOOL',
      text,
      canonical: `S:${name}`,
      tag: null,
      namedTag: null,
      info: { type: { kind: 'atomic', name: 'BOOL' }, dims: null },
      writable: name !== 'FS',
      isIO: false,
      isStatic: true,
      isConst: false,
      get: () => st[name],
      set: (v) => {
        if (name !== 'FS') st[name] = v ? 1 : 0;
        return false;
      },
    };
  }

  const tag = scope.lookup(path.base);
  if (!tag) return { error: `Undefined tag '${path.base}'` };

  if (tag.def.alias) {
    if (aliasDepth >= MAX_ALIAS_DEPTH) return { error: `Alias '${tag.name}' is circular or nested too deeply` };
    let target: TagPath;
    try {
      target = parseTagPath(tag.def.alias);
    } catch (e) {
      return { error: `Alias '${tag.name}' has an invalid target '${tag.def.alias}': ${(e as ParseError).message}` };
    }
    const combined: TagPath = { base: target.base, segs: [...target.segs, ...path.segs] };
    const r = compileRef(tag.scope, combined, text, env, aliasDepth + 1);
    if (isRefError(r)) {
      return { error: aliasDepth === 0 && path.segs.length === 0 ? `Alias '${tag.name}' -> ${r.error}` : r.error };
    }
    r.namedTag = aliasDepth === 0 ? tag : r.namedTag;
    r.text = text;
    if (tag.def.constant) r.writable = false;
    return r;
  }

  if (!tag.type) return { error: `Tag '${tag.name}' has no data type` };

  let info: TypeInfo = { type: tag.type, dims: tag.dims };
  // Cursor: either static (holder, key) or dynamic closures.
  let sHolder: any = tag.holder;
  let sKey: string | number = 'value';
  let dynamic = false;
  let getHolder: () => any = () => tag.holder;
  let getKey: () => string | number = () => 'value';
  let element: ElementContext | undefined;
  let bit: { width: number; atype: AtomicTypeName; index: number | (() => number) } | null = null;
  const canonicalSegs: PathSeg[] = [];

  const toDynamic = () => {
    if (dynamic) return;
    dynamic = true;
    const h = sHolder;
    const k = sKey;
    getHolder = () => h;
    getKey = () => k;
  };

  for (let si = 0; si < path.segs.length; si++) {
    const seg = path.segs[si];
    if (bit) return { error: `'${text}': a bit cannot have members` };
    element = undefined;
    if (seg.kind === 'member') {
      if (info.dims) return { error: `'${text}': array '${formatPath({ base: path.base, segs: canonicalSegs })}' needs a subscript before '.${seg.name}'` };
      if (info.type.kind !== 'struct') return { error: `'${text}': '${seg.name}' is not a member of ${info.type.name}` };
      const m = info.type.memberIndex.get(seg.name.toLowerCase());
      if (!m) return { error: `'${text}': '${seg.name}' is not a member of ${info.type.name}` };
      const mt: DataType | undefined = reg(tag, m.dataType);
      if (!mt) return { error: `'${text}': member type '${m.dataType}' is undefined` };
      const mname = m.name;
      if (!dynamic) {
        sHolder = sHolder[sKey];
        sKey = mname;
      } else {
        const ph = getHolder;
        const pk = getKey;
        getHolder = () => ph()[pk()];
        getKey = () => mname;
      }
      info = { type: mt, dims: m.dims && m.dims.length ? [...m.dims] : null };
      canonicalSegs.push({ kind: 'member', name: mname });
      continue;
    }
    if (seg.kind === 'index') {
      if (!info.dims) return { error: `'${text}': ${info.type.name} is not an array` };
      const dims = info.dims;
      if (seg.indices.length !== dims.length) return { error: `'${text}': expected ${dims.length} subscript(s), found ${seg.indices.length}` };
      // constant subscripts?
      const consts: (number | null)[] = seg.indices.map((e) => (e.kind === 'num' && !e.isReal ? e.value : null));
      const length = dims.reduce((a, x) => a * x, 1);
      if (consts.every((c) => c !== null)) {
        let flat = 0;
        for (let d = 0; d < dims.length; d++) {
          const c = consts[d]!;
          if (c < 0 || c >= dims[d]) return { error: `'${text}': array subscript ${c} is out of range (0..${dims[d] - 1})` };
          flat = flat * dims[d] + c;
        }
        if (!dynamic) {
          const arr = sHolder[sKey];
          sHolder = arr;
          sKey = flat;
          element = { array: () => arr, index: () => flat, length };
        } else {
          const ph = getHolder;
          const pk = getKey;
          getHolder = () => ph()[pk()];
          getKey = () => flat;
          const gh = getHolder;
          element = { array: () => gh(), index: () => flat, length };
        }
      } else {
        const fns: (() => number)[] = [];
        for (let d = 0; d < seg.indices.length; d++) {
          const e = seg.indices[d];
          if (e.kind === 'num') {
            if (e.isReal) return { error: `'${text}': array subscript must be an integer` };
            if (e.value < 0 || e.value >= dims[d]) return { error: `'${text}': array subscript ${e.value} is out of range (0..${dims[d] - 1})` };
            const v = e.value;
            fns.push(() => v);
            continue;
          }
          const f = env.compileIndex(e);
          if (!f) return { error: `'${text}': invalid array subscript` };
          fns.push(f);
        }
        toDynamic();
        const ph = getHolder;
        const pk = getKey;
        const rt = env.rt;
        const label = text;
        const computeIndex =
          dims.length === 1
            ? () => {
                const i = fns[0]();
                if (i < 0 || i >= dims[0] || !Number.isInteger(i)) rt.majorFault(FAULT.ARRAY_SUBSCRIPT, `${label}: subscript ${i}`);
                return i;
              }
            : () => {
                let flat = 0;
                for (let d = 0; d < dims.length; d++) {
                  const i = fns[d]();
                  if (i < 0 || i >= dims[d] || !Number.isInteger(i)) rt.majorFault(FAULT.ARRAY_SUBSCRIPT, `${label}: subscript ${i}`);
                  flat = flat * dims[d] + i;
                }
                return flat;
              };
        getHolder = () => ph()[pk()];
        getKey = computeIndex;
        const gh = getHolder;
        element = { array: () => gh(), index: computeIndex, length };
      }
      info = { type: info.type, dims: null };
      canonicalSegs.push(seg);
      continue;
    }
    // bit access
    if (info.dims) return { error: `'${text}': array needs a subscript before a bit number` };
    if (info.type.kind !== 'atomic' || !isIntegerType(info.type.name)) return { error: `'${text}': bit access requires a SINT, INT or DINT (found ${info.type.name})` };
    const width = bitWidth(info.type.name);
    if (seg.kind === 'bit') {
      if (seg.bit < 0 || seg.bit >= width) return { error: `'${text}': bit ${seg.bit} is out of range for ${info.type.name} (0..${width - 1})` };
      bit = { width, atype: info.type.name, index: seg.bit };
    } else {
      const f = env.compileIndex(seg.index);
      if (!f) return { error: `'${text}': invalid bit index` };
      const rt = env.rt;
      const label = text;
      bit = {
        width,
        atype: info.type.name,
        index: () => {
          const i = f();
          if (i < 0 || i >= width) rt.majorFault(FAULT.ARRAY_SUBSCRIPT, `${label}: bit ${i}`);
          return i;
        },
      };
      toDynamic();
    }
    canonicalSegs.push(seg);
  }

  const canonical = formatPath({ base: tag.name, segs: canonicalSegs });
  const isIO = !!tag.module;
  const writable = !tag.def.constant;
  const common = { text, canonical, tag, namedTag: tag, isIO, writable, isStatic: !dynamic, element };

  if (bit) {
    const b = bit;
    const boolInfo: TypeInfo = { type: { kind: 'atomic', name: 'BOOL' }, dims: null };
    const narrow: 'SINT' | 'INT' | null = b.atype === 'SINT' || b.atype === 'INT' ? b.atype : null;
    if (!dynamic && typeof b.index === 'number') {
      const h = sHolder;
      const k = sKey;
      const mask = b.index === 31 ? DINT_MIN : 1 << b.index;
      const shift = b.index;
      return {
        ...common,
        element: undefined,
        kind: 'atomic',
        atype: 'BOOL',
        info: boolInfo,
        isConst: false,
        get: () => (h[k] >>> shift) & 1,
        set: narrow
          ? (v) => {
              h[k] = wrapInt(narrow, v !== 0 && v === v ? h[k] | mask : h[k] & ~mask);
              return false;
            }
          : (v) => {
              h[k] = v !== 0 && v === v ? h[k] | mask : h[k] & ~mask;
              return false;
            },
      };
    }
    const gh = getHolder;
    const gk = getKey;
    const bi = typeof b.index === 'number' ? (() => b.index as number) : b.index;
    return {
      ...common,
      element: undefined,
      kind: 'atomic',
      atype: 'BOOL',
      info: boolInfo,
      isConst: false,
      get: () => (gh()[gk()] >>> bi()) & 1,
      set: (v) => {
        const h = gh();
        const k = gk();
        const i = bi();
        const mask = i === 31 ? DINT_MIN : 1 << i;
        const nv = v !== 0 && v === v ? h[k] | mask : h[k] & ~mask;
        h[k] = narrow ? wrapInt(narrow, nv) : nv;
        return false;
      },
    };
  }

  if (info.dims) {
    const length = info.dims.reduce((a, x) => a * x, 1);
    const getArr = dynamic ? ((gh, gk) => () => gh()[gk()])(getHolder, getKey) : ((h, k) => () => h[k])(sHolder, sKey);
    return { ...common, kind: 'array', info, length, get: getArr };
  }
  if (info.type.kind === 'struct') {
    const getObj = dynamic ? ((gh, gk) => () => gh()[gk()])(getHolder, getKey) : ((h, k) => () => h[k])(sHolder, sKey);
    return { ...common, kind: 'struct', info, stype: info.type, get: getObj };
  }
  const atype = info.type.name;
  if (!dynamic) {
    const h = sHolder;
    const k = sKey;
    return { ...common, kind: 'atomic', atype, info, isConst: false, get: () => h[k], set: staticSetter(atype, h, k) };
  }
  const gh = getHolder;
  const gk = getKey;
  return { ...common, kind: 'atomic', atype, info, isConst: false, get: () => gh()[gk()], set: atomicSetter(atype, gh, gk) };
}

function reg(tag: Tag, name: string): DataType | undefined {
  return tag.scope.types.get(name);
}

export { DINT_MAX, DINT_MIN };
