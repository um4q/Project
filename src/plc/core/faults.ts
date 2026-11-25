/**
 * Controller fault model. Codes follow the Logix "Type / Code" convention so the
 * fault dialog reads like the real thing.
 */

export interface FaultLocation {
  task?: string;
  program?: string;
  routine?: string;
  /** Zero-based rung number (ladder) */
  rung?: number;
  /** Pre-order element id within the rung (ladder) */
  element?: number;
  /** Instruction mnemonic that faulted */
  instruction?: string;
  /** 1-based line (ST) */
  line?: number;
  /** SFC step / FBD block name */
  item?: string;
}

export interface FaultRecord extends FaultLocation {
  type: number;
  code: number;
  message: string;
  /** Controller virtual time (ms) when the fault was logged */
  time: number;
  major: boolean;
}

/** Well-known fault codes (type, code). */
export const FAULT = {
  /** Arithmetic overflow (minor in real Logix; divide-by-zero is promoted to major per LogixSim spec). */
  ARITH_OVERFLOW: { type: 4, code: 4, message: 'Arithmetic overflow' },
  DIVIDE_BY_ZERO: { type: 4, code: 4, message: 'Arithmetic overflow: divide by zero' },
  ARRAY_SUBSCRIPT: { type: 4, code: 20, message: 'Array subscript too large, or CONTROL .POS or .LEN is invalid' },
  JSR_PARAMS: { type: 4, code: 31, message: 'The parameters of the JSR instruction do not match those of the associated SBR or RET instruction' },
  NESTING: { type: 4, code: 31, message: 'JSR nesting limit exceeded' },
  TIMER_NEGATIVE: { type: 4, code: 34, message: 'A timer instruction has a negative preset or accumulated value' },
  LABEL_NOT_FOUND: { type: 4, code: 42, message: 'JMP to a label that does not exist' },
  WATCHDOG: { type: 6, code: 1, message: 'Task watchdog expired' },
} as const;

export type FaultSpec = { type: number; code: number; message: string };

/** Thrown from instruction code to abort the scan with a major fault. */
export class PlcMajorFault extends Error {
  readonly type: number;
  readonly code: number;
  constructor(spec: FaultSpec, detail?: string) {
    super(detail ? `${spec.message} (${detail})` : spec.message);
    this.type = spec.type;
    this.code = spec.code;
    this.name = 'PlcMajorFault';
  }
}
