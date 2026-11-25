/**
 * Bit instructions: XIC, XIO, OTE, OTL, OTU, ONS, OSR, OSF.
 */
import type { InstructionDef } from './registry';

export const bitInstructions: InstructionDef[] = [
  {
    mnemonic: 'XIC',
    category: 'Bit',
    title: 'Examine If Closed',
    kind: 'input',
    box: false,
    operands: [{ name: 'Data Bit', kind: 'bit' }],
    compile(c) {
      const b = c.bit(0);
      const get = b.get;
      return { exec: (rin) => rin && get() === 1 };
    },
  },
  {
    mnemonic: 'XIO',
    category: 'Bit',
    title: 'Examine If Open',
    kind: 'input',
    box: false,
    operands: [{ name: 'Data Bit', kind: 'bit' }],
    compile(c) {
      const b = c.bit(0);
      const get = b.get;
      return { exec: (rin) => rin && get() === 0 };
    },
  },
  {
    mnemonic: 'OTE',
    category: 'Bit',
    title: 'Output Energize',
    kind: 'output',
    box: false,
    operands: [{ name: 'Data Bit', kind: 'bit' }],
    compile(c) {
      const b = c.bit(0, { write: true });
      const set = b.set;
      return {
        exec(rin) {
          set(rin ? 1 : 0);
          return rin;
        },
        // Prescan: non-retentive outputs are cleared
        prescan() {
          set(0);
        },
      };
    },
  },
  {
    mnemonic: 'OTL',
    category: 'Bit',
    title: 'Output Latch',
    kind: 'output',
    box: false,
    operands: [{ name: 'Data Bit', kind: 'bit' }],
    compile(c) {
      const b = c.bit(0, { write: true });
      const set = b.set;
      return {
        exec(rin) {
          if (rin) set(1);
          return rin;
        },
      };
    },
  },
  {
    mnemonic: 'OTU',
    category: 'Bit',
    title: 'Output Unlatch',
    kind: 'output',
    box: false,
    operands: [{ name: 'Data Bit', kind: 'bit' }],
    compile(c) {
      const b = c.bit(0, { write: true });
      const set = b.set;
      return {
        exec(rin) {
          if (rin) set(0);
          return rin;
        },
      };
    },
  },
  {
    mnemonic: 'ONS',
    category: 'Bit',
    title: 'One Shot',
    kind: 'input',
    box: false,
    operands: [{ name: 'Storage Bit', kind: 'bit' }],
    compile(c) {
      const s = c.bit(0, { write: true });
      const get = s.get;
      const set = s.set;
      return {
        exec(rin) {
          if (!rin) {
            set(0);
            return false;
          }
          if (get()) return false;
          set(1);
          return true;
        },
        // Prescan: storage bit set to prevent a false trigger on the first scan
        prescan() {
          set(1);
        },
      };
    },
  },
  {
    mnemonic: 'OSR',
    category: 'Bit',
    title: 'One Shot Rising',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Storage Bit', kind: 'bit' },
      { name: 'Output Bit', kind: 'bit' },
    ],
    compile(c) {
      const s = c.bit(0, { write: true });
      const o = c.bit(1, { write: true });
      return {
        exec(rin) {
          if (rin) {
            o.set(s.get() ? 0 : 1);
            s.set(1);
          } else {
            s.set(0);
            o.set(0);
          }
          return rin;
        },
        prescan() {
          s.set(1);
          o.set(0);
        },
      };
    },
  },
  {
    mnemonic: 'OSF',
    category: 'Bit',
    title: 'One Shot Falling',
    kind: 'output',
    box: true,
    operands: [
      { name: 'Storage Bit', kind: 'bit' },
      { name: 'Output Bit', kind: 'bit' },
    ],
    compile(c) {
      const s = c.bit(0, { write: true });
      const o = c.bit(1, { write: true });
      return {
        exec(rin) {
          if (!rin) {
            o.set(s.get() ? 1 : 0);
            s.set(0);
          } else {
            s.set(1);
            o.set(0);
          }
          return rin;
        },
        prescan() {
          s.set(0);
          o.set(0);
        },
      };
    },
  },
];
