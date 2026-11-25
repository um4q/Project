/**
 * Project compiler: builds the tag database, I/O tags and executable routines
 * from a ProjectDef. Used by both Verify and Download.
 */
import { Runtime } from '../core/runtime';
import { PlcMajorFault } from '../core/faults';
import { TagDatabase, type Scope, type TagProblem } from '../core/tags';
import { compileRef, isRefError } from '../core/refs';
import { parseTagPath, ParseError } from '../expr/parser';
import { validateName } from '../core/names';
import { IOSystem } from './io';
import type { ProgramDef, ProjectDef, TaskDef } from './project';
import { getRoutineCompiler, registerRoutineCompiler, type CompiledRoutine, type RoutineCompileEnv, type VerifyError } from './routines';
import { compileLadderRoutine } from '../ladder/compile';
import { getInstruction } from '../ladder/instructions';
import { isMissingOperand, type LadderElement } from '../ladder/ast';

registerRoutineCompiler('RLL', compileLadderRoutine);

export interface CompiledProgram {
  name: string;
  def: ProgramDef;
  scope: Scope;
  routines: Map<string, CompiledRoutine>;
  main: CompiledRoutine | null;
  /** True until the program's first scan after entering Run (drives S:FS) */
  firstScan: boolean;
}

export interface CompiledTask {
  name: string;
  def: TaskDef;
  type: 'CONTINUOUS' | 'PERIODIC';
  periodMs: number;
  priority: number;
  watchdogMs: number;
  programs: CompiledProgram[];
}

export interface CompiledProject {
  def: ProjectDef;
  rt: Runtime;
  db: TagDatabase;
  tasks: CompiledTask[];
  programs: Map<string, CompiledProgram>;
  scanPeriodMs: number;
}

export interface CompileResult {
  project: CompiledProject | null;
  errors: VerifyError[];
  warnings: VerifyError[];
}

const tagErr = (p: TagProblem): VerifyError => ({ severity: 'error', message: `Tag '${p.tag}' (${p.scope}): ${p.message}`, scope: p.scope, tag: p.tag });

export function compileProject(def: ProjectDef): CompileResult {
  const all: VerifyError[] = [];
  const err = (e: Omit<VerifyError, 'severity'>) => all.push({ severity: 'error', ...e });
  const warn = (e: Omit<VerifyError, 'severity'>) => all.push({ severity: 'warning', ...e });

  const rt = new Runtime();
  const db = new TagDatabase(rt);

  // Data types
  for (const m of db.types.defineUDTs(def.dataTypes ?? [])) err({ message: m });

  // I/O modules
  for (const p of IOSystem.createModuleTags(db, def.modules ?? [])) err({ message: `I/O slot ${p.slot}: ${p.message}`, slot: p.slot });

  // Controller tags
  const problems: TagProblem[] = [];
  for (const t of def.tags ?? []) db.createTag(db.controller, t, problems);

  // Programs and program tags
  const progNames = new Set<string>();
  for (const p of def.programs) {
    const ne = validateName(p.name, 'Program name');
    if (ne) err({ message: ne, program: p.name });
    const key = p.name.toLowerCase();
    if (progNames.has(key)) err({ message: `Duplicate program '${p.name}'`, program: p.name });
    progNames.add(key);
    const scope = db.addProgramScope(p.name);
    for (const t of p.tags ?? []) db.createTag(scope, t, problems);
  }
  for (const p of problems) all.push(tagErr(p));

  // Alias tags: validate targets and adopt their type for display
  const refEnv = { rt, compileIndex: () => null };
  for (const scope of db.allScopes()) {
    for (const tag of scope.tags.values()) {
      if (!tag.def.alias) continue;
      let path;
      try {
        path = parseTagPath(tag.def.alias);
      } catch (e) {
        err({ message: `Alias '${tag.name}': invalid target '${tag.def.alias}': ${(e as ParseError).message}`, scope: scope.name, tag: tag.name });
        continue;
      }
      if (path.segs.some((s) => (s.kind === 'index' && s.indices.some((i) => i.kind !== 'num')) || s.kind === 'bitIndirect')) {
        err({ message: `Alias '${tag.name}': the target must not use tag subscripts`, scope: scope.name, tag: tag.name });
        continue;
      }
      const r = compileRef(scope, { base: tag.name, segs: [] }, tag.name, refEnv);
      if (isRefError(r)) {
        err({ message: `Alias '${tag.name}': ${r.error}`, scope: scope.name, tag: tag.name });
        continue;
      }
      tag.type = r.info.type;
      tag.dims = r.info.dims;
    }
  }

  // Tasks
  const scheduled = new Map<string, string>();
  const tasks: CompiledTask[] = [];
  let continuous = 0;
  const taskNames = new Set<string>();
  for (const t of def.tasks) {
    const ne = validateName(t.name, 'Task name');
    if (ne) err({ message: ne, task: t.name });
    if (taskNames.has(t.name.toLowerCase())) err({ message: `Duplicate task '${t.name}'`, task: t.name });
    taskNames.add(t.name.toLowerCase());
    if (t.type === 'CONTINUOUS') continuous++;
    if (t.watchdogMs !== undefined && (typeof t.watchdogMs !== 'number' || !Number.isFinite(t.watchdogMs) || t.watchdogMs < 1 || t.watchdogMs > 2_000_000))
      err({ message: `Task '${t.name}': watchdog ${t.watchdogMs} ms is invalid (1 ms to 2000 s)`, task: t.name });
    if (t.type === 'PERIODIC') {
      const per = t.periodMs;
      if (typeof per !== 'number' || !Number.isFinite(per) || per < 0.1 || per > 2_000_000)
        err({ message: `Periodic task '${t.name}': period ${per} ms is invalid (0.1 ms to 2000 s)`, task: t.name });
      if (t.priority !== undefined && (!Number.isInteger(t.priority) || t.priority < 1 || t.priority > 15))
        err({ message: `Task '${t.name}': priority must be 1..15`, task: t.name });
    }
    for (const pn of t.programs) {
      const k = pn.toLowerCase();
      if (!progNames.has(k)) err({ message: `Task '${t.name}' schedules unknown program '${pn}'`, task: t.name });
      else if (scheduled.has(k)) err({ message: `Program '${pn}' is scheduled in both '${scheduled.get(k)}' and '${t.name}'`, task: t.name, program: pn });
      else scheduled.set(k, t.name);
    }
  }
  if (continuous > 1) err({ message: 'Only one continuous task is allowed' });
  const sp = def.controller.scanPeriodMs ?? 10;
  if (typeof sp !== 'number' || !Number.isFinite(sp) || sp < 0.1 || sp > 2000) err({ message: `Controller scan period ${sp} ms is invalid (0.1 to 2000 ms)` });
  const fh = def.faultHandler?.toLowerCase();
  if (def.faultHandler) {
    if (!progNames.has(fh!)) err({ message: `Controller Fault Handler program '${def.faultHandler}' does not exist` });
    else if (scheduled.has(fh!)) err({ message: `Controller Fault Handler program '${def.faultHandler}' must not be scheduled in a task`, program: def.faultHandler });
  }
  for (const p of def.programs)
    if (!scheduled.has(p.name.toLowerCase()) && p.name.toLowerCase() !== fh) warn({ message: `Program '${p.name}' is not scheduled in any task`, program: p.name });

  // Routines
  const downloadHooks: (() => void)[] = [];
  const programs = new Map<string, CompiledProgram>();
  for (const p of def.programs) {
    const scope = db.scope(p.name);
    const routines = new Map<string, CompiledRoutine>();
    const routineNames = new Set<string>();
    for (const r of p.routines) {
      const ne = validateName(r.name, 'Routine name');
      if (ne) err({ message: ne, program: p.name, routine: r.name });
      if (routineNames.has(r.name.toLowerCase())) err({ message: `Duplicate routine '${r.name}'`, program: p.name, routine: r.name });
      routineNames.add(r.name.toLowerCase());
    }
    const env: RoutineCompileEnv = {
      rt,
      db,
      scope,
      programName: p.name,
      routineNames,
      getRoutine: (name) => routines.get(name.toLowerCase()),
      errors: all,
      onDownload: (fn) => downloadHooks.push(fn),
    };
    for (const r of p.routines) {
      const compiler = getRoutineCompiler(r.type);
      if (!compiler) {
        err({ message: `Routine type ${r.type} is not supported yet`, program: p.name, routine: r.name });
        continue;
      }
      routines.set(r.name.toLowerCase(), compiler(r, env));
    }
    if (p.faultRoutine && !routineNames.has(p.faultRoutine.toLowerCase()))
      err({ message: `Program '${p.name}': fault routine '${p.faultRoutine}' does not exist`, program: p.name });
    const main = routines.get((p.mainRoutine ?? '').toLowerCase()) ?? null;
    if (!p.mainRoutine || !routineNames.has(p.mainRoutine.toLowerCase())) err({ message: `Program '${p.name}' has no main routine '${p.mainRoutine ?? ''}'`, program: p.name });
    programs.set(p.name.toLowerCase(), { name: p.name, def: p, scope, routines, main, firstScan: true });

    // JSR <-> SBR parameter count check
    for (const r of p.routines) {
      if (r.type !== 'RLL') continue;
      r.rungs.forEach((rd, rungIdx) => {
        const rung = routines.get(r.name.toLowerCase())?.ladder?.rungs[rungIdx];
        if (!rung) return;
        let id = 0;
        const visit = (series: LadderElement[]) => {
          for (const el of series) {
            const myId = id++;
            if (el.kind === 'branch') {
              el.legs.forEach(visit);
              continue;
            }
            if (el.mnemonic !== 'JSR' || el.operands.length < 2) continue;
            const target = routines.get(el.operands[0].trim().toLowerCase());
            const nIn = Number(el.operands[1]);
            if (!target || !Number.isInteger(nIn)) continue;
            const sbr = target.sbrParams;
            if (nIn > 0 && sbr === null)
              err({ message: `Rung ${rungIdx}, JSR: routine '${target.name}' has no SBR instruction to receive ${nIn} input parameter(s)`, program: p.name, routine: r.name, rung: rungIdx, element: myId });
            else if (sbr !== null && sbr !== nIn)
              err({ message: `Rung ${rungIdx}, JSR: passes ${nIn} input parameter(s) but SBR in '${target.name}' has ${sbr}`, program: p.name, routine: r.name, rung: rungIdx, element: myId });
          }
        };
        visit(rung.elements);
      });
    }
  }

  for (const t of def.tasks) {
    tasks.push({
      name: t.name,
      def: t,
      type: t.type,
      periodMs: t.type === 'PERIODIC' ? t.periodMs ?? 10 : def.controller.scanPeriodMs ?? 10,
      priority: t.type === 'PERIODIC' ? t.priority ?? 10 : 16,
      watchdogMs: t.watchdogMs ?? 500,
      programs: t.programs.map((n) => programs.get(n.toLowerCase())).filter((x): x is CompiledProgram => !!x),
    });
  }

  const errors = all.filter((e) => e.severity === 'error');
  const warnings = all.filter((e) => e.severity === 'warning');
  if (errors.length) return { project: null, errors, warnings };
  for (const h of downloadHooks) {
    // a hook resolving an indirect operand (Tmrs[Idx]) may hit an out-of-range subscript: skip it
    try {
      h();
    } catch (e) {
      if (!(e instanceof PlcMajorFault)) throw e;
    }
  }
  return {
    project: { def, rt, db, tasks, programs, scanPeriodMs: def.controller.scanPeriodMs ?? 10 },
    errors,
    warnings,
  };
}

/** Verify a project (no side effects). */
export function verifyProject(def: ProjectDef): VerifyError[] {
  const r = compileProject(def);
  return [...r.errors, ...r.warnings];
}

/** Find the mnemonic of an element id in a rung (for fault reports). */
export function elementMnemonic(elements: LadderElement[], target: number): string | undefined {
  let id = 0;
  let found: string | undefined;
  const visit = (series: LadderElement[]) => {
    for (const el of series) {
      if (found) return;
      const my = id++;
      if (my === target && el.kind === 'instr') {
        found = el.mnemonic;
        return;
      }
      if (el.kind === 'branch') el.legs.forEach(visit);
    }
  };
  visit(elements);
  return found;
}

export { getInstruction, isMissingOperand };
