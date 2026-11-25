/**
 * Counter instructions: CTU, CTD, and RES (reset a TIMER, COUNTER or CONTROL).
 *
 * CTU/CTD operands (Logix order): Counter (COUNTER), Preset (immediate DINT),
 * Accum (immediate DINT). The literals are written into .PRE/.ACC at download;
 * at run time the live members are used.
 *
 * Counting happens on false->true transitions of the rung, detected with the
 * counter's own .CU / .CD bit, so a CTU and a CTD can share one COUNTER tag.
 * The 32-bit accumulator wraps; .OV / .UN record the wrap (a wrap in the
 * opposite direction cancels a pending .UN / .OV instead).
 */
import type { InstructionDef, InstrCompiler, Executable } from './registry';
import type { StructRef } from '../../core/refs';
import { DINT_MAX, DINT_MIN, type StructValue } from '../../core/values';
import { passThrough } from './registry';

interface CounterObj {
  PRE: number;
  ACC: number;
  CU: number;
  CD: number;
  DN: number;
  OV: number;
  UN: number;
}

interface TimerBits {
  ACC: number;
  EN: number;
  TT: number;
  DN: number;
}

interface ControlBits {
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

type CounterStep = (o: CounterObj, rungIn: boolean) => void;

function compileCounter(c: InstrCompiler, step: CounterStep, prescan: (o: CounterObj) => void): Executable {
  const ref: StructRef = c.struct(0, 'COUNTER');
  if (!c.failed && !ref.writable) c.error(0, `'${ref.text}' is read-only`);
  const preset = c.immediate(1, { integer: true, min: DINT_MIN, max: DINT_MAX });
  const accum = c.immediate(2, { integer: true, min: DINT_MIN, max: DINT_MAX });
  const get = ref.get as unknown as () => CounterObj;

  if (preset !== null && accum !== null) {
    c.onDownload(() => {
      let o: CounterObj;
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
      let o: CounterObj;
      try {
        o = get();
      } catch {
        return;
      }
      prescan(o);
    },
  };
}

const counterOperands = [
  { name: 'Counter', kind: 'counter' as const },
  { name: 'Preset', kind: 'immediate' as const, description: 'Count at which .DN is set' },
  { name: 'Accum', kind: 'immediate' as const, description: 'Accumulated count' },
];

function resetTimer(v: StructValue): void {
  const o = v as unknown as TimerBits;
  o.ACC = 0;
  o.EN = 0;
  o.TT = 0;
  o.DN = 0;
}

function resetCounter(v: StructValue): void {
  const o = v as unknown as CounterObj;
  o.ACC = 0;
  o.CU = 0;
  o.CD = 0;
  o.DN = 0;
  o.OV = 0;
  o.UN = 0;
}

function resetControl(v: StructValue): void {
  const o = v as unknown as ControlBits;
  o.POS = 0;
  o.EN = 0;
  o.EU = 0;
  o.DN = 0;
  o.EM = 0;
  o.ER = 0;
  o.UL = 0;
  o.IN = 0;
  o.FD = 0;
}

export const counterInstructions: InstructionDef[] = [
  {
    mnemonic: 'CTU',
    category: 'Timer/Counter',
    title: 'Count Up',
    kind: 'output',
    box: true,
    operands: counterOperands,
    compile(c) {
      return compileCounter(
        c,
        (o, rin) => {
          if (!rin) {
            o.CU = 0;
            return;
          }
          if (o.CU === 0) {
            if (o.ACC === DINT_MAX) {
              o.ACC = DINT_MIN;
              if (o.UN !== 0) o.UN = 0;
              else o.OV = 1;
            } else {
              o.ACC = o.ACC + 1;
            }
          }
          o.CU = 1;
          o.DN = o.ACC >= o.PRE ? 1 : 0;
        },
        // Prescan: .CU set so a rung that is already true does not count on the first scan
        (o) => {
          o.CU = 1;
        },
      );
    },
  },
  {
    mnemonic: 'CTD',
    category: 'Timer/Counter',
    title: 'Count Down',
    kind: 'output',
    box: true,
    operands: counterOperands,
    compile(c) {
      return compileCounter(
        c,
        (o, rin) => {
          if (!rin) {
            o.CD = 0;
            return;
          }
          if (o.CD === 0) {
            if (o.ACC === DINT_MIN) {
              o.ACC = DINT_MAX;
              if (o.OV !== 0) o.OV = 0;
              else o.UN = 1;
            } else {
              o.ACC = o.ACC - 1;
            }
          }
          o.CD = 1;
          o.DN = o.ACC >= o.PRE ? 1 : 0;
        },
        // Prescan: .CD set so a rung that is already true does not count on the first scan
        (o) => {
          o.CD = 1;
        },
      );
    },
  },
  {
    mnemonic: 'RES',
    category: 'Timer/Counter',
    title: 'Reset',
    kind: 'output',
    box: false,
    operands: [{ name: 'Structure', kind: 'tag', description: 'TIMER, COUNTER or CONTROL to reset' }],
    compile(c) {
      const ref = c.ref(0, { write: true });
      if (!ref) return passThrough;
      const typeName = ref.kind === 'struct' && ref.stype.origin === 'builtin' ? ref.stype.name.toUpperCase() : '';
      const reset = typeName === 'TIMER' ? resetTimer : typeName === 'COUNTER' ? resetCounter : typeName === 'CONTROL' ? resetControl : null;
      if (!reset) {
        const what = ref.kind === 'array' ? `an array of ${ref.info.type.name}` : ref.kind === 'struct' ? ref.stype.name : ref.atype;
        c.error(0, `Invalid data type: '${ref.text}' is ${what}; TIMER, COUNTER or CONTROL required`);
        return passThrough;
      }
      const sref = ref as StructRef;
      if (sref.isStatic) {
        const o = sref.get();
        return {
          exec(rin) {
            if (rin) reset(o);
            return rin;
          },
        };
      }
      const get = sref.get;
      return {
        exec(rin) {
          if (rin) reset(get());
          return rin;
        },
      };
    },
  },
];
