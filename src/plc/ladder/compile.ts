/**
 * Ladder (RLL) routine compiler and executor.
 *
 * Rung semantics (Logix):
 *  - Every instruction executes on every scan, with the rung-condition-in it
 *    receives (false conditions still run "false" actions: OTE clears, TON
 *    resets, ...).
 *  - A branch passes the same rung-condition-in to each leg (top to bottom) and
 *    its output is the OR of the leg outputs.
 *  - JMP/LBL, MCR zones, JSR/SBR/RET and the watchdog are handled here.
 */
import type { LadderElement, LadderInstr, Rung } from './ast';
import { isMissingOperand, countElements } from './ast';
import { parseRung, NeutralParseError } from './neutral';
import {
  failedExecutable,
  getInstruction,
  type Executable,
  type InstrCompiler,
  type RoutineHandle,
  type Span,
} from './instructions/registry';
import type { CompiledRoutine, RoutineCompileEnv, VerifyError } from '../engine/routines';
import { beginPrescanPass, currentPrescanPass } from '../engine/routines';
import type { RLLRoutineDef, RoutineDef } from '../engine/project';
import { compileRef, constRef, isRefError, type AtomicRef, type Ref, type StructRef } from '../core/refs';
import { parseExpression, parseLiteral, parseTagPath, ParseError } from '../expr/parser';
import { compileExpr, type CompiledExpr, type ExprEnv } from '../expr/compile';
import type { Expr } from '../expr/ast';
import { isNumericType } from '../core/datatypes';
import { FAULT } from '../core/faults';
import { copyInto, convert, type StructValue, type TypeInfo } from '../core/values';
import { validateName } from '../core/names';

// ----------------------------------------------------------------------------- operand compilation

const DUMMY_BOOL: AtomicRef = { ...constRef(0, false, '?'), atype: 'BOOL', info: { type: { kind: 'atomic', name: 'BOOL' }, dims: null } };

function dummyStruct(): StructRef {
  const obj: StructValue = {};
  return {
    kind: 'struct',
    stype: { kind: 'struct', name: '?', members: [], memberIndex: new Map(), origin: 'builtin' },
    text: '?',
    canonical: '?',
    tag: null,
    namedTag: null,
    info: { type: { kind: 'atomic', name: 'DINT' }, dims: null },
    writable: false,
    isIO: false,
    isStatic: true,
    get: () => obj,
  };
}

/** Compile helpers shared by the instruction compiler (also used by ST/FBD later). */
export class OperandCompiler {
  constructor(
    readonly env: RoutineCompileEnv,
    private readonly report: (operand: number, message: string, pos?: number) => void,
  ) {}

  get exprEnv(): ExprEnv {
    return {
      rt: this.env.rt,
      resolve: (path, text) => compileRef(this.env.scope, path, text, this.refEnv),
      error: (msg) => this.report(this.current, msg),
    };
  }

  /** Operand index being compiled (for error attribution inside expressions) */
  current = -1;

  get refEnv() {
    return {
      rt: this.env.rt,
      compileIndex: (e: Expr): (() => number) | null => {
        const ce = compileExpr(e, this.exprEnv);
        if (ce.cls === 'REAL') {
          this.report(this.current, 'Array subscript must be an integer expression');
          return null;
        }
        return ce.eval;
      },
    };
  }

  /** Compile a tag reference. Reports and returns null on error. */
  tagRef(i: number, text: string): Ref | null {
    this.current = i;
    let path;
    try {
      path = parseTagPath(text);
    } catch (e) {
      this.report(i, e instanceof ParseError ? `Invalid tag reference '${text}': ${e.message}` : String(e));
      return null;
    }
    const r = compileRef(this.env.scope, path, text, this.refEnv);
    if (isRefError(r)) {
      this.report(i, r.error);
      return null;
    }
    return r;
  }

  expression(i: number, text: string): CompiledExpr {
    this.current = i;
    let ast: Expr;
    try {
      ast = parseExpression(text);
    } catch (e) {
      this.report(i, e instanceof ParseError ? `Invalid expression: ${e.message}` : String(e));
      return { cls: 'DINT', eval: () => 0, constValue: 0, refs: [] };
    }
    return compileExpr(ast, this.exprEnv);
  }
}

function makeSpan(ref: Ref, rt: RoutineCompileEnv['rt']): Span {
  const elemInfo: TypeInfo = ref.kind === 'array' ? { type: ref.info.type, dims: null } : { type: ref.info.type, dims: null };
  const atomic = elemInfo.type.kind === 'atomic' ? elemInfo.type.name : null;
  const setInto = (arr: any, k: number, v: number): boolean => {
    const r = convert(atomic!, v);
    arr[k] = r.value;
    return r.overflow;
  };
  const checkRange = (start: number, i: number, n: number) => {
    if (i < 0 || start + i >= n) rt.majorFault(FAULT.ARRAY_SUBSCRIPT, `${ref.text}: element ${start + i} of ${n}`);
  };
  if (ref.kind === 'array') {
    const n = ref.length;
    return {
      info: elemInfo,
      ref,
      available: () => n,
      start: () => 0,
      get: (i) => {
        checkRange(0, i, n);
        return ref.get()[i] as number;
      },
      set: (i, v) => {
        checkRange(0, i, n);
        return setInto(ref.get(), i, v);
      },
      obj: (i) => {
        checkRange(0, i, n);
        return ref.get()[i] as StructValue;
      },
      assign: (i, v) => {
        checkRange(0, i, n);
        const arr = ref.get();
        if (typeof v === 'number') setInto(arr, i, v);
        else copyInto(arr[i] as StructValue, v);
      },
    };
  }
  if (ref.element) {
    const el = ref.element;
    const n = el.length;
    return {
      info: elemInfo,
      ref,
      available: () => n - el.index(),
      start: () => el.index(),
      get: (i) => {
        const s = el.index();
        checkRange(s, i, n);
        return el.array()[s + i] as number;
      },
      set: (i, v) => {
        const s = el.index();
        checkRange(s, i, n);
        return setInto(el.array(), s + i, v);
      },
      obj: (i) => {
        const s = el.index();
        checkRange(s, i, n);
        return el.array()[s + i] as StructValue;
      },
      assign: (i, v) => {
        const s = el.index();
        checkRange(s, i, n);
        const arr = el.array();
        if (typeof v === 'number') setInto(arr, s + i, v);
        else copyInto(arr[s + i] as StructValue, v);
      },
    };
  }
  // scalar: a span of one element
  return {
    info: elemInfo,
    ref,
    available: () => 1,
    start: () => 0,
    get: (i) => {
      checkRange(0, i, 1);
      return (ref as AtomicRef).get();
    },
    set: (i, v) => {
      checkRange(0, i, 1);
      return (ref as AtomicRef).set(v);
    },
    obj: (i) => {
      checkRange(0, i, 1);
      return (ref as StructRef).get();
    },
    assign: (i, v) => {
      checkRange(0, i, 1);
      if (typeof v === 'number') (ref as AtomicRef).set(v);
      else copyInto((ref as StructRef).get(), v);
    },
  };
}

class InstrCompilerImpl implements InstrCompiler {
  failed = false;
  private oc: OperandCompiler;

  constructor(
    private readonly env: RoutineCompileEnv,
    private readonly instr: LadderInstr,
    readonly routineName: string,
    readonly rung: number,
    readonly element: number,
  ) {
    this.oc = new OperandCompiler(env, (i, msg) => this.error(i, msg));
  }

  get rt() {
    return this.env.rt;
  }
  get mnemonic() {
    return this.instr.mnemonic;
  }
  get operands() {
    return this.instr.operands;
  }
  get programName() {
    return this.env.programName;
  }

  private push(severity: VerifyError['severity'], i: number, message: string) {
    this.env.errors.push({
      severity,
      message: `Rung ${this.rung}, ${this.mnemonic}${i >= 0 ? `, Operand ${i}` : ''}: ${message}`,
      program: this.env.programName,
      routine: this.routineName,
      rung: this.rung,
      element: this.element,
      operand: i >= 0 ? i : undefined,
    });
  }

  error(i: number, message: string): void {
    this.failed = true;
    this.push('error', i, message);
  }

  warning(i: number, message: string): void {
    this.push('warning', i, message);
  }

  private text(i: number): string | null {
    const t = this.instr.operands[i];
    if (isMissingOperand(t)) {
      this.error(i, 'Missing operand');
      return null;
    }
    return t.trim();
  }

  bit(i: number, opts: { write?: boolean } = {}): AtomicRef {
    const t = this.text(i);
    if (t === null) return DUMMY_BOOL;
    if (parseLiteral(t)) {
      this.error(i, 'Immediate value not allowed; a BOOL tag is required');
      return DUMMY_BOOL;
    }
    const r = this.oc.tagRef(i, t);
    if (!r) return DUMMY_BOOL;
    if (r.kind !== 'atomic' || r.atype !== 'BOOL') {
      this.error(i, `Invalid data type: '${t}' is ${typeLabel(r)}; BOOL required`);
      return DUMMY_BOOL;
    }
    if (opts.write && !r.writable) {
      this.error(i, `'${t}' is read-only`);
      return DUMMY_BOOL;
    }
    return r;
  }

  source(i: number, opts: { integer?: boolean; allowBool?: boolean } = {}): AtomicRef {
    const t = this.text(i);
    if (t === null) return constRef(0, false, '?');
    const lit = parseLiteral(t);
    if (lit) {
      if (opts.integer && lit.isReal) {
        this.error(i, 'Invalid data type: integer value required');
        return constRef(0, false, t);
      }
      if (!lit.isReal && (lit.value > 2147483647 || lit.value < -2147483648)) {
        this.error(i, `Immediate value ${t} is out of DINT range`);
        return constRef(0, false, t);
      }
      return constRef(lit.value, lit.isReal, t);
    }
    const r = this.oc.tagRef(i, t);
    if (!r) return constRef(0, false, t);
    return this.checkNumeric(i, t, r, opts) ?? constRef(0, false, t);
  }

  dest(i: number, opts: { integer?: boolean; allowBool?: boolean } = {}): AtomicRef {
    const t = this.text(i);
    if (t === null) return constRef(0, false, '?');
    if (parseLiteral(t)) {
      this.error(i, 'Immediate value not allowed; destination must be a tag');
      return constRef(0, false, t);
    }
    const r = this.oc.tagRef(i, t);
    if (!r) return constRef(0, false, t);
    const a = this.checkNumeric(i, t, r, opts);
    if (!a) return constRef(0, false, t);
    if (!a.writable) {
      this.error(i, `'${t}' is read-only`);
      return constRef(0, false, t);
    }
    return a;
  }

  private checkNumeric(i: number, t: string, r: Ref, opts: { integer?: boolean; allowBool?: boolean }): AtomicRef | null {
    if (r.kind !== 'atomic') {
      this.error(i, `Invalid data type: '${t}' is ${typeLabel(r)}; SINT, INT, DINT${opts.integer ? '' : ' or REAL'} required`);
      return null;
    }
    if (r.atype === 'BOOL' && !opts.allowBool) {
      this.error(i, `Invalid data type: '${t}' is BOOL; SINT, INT, DINT${opts.integer ? '' : ' or REAL'} required`);
      return null;
    }
    if (opts.integer && r.atype === 'REAL') {
      this.error(i, `Invalid data type: '${t}' is REAL; SINT, INT or DINT required`);
      return null;
    }
    if (r.atype !== 'BOOL' && !isNumericType(r.atype)) {
      this.error(i, `Invalid data type '${r.atype}'`);
      return null;
    }
    return r;
  }

  struct(i: number, typeName: string): StructRef {
    const t = this.text(i);
    if (t === null) return dummyStruct();
    if (parseLiteral(t)) {
      this.error(i, `Immediate value not allowed; ${typeName} tag required`);
      return dummyStruct();
    }
    const r = this.oc.tagRef(i, t);
    if (!r) return dummyStruct();
    if (r.kind !== 'struct' || r.stype.name.toLowerCase() !== typeName.toLowerCase()) {
      this.error(i, `Invalid data type: '${t}' is ${typeLabel(r)}; ${typeName} required`);
      return dummyStruct();
    }
    return r;
  }

  ref(i: number, opts: { write?: boolean } = {}): Ref | null {
    const t = this.text(i);
    if (t === null) return null;
    const lit = parseLiteral(t);
    if (lit) {
      if (opts.write) {
        this.error(i, 'Immediate value not allowed; a tag is required');
        return null;
      }
      return constRef(lit.value, lit.isReal, t);
    }
    const r = this.oc.tagRef(i, t);
    if (!r) return null;
    if (opts.write && !r.writable) {
      this.error(i, `'${t}' is read-only`);
      return null;
    }
    return r;
  }

  span(i: number, opts: { write?: boolean; atomicOnly?: boolean; types?: string[] } = {}): Span {
    const t = this.text(i);
    const fallback = () => makeSpan(constRef(0, false, t ?? '?'), this.env.rt);
    if (t === null) return fallback();
    if (parseLiteral(t)) {
      this.error(i, 'Immediate value not allowed; an array tag is required');
      return fallback();
    }
    const r = this.oc.tagRef(i, t);
    if (!r) return fallback();
    if (opts.write && !r.writable) {
      this.error(i, `'${t}' is read-only`);
      return fallback();
    }
    const elemType = r.info.type;
    if (opts.atomicOnly && elemType.kind !== 'atomic') {
      this.error(i, `Invalid data type: '${t}' must be an array of SINT, INT, DINT or REAL`);
      return fallback();
    }
    if (opts.types && !opts.types.some((x) => x.toLowerCase() === elemType.name.toLowerCase())) {
      this.error(i, `Invalid data type: '${t}' is ${elemType.name}; ${opts.types.join(', ')} required`);
      return fallback();
    }
    if (r.kind === 'atomic' && !r.element && r.atype === 'BOOL' && r.canonical.match(/\.\d+$|\.\[/)) {
      this.error(i, `'${t}': a bit cannot be used as an array`);
      return fallback();
    }
    return makeSpan(r, this.env.rt);
  }

  expression(i: number): CompiledExpr {
    const t = this.text(i);
    if (t === null) return { cls: 'DINT', eval: () => 0, constValue: 0, refs: [] };
    return this.oc.expression(i, t);
  }

  immediate(i: number, opts: { integer?: boolean; min?: number; max?: number } = {}): number | null {
    const t = this.text(i);
    if (t === null) return null;
    const lit = parseLiteral(t);
    if (!lit) {
      this.error(i, `Immediate value required, found '${t}'`);
      return null;
    }
    if (opts.integer && lit.isReal) {
      this.error(i, 'Integer immediate value required');
      return null;
    }
    if (opts.min !== undefined && lit.value < opts.min) {
      this.error(i, `Value ${lit.value} is less than the minimum ${opts.min}`);
      return null;
    }
    if (opts.max !== undefined && lit.value > opts.max) {
      this.error(i, `Value ${lit.value} is greater than the maximum ${opts.max}`);
      return null;
    }
    return lit.value;
  }

  literal(i: number): number | null {
    const t = this.instr.operands[i];
    if (isMissingOperand(t)) return null;
    return parseLiteral(t)?.value ?? null;
  }

  routine(i: number): RoutineHandle {
    const t = this.text(i);
    const name = t ?? '?';
    if (t !== null && !this.env.routineNames.has(t.toLowerCase())) this.error(i, `Routine '${t}' does not exist in program '${this.env.programName}'`);
    const env = this.env;
    return {
      name,
      get: () => {
        const r = env.getRoutine(name);
        if (!r) throw new Error(`Routine ${name} not found`);
        return r;
      },
    };
  }

  label(i: number): string {
    const t = this.text(i);
    if (t === null) return '?';
    const e = validateName(t, 'Label');
    if (e) this.error(i, e);
    return t.toLowerCase();
  }

  onDownload(fn: () => void): void {
    this.env.onDownload(fn);
  }
}

function typeLabel(r: Ref): string {
  if (r.kind === 'array') return `an array of ${r.info.type.name}`;
  if (r.kind === 'struct') return r.stype.name;
  return r.atype;
}

// ----------------------------------------------------------------------------- rung structure checks

function endsWithOutput(series: LadderElement[]): boolean {
  if (series.length === 0) return false;
  const last = series[series.length - 1];
  if (last.kind === 'branch') return last.legs.length > 0 && last.legs.every((l) => endsWithOutput(l));
  const def = getInstruction(last.mnemonic);
  return !def || def.kind !== 'input';
}

// ----------------------------------------------------------------------------- routine compiler

type ElemFn = (rungIn: boolean) => boolean;

export function compileLadderRoutine(rdef: RoutineDef, env: RoutineCompileEnv): CompiledRoutine {
  const def = rdef as RLLRoutineDef;
  const rt = env.rt;
  const rungs: Rung[] = [];
  const execs: ElemFn[] = [];
  const prescans: (() => void)[] = [];
  const power: Uint8Array[] = [];
  const labels = new Map<string, number>();
  const routineErr = (rung: number, message: string, element?: number) =>
    env.errors.push({ severity: 'error', message: `Rung ${rung}: ${message}`, program: env.programName, routine: def.name, rung, element });

  let sbrParams: number | null = null;

  def.rungs.forEach((rd, r) => {
    let rung: Rung;
    try {
      rung = parseRung(rd.text ?? '');
    } catch (e) {
      routineErr(r, e instanceof NeutralParseError ? e.message : String(e));
      rung = { elements: [] };
    }
    if (rd.comment) rung.comment = rd.comment;
    rungs.push(rung);
    const pf = new Uint8Array(countElements(rung.elements));
    power.push(pf);

    // structure checks
    if (rung.elements.length && !endsWithOutput(rung.elements)) routineErr(r, 'Rung must end with an output instruction');

    let nextId = 0;
    const compileSeries = (series: LadderElement[]): ElemFn => {
      const fns = series.map(compileElement);
      if (fns.length === 0) return (rin) => rin;
      if (fns.length === 1) return fns[0];
      if (fns.length === 2) {
        const [a, b] = fns;
        return (rin) => b(a(rin));
      }
      return (rin) => {
        let c = rin;
        for (let i = 0; i < fns.length; i++) c = fns[i](c);
        return c;
      };
    };
    const compileElement = (el: LadderElement, idx: number, series: LadderElement[]): ElemFn => {
      const id = nextId++;
      if (el.kind === 'branch') {
        if (el.legs.length < 2) routineErr(r, 'A branch needs at least two legs', id);
        const legs = el.legs.map((leg) => compileSeries(leg));
        return (rin) => {
          let out = false;
          for (let i = 0; i < legs.length; i++) if (legs[i](rin)) out = true;
          pf[id] = out ? 1 : 0;
          return out;
        };
      }
      const idef = getInstruction(el.mnemonic);
      if (!idef) {
        routineErr(r, `Unknown instruction '${el.mnemonic}'`, id);
        return (rin) => rin;
      }
      // placement rules
      const topLevelFirst = series === rung.elements && idx === 0;
      if (idef.mnemonic === 'LBL' && !topLevelFirst) routineErr(r, 'LBL must be the first instruction on the rung', id);
      if (idef.mnemonic === 'SBR' && !(topLevelFirst && r === 0)) routineErr(r, 'SBR must be the first instruction of the first rung', id);
      if (!idef.variadic && el.operands.length !== idef.operands.length) {
        routineErr(r, `${idef.mnemonic} expects ${idef.operands.length} operand(s), found ${el.operands.length}`, id);
        return (rin) => rin;
      }
      const c = new InstrCompilerImpl(env, el, def.name, r, id);
      let ex: Executable;
      try {
        ex = idef.compile(c);
      } catch (e) {
        routineErr(r, `${idef.mnemonic}: internal compile error: ${(e as Error).message}`, id);
        ex = failedExecutable;
      }
      if (c.failed) ex = failedExecutable;
      if (ex.prescan) prescans.push(ex.prescan.bind(ex));
      const exec = ex.exec;
      const loc = rt.loc;
      return (rin) => {
        loc.element = id;
        const out = exec(rin);
        pf[id] = out ? 1 : 0;
        return out;
      };
    };

    const first = rung.elements[0];
    if (first && first.kind === 'instr') {
      const m = first.mnemonic.toUpperCase();
      if (m === 'LBL') {
        const name = (first.operands[0] ?? '').trim().toLowerCase();
        if (name && name !== '?') {
          if (labels.has(name)) routineErr(r, `Label '${first.operands[0]}' is already used on rung ${labels.get(name)}`, 0);
          else labels.set(name, r);
        }
      }
      if (m === 'SBR' && r === 0) sbrParams = first.operands.filter((o) => !isMissingOperand(o)).length;
    }
    execs.push(compileSeries(rung.elements));
  });

  // JMP targets
  rungs.forEach((rung, r) => {
    let id = 0;
    const visit = (series: LadderElement[]) => {
      for (const el of series) {
        const myId = id++;
        if (el.kind === 'branch') el.legs.forEach(visit);
        else if (el.mnemonic.toUpperCase() === 'JMP') {
          const name = (el.operands[0] ?? '').trim().toLowerCase();
          if (name && name !== '?' && !labels.has(name)) routineErr(r, `JMP target label '${el.operands[0]}' does not exist in this routine`, myId);
        }
      }
    };
    visit(rung.elements);
  });

  const rungIn = new Uint8Array(rungs.length);
  const n = execs.length;
  let lastPrescan = -1;

  const routine: CompiledRoutine = {
    name: def.name,
    type: 'RLL',
    sbrParams,
    ladder: { rungs, power, rungIn },
    run() {
      const loc = rt.loc;
      const prevRoutine = loc.routine;
      const prevRung = loc.rung;
      const prevElement = loc.element;
      const prevMcrOpen = rt.mcrOpen;
      const prevMcrFalse = rt.mcrFalse;
      rt.mcrOpen = false;
      rt.mcrFalse = false;
      loc.routine = def.name;
      const frame = rt.frames[rt.frames.length - 1];
      let r = 0;
      while (r < n) {
        loc.rung = r;
        if (--rt.budget < 0) rt.majorFault(FAULT.WATCHDOG, `task exceeded ${rt.watchdogMs} ms`);
        const rin = !rt.mcrFalse;
        rungIn[r] = rin ? 1 : 0;
        execs[r](rin);
        if (rt.jumpLabel !== null) {
          const target = labels.get(rt.jumpLabel);
          rt.jumpLabel = null;
          if (target === undefined) rt.majorFault(FAULT.LABEL_NOT_FOUND);
          r = target as number;
          continue;
        }
        if (frame && frame.returned) break;
        r++;
      }
      rt.mcrOpen = prevMcrOpen;
      rt.mcrFalse = prevMcrFalse;
      loc.routine = prevRoutine;
      loc.rung = prevRung;
      loc.element = prevElement;
    },
    prescan() {
      const pass = currentPrescanPass();
      if (lastPrescan === pass) return;
      lastPrescan = pass;
      const prevRoutine = rt.loc.routine;
      rt.loc.routine = def.name;
      for (const p of prescans) p();
      for (const pf of power) pf.fill(0);
      rungIn.fill(0);
      rt.loc.routine = prevRoutine;
    },
  };
  return routine;
}

export { beginPrescanPass };
