/**
 * Serializable project model (saved to localStorage / exported as .lsim.json).
 */
import type { TagDef } from '../core/tags';
import type { UDTDef } from '../core/datatypes';
import type { ModuleDef } from './io';

export type RoutineType = 'RLL' | 'ST' | 'SFC' | 'FBD';

export interface RungDef {
  /** Neutral text, e.g. `XIC Start OTE Run ;` */
  text: string;
  comment?: string;
}

export interface RLLRoutineDef {
  name: string;
  type: 'RLL';
  description?: string;
  rungs: RungDef[];
}

export interface STRoutineDef {
  name: string;
  type: 'ST';
  description?: string;
  code: string;
}

/** SFC and FBD bodies are defined by their own stages; kept opaque here. */
export interface SFCRoutineDef {
  name: string;
  type: 'SFC';
  description?: string;
  chart: unknown;
}

export interface FBDRoutineDef {
  name: string;
  type: 'FBD';
  description?: string;
  sheets: unknown;
}

export type RoutineDef = RLLRoutineDef | STRoutineDef | SFCRoutineDef | FBDRoutineDef;

export interface ProgramDef {
  name: string;
  description?: string;
  mainRoutine: string;
  /** Optional fault routine run when an instruction in this program faults */
  faultRoutine?: string;
  inhibited?: boolean;
  tags?: TagDef[];
  routines: RoutineDef[];
}

export interface TaskDef {
  name: string;
  type: 'CONTINUOUS' | 'PERIODIC';
  /** Period in ms (periodic tasks) */
  periodMs?: number;
  /** 1 (highest) .. 15 (lowest); periodic tasks only */
  priority?: number;
  /** Watchdog in ms (default 500) */
  watchdogMs?: number;
  inhibited?: boolean;
  /** Programs in execution order */
  programs: string[];
}

export interface ControllerDef {
  name: string;
  catalog?: string;
  description?: string;
  /** Continuous task scan period in ms (default 10) */
  scanPeriodMs?: number;
}

export interface ProjectDef {
  schema?: 'logixsim.project';
  version?: number;
  controller: ControllerDef;
  dataTypes?: UDTDef[];
  /** Controller-scope tags */
  tags?: TagDef[];
  /** I/O configuration (local chassis) */
  modules?: ModuleDef[];
  tasks: TaskDef[];
  programs: ProgramDef[];
  /** Program run when a major fault occurs (Controller Fault Handler) */
  faultHandler?: string;
}

export const PROJECT_SCHEMA = 'logixsim.project';
export const PROJECT_VERSION = 1;

/** Minimal empty project with MainTask / MainProgram / MainRoutine. */
export function newProject(name = 'NewController'): ProjectDef {
  return {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    controller: { name, catalog: 'LX-C30 Compact Controller', scanPeriodMs: 10 },
    dataTypes: [],
    tags: [],
    modules: [],
    tasks: [{ name: 'MainTask', type: 'CONTINUOUS', watchdogMs: 500, programs: ['MainProgram'] }],
    programs: [{ name: 'MainProgram', mainRoutine: 'MainRoutine', tags: [], routines: [{ name: 'MainRoutine', type: 'RLL', rungs: [] }] }],
  };
}

/**
 * Convenience builder for tests and samples: a single-program project from
 * ladder rung texts.
 */
export function ladderProject(opts: {
  tags?: TagDef[];
  programTags?: TagDef[];
  rungs: (string | RungDef)[];
  routines?: RoutineDef[];
  modules?: ModuleDef[];
  dataTypes?: UDTDef[];
  scanPeriodMs?: number;
}): ProjectDef {
  const p = newProject('Test');
  p.tags = opts.tags ?? [];
  p.modules = opts.modules ?? [];
  p.dataTypes = opts.dataTypes ?? [];
  if (opts.scanPeriodMs) p.controller.scanPeriodMs = opts.scanPeriodMs;
  const prog = p.programs[0];
  prog.tags = opts.programTags ?? [];
  prog.routines = [
    { name: 'MainRoutine', type: 'RLL', rungs: opts.rungs.map((r) => (typeof r === 'string' ? { text: r } : r)) },
    ...(opts.routines ?? []),
  ];
  return p;
}
