/**
 * Data types: atomic types, built-in structures (TIMER, COUNTER, CONTROL, FBD_*),
 * module-defined I/O structures and user-defined types (UDTs).
 *
 * Names are case-insensitive (as in Logix) but case-preserving.
 */

export type AtomicTypeName = 'BOOL' | 'SINT' | 'INT' | 'DINT' | 'REAL';

export const ATOMIC_TYPES: readonly AtomicTypeName[] = ['BOOL', 'SINT', 'INT', 'DINT', 'REAL'];

export interface AtomicType {
  kind: 'atomic';
  name: AtomicTypeName;
}

export interface MemberDef {
  name: string;
  /** Data type name of the member */
  dataType: string;
  /** Array dimension (UDT members support one dimension) */
  dims?: number[];
  description?: string;
  /** Hidden members are not shown in the tag editor */
  hidden?: boolean;
  /** Default value for new instances (atomic members only) */
  defaultValue?: number;
  /** Read-only from user logic (e.g. module status) */
  readOnly?: boolean;
}

export interface StructType {
  kind: 'struct';
  name: string;
  description?: string;
  members: MemberDef[];
  /** lowercase member name -> member */
  memberIndex: Map<string, MemberDef>;
  /** 'builtin' (TIMER...), 'module' (I/O), 'udt' (user-defined) */
  origin: 'builtin' | 'module' | 'udt';
}

export type DataType = AtomicType | StructType;

/** A UDT definition as stored in a project file. */
export interface UDTDef {
  name: string;
  description?: string;
  members: MemberDef[];
}

export const MAX_ARRAY_DIMS = 3;

export function isIntegerType(t: AtomicTypeName): boolean {
  return t === 'SINT' || t === 'INT' || t === 'DINT';
}

export function isNumericType(t: AtomicTypeName): boolean {
  return t === 'SINT' || t === 'INT' || t === 'DINT' || t === 'REAL';
}

/** Number of bits addressable with `.n` on an integer type. */
export function bitWidth(t: AtomicTypeName): number {
  switch (t) {
    case 'SINT':
      return 8;
    case 'INT':
      return 16;
    case 'DINT':
      return 32;
    default:
      return 0;
  }
}

function struct(name: string, members: MemberDef[], origin: StructType['origin'] = 'builtin', description?: string): StructType {
  const memberIndex = new Map<string, MemberDef>();
  for (const m of members) memberIndex.set(m.name.toLowerCase(), m);
  return { kind: 'struct', name, members, memberIndex, origin, description };
}

const b = (name: string, description?: string, extra: Partial<MemberDef> = {}): MemberDef => ({ name, dataType: 'BOOL', description, ...extra });
const d = (name: string, description?: string, extra: Partial<MemberDef> = {}): MemberDef => ({ name, dataType: 'DINT', description, ...extra });
const r = (name: string, description?: string, extra: Partial<MemberDef> = {}): MemberDef => ({ name, dataType: 'REAL', description, ...extra });

export const BUILTIN_STRUCTS: StructType[] = [
  struct('TIMER', [
    d('PRE', 'Preset (ms)'),
    d('ACC', 'Accumulated time (ms)'),
    b('EN', 'Enable'),
    b('TT', 'Timer timing'),
    b('DN', 'Done'),
  ], 'builtin', 'Timer'),
  struct('COUNTER', [
    d('PRE', 'Preset'),
    d('ACC', 'Accumulated count'),
    b('CU', 'Count up enable'),
    b('CD', 'Count down enable'),
    b('DN', 'Done'),
    b('OV', 'Overflow'),
    b('UN', 'Underflow'),
  ], 'builtin', 'Counter'),
  struct('CONTROL', [
    d('LEN', 'Length'),
    d('POS', 'Position'),
    b('EN', 'Enable'),
    b('EU', 'Enable unload'),
    b('DN', 'Done'),
    b('EM', 'Empty'),
    b('ER', 'Error'),
    b('UL', 'Unload'),
    b('IN', 'Inhibit'),
    b('FD', 'Found'),
  ], 'builtin', 'Control structure for file/shift instructions'),
  struct('FBD_TIMER', [
    b('EnableIn', 'Enable input', { defaultValue: 1 }),
    b('TimerEnable', 'Timer enable'),
    d('PRE', 'Preset (ms)'),
    b('Reset', 'Reset'),
    b('EnableOut', 'Enable output'),
    d('ACC', 'Accumulated time (ms)'),
    b('EN', 'Enable'),
    b('TT', 'Timer timing'),
    b('DN', 'Done'),
    d('Status', 'Status'),
    b('InstructFault', 'Instruction fault'),
    b('PresetInv', 'Preset invalid'),
  ], 'builtin', 'Function block timer (TONR/TOFR/RTOR)'),
  struct('FBD_COUNTER', [
    b('EnableIn', 'Enable input', { defaultValue: 1 }),
    b('CUEnable', 'Count up enable'),
    b('CDEnable', 'Count down enable'),
    d('PRE', 'Preset'),
    b('Reset', 'Reset'),
    b('EnableOut', 'Enable output'),
    d('ACC', 'Accumulated count'),
    b('CU', 'Count up'),
    b('CD', 'Count down'),
    b('DN', 'Done'),
    b('OV', 'Overflow'),
    b('UN', 'Underflow'),
  ], 'builtin', 'Function block up/down counter (CTUD)'),
  struct('MOVING_STD_DEV', [
    b('EnableIn', 'Enable input', { defaultValue: 1 }),
    r('In', 'Input'),
    b('InFault', 'Input bad health'),
    b('Initialize', 'Initialize'),
    b('SampleEnable', 'Sample enable', { defaultValue: 1 }),
    d('NumberOfSamples', 'Number of samples', { defaultValue: 1 }),
    b('EnableOut', 'Enable output'),
    r('Out', 'Standard deviation'),
    r('Average', 'Moving average'),
    d('Status', 'Status'),
    b('InstructFault', 'Instruction fault'),
    b('InFaulted', 'Input faulted'),
    b('NumberOfSampInv', 'Number of samples invalid'),
  ], 'builtin', 'Moving standard deviation (MSTD)'),
];

const ATOMIC_OBJECTS = new Map<string, AtomicType>(ATOMIC_TYPES.map((n) => [n.toLowerCase(), { kind: 'atomic', name: n }]));

export class TypeRegistry {
  private types = new Map<string, DataType>();

  constructor() {
    for (const [k, v] of ATOMIC_OBJECTS) this.types.set(k, v);
    for (const s of BUILTIN_STRUCTS) this.types.set(s.name.toLowerCase(), s);
  }

  get(name: string): DataType | undefined {
    return this.types.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.types.has(name.toLowerCase());
  }

  atomic(name: AtomicTypeName): AtomicType {
    return ATOMIC_OBJECTS.get(name.toLowerCase())!;
  }

  /** Register a module-defined structure (I/O). */
  defineModuleType(name: string, members: MemberDef[], description?: string): StructType {
    const existing = this.types.get(name.toLowerCase());
    if (existing && existing.kind === 'struct') return existing;
    const s = struct(name, members, 'module', description);
    this.types.set(name.toLowerCase(), s);
    return s;
  }

  /**
   * Register UDTs. Returns a list of error messages (unknown member types,
   * recursion, duplicate names). Valid UDTs are registered even if others fail.
   */
  defineUDTs(defs: UDTDef[]): string[] {
    const errors: string[] = [];
    const pending = new Map<string, UDTDef>();
    for (const def of defs) {
      const key = def.name.toLowerCase();
      if (this.types.has(key) || pending.has(key)) {
        errors.push(`Data type '${def.name}' is already defined`);
        continue;
      }
      pending.set(key, def);
    }
    // Validate members & detect recursion with DFS.
    const state = new Map<string, 'visiting' | 'done' | 'bad'>();
    const visit = (key: string, path: string[]): boolean => {
      const st = state.get(key);
      if (st === 'done') return true;
      if (st === 'bad') return false;
      if (st === 'visiting') {
        errors.push(`Data type '${pending.get(key)!.name}' contains itself (${[...path, pending.get(key)!.name].join(' -> ')})`);
        return false;
      }
      state.set(key, 'visiting');
      const def = pending.get(key)!;
      let ok = true;
      const seen = new Set<string>();
      for (const m of def.members) {
        const mk = m.name.toLowerCase();
        if (seen.has(mk)) {
          errors.push(`Data type '${def.name}': duplicate member '${m.name}'`);
          ok = false;
        }
        seen.add(mk);
        if (m.dims && (m.dims.length > 1 || m.dims.some((n) => !Number.isInteger(n) || n < 1))) {
          errors.push(`Data type '${def.name}': member '${m.name}' must have a single positive array dimension`);
          ok = false;
        }
        const tk = m.dataType.toLowerCase();
        if (pending.has(tk)) {
          if (!visit(tk, [...path, def.name])) ok = false;
        } else if (!this.types.has(tk)) {
          errors.push(`Data type '${def.name}': member '${m.name}' has unknown data type '${m.dataType}'`);
          ok = false;
        }
      }
      state.set(key, ok ? 'done' : 'bad');
      if (ok) this.types.set(key, struct(def.name, def.members.map((m) => ({ ...m })), 'udt', def.description));
      return ok;
    };
    for (const key of pending.keys()) visit(key, []);
    return errors;
  }

  all(): DataType[] {
    return [...this.types.values()];
  }
}
