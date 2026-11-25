/**
 * File/Shift instructions: BSL, BSR (bit shift registers), FFL, FFU (FIFO) and
 * LFL, LFU (LIFO).
 *
 * All six are output box instructions that pass rung-condition-in through and
 * keep their state in a CONTROL tag:
 *  - The literal Length (and Position for FIFO/LIFO) operands are written into
 *    the CONTROL's .LEN (.POS) at download. At run time the instructions only use
 *    the live .LEN/.POS members, so logic or the watch window may change them.
 *  - BSL/BSR act once per false -> true transition of the rung (.EN is the edge
 *    memory). A bit shift moves .LEN bits across consecutive DINT elements,
 *    starting at the Array operand's element.
 *  - FFL/LFL use .EN as load-edge memory, FFU/LFU use .EU as unload-edge memory,
 *    so a load and an unload instruction can share one CONTROL tag. .DN (full)
 *    and .EM (empty) are refreshed on every execution.
 *
 * The array operands are compiled with `c.span`; at run time the instructions
 * work directly on the backing array (resolved once per execution) so a shift
 * does no per-element bounds checks or allocation.
 */
import type { Executable, InstrCompiler, InstructionDef, OperandSpec, Span } from './registry';
import type { Runtime } from '../../core/runtime';
import type { AtomicRef, Ref, StructRef } from '../../core/refs';
import { FAULT } from '../../core/faults';
import { DINT_MAX, convert, copyInto, type StructValue, type Value } from '../../core/values';
import type { AtomicTypeName } from '../../core/datatypes';

/** Live CONTROL structure (members keyed by canonical name). */
interface ControlObj {
  LEN: number;
  POS: number;
  EN: number;
  EU: number;
  DN: number;
  EM: number;
  ER: number;
  UL: number;
  IN: number;
  FD: number;
}

// ----------------------------------------------------------------------------- backing storage

/**
 * Raw access to the elements of a span. `open()` resolves (once per execution)
 * the backing array, the flat index of the start element and the number of
 * elements available from it; `close()` commits a scalar atomic operand.
 */
interface Cells {
  arr: Value[];
  base: number;
  n: number;
  open(): void;
  close(): void;
}

function cellsOf(span: Span): Cells {
  const r: Ref = span.ref;
  if (r.kind === 'array') {
    const get = r.get;
    const len = r.length;
    const cells: Cells = {
      arr: [],
      base: 0,
      n: len,
      open() {
        cells.arr = get();
      },
      close() {},
    };
    return cells;
  }
  if (r.element) {
    const e = r.element;
    const len = e.length;
    const cells: Cells = {
      arr: [],
      base: 0,
      n: 0,
      open() {
        // index() validates an indirect subscript (Type 4 Code 20 when out of range)
        const b = e.index();
        cells.arr = e.array();
        cells.base = b;
        cells.n = len - b;
      },
      close() {},
    };
    return cells;
  }
  // A scalar is a span of one element.
  const scratch: Value[] = [0];
  if (r.kind === 'struct') {
    const get = r.get;
    return {
      arr: scratch,
      base: 0,
      n: 1,
      open() {
        scratch[0] = get();
      },
      close() {},
    };
  }
  const a = r as AtomicRef;
  return {
    arr: scratch,
    base: 0,
    n: 1,
    open() {
      scratch[0] = a.get();
    },
    close() {
      a.set(scratch[0] as number);
    },
  };
}

/** Logix conversion into an atomic element type (fast path for in-range DINT). */
function storeFn(t: AtomicTypeName): (v: number) => number {
  switch (t) {
    case 'REAL':
      return Math.fround;
    case 'DINT':
      return (v) => ((v | 0) === v ? v : convert('DINT', v).value);
    default:
      return (v) => convert(t, v).value;
  }
}

/** Set every atomic member of a structure (recursively, arrays included) to zero. */
function zeroStruct(o: StructValue): void {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'number') o[k] = 0;
    else if (Array.isArray(v)) zeroArray(v);
    else zeroStruct(v);
  }
}

function zeroArray(a: Value[]): void {
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (typeof v === 'number') a[i] = 0;
    else if (Array.isArray(v)) zeroArray(v);
    else zeroStruct(v);
  }
}

// ----------------------------------------------------------------------------- common operand helpers

/** CONTROL operand (must be writable). */
function controlOperand(c: InstrCompiler, i: number): StructRef {
  const ref = c.struct(i, 'CONTROL');
  if (ref.tag && !ref.writable) c.error(i, `'${ref.text}' is read-only`);
  return ref;
}

/** Apply the literal Length (and Position) into the CONTROL tag at download. */
function applyAtDownload(c: InstrCompiler, ctrl: StructRef, len: number | null, pos: number | null | undefined): void {
  if (len === null || pos === null) return;
  const get = ctrl.get as unknown as () => ControlObj;
  c.onDownload(() => {
    let o: ControlObj;
    try {
      o = get();
    } catch {
      // An indirect subscript that is out of range at download: nothing to apply.
      return;
    }
    o.LEN = len;
    if (pos !== undefined) o.POS = pos;
  });
}

/** Bind a per-scan step and a prescan action to the CONTROL object. */
function withControl(ctrl: StructRef, step: (o: ControlObj, rin: boolean) => void, prescan: (o: ControlObj) => void): Executable {
  const get = ctrl.get as unknown as () => ControlObj;
  if (ctrl.isStatic) {
    const o = get();
    return {
      exec(rin) {
        step(o, rin);
        return rin;
      },
      prescan() {
        prescan(o);
      },
    };
  }
  return {
    exec(rin) {
      step(get(), rin);
      return rin;
    },
    prescan() {
      // An indirect CONTROL element is resolved with the current subscript value.
      let o: ControlObj;
      try {
        o = get();
      } catch {
        return;
      }
      prescan(o);
    },
  };
}

function badControl(rt: Runtime, o: ControlObj, what: string): never {
  o.ER = 1;
  return rt.majorFault(FAULT.ARRAY_SUBSCRIPT, what);
}

// ----------------------------------------------------------------------------- BSL / BSR

/**
 * Shift .LEN bits of the DINT elements arr[base..] one position.
 * Bit k is bit (k % 32) of element base + floor(k / 32). Bits at index >= len
 * are untouched. Returns the bit shifted out (.UL).
 */
function shiftLeft(arr: Value[], base: number, len: number, src: number): number {
  const words = (len + 31) >>> 5;
  const lastBits = len - ((words - 1) << 5); // 1..32
  const mask = (-1 >>> (32 - lastBits)) | 0;
  const last = base + words - 1;
  const ul = ((arr[last] as number) >>> (lastBits - 1)) & 1;
  let carry = src;
  for (let w = base; w < last; w++) {
    const v = arr[w] as number;
    arr[w] = (v << 1) | carry;
    carry = v >>> 31;
  }
  const v = arr[last] as number;
  arr[last] = (v & ~mask) | (((v << 1) | carry) & mask);
  return ul;
}

function shiftRight(arr: Value[], base: number, len: number, src: number): number {
  const words = (len + 31) >>> 5;
  const lastBits = len - ((words - 1) << 5); // 1..32
  const mask = (-1 >>> (32 - lastBits)) | 0;
  const last = base + words - 1;
  const ul = (arr[base] as number) & 1;
  const lv = arr[last] as number;
  let carry = lv & 1;
  arr[last] = (lv & ~mask) | ((((lv & mask) >>> 1) | (src << (lastBits - 1))) & mask);
  for (let w = last - 1; w >= base; w--) {
    const v = arr[w] as number;
    arr[w] = (v >>> 1) | (carry << 31);
    carry = v & 1;
  }
  return ul;
}

function compileBitShift(c: InstrCompiler, shift: typeof shiftLeft): Executable {
  const span = c.span(0, { write: true, types: ['DINT'] });
  const ctrl = controlOperand(c, 1);
  const srcBit = c.bit(2);
  const len = c.immediate(3, { integer: true, min: 0, max: DINT_MAX });
  applyAtDownload(c, ctrl, len, undefined);

  const rt = c.rt;
  const cells = cellsOf(span);
  const srcGet = srcBit.get;
  const label = span.ref.text;

  return withControl(
    ctrl,
    (o, rin) => {
      if (!rin) {
        o.EN = 0;
        o.DN = 0;
        o.ER = 0;
        o.POS = 0;
        return;
      }
      if (o.EN) return;
      o.EN = 1;
      const n = o.LEN;
      cells.open();
      if (n < 0 || n > 32 * cells.n) badControl(rt, o, `${label}: .LEN ${n} with ${cells.n * 32} bit(s) available`);
      if (n === 0) {
        o.DN = 1;
        return;
      }
      const src = srcGet() ? 1 : 0;
      o.UL = shift(cells.arr, cells.base, n, src);
      cells.close();
      o.DN = 1;
      o.POS = n;
    },
    (o) => {
      o.EN = 0;
      o.DN = 0;
      o.ER = 0;
      o.POS = 0;
    },
  );
}

const bitShiftOperands: OperandSpec[] = [
  { name: 'Array', kind: 'array', description: 'DINT array (first element to shift)' },
  { name: 'Control', kind: 'control' },
  { name: 'Source Bit', kind: 'bit', description: 'Bit shifted into the array' },
  { name: 'Length', kind: 'immediate', description: 'Number of bits to shift' },
];

// ----------------------------------------------------------------------------- FIFO / LIFO

interface QueueOps {
  /** Element type is a structure */
  isStruct: boolean;
  /** Atomic element type (when not a structure) */
  atype: AtomicTypeName;
}

/** Compile the FIFO/LIFO array operand; reports BOOL / whole-bit misuse. */
function queueSpan(c: InstrCompiler, i: number): { span: Span; ok: boolean; ops: QueueOps } {
  const span = c.span(i, { write: true });
  // The fallback span of a failed operand is a literal constant.
  let ok = !(span.ref.kind === 'atomic' && span.ref.isConst);
  const t = span.info.type;
  if (ok && t.kind === 'atomic' && t.name === 'BOOL') {
    c.error(i, `Invalid data type: '${span.ref.text}' is BOOL; an array of SINT, INT, DINT, REAL or a structure is required`);
    ok = false;
  }
  return { span, ok, ops: { isStruct: t.kind === 'struct', atype: t.kind === 'atomic' ? t.name : 'DINT' } };
}

/** Describe a reference's type for messages. */
function refType(r: Ref): string {
  if (r.kind === 'array') return `an array of ${r.info.type.name}`;
  if (r.kind === 'struct') return r.stype.name;
  return r.atype;
}

/** Check that element operand `r` (Source or Dest) is compatible with the queue element type. */
function checkElement(c: InstrCompiler, i: number, r: Ref, span: Span, role: string): boolean {
  const t = span.info.type;
  const what = refType(r);
  if (r.kind === 'array') {
    c.error(i, `Invalid data type: ${role} '${r.text}' is ${what}; a single element is required`);
    return false;
  }
  if (t.kind === 'struct') {
    if (r.kind !== 'struct' || r.stype !== t) {
      c.error(i, `Invalid data type: ${role} '${r.text}' is ${what}; ${t.name} is required to match the ${t.name} elements`);
      return false;
    }
    return true;
  }
  if (r.kind !== 'atomic' || r.atype === 'BOOL') {
    c.error(i, `Invalid data type: ${role} '${r.text}' is ${what}; SINT, INT, DINT or REAL is required`);
    return false;
  }
  return true;
}

/** Source operand of FFL/LFL: returns a function storing the source into arr[k]. */
function loader(c: InstrCompiler, i: number, span: Span, spanOk: boolean, ops: QueueOps): (arr: Value[], k: number) => void {
  const r = c.ref(i);
  if (!r || !spanOk || !checkElement(c, i, r, span, 'Source')) return () => {};
  if (ops.isStruct) {
    const get = (r as StructRef).get;
    return (arr, k) => copyInto(arr[k] as StructValue, get());
  }
  const get = (r as AtomicRef).get;
  const store = storeFn(ops.atype);
  return (arr, k) => {
    arr[k] = store(get());
  };
}

/**
 * Dest operand of FFU/LFU: returns a function copying arr[k] into the destination.
 * Called with k < 0 when the queue is empty: Logix returns 0 to the destination.
 */
function unloader(c: InstrCompiler, i: number, span: Span, spanOk: boolean, ops: QueueOps): (arr: Value[], k: number) => void {
  const r = c.ref(i, { write: true });
  if (!r || !spanOk || !checkElement(c, i, r, span, 'Dest')) return () => {};
  if (ops.isStruct) {
    const get = (r as StructRef).get;
    return (arr, k) => (k < 0 ? zeroStruct(get()) : copyInto(get(), arr[k] as StructValue));
  }
  const set = (r as AtomicRef).set;
  return (arr, k) => {
    set(k < 0 ? 0 : (arr[k] as number));
  };
}

/** Clear element arr[k] (structures: every atomic member). */
function clearer(ops: QueueOps): (arr: Value[], k: number) => void {
  if (ops.isStruct) return (arr, k) => zeroStruct(arr[k] as StructValue);
  return (arr, k) => {
    arr[k] = 0;
  };
}

const EMPTY: Value[] = [];

function refreshStatus(o: ControlObj): void {
  o.DN = o.POS >= o.LEN ? 1 : 0;
  o.EM = o.POS === 0 ? 1 : 0;
}

/** Length (>= 1) and Position (>= 0) literals, applied to the CONTROL at download. */
function queueLiterals(c: InstrCompiler, ctrl: StructRef, lenIdx: number): void {
  const len = c.immediate(lenIdx, { integer: true, min: 1, max: DINT_MAX });
  const pos = c.immediate(lenIdx + 1, { integer: true, min: 0, max: DINT_MAX });
  applyAtDownload(c, ctrl, len, pos);
}

/** FFL and LFL (identical load behaviour). */
function compileLoad(c: InstrCompiler): Executable {
  const { span, ok, ops } = queueSpan(c, 1);
  const load = loader(c, 0, span, ok, ops);
  const ctrl = controlOperand(c, 2);
  queueLiterals(c, ctrl, 3);

  const rt = c.rt;
  const cells = cellsOf(span);
  const label = span.ref.text;

  return withControl(
    ctrl,
    (o, rin) => {
      if (!rin) o.EN = 0;
      else if (!o.EN) {
        o.EN = 1;
        const pos = o.POS;
        const len = o.LEN;
        if (pos < len) {
          cells.open();
          if (pos < 0 || len > cells.n) badControl(rt, o, `${label}: .POS ${pos}, .LEN ${len} with ${cells.n} element(s) available`);
          load(cells.arr, cells.base + pos);
          cells.close();
          o.POS = pos + 1;
        }
      }
      refreshStatus(o);
    },
    (o) => {
      // Prevents a false load when the rung is already true on the first scan.
      o.EN = 1;
    },
  );
}

/** FFU: unload element 0 and shift the whole .LEN elements down. */
function compileFifoUnload(c: InstrCompiler): Executable {
  const { span, ok, ops } = queueSpan(c, 0);
  const unload = unloader(c, 1, span, ok, ops);
  const ctrl = controlOperand(c, 2);
  queueLiterals(c, ctrl, 3);

  const rt = c.rt;
  const cells = cellsOf(span);
  const clear = clearer(ops);
  const isStruct = ops.isStruct;
  const label = span.ref.text;

  return withControl(
    ctrl,
    (o, rin) => {
      if (!rin) o.EU = 0;
      else if (!o.EU) {
        o.EU = 1;
        const pos = o.POS;
        if (pos > 0) {
          const len = o.LEN;
          cells.open();
          if (len < 1 || len > cells.n) badControl(rt, o, `${label}: .LEN ${len} with ${cells.n} element(s) available`);
          const arr = cells.arr;
          const b = cells.base;
          unload(arr, b);
          if (isStruct) for (let i = 0; i < len - 1; i++) copyInto(arr[b + i] as StructValue, arr[b + i + 1] as StructValue);
          else arr.copyWithin(b, b + 1, b + len);
          clear(arr, b + len - 1);
          cells.close();
          o.POS = pos - 1;
        } else unload(EMPTY, -1); // empty: Dest = 0
      }
      refreshStatus(o);
    },
    (o) => {
      o.EU = 1;
    },
  );
}

/** LFU: unload the last loaded element (.POS - 1). */
function compileLifoUnload(c: InstrCompiler): Executable {
  const { span, ok, ops } = queueSpan(c, 0);
  const unload = unloader(c, 1, span, ok, ops);
  const ctrl = controlOperand(c, 2);
  queueLiterals(c, ctrl, 3);

  const rt = c.rt;
  const cells = cellsOf(span);
  const clear = clearer(ops);
  const label = span.ref.text;

  return withControl(
    ctrl,
    (o, rin) => {
      if (!rin) o.EU = 0;
      else if (!o.EU) {
        o.EU = 1;
        const pos = o.POS;
        if (pos > 0) {
          const len = o.LEN;
          cells.open();
          if (len < 1 || len > cells.n || pos > cells.n)
            badControl(rt, o, `${label}: .POS ${pos}, .LEN ${len} with ${cells.n} element(s) available`);
          const k = cells.base + pos - 1;
          unload(cells.arr, k);
          clear(cells.arr, k);
          cells.close();
          o.POS = pos - 1;
        } else unload(EMPTY, -1); // empty: Dest = 0
      }
      refreshStatus(o);
    },
    (o) => {
      o.EU = 1;
    },
  );
}

const lengthOperand: OperandSpec = { name: 'Length', kind: 'immediate', description: 'Number of elements (applied to .LEN at download)' };
const positionOperand: OperandSpec = { name: 'Position', kind: 'immediate', description: 'Initial position (applied to .POS at download)' };

export const fileInstructions: InstructionDef[] = [
  {
    mnemonic: 'BSL',
    category: 'File/Shift',
    title: 'Bit Shift Left',
    kind: 'output',
    box: true,
    operands: bitShiftOperands,
    compile: (c) => compileBitShift(c, shiftLeft),
  },
  {
    mnemonic: 'BSR',
    category: 'File/Shift',
    title: 'Bit Shift Right',
    kind: 'output',
    box: true,
    operands: bitShiftOperands,
    compile: (c) => compileBitShift(c, shiftRight),
  },
  {
    mnemonic: 'FFL',
    category: 'File/Shift',
    title: 'FIFO Load',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Source', kind: 'source', description: 'Value or structure to load' },
      { name: 'FIFO', kind: 'array', description: 'First element of the FIFO array' },
      { name: 'Control', kind: 'control' },
      lengthOperand,
      positionOperand,
    ],
    compile: compileLoad,
  },
  {
    mnemonic: 'FFU',
    category: 'File/Shift',
    title: 'FIFO Unload',
    kind: 'output',
    box: true,
    operands: [
      { name: 'FIFO', kind: 'array', description: 'First element of the FIFO array' },
      { name: 'Dest', kind: 'dest', description: 'Receives the unloaded element' },
      { name: 'Control', kind: 'control' },
      lengthOperand,
      positionOperand,
    ],
    compile: compileFifoUnload,
  },
  {
    mnemonic: 'LFL',
    category: 'File/Shift',
    title: 'LIFO Load',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Source', kind: 'source', description: 'Value or structure to load' },
      { name: 'LIFO', kind: 'array', description: 'First element of the LIFO array' },
      { name: 'Control', kind: 'control' },
      lengthOperand,
      positionOperand,
    ],
    compile: compileLoad,
  },
  {
    mnemonic: 'LFU',
    category: 'File/Shift',
    title: 'LIFO Unload',
    kind: 'output',
    box: true,
    operands: [
      { name: 'LIFO', kind: 'array', description: 'First element of the LIFO array' },
      { name: 'Dest', kind: 'dest', description: 'Receives the unloaded element' },
      { name: 'Control', kind: 'control' },
      lengthOperand,
      positionOperand,
    ],
    compile: compileLifoUnload,
  },
];
