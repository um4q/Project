/**
 * Runtime context shared by all compiled code of one downloaded project.
 * Compiled instruction closures capture this object, so the hot path does not
 * pass a context around.
 */
import { FAULT, PlcMajorFault, type FaultLocation, type FaultRecord, type FaultSpec } from './faults';

/** Arithmetic / system status flags addressable as S:FS, S:N, S:Z, S:V, S:C, S:MINOR. */
export class StatusFlags {
  /** First scan after entering Run (per program) */
  FS = 0;
  /** Negative */
  N = 0;
  /** Zero */
  Z = 0;
  /** Overflow */
  V = 0;
  /** Carry */
  C = 0;
  /** Minor fault present */
  MINOR = 0;
}

export const STATUS_FLAG_NAMES = ['FS', 'N', 'Z', 'V', 'C', 'MINOR'] as const;
export type StatusFlagName = (typeof STATUS_FLAG_NAMES)[number];

/** Virtual watchdog cost: one rung / ST statement = 1 µs of task time. */
export const WORK_UNITS_PER_MS = 1000;

export interface CallFrame {
  /** Values passed by JSR input parameters (consumed by SBR) */
  args: unknown[] | null;
  /** Values produced by RET (copied back to JSR return parameters) */
  returns: unknown[] | null;
  /** Set when RET executed: the routine stops after the current rung */
  returned: boolean;
}

export class Runtime {
  /** Controller virtual time in ms */
  now = 0;
  readonly status = new StatusFlags();
  /** True while executing prescan (all instructions run their prescan action) */
  prescanning = false;
  /** Where execution currently is (for fault reports and the online view) */
  readonly loc: FaultLocation = {};
  /** Remaining watchdog work units for the current task scan */
  budget = Infinity;
  /** Watchdog limit for the current task, for messages */
  watchdogMs = 500;
  /** Pending JMP target label (lowercase), set by JMP when its rung is true */
  jumpLabel: string | null = null;
  /** MCR zone state for the routine being executed */
  mcrOpen = false;
  mcrFalse = false;
  /** JSR call stack */
  readonly frames: CallFrame[] = [];
  /** Minor fault log (bounded) */
  readonly minorFaults: FaultRecord[] = [];
  /** Max JSR nesting */
  maxCallDepth = 32;
  /** Incremented at the start of every task scan (1, 2, ...); 0 = never scanned */
  scanId = 0;

  majorFault(spec: FaultSpec, detail?: string): never {
    throw new PlcMajorFault(spec, detail);
  }

  /** Record a minor fault (does not stop the controller). */
  minorFault(spec: FaultSpec, detail?: string): void {
    this.status.MINOR = 1;
    if (this.minorFaults.length >= 32) this.minorFaults.shift();
    this.minorFaults.push({
      ...this.loc,
      type: spec.type,
      code: spec.code,
      message: detail ? `${spec.message} (${detail})` : spec.message,
      time: this.now,
      major: false,
    });
  }

  /** Arithmetic status update after a math/move instruction. */
  setArith(result: number, overflow: boolean): void {
    const s = this.status;
    s.Z = result === 0 ? 1 : 0;
    s.N = result < 0 ? 1 : 0;
    s.V = overflow ? 1 : 0;
    if (overflow) this.minorFault(FAULT.ARITH_OVERFLOW);
  }

  /** Charge watchdog work; faults with a watchdog timeout when exhausted. */
  charge(units: number): void {
    this.budget -= units;
    if (this.budget < 0) this.majorFault(FAULT.WATCHDOG, `task exceeded ${this.watchdogMs} ms`);
  }

  get frame(): CallFrame | undefined {
    return this.frames[this.frames.length - 1];
  }
}
