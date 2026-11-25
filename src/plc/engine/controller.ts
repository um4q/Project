/**
 * The controller: modes, download/upload, deterministic task scheduling, the
 * scan cycle (inputs -> programs -> outputs), prescan, S:FS, faults and stats.
 *
 * Time is virtual: `advance(ms)` runs every task scan due in [now, now + ms).
 * The continuous task runs every `scanPeriodMs` (default 10 ms).
 */
import { PlcMajorFault, type FaultRecord } from '../core/faults';
import { compileRef, isRefError, type Ref } from '../core/refs';
import { parseTagPath } from '../expr/parser';
import { applyInitialValue, cloneValue, type Value } from '../core/values';
import { compileProject, elementMnemonic, type CompiledProgram, type CompiledProject, type CompiledTask } from './compileProject';
import { IOSystem } from './io';
import type { ProjectDef } from './project';
import { beginPrescanPass, type LadderLiveState, type VerifyError } from './routines';
import type { Runtime } from '../core/runtime';

export type ControllerMode = 'PROGRAM' | 'RUN' | 'FAULTED';

export interface ScanStats {
  /** CPU time of the last continuous-task scan in µs */
  lastScanUs: number;
  /** Max continuous-task scan CPU time since entering Run in µs */
  maxScanUs: number;
  /** Number of continuous-task scans since entering Run */
  scans: number;
}

export interface DownloadResult {
  ok: boolean;
  errors: VerifyError[];
  warnings: VerifyError[];
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Controller {
  mode: ControllerMode = 'PROGRAM';
  /** Virtual time in ms */
  time = 0;
  readonly io = new IOSystem();
  readonly stats: ScanStats = { lastScanUs: 0, maxScanUs: 0, scans: 0 };
  majorFault: FaultRecord | null = null;
  /** Major fault history (most recent last) */
  readonly faultLog: FaultRecord[] = [];
  private compiled: CompiledProject | null = null;
  private nextDue = new Map<CompiledTask, number>();
  private refCache = new Map<string, Ref>();
  private listeners = new Set<() => void>();

  get project(): ProjectDef | null {
    return this.compiled?.def ?? null;
  }

  get runtime(): Runtime | null {
    return this.compiled?.rt ?? null;
  }

  get compiledProject(): CompiledProject | null {
    return this.compiled;
  }

  /** Subscribe to state changes (mode, download, fault). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------ download / upload

  verify(def: ProjectDef): DownloadResult {
    const r = compileProject(def);
    return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings };
  }

  /** Download a project. Allowed only in Program mode (or Faulted). Blocked when Verify finds errors. */
  download(def: ProjectDef): DownloadResult {
    if (this.mode === 'RUN') {
      return { ok: false, errors: [{ severity: 'error', message: 'The controller must be in Program mode to download' }], warnings: [] };
    }
    const snapshot = structuredClone(def);
    const r = compileProject(snapshot);
    if (!r.project) return { ok: false, errors: r.errors, warnings: r.warnings };
    this.compiled = r.project;
    this.compiled.rt.now = this.time;
    this.io.bind(r.project.db, snapshot.modules ?? [], r.project.rt);
    this.refCache.clear();
    this.majorFault = null;
    this.mode = 'PROGRAM';
    this.io.readInputs();
    this.io.writeOutputs(false);
    this.emit();
    return { ok: true, errors: [], warnings: r.warnings };
  }

  /** Project definition with tag values replaced by the controller's current values. */
  upload(): ProjectDef | null {
    if (!this.compiled) return null;
    const def = structuredClone(this.compiled.def);
    const db = this.compiled.db;
    const fill = (tags: { name: string; alias?: string; value?: unknown }[] | undefined, scope: ReturnType<typeof db.scope>) => {
      for (const t of tags ?? []) {
        if (t.alias) continue;
        const tag = scope.own(t.name);
        if (tag) t.value = cloneValue(tag.holder.value);
      }
    };
    fill(def.tags, db.controller);
    for (const p of def.programs) fill(p.tags, db.scope(p.name));
    return def;
  }

  // ------------------------------------------------------------------ modes

  /** Change mode. Returns an error message or null. */
  setMode(mode: 'PROGRAM' | 'RUN'): string | null {
    if (mode === 'RUN') {
      if (!this.compiled) return 'No project has been downloaded';
      if (this.mode === 'FAULTED') return 'Clear the major fault before going to Run';
      if (this.mode === 'RUN') return null;
      this.enterRun();
      const f = this.majorFault as FaultRecord | null;
      return (this.mode as ControllerMode) === 'FAULTED' && f ? `Major fault during prescan: Type ${f.type} Code ${f.code}: ${f.message}` : null;
    }
    if (this.mode === 'FAULTED') return 'Clear the major fault first';
    this.mode = 'PROGRAM';
    this.io.writeOutputs(false);
    this.emit();
    return null;
  }

  private enterRun(): void {
    const cp = this.compiled!;
    const rt = cp.rt;
    rt.now = this.time;
    rt.frames.length = 0;
    rt.jumpLabel = null;
    // Prescan every program (JSR'd routines are prescanned once via JSR)
    beginPrescanPass();
    rt.prescanning = true;
    let current: CompiledProgram | undefined;
    try {
      for (const t of cp.tasks) {
        for (const p of t.programs) {
          if (p.def.inhibited || !p.main) continue;
          current = p;
          rt.loc.task = t.name;
          rt.loc.program = p.name;
          rt.frames.push({ args: null, returns: null, returned: false });
          p.main.prescan();
          rt.frames.pop();
        }
      }
    } catch (e) {
      rt.prescanning = false;
      this.mode = 'RUN';
      this.raiseFault(e, current);
      return;
    }
    rt.prescanning = false;
    for (const p of cp.programs.values()) p.firstScan = true;
    this.stats.lastScanUs = 0;
    this.stats.maxScanUs = 0;
    this.stats.scans = 0;
    this.nextDue.clear();
    for (const t of cp.tasks) this.nextDue.set(t, this.time);
    this.mode = 'RUN';
    this.emit();
  }

  /** Clear a major fault: the controller goes to Program mode. */
  clearFault(): void {
    if (this.mode !== 'FAULTED') return;
    this.majorFault = null;
    this.mode = 'PROGRAM';
    if (this.compiled) this.compiled.rt.status.MINOR = 0;
    this.io.writeOutputs(false);
    this.emit();
  }

  // ------------------------------------------------------------------ execution

  /**
   * Advance virtual time by `ms`, running every task scan that is due in
   * [time, time + ms). In Program/Faulted mode the I/O image is still updated
   * (inputs read, outputs de-energized).
   */
  advance(ms: number): void {
    const end = this.time + ms;
    const cp = this.compiled;
    if (!cp || this.mode !== 'RUN') {
      if (cp) {
        cp.rt.now = end;
        this.io.readInputs();
        this.io.writeOutputs(false);
      }
      this.time = end;
      return;
    }
    for (;;) {
      // next due task: earliest time, then priority (lower number first)
      let best: CompiledTask | null = null;
      let bestT = Infinity;
      for (const t of cp.tasks) {
        if (t.def.inhibited) continue;
        const due = this.nextDue.get(t)!;
        if (due < bestT || (due === bestT && best && t.priority < best.priority)) {
          best = t;
          bestT = due;
        }
      }
      if (!best || bestT >= end) break;
      this.time = bestT;
      this.nextDue.set(best, bestT + best.periodMs);
      this.runTask(best);
      if (this.mode !== 'RUN') break;
    }
    this.time = end;
    cp.rt.now = end;
  }

  /** Run exactly one continuous-task scan at the current time and advance by one scan period. */
  scan(): void {
    const cp = this.compiled;
    this.advance(cp ? cp.scanPeriodMs : 10);
  }

  private runTask(task: CompiledTask): void {
    const cp = this.compiled!;
    const rt = cp.rt;
    rt.now = this.time;
    rt.budget = task.watchdogMs * 1000;
    rt.watchdogMs = task.watchdogMs;
    rt.frames.length = 0;
    rt.jumpLabel = null;
    rt.loc.task = task.name;
    const t0 = now();
    let current: CompiledProgram | undefined;
    try {
      this.io.readInputs();
      for (const p of task.programs) {
        if (p.def.inhibited || !p.main) continue;
        current = p;
        rt.loc.program = p.name;
        rt.loc.routine = p.main.name;
        rt.status.FS = p.firstScan ? 1 : 0;
        rt.frames.push({ args: null, returns: null, returned: false });
        p.main.run();
        rt.frames.pop();
        p.firstScan = false;
      }
      rt.status.FS = 0;
      this.io.writeOutputs(true);
    } catch (e) {
      this.raiseFault(e, current);
      return;
    }
    if (task.type === 'CONTINUOUS') {
      const us = (now() - t0) * 1000;
      this.stats.lastScanUs = us;
      if (us > this.stats.maxScanUs) this.stats.maxScanUs = us;
      this.stats.scans++;
    }
  }

  private raiseFault(e: unknown, program: CompiledProgram | undefined): void {
    const cp = this.compiled!;
    const rt = cp.rt;
    const loc = { ...rt.loc };
    let rec: FaultRecord;
    if (e instanceof PlcMajorFault) {
      rec = { ...loc, type: e.type, code: e.code, message: e.message, time: this.time, major: true };
    } else {
      rec = { ...loc, type: 0, code: 0, message: `Internal error: ${(e as Error)?.message ?? String(e)}`, time: this.time, major: true };
      if (typeof console !== 'undefined') console.error(e);
    }
    if (program && loc.routine && loc.rung !== undefined && loc.element !== undefined) {
      const routine = program.routines.get(loc.routine.toLowerCase());
      const rung = routine?.ladder?.rungs[loc.rung];
      if (rung) rec.instruction = elementMnemonic(rung.elements, loc.element);
    }
    this.majorFault = rec;
    this.faultLog.push(rec);
    if (this.faultLog.length > 16) this.faultLog.shift();
    this.mode = 'FAULTED';
    rt.status.FS = 0;
    this.io.writeOutputs(false);
    this.emit();
  }

  // ------------------------------------------------------------------ tag access (watch window, scene, tests)

  private ref(path: string, program?: string | null): Ref {
    const cp = this.compiled;
    if (!cp) throw new Error('No project downloaded');
    const key = `${program ?? ''}|${path}`.toLowerCase();
    let r = this.refCache.get(key);
    if (!r) {
      const scope = cp.db.scope(program ?? null);
      const res = compileRef(scope, parseTagPath(path), path, { rt: cp.rt, compileIndex: () => null });
      if (isRefError(res)) throw new Error(res.error);
      r = res;
      this.refCache.set(key, r);
    }
    return r;
  }

  /** Read a tag value (number for atomic, deep copy for structures/arrays). Throws on bad paths. */
  read(path: string, program?: string | null): Value {
    const r = this.ref(path, program);
    return r.kind === 'atomic' ? r.get() : cloneValue(r.get());
  }

  /** Read an atomic value as a number. */
  readNumber(path: string, program?: string | null): number {
    const r = this.ref(path, program);
    if (r.kind !== 'atomic') throw new Error(`'${path}' is not an atomic tag`);
    return r.get();
  }

  readBool(path: string, program?: string | null): boolean {
    return this.readNumber(path, program) !== 0;
  }

  /** Write a tag value (number/boolean for atomic, partial object/array for structures). */
  write(path: string, value: number | boolean | object, program?: string | null): void {
    const r = this.ref(path, program);
    if (r.kind === 'atomic') {
      if (typeof value === 'object') throw new Error(`'${path}' is atomic`);
      r.set(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      return;
    }
    const problems: string[] = [];
    applyInitialValue(this.compiled!.db.types, r.info, { holder: { v: r.get() }, key: 'v' }, value, problems, path);
    if (problems.length) throw new Error(problems.join('; '));
  }

  /** Live ladder state for the online view. */
  ladderState(program: string, routine: string): LadderLiveState | undefined {
    return this.compiled?.programs.get(program.toLowerCase())?.routines.get(routine.toLowerCase())?.ladder;
  }

  /** Minor faults logged by the runtime. */
  get minorFaults(): FaultRecord[] {
    return this.compiled?.rt.minorFaults ?? [];
  }

  /** Forces: proxies to the I/O system. */
  get forcesActive(): boolean {
    return this.io.forcesActive;
  }
}
