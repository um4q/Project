/**
 * Timer instructions: TON, TOF, RTO.
 *
 * Operands (Logix order): Timer (TIMER), Preset (immediate DINT >= 0),
 * Accum (immediate DINT >= 0). The literal Preset/Accum are written into the
 * tag's .PRE/.ACC at download; at run time the instructions always use the live
 * .PRE/.ACC members, so logic (or the watch window) may change them.
 *
 * Time base: whole milliseconds of controller virtual time. The timestamp of the
 * last update is hidden state stored on the TIMER object itself (under a
 * module-level Symbol, so it is never serialized and is shared correctly when two
 * instructions use the same tag). The fractional remainder of a scan period is
 * kept in the timestamp so no time is lost with non-integer periods.
 */
import type { InstructionDef, InstrCompiler, Executable } from './registry';
import type { Runtime } from '../../core/runtime';
import type { StructRef } from '../../core/refs';
import { FAULT } from '../../core/faults';
import { DINT_MAX } from '../../core/values';

/** Hidden per-timer timestamp (ms of virtual time, may be fractional). */
const LAST = Symbol('logixsim.timer.last');

interface TimerObj {
  PRE: number;
  ACC: number;
  EN: number;
  TT: number;
  DN: number;
  [LAST]?: number;
}

/** Start timing: remember the timestamp, add no time on this scan. */
function startTiming(o: TimerObj, now: number): void {
  o[LAST] = now;
}

/** Add the whole milliseconds elapsed since the last update to .ACC. */
function accumulate(o: TimerObj, now: number): void {
  const last = o[LAST];
  if (last === undefined || last > now) {
    // No valid timestamp (e.g. .EN written by hand): start from here.
    o[LAST] = now;
    return;
  }
  const delta = Math.floor(now - last);
  if (delta > 0) {
    o[LAST] = last + delta;
    o.ACC = o.ACC + delta;
  }
}

function checkNegative(rt: Runtime, o: TimerObj): void {
  if (o.PRE < 0 || o.ACC < 0) rt.majorFault(FAULT.TIMER_NEGATIVE, `.PRE = ${o.PRE}, .ACC = ${o.ACC}`);
}

type TimerStep = (o: TimerObj, rungIn: boolean) => void;

/**
 * Common compile: TIMER operand + literal Preset/Accum applied at download.
 * `step` implements the instruction for one scan; `prescan` its prescan action.
 */
function compileTimer(c: InstrCompiler, step: TimerStep, prescan: (o: TimerObj) => void): Executable {
  const ref: StructRef = c.struct(0, 'TIMER');
  if (!c.failed && !ref.writable) c.error(0, `'${ref.text}' is read-only`);
  const preset = c.immediate(1, { integer: true, min: 0, max: DINT_MAX });
  const accum = c.immediate(2, { integer: true, min: 0, max: DINT_MAX });
  const get = ref.get as unknown as () => TimerObj;

  if (preset !== null && accum !== null) {
    c.onDownload(() => {
      let o: TimerObj;
      try {
        o = get();
      } catch {
        // An indirect subscript that is out of range at download: nothing to preset.
        return;
      }
      o.PRE = preset;
      o.ACC = accum;
    });
  }

  if (ref.isStatic) {
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
      // An indirect element is resolved with the current subscript value; out of range faults 4/20 like any prescan.
      prescan(get());
    },
  };
}

const timerOperands = [
  { name: 'Timer', kind: 'timer' as const },
  { name: 'Preset', kind: 'immediate' as const, description: 'Preset time in ms' },
  { name: 'Accum', kind: 'immediate' as const, description: 'Accumulated time in ms' },
];

export const timerInstructions: InstructionDef[] = [
  {
    mnemonic: 'TON',
    category: 'Timer/Counter',
    title: 'Timer On Delay',
    kind: 'output',
    box: true,
    operands: timerOperands,
    compile(c) {
      const rt = c.rt;
      return compileTimer(
        c,
        (o, rin) => {
          if (!rin) {
            o.EN = 0;
            o.TT = 0;
            o.DN = 0;
            o.ACC = 0;
            return;
          }
          const wasEnabled = o.EN;
          o.EN = 1;
          if (o.DN !== 0) {
            o.TT = 0;
            return;
          }
          checkNegative(rt, o);
          o.TT = 1;
          if (wasEnabled === 0) startTiming(o, rt.now);
          else accumulate(o, rt.now);
          if (o.ACC >= o.PRE) {
            o.DN = 1;
            o.TT = 0;
            o.ACC = o.PRE;
          }
        },
        (o) => {
          o.EN = 0;
          o.TT = 0;
          o.DN = 0;
          o.ACC = 0;
        },
      );
    },
  },
  {
    mnemonic: 'TOF',
    category: 'Timer/Counter',
    title: 'Timer Off Delay',
    kind: 'output',
    box: true,
    operands: timerOperands,
    compile(c) {
      const rt = c.rt;
      return compileTimer(
        c,
        (o, rin) => {
          if (rin) {
            o.EN = 1;
            o.TT = 0;
            o.DN = 1;
            o.ACC = 0;
            return;
          }
          const wasEnabled = o.EN;
          o.EN = 0;
          if (o.DN === 0) return;
          checkNegative(rt, o);
          if (wasEnabled !== 0) {
            // first false scan: start the off-delay
            o.TT = 1;
            startTiming(o, rt.now);
          } else {
            accumulate(o, rt.now);
          }
          if (o.ACC >= o.PRE) {
            o.DN = 0;
            o.TT = 0;
            o.ACC = o.PRE;
          }
        },
        (o) => {
          o.EN = 0;
          o.TT = 0;
          o.DN = 0;
          o.ACC = o.PRE;
        },
      );
    },
  },
  {
    mnemonic: 'RTO',
    category: 'Timer/Counter',
    title: 'Retentive Timer On',
    kind: 'output',
    box: true,
    operands: timerOperands,
    compile(c) {
      const rt = c.rt;
      return compileTimer(
        c,
        (o, rin) => {
          if (!rin) {
            // .ACC and .DN are retained; only RES clears them
            o.EN = 0;
            o.TT = 0;
            return;
          }
          const wasEnabled = o.EN;
          o.EN = 1;
          if (o.DN !== 0) {
            o.TT = 0;
            return;
          }
          checkNegative(rt, o);
          o.TT = 1;
          if (wasEnabled === 0) startTiming(o, rt.now);
          else accumulate(o, rt.now);
          if (o.ACC >= o.PRE) {
            o.DN = 1;
            o.TT = 0;
            o.ACC = o.PRE;
          }
        },
        (o) => {
          o.EN = 0;
          o.TT = 0;
        },
      );
    },
  },
];
