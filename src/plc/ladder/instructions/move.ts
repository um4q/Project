/**
 * Move/Logical instructions: MOV, MVM, CLR, AND, OR, XOR, NOT, COP, FLL.
 *
 * All of them are output box instructions that act only while the rung is
 * true and pass rung-condition-in through. None has a prescan action.
 *
 * Bitwise instructions work on 32-bit two's complement values (SINT/INT
 * sources are sign-extended). When the destination is narrower the low bits
 * are kept without flagging an overflow.
 *
 * COP copies bytes (no numeric conversion) and FLL fills with a converted
 * value; both clamp to the end of the destination (and COP to the end of the
 * source) and never fault for running off an array.
 */
import type { InstructionDef, InstrCompiler, Executable, Span } from './registry';
import type { AtomicRef, Ref } from '../../core/refs';
import type { AtomicTypeName, StructType, TypeRegistry } from '../../core/datatypes';
import { FAULT } from '../../core/faults';
import { atomicSize, convert, copyInto, type StructValue, type Value } from '../../core/values';

// ----------------------------------------------------------------------------- helpers

/** Bit pattern -> destination width, keeping the low bits (no overflow). */
function narrower(t: AtomicTypeName): (v: number) => number {
  switch (t) {
    case 'SINT':
      return (v) => (v << 24) >> 24;
    case 'INT':
      return (v) => (v << 16) >> 16;
    default:
      return (v) => v | 0;
  }
}

/** Logix numeric conversion into `t`, without overflow reporting (fast path avoids allocation). */
function converter(t: AtomicTypeName): (v: number) => number {
  switch (t) {
    case 'BOOL':
      return (v) => (v !== 0 && v === v ? 1 : 0);
    case 'REAL':
      return Math.fround;
    case 'DINT':
      return (v) => ((v | 0) === v ? v : convert('DINT', v).value);
    case 'INT':
      return (v) => (v >= -32768 && v <= 32767 && (v | 0) === v ? v : convert('INT', v).value);
    default:
      return (v) => (v >= -128 && v <= 127 && (v | 0) === v ? v : convert('SINT', v).value);
  }
}

/**
 * Direct access to the memory behind a span operand, resolved once per
 * execution (the span helpers re-evaluate the subscript on every element).
 * A scalar is presented as a one-element box; an atomic scalar destination is
 * written back with `commit()`.
 */
interface Region {
  /** Elements in the backing store (array length, or 1 for a scalar) */
  total: number;
  /** Backing array for this execution */
  arr: () => Value[];
  /** Start element (evaluates a dynamic subscript; faults when out of range) */
  start: () => number;
  /** Store the box back into an atomic scalar (no-op otherwise) */
  commit: () => void;
}

const noop = () => {};

function region(ref: Ref): Region {
  if (ref.kind === 'array') return { total: ref.length, arr: ref.get, start: () => 0, commit: noop };
  if (ref.element) {
    const el = ref.element;
    return { total: el.length, arr: el.array, start: el.index, commit: noop };
  }
  const box: Value[] = [0];
  if (ref.kind === 'struct') {
    const get = ref.get;
    return {
      total: 1,
      arr: () => {
        box[0] = get();
        return box;
      },
      start: () => 0,
      commit: noop,
    };
  }
  const get = ref.get;
  const set = ref.set;
  return {
    total: 1,
    arr: () => {
      box[0] = get();
      return box;
    },
    start: () => 0,
    commit: () => {
      set(box[0] as number);
    },
  };
}

function sameElementType(a: Span, b: Span): boolean {
  const ta = a.info.type;
  const tb = b.info.type;
  if (ta.kind === 'atomic' && tb.kind === 'atomic') return ta.name === tb.name;
  return ta === tb;
}

/** Length operand: literal or integer tag; negative is a major fault at run time. */
function lengthOperand(c: InstrCompiler, i: number): () => number {
  return c.source(i, { integer: true }).get;
}

type ByteWriter = (dv: DataView, off: number, v: number) => void;
type ByteReader = (dv: DataView, off: number) => number;

function byteWriter(t: AtomicTypeName): ByteWriter {
  switch (t) {
    case 'BOOL':
      return (dv, o, v) => dv.setUint8(o, v ? 1 : 0);
    case 'SINT':
      return (dv, o, v) => dv.setInt8(o, v);
    case 'INT':
      return (dv, o, v) => dv.setInt16(o, v, true);
    case 'DINT':
      return (dv, o, v) => dv.setInt32(o, v, true);
    default:
      return (dv, o, v) => dv.setFloat32(o, v, true);
  }
}

function byteReader(t: AtomicTypeName): ByteReader {
  switch (t) {
    case 'BOOL':
      return (dv, o) => (dv.getUint8(o) !== 0 ? 1 : 0);
    case 'SINT':
      return (dv, o) => dv.getInt8(o);
    case 'INT':
      return (dv, o) => dv.getInt16(o, true);
    case 'DINT':
      return (dv, o) => dv.getInt32(o, true);
    default:
      return (dv, o) => dv.getFloat32(o, true);
  }
}

// ----------------------------------------------------------------------------- bitwise

type BinOp = (a: number, b: number) => number;

/**
 * Logical instructions zero-fill smaller integer operands (Logix: "Logical
 * instructions use zero fill. All other instructions use sign-extension.").
 * When all operands share one type the stored low bits are the same either way.
 */
function zeroFilled(r: AtomicRef): () => number {
  const g = r.get;
  if (r.atype === 'SINT') return () => g() & 0xff;
  if (r.atype === 'INT') return () => g() & 0xffff;
  return g;
}

/** AND / OR / XOR: Source A, Source B, Dest (integers). */
function bitwise2(mnemonic: string, title: string, op: BinOp): InstructionDef {
  return {
    mnemonic,
    category: 'Move/Logical',
    title,
    kind: 'output',
    box: true,
    operands: [
      { name: 'Source A', kind: 'source' },
      { name: 'Source B', kind: 'source' },
      { name: 'Dest', kind: 'dest' },
    ],
    compile(c) {
      const a = zeroFilled(c.source(0, { integer: true }));
      const b = zeroFilled(c.source(1, { integer: true }));
      const dst = c.dest(2, { integer: true });
      const set = dst.set;
      const wrap = narrower(dst.atype);
      const rt = c.rt;
      return {
        exec(rin) {
          if (rin) {
            const v = wrap(op(a(), b()));
            set(v);
            rt.setArith(v, false);
          }
          return rin;
        },
      };
    },
  };
}

// ----------------------------------------------------------------------------- COP

function compileCop(c: InstrCompiler): Executable {
  const sspan = c.span(0);
  const dspan = c.span(1, { write: true });
  const length = lengthOperand(c, 2);
  const rt = c.rt;
  const st = sspan.info.type;
  const dt = dspan.info.type;
  const same = sameElementType(sspan, dspan);
  rejectBool(c, 0, sspan);
  rejectBool(c, 1, dspan);
  if (!c.failed && !same && (st.kind === 'struct' || dt.kind === 'struct')) {
    c.error(
      -1,
      `Source is ${st.name} and Dest is ${dt.name}: LogixSim only supports COP between identical structure types (or between atomic types)`,
    );
  }
  const S = region(sspan.ref);
  const D = region(dspan.ref);

  const checkLength = (len: number) => {
    if (len < 0) rt.majorFault(FAULT.ARRAY_SUBSCRIPT, `COP length ${len} is negative`);
  };

  if (same) {
    const isStruct = dt.kind === 'struct';
    return {
      exec(rin) {
        if (!rin) return rin;
        const len = length();
        checkLength(len);
        if (len === 0) return rin;
        const sa = S.arr();
        const ss = S.start();
        const da = D.arr();
        const ds = D.start();
        let n = D.total - ds;
        if (len < n) n = len;
        if (S.total - ss < n) n = S.total - ss;
        // memmove semantics: copy backwards when shifting up within one array
        const backward = sa === da && ds > ss;
        if (isStruct) {
          if (backward) for (let i = n - 1; i >= 0; i--) copyInto(da[ds + i] as StructValue, sa[ss + i] as StructValue);
          else for (let i = 0; i < n; i++) copyInto(da[ds + i] as StructValue, sa[ss + i] as StructValue);
        } else {
          if (backward) for (let i = n - 1; i >= 0; i--) da[ds + i] = sa[ss + i];
          else for (let i = 0; i < n; i++) da[ds + i] = sa[ss + i];
          D.commit();
        }
        return rin;
      },
    };
  }

  // Different atomic types: reinterpret the bytes (little-endian, REAL as float32).
  const sType = (st.kind === 'atomic' ? st.name : 'DINT') as AtomicTypeName;
  const dType = (dt.kind === 'atomic' ? dt.name : 'DINT') as AtomicTypeName;
  const sSize = atomicSize(sType);
  const dSize = atomicSize(dType);
  const dv = new DataView(new ArrayBuffer(D.total * dSize + 4));
  const write = byteWriter(sType);
  const writeDst = byteWriter(dType);
  const read = byteReader(dType);
  return {
    exec(rin) {
      if (!rin) return rin;
      const len = length();
      checkLength(len);
      if (len === 0) return rin;
      const sa = S.arr();
      const ss = S.start();
      const da = D.arr();
      const ds = D.start();
      let dn = D.total - ds;
      if (len < dn) dn = len;
      let bytes = dn * dSize;
      const sBytes = (S.total - ss) * sSize;
      if (sBytes < bytes) bytes = sBytes;
      const sn = Math.ceil(bytes / sSize);
      dn = Math.ceil(bytes / dSize);
      // A partially overwritten last destination element keeps its other bytes.
      if (bytes % dSize !== 0) writeDst(dv, (dn - 1) * dSize, da[ds + dn - 1] as number);
      for (let i = 0; i < sn; i++) write(dv, i * sSize, sa[ss + i] as number);
      for (let i = 0; i < dn; i++) da[ds + i] = read(dv, i * dSize);
      D.commit();
      return rin;
    },
  };
}

// ----------------------------------------------------------------------------- FLL

/** BOOL arrays are bit-packed in Logix memory: COP and FLL do not accept BOOL operands. */
function rejectBool(c: InstrCompiler, i: number, span: Span): void {
  const t = span.info.type;
  if (!c.failed && t.kind === 'atomic' && t.name === 'BOOL') c.error(i, `Invalid data type: '${c.operands[i]}' is BOOL; SINT, INT, DINT, REAL or a structure is required`);
}

/** Build a filler that sets every atomic member of a structure (recursively) to a converted value. */
function structFiller(type: StructType, reg: TypeRegistry | undefined): (obj: StructValue, v: number) => void {
  const steps: ((obj: StructValue, v: number) => void)[] = [];
  for (const m of type.members) {
    const mt = reg?.get(m.dataType);
    const name = m.name;
    const isArr = !!(m.dims && m.dims.length);
    if (!mt || mt.kind === 'atomic') {
      const conv = converter(mt && mt.kind === 'atomic' ? mt.name : 'DINT');
      steps.push(
        isArr
          ? (o, v) => {
              const a = o[name] as Value[];
              const x = conv(v);
              for (let i = 0; i < a.length; i++) a[i] = x;
            }
          : (o, v) => {
              o[name] = conv(v);
            },
      );
    } else {
      const inner = structFiller(mt, reg);
      steps.push(
        isArr
          ? (o, v) => {
              for (const e of o[name] as Value[]) inner(e as StructValue, v);
            }
          : (o, v) => inner(o[name] as StructValue, v),
      );
    }
  }
  return (obj, v) => {
    for (const s of steps) s(obj, v);
  };
}

function compileFll(c: InstrCompiler): Executable {
  const dspan = c.span(1, { write: true });
  rejectBool(c, 1, dspan);
  const length = lengthOperand(c, 2);
  const rt = c.rt;
  const dt = dspan.info.type;
  const D = region(dspan.ref);
  const checkLength = (len: number) => {
    if (len < 0) rt.majorFault(FAULT.ARRAY_SUBSCRIPT, `FLL length ${len} is negative`);
  };

  if (dt.kind === 'struct') {
    const sref = c.ref(0);
    let sget: () => StructValue = () => ({});
    if (sref && sref.kind === 'atomic' && sref.atype !== 'BOOL') {
      // 'FLL 0 Udt[0] n' clears structures: every atomic member gets the (converted) source value
      const fill = structFiller(dt, dspan.ref.tag?.scope.types);
      const get = sref.get;
      return {
        exec(rin) {
          if (!rin) return rin;
          const len = length();
          checkLength(len);
          if (len === 0) return rin;
          const v = get();
          const da = D.arr();
          const ds = D.start();
          let n = D.total - ds;
          if (len < n) n = len;
          for (let i = 0; i < n; i++) fill(da[ds + i] as StructValue, v);
          return rin;
        },
      };
    }
    if (sref) {
      if (sref.kind !== 'struct' || sref.stype !== dt) {
        const what = sref.kind === 'array' ? `an array of ${sref.info.type.name}` : sref.kind === 'struct' ? sref.stype.name : sref.atype;
        c.error(0, `Invalid data type: Source '${sref.text}' is ${what}; a ${dt.name} is required to fill ${dt.name} elements`);
      } else sget = sref.get;
    }
    return {
      exec(rin) {
        if (!rin) return rin;
        const len = length();
        checkLength(len);
        if (len === 0) return rin;
        const src = sget();
        const da = D.arr();
        const ds = D.start();
        let n = D.total - ds;
        if (len < n) n = len;
        for (let i = 0; i < n; i++) {
          const e = da[ds + i] as StructValue;
          if (e !== src) copyInto(e, src);
        }
        return rin;
      },
    };
  }

  const src: AtomicRef = c.source(0);
  const get = src.get;
  const conv = converter(dt.kind === 'atomic' ? dt.name : 'DINT');
  return {
    exec(rin) {
      if (!rin) return rin;
      const len = length();
      checkLength(len);
      if (len === 0) return rin;
      const v = conv(get());
      const da = D.arr();
      const ds = D.start();
      let n = D.total - ds;
      if (len < n) n = len;
      for (let i = 0; i < n; i++) da[ds + i] = v;
      D.commit();
      return rin;
    },
  };
}

// ----------------------------------------------------------------------------- definitions

export const moveInstructions: InstructionDef[] = [
  {
    mnemonic: 'MOV',
    category: 'Move/Logical',
    title: 'Move',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Source', kind: 'source' },
      { name: 'Dest', kind: 'dest' },
    ],
    compile(c) {
      const get = c.source(0).get;
      const dst = c.dest(1);
      const set = dst.set;
      const dget = dst.get;
      const rt = c.rt;
      return {
        exec(rin) {
          if (rin) {
            const ov = set(get());
            rt.setArith(dget(), ov);
          }
          return rin;
        },
      };
    },
  },
  {
    mnemonic: 'MVM',
    category: 'Move/Logical',
    title: 'Masked Move',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Source', kind: 'source' },
      { name: 'Mask', kind: 'source' },
      { name: 'Dest', kind: 'dest' },
    ],
    compile(c) {
      const src = zeroFilled(c.source(0, { integer: true }));
      const mask = zeroFilled(c.source(1, { integer: true }));
      const dst = c.dest(2, { integer: true });
      const set = dst.set;
      const dget = dst.get;
      const wrap = narrower(dst.atype);
      const rt = c.rt;
      return {
        exec(rin) {
          if (rin) {
            const m = mask();
            const v = wrap((dget() & ~m) | (src() & m));
            set(v);
            rt.setArith(v, false);
          }
          return rin;
        },
      };
    },
  },
  {
    mnemonic: 'CLR',
    category: 'Move/Logical',
    title: 'Clear',
    kind: 'output',
    box: true,
    operands: [{ name: 'Dest', kind: 'dest' }],
    compile(c) {
      const set = c.dest(0).set;
      const rt = c.rt;
      return {
        exec(rin) {
          if (rin) {
            set(0);
            rt.setArith(0, false);
          }
          return rin;
        },
      };
    },
  },
  bitwise2('AND', 'Bitwise AND', (a, b) => a & b),
  bitwise2('OR', 'Bitwise OR', (a, b) => a | b),
  bitwise2('XOR', 'Bitwise Exclusive OR', (a, b) => a ^ b),
  {
    mnemonic: 'NOT',
    category: 'Move/Logical',
    title: 'Bitwise NOT',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Source', kind: 'source' },
      { name: 'Dest', kind: 'dest' },
    ],
    compile(c) {
      const src = zeroFilled(c.source(0, { integer: true }));
      const dst = c.dest(1, { integer: true });
      const set = dst.set;
      const wrap = narrower(dst.atype);
      const rt = c.rt;
      return {
        exec(rin) {
          if (rin) {
            const v = wrap(~src());
            set(v);
            rt.setArith(v, false);
          }
          return rin;
        },
      };
    },
  },
  {
    mnemonic: 'COP',
    category: 'Move/Logical',
    title: 'Copy File',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Source', kind: 'array', description: 'First element to copy' },
      { name: 'Dest', kind: 'array', description: 'First element to overwrite' },
      { name: 'Length', kind: 'source', description: 'Number of destination elements to copy' },
    ],
    compile: compileCop,
  },
  {
    mnemonic: 'FLL',
    category: 'Move/Logical',
    title: 'File Fill',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Source', kind: 'source', description: 'Value (or structure) to copy into each element' },
      { name: 'Dest', kind: 'array', description: 'First element to fill' },
      { name: 'Length', kind: 'source', description: 'Number of destination elements to fill' },
    ],
    compile: compileFll,
  },
];
