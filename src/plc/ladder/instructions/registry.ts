/**
 * Ladder instruction registry.
 *
 * Every instruction is described by an `InstructionDef`: metadata for the
 * editor (category tab, operand names, contact/coil vs box), plus a `compile`
 * function that turns operand texts into an `Executable` using the
 * `InstrCompiler` helpers. Helpers report verify errors themselves and return
 * safe dummies, so compile functions can be written straight-line.
 */
import type { Runtime } from '../../core/runtime';
import type { AtomicRef, Ref, StructRef } from '../../core/refs';
import type { StructValue, TypeInfo } from '../../core/values';
import type { CompiledExpr } from '../../expr/compile';

export type InstrCategory = 'Bit' | 'Timer/Counter' | 'Compare' | 'Compute/Math' | 'Move/Logical' | 'File/Shift' | 'Program Control';

export const CATEGORIES: InstrCategory[] = ['Bit', 'Timer/Counter', 'Compare', 'Compute/Math', 'Move/Logical', 'File/Shift', 'Program Control'];

/**
 * input:  conditions the rung (may not end a rung)
 * output: may end a rung (passes rung-condition-in through unless stated)
 * either: may appear anywhere
 */
export type InstrKind = 'input' | 'output' | 'either';

export type OperandKind =
  | 'bit'
  | 'source'
  | 'dest'
  | 'timer'
  | 'counter'
  | 'control'
  | 'array'
  | 'tag'
  | 'expression'
  | 'immediate'
  | 'routine'
  | 'label'
  | 'param';

export interface OperandSpec {
  name: string;
  kind: OperandKind;
  description?: string;
}

export interface Executable {
  /** Execute with rung-condition-in; return rung-condition-out. */
  exec(rungIn: boolean): boolean;
  /** Prescan action, run once on entering Run mode. */
  prescan?(): void;
}

/** Contiguous run of array elements starting at the operand (or a single scalar). */
export interface Span {
  /** Element type (dims null) */
  info: TypeInfo;
  /** The compiled operand reference */
  ref: Ref;
  /** Elements available from the start element to the end of the array (1 for a scalar) */
  available(): number;
  /** Flat index of the start element in its array (0 for a scalar) */
  start(): number;
  /** Atomic element value at offset i from start */
  get(i: number): number;
  /** Store atomic element at offset i (Logix conversion). Returns overflow. */
  set(i: number, v: number): boolean;
  /** Live structure element at offset i */
  obj(i: number): StructValue;
  /** Replace a whole element (atomic number or deep copy of a structure) */
  assign(i: number, v: number | StructValue): void;
}

export interface RoutineHandle {
  name: string;
  /** The compiled routine (available at run time) */
  get(): CompiledRoutineLike;
}

export interface CompiledRoutineLike {
  name: string;
  run(): void;
  prescan(): void;
  /** Number of SBR input parameters (null if the routine has no SBR) */
  sbrParams: number | null;
}

export interface InstrCompiler {
  readonly rt: Runtime;
  readonly mnemonic: string;
  /** Raw operand texts */
  readonly operands: string[];
  /** Program and routine being compiled */
  readonly programName: string;
  readonly routineName: string;
  /** Rung index and element id */
  readonly rung: number;
  readonly element: number;

  /** Report a verify error on operand i (-1 for the instruction itself). */
  error(i: number, message: string): void;
  /** Report a verify warning on operand i. */
  warning(i: number, message: string): void;
  /** True once an error was reported for this instruction */
  readonly failed: boolean;

  /** BOOL operand: BOOL tag/member/element or integer bit (`Dint.5`). */
  bit(i: number, opts?: { write?: boolean }): AtomicRef;
  /** Numeric source: SINT/INT/DINT/REAL tag or literal. `integer` rejects REAL. */
  source(i: number, opts?: { integer?: boolean; allowBool?: boolean }): AtomicRef;
  /** Writable numeric destination. `integer` rejects REAL. */
  dest(i: number, opts?: { integer?: boolean; allowBool?: boolean }): AtomicRef;
  /** Structure operand of a given type (TIMER, COUNTER, CONTROL, or any type name). */
  struct(i: number, typeName: string, opts?: { write?: boolean }): StructRef;
  /** Any tag reference (atomic, struct or array). Returns null on error. */
  ref(i: number, opts?: { write?: boolean }): Ref | null;
  /** Array span (`Arr[3]` starts at element 3; `Arr` starts at 0; a scalar is a span of 1). */
  span(i: number, opts?: { write?: boolean; atomicOnly?: boolean; types?: string[] }): Span;
  /** CPT/CMP expression. */
  expression(i: number): CompiledExpr;
  /** Required literal constant. Returns null (and reports) when missing/invalid. */
  immediate(i: number, opts?: { integer?: boolean; min?: number; max?: number }): number | null;
  /** Optional literal: the value if operand i is a numeric literal, else null (no error). */
  literal(i: number): number | null;
  /** Routine in the same program (JSR). */
  routine(i: number): RoutineHandle;
  /** Label name (JMP/LBL), lowercase. */
  label(i: number): string;
  /** Run `fn` once after a successful download (e.g. apply TON preset into Timer.PRE). */
  onDownload(fn: () => void): void;
}

export interface InstructionDef {
  mnemonic: string;
  category: InstrCategory;
  /** Full name, e.g. "Examine If Closed" */
  title: string;
  kind: InstrKind;
  operands: OperandSpec[];
  /** Variable operand count (JSR/SBR/RET) */
  variadic?: boolean;
  /** Drawn as a box (true) or as a contact/coil (false) */
  box: boolean;
  compile(c: InstrCompiler): Executable;
}

const REGISTRY = new Map<string, InstructionDef>();

export function registerInstructions(defs: InstructionDef[]): void {
  for (const d of defs) {
    const key = d.mnemonic.toUpperCase();
    if (REGISTRY.has(key)) throw new Error(`Instruction ${key} registered twice`);
    REGISTRY.set(key, d);
  }
}

export function getInstruction(mnemonic: string): InstructionDef | undefined {
  return REGISTRY.get(mnemonic.toUpperCase());
}

export function allInstructions(): InstructionDef[] {
  return [...REGISTRY.values()];
}

export function instructionsByCategory(cat: InstrCategory): InstructionDef[] {
  return allInstructions().filter((d) => d.category === cat);
}

/** Helper for instructions without state. */
export const passThrough: Executable = { exec: (r) => r };

/** Executable used when compilation failed (never runs: download is blocked). */
export const failedExecutable: Executable = { exec: (r) => r };
