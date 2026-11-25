/**
 * Routine compiler registry. Each language (RLL now; ST, SFC, FBD in later
 * stages) registers a compiler that turns a RoutineDef into a CompiledRoutine.
 */
import type { Runtime } from '../core/runtime';
import type { Scope, TagDatabase } from '../core/tags';
import type { RoutineDef, RoutineType } from './project';
import type { Rung } from '../ladder/ast';

export interface VerifyError {
  severity: 'error' | 'warning';
  message: string;
  program?: string;
  routine?: string;
  /** Ladder rung (0-based) */
  rung?: number;
  /** Ladder element id (pre-order within rung) */
  element?: number;
  /** Operand index */
  operand?: number;
  /** ST line / column (1-based) */
  line?: number;
  col?: number;
  /** SFC step/transition or FBD block id */
  item?: string;
  /** Tag errors */
  scope?: string;
  tag?: string;
  /** I/O module slot */
  slot?: number;
  task?: string;
}

/** Live ladder state for the online view. */
export interface LadderLiveState {
  rungs: Rung[];
  /** Per rung: power-flow out of each element (pre-order element ids) */
  power: Uint8Array[];
  /** Per rung: 1 if the rung was scanned with a true rung-condition-in */
  rungIn: Uint8Array;
}

export interface CompiledRoutine {
  name: string;
  type: RoutineType;
  /** Execute one scan of the routine. */
  run(): void;
  /** Prescan (Program -> Run). Safe to call more than once per pass (runs once). */
  prescan(): void;
  /** Number of SBR input parameters, or null if the routine has no SBR. */
  sbrParams: number | null;
  /** Ladder online-view state (RLL only) */
  ladder?: LadderLiveState;
}

export interface RoutineCompileEnv {
  rt: Runtime;
  db: TagDatabase;
  scope: Scope;
  programName: string;
  /** Names (lowercase) of routines in the program */
  routineNames: Set<string>;
  /** Runtime lookup of a compiled routine in the same program */
  getRoutine(name: string): CompiledRoutine | undefined;
  errors: VerifyError[];
  /** Register code to run after a successful download */
  onDownload(fn: () => void): void;
}

export type RoutineCompiler = (def: RoutineDef, env: RoutineCompileEnv) => CompiledRoutine;

const COMPILERS = new Map<RoutineType, RoutineCompiler>();

export function registerRoutineCompiler(type: RoutineType, compiler: RoutineCompiler): void {
  COMPILERS.set(type, compiler);
}

export function getRoutineCompiler(type: RoutineType): RoutineCompiler | undefined {
  return COMPILERS.get(type);
}

/** Prescan bookkeeping: routines prescan once per pass. */
let prescanPass = 0;
export function beginPrescanPass(): number {
  return ++prescanPass;
}
export function currentPrescanPass(): number {
  return prescanPass;
}
