/**
 * Program control: JSR / SBR / RET, JMP / LBL, MCR, AFI, NOP.
 */
import type { InstructionDef } from './registry';
import { FAULT } from '../../core/faults';
import { readParam, writeParam } from '../params';
import type { Ref } from '../../core/refs';

export const programInstructions: InstructionDef[] = [
  {
    mnemonic: 'JSR',
    category: 'Program Control',
    title: 'Jump to Subroutine',
    kind: 'output',
    box: true,
    variadic: true,
    operands: [
      { name: 'Routine Name', kind: 'routine' },
      { name: 'Input Par Count', kind: 'immediate', description: 'Number of input parameters' },
      { name: 'Input Par / Return Par', kind: 'param' },
    ],
    compile(c) {
      const routine = c.routine(0);
      if (c.operands.length < 2) {
        c.error(-1, 'JSR needs the routine name and the number of input parameters, e.g. JSR(Sub,0)');
      }
      const nIn = c.operands.length >= 2 ? c.immediate(1, { integer: true, min: 0 }) ?? 0 : 0;
      const rest = c.operands.length - 2;
      if (nIn > rest) c.error(1, `Input parameter count ${nIn} is larger than the ${Math.max(0, rest)} parameter(s) given`);
      const inputs: Ref[] = [];
      const returns: Ref[] = [];
      for (let k = 2; k < c.operands.length; k++) {
        const isInput = k - 2 < nIn;
        const r = c.ref(k, { write: !isInput });
        if (r) (isInput ? inputs : returns).push(r);
      }
      const rt = c.rt;
      return {
        exec(rin) {
          if (!rin) return false;
          const args = inputs.map(readParam);
          if (rt.frames.length >= rt.maxCallDepth) rt.majorFault(FAULT.NESTING, `${rt.maxCallDepth} levels`);
          const frame = { args, returns: null as unknown[] | null, returned: false };
          rt.frames.push(frame);
          routine.get().run();
          rt.frames.pop();
          if (frame.returns && returns.length) {
            if (frame.returns.length !== returns.length) rt.majorFault(FAULT.JSR_PARAMS, `RET returned ${frame.returns.length}, JSR expects ${returns.length}`);
            for (let k = 0; k < returns.length; k++) if (!writeParam(returns[k], frame.returns[k])) rt.majorFault(FAULT.JSR_PARAMS, `return parameter ${k} type mismatch`);
          }
          return true;
        },
        prescan() {
          routine.get().prescan();
        },
      };
    },
  },
  {
    mnemonic: 'SBR',
    category: 'Program Control',
    title: 'Subroutine',
    kind: 'either',
    box: true,
    variadic: true,
    operands: [{ name: 'Input Par', kind: 'param' }],
    compile(c) {
      const params: Ref[] = [];
      for (let k = 0; k < c.operands.length; k++) {
        const r = c.ref(k, { write: true });
        if (r) params.push(r);
      }
      const rt = c.rt;
      return {
        exec(rin) {
          const frame = rt.frames[rt.frames.length - 1];
          const args = frame?.args ?? [];
          if (args.length !== params.length) {
            // A routine scanned as a main routine (no JSR) with SBR parameters is left alone.
            if (frame && frame.args) rt.majorFault(FAULT.JSR_PARAMS, `JSR passes ${args.length}, SBR expects ${params.length}`);
            return rin;
          }
          for (let k = 0; k < params.length; k++) if (!writeParam(params[k], args[k])) rt.majorFault(FAULT.JSR_PARAMS, `input parameter ${k} type mismatch`);
          return rin;
        },
      };
    },
  },
  {
    mnemonic: 'RET',
    category: 'Program Control',
    title: 'Return from Subroutine',
    kind: 'output',
    box: true,
    variadic: true,
    operands: [{ name: 'Return Par', kind: 'param' }],
    compile(c) {
      const values: Ref[] = [];
      for (let k = 0; k < c.operands.length; k++) {
        const r = c.ref(k);
        if (r) values.push(r);
      }
      const rt = c.rt;
      return {
        exec(rin) {
          if (!rin) return false;
          const frame = rt.frames[rt.frames.length - 1];
          if (frame) {
            frame.returns = values.map(readParam);
            frame.returned = true;
          }
          return true;
        },
      };
    },
  },
  {
    mnemonic: 'JMP',
    category: 'Program Control',
    title: 'Jump to Label',
    kind: 'output',
    box: false,
    operands: [{ name: 'Label Name', kind: 'label' }],
    compile(c) {
      const label = c.label(0);
      const rt = c.rt;
      return {
        exec(rin) {
          if (rin) rt.jumpLabel = label;
          return rin;
        },
      };
    },
  },
  {
    mnemonic: 'LBL',
    category: 'Program Control',
    title: 'Label',
    kind: 'either',
    box: false,
    operands: [{ name: 'Label Name', kind: 'label' }],
    compile(c) {
      c.label(0);
      return { exec: (rin) => rin };
    },
  },
  {
    mnemonic: 'MCR',
    category: 'Program Control',
    title: 'Master Control Reset',
    kind: 'output',
    box: false,
    operands: [],
    compile(c) {
      const rt = c.rt;
      return {
        exec(rin) {
          if (rt.mcrOpen) {
            // end of zone (the ending MCR is unconditional)
            rt.mcrOpen = false;
            rt.mcrFalse = false;
          } else {
            rt.mcrOpen = true;
            rt.mcrFalse = !rin;
          }
          return rin;
        },
      };
    },
  },
  {
    mnemonic: 'AFI',
    category: 'Program Control',
    title: 'Always False',
    kind: 'input',
    box: false,
    operands: [],
    compile() {
      return { exec: () => false };
    },
  },
  {
    mnemonic: 'NOP',
    category: 'Program Control',
    title: 'No Operation',
    kind: 'either',
    box: false,
    operands: [],
    compile() {
      return { exec: (rin) => rin };
    },
  },
];
