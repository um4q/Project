/**
 * Local I/O chassis: module catalog, module-defined tags (`Local:<slot>:I/O`),
 * the field side the 3D scene reads and writes, analog scaling and I/O forces.
 *
 * The controller copies field -> input tags at the start of every task scan and
 * output tags -> field at the end (synchronous image, as specified).
 */
import type { MemberDef } from '../core/datatypes';
import type { TagDatabase, Tag } from '../core/tags';
import { compileRef, isRefError, type AtomicRef } from '../core/refs';
import { parseTagPath } from '../expr/parser';
import type { Runtime } from '../core/runtime';

export type AnalogRange = '0-10V' | '0-5V' | '1-5V' | '4-20mA' | '-10-10V';

export const ANALOG_RANGES: Record<AnalogRange, { lo: number; hi: number; unit: 'V' | 'mA' }> = {
  '0-10V': { lo: 0, hi: 10, unit: 'V' },
  '0-5V': { lo: 0, hi: 5, unit: 'V' },
  '1-5V': { lo: 1, hi: 5, unit: 'V' },
  '4-20mA': { lo: 4, hi: 20, unit: 'mA' },
  '-10-10V': { lo: -10, hi: 10, unit: 'V' },
};

export interface AnalogChannelConfig {
  range: AnalogRange;
  /** Engineering value at the low end of the signal range */
  lowEng: number;
  /** Engineering value at the high end of the signal range */
  highEng: number;
  /** Engineering units label, e.g. "mm", "°C" */
  units?: string;
}

export interface ModuleDef {
  slot: number;
  catalog: string;
  name?: string;
  description?: string;
  /** Analog channel configuration (analog modules) */
  channels?: AnalogChannelConfig[];
}

export type ModuleKind = 'DI' | 'DO' | 'AI' | 'AO';

export interface CatalogEntry {
  catalog: string;
  kind: ModuleKind;
  description: string;
  /** Points (digital) or channels (analog) */
  size: number;
  inputType?: string;
  outputType?: string;
}

const bool = (name: string, description?: string): MemberDef => ({ name, dataType: 'BOOL', description, readOnly: true });
const dint = (name: string, description?: string): MemberDef => ({ name, dataType: 'DINT', description });
const real = (name: string, description?: string): MemberDef => ({ name, dataType: 'REAL', description });

export const MODULE_CATALOG: CatalogEntry[] = [
  { catalog: 'LX-IQ16', kind: 'DI', description: '16-point 24 V DC input', size: 16, inputType: 'LX:IQ16:I:0' },
  { catalog: 'LX-OB16', kind: 'DO', description: '16-point 24 V DC source output', size: 16, inputType: 'LX:OB16:I:0', outputType: 'LX:OB16:O:0' },
  { catalog: 'LX-IF4', kind: 'AI', description: '4-channel analog input (V / mA)', size: 4, inputType: 'LX:IF4:I:0' },
  { catalog: 'LX-OF2', kind: 'AO', description: '2-channel analog output (V / mA)', size: 2, inputType: 'LX:OF2:I:0', outputType: 'LX:OF2:O:0' },
];

export function catalogEntry(catalog: string): CatalogEntry | undefined {
  return MODULE_CATALOG.find((c) => c.catalog.toLowerCase() === catalog.toLowerCase());
}

function moduleTypeMembers(typeName: string): MemberDef[] {
  switch (typeName) {
    case 'LX:IQ16:I:0':
      return [dint('Fault', 'Module fault word'), dint('Data', 'Input data (bits 0-15)')];
    case 'LX:OB16:I:0':
      return [dint('Fault', 'Module fault word'), dint('Data', 'Output readback (bits 0-15)')];
    case 'LX:OB16:O:0':
      return [dint('Data', 'Output data (bits 0-15)')];
    case 'LX:IF4:I:0': {
      const m: MemberDef[] = [dint('Fault', 'Module fault word')];
      for (let c = 0; c < 4; c++) m.push(real(`Ch${c}Data`, `Channel ${c} value (engineering units)`));
      for (let c = 0; c < 4; c++) m.push(bool(`Ch${c}Underrange`, `Channel ${c} under range`), bool(`Ch${c}Overrange`, `Channel ${c} over range`));
      return m;
    }
    case 'LX:OF2:I:0': {
      const m: MemberDef[] = [dint('Fault', 'Module fault word')];
      for (let c = 0; c < 2; c++) m.push(bool(`Ch${c}Underrange`, `Channel ${c} clamped low`), bool(`Ch${c}Overrange`, `Channel ${c} clamped high`));
      return m;
    }
    case 'LX:OF2:O:0':
      return [real('Ch0Data', 'Channel 0 value (engineering units)'), real('Ch1Data', 'Channel 1 value (engineering units)')];
  }
  throw new Error(`Unknown module type ${typeName}`);
}

export function defaultChannels(entry: CatalogEntry): AnalogChannelConfig[] {
  if (entry.kind !== 'AI' && entry.kind !== 'AO') return [];
  return Array.from({ length: entry.size }, () => ({ range: '0-10V' as AnalogRange, lowEng: 0, highEng: 10 }));
}

/** Field-side state of one slot (what the 3D scene sees). */
export interface FieldSlot {
  catalog: string;
  /** Digital input bits driven by the scene */
  inputs: number;
  /** Digital output bits driven by the controller */
  outputs: number;
  /** Analog input signals (V or mA) driven by the scene */
  analogIn: number[];
  /** Analog output signals (V or mA) driven by the controller */
  analogOut: number[];
}

export interface ForceEntry {
  /** Canonical tag path, e.g. `Local:1:I.Data.3` */
  path: string;
  value: number;
}

interface BoundModule {
  def: ModuleDef;
  entry: CatalogEntry;
  field: FieldSlot;
  channels: AnalogChannelConfig[];
  inTag: Tag | null;
  outTag: Tag | null;
}

interface BoundForce extends ForceEntry {
  ref: AtomicRef;
  connection: 'I' | 'O';
}

export interface ModuleProblem {
  slot: number;
  message: string;
}

export function scaleToEngineering(cfg: AnalogChannelConfig, signal: number): { value: number; under: boolean; over: boolean } {
  const r = ANALOG_RANGES[cfg.range];
  const under = signal < r.lo;
  const over = signal > r.hi;
  const s = Math.min(r.hi, Math.max(r.lo, signal));
  const value = cfg.lowEng + ((s - r.lo) * (cfg.highEng - cfg.lowEng)) / (r.hi - r.lo);
  return { value, under, over };
}

export function scaleToSignal(cfg: AnalogChannelConfig, eng: number): { value: number; under: boolean; over: boolean } {
  const r = ANALOG_RANGES[cfg.range];
  const span = cfg.highEng - cfg.lowEng;
  const sig = span === 0 ? r.lo : r.lo + ((eng - cfg.lowEng) * (r.hi - r.lo)) / span;
  const under = sig < r.lo;
  const over = sig > r.hi;
  return { value: Math.min(r.hi, Math.max(r.lo, sig)), under, over };
}

export class IOSystem {
  private modules: BoundModule[] = [];
  /** Field state by slot; survives re-download when the catalog is unchanged */
  private field = new Map<number, FieldSlot>();
  private forces: BoundForce[] = [];
  private forceDefs: ForceEntry[] = [];
  forcesEnabled = false;
  private db: TagDatabase | null = null;
  private rt: Runtime | null = null;

  /**
   * Create module tags in `db` for the given modules. Problems are returned
   * (duplicate slot, unknown catalog...). Call before compiling logic.
   */
  static createModuleTags(db: TagDatabase, modules: ModuleDef[]): ModuleProblem[] {
    const problems: ModuleProblem[] = [];
    const used = new Set<number>();
    for (const m of modules) {
      const entry = catalogEntry(m.catalog);
      if (!Number.isInteger(m.slot) || m.slot < 1 || m.slot > 30) {
        problems.push({ slot: m.slot, message: `Slot ${m.slot} is invalid (1..30; slot 0 is the controller)` });
        continue;
      }
      if (used.has(m.slot)) {
        problems.push({ slot: m.slot, message: `Slot ${m.slot} is used by more than one module` });
        continue;
      }
      used.add(m.slot);
      if (!entry) {
        problems.push({ slot: m.slot, message: `Unknown module catalog number '${m.catalog}'` });
        continue;
      }
      const tagProblems: { message: string }[] = [];
      for (const [conn, typeName] of [
        ['I', entry.inputType],
        ['O', entry.outputType],
      ] as const) {
        if (!typeName) continue;
        db.types.defineModuleType(typeName, moduleTypeMembers(typeName), `${entry.catalog} ${conn === 'I' ? 'input' : 'output'} data`);
        db.createTag(
          db.controller,
          { name: `Local:${m.slot}:${conn}`, dataType: typeName, description: m.description ?? `${entry.catalog} ${entry.description}` },
          tagProblems as any,
          { slot: m.slot, connection: conn, catalog: entry.catalog },
        );
      }
      for (const p of tagProblems) problems.push({ slot: m.slot, message: p.message });
      if ((entry.kind === 'AI' || entry.kind === 'AO') && m.channels) {
        if (m.channels.length > entry.size) problems.push({ slot: m.slot, message: `${entry.catalog} has only ${entry.size} channels` });
        m.channels.forEach((c, i) => {
          if (!ANALOG_RANGES[c.range]) problems.push({ slot: m.slot, message: `Channel ${i}: unknown range '${c.range}'` });
          if (!Number.isFinite(c.lowEng) || !Number.isFinite(c.highEng) || c.lowEng === c.highEng)
            problems.push({ slot: m.slot, message: `Channel ${i}: low and high engineering values must be different numbers` });
        });
      }
    }
    return problems;
  }

  /** Bind to a (new) tag database after download. Field state is kept per slot when the catalog matches. */
  bind(db: TagDatabase, modules: ModuleDef[], rt: Runtime): void {
    this.db = db;
    this.rt = rt;
    this.modules = [];
    const nextField = new Map<number, FieldSlot>();
    for (const def of modules) {
      const entry = catalogEntry(def.catalog);
      if (!entry) continue;
      let field = this.field.get(def.slot);
      if (!field || field.catalog !== entry.catalog) {
        field = {
          catalog: entry.catalog,
          inputs: 0,
          outputs: 0,
          analogIn: entry.kind === 'AI' ? new Array(entry.size).fill(0) : [],
          analogOut: entry.kind === 'AO' ? new Array(entry.size).fill(0) : [],
        };
      }
      nextField.set(def.slot, field);
      const channels = defaultChannels(entry).map((d, i) => ({ ...d, ...(def.channels?.[i] ?? {}) }));
      this.modules.push({
        def,
        entry,
        field,
        channels,
        inTag: db.controller.own(`Local:${def.slot}:I`) ?? null,
        outTag: db.controller.own(`Local:${def.slot}:O`) ?? null,
      });
    }
    this.field = nextField;
    this.rebindForces();
  }

  // ---------------------------------------------------------------- field API (scene side)

  slot(slot: number): FieldSlot | undefined {
    return this.field.get(slot);
  }

  /** Field slot if `point` is a valid point number of its module. */
  private point(slot: number, point: number): FieldSlot | undefined {
    const f = this.field.get(slot);
    if (!f || !Number.isInteger(point) || point < 0 || point >= (catalogEntry(f.catalog)?.size ?? 0)) return undefined;
    return f;
  }

  setInput(slot: number, point: number, on: boolean): void {
    const f = this.point(slot, point);
    if (!f) return;
    f.inputs = on ? f.inputs | (1 << point) : f.inputs & ~(1 << point);
  }

  getInput(slot: number, point: number): boolean {
    const f = this.point(slot, point);
    return !!f && ((f.inputs >>> point) & 1) === 1;
  }

  setInputWord(slot: number, word: number): void {
    const f = this.field.get(slot);
    if (f) f.inputs = word | 0;
  }

  getOutput(slot: number, point: number): boolean {
    const f = this.point(slot, point);
    return !!f && ((f.outputs >>> point) & 1) === 1;
  }

  getOutputWord(slot: number): number {
    return this.field.get(slot)?.outputs ?? 0;
  }

  /** Set an analog input signal in volts / mA. */
  setAnalogInput(slot: number, ch: number, signal: number): void {
    const f = this.field.get(slot);
    if (f && ch >= 0 && ch < f.analogIn.length) f.analogIn[ch] = signal;
  }

  /** Set an analog input by engineering value (converted to signal with the channel config). */
  setAnalogInputEng(slot: number, ch: number, eng: number): void {
    const m = this.modules.find((x) => x.def.slot === slot);
    if (!m || !m.channels[ch]) return;
    this.setAnalogInput(slot, ch, scaleToSignal(m.channels[ch], eng).value);
  }

  getAnalogOutput(slot: number, ch: number): number {
    return this.field.get(slot)?.analogOut[ch] ?? 0;
  }

  channelConfig(slot: number, ch: number): AnalogChannelConfig | undefined {
    return this.modules.find((x) => x.def.slot === slot)?.channels[ch];
  }

  // ---------------------------------------------------------------- forces

  /** Current force list (canonical paths). */
  listForces(): ForceEntry[] {
    return this.forceDefs.map((f) => ({ ...f }));
  }

  get hasForces(): boolean {
    return this.forceDefs.length > 0;
  }

  /** True when forces are installed and enabled (yellow "I/O Forced"). */
  get forcesActive(): boolean {
    return this.forcesEnabled && this.forces.length > 0;
  }

  /**
   * Force an I/O point. `path` may be an alias (e.g. `Start`) or an I/O path
   * (`Local:1:I.Data.6`). Returns an error message or null.
   */
  addForce(path: string, value: number, program?: string): string | null {
    if (!this.db || !this.rt) return 'Controller has no project';
    const r = this.resolveForce(path, program);
    if (typeof r === 'string') return r;
    this.removeForce(r.canonical);
    this.forceDefs.push({ path: r.canonical, value });
    this.rebindForces();
    return null;
  }

  removeForce(path: string, program?: string): void {
    let canonical = path;
    if (this.db) {
      const r = this.resolveForce(path, program);
      if (typeof r !== 'string') canonical = r.canonical;
    }
    const k = canonical.toLowerCase();
    this.forceDefs = this.forceDefs.filter((f) => f.path.toLowerCase() !== k);
    this.rebindForces();
  }

  clearForces(): void {
    this.forceDefs = [];
    this.forces = [];
  }

  setForces(list: ForceEntry[]): void {
    this.forceDefs = list.map((f) => ({ ...f }));
    this.rebindForces();
  }

  private resolveForce(path: string, program?: string): AtomicRef | string {
    const db = this.db!;
    let scope = db.controller;
    if (program) {
      try {
        scope = db.scope(program);
      } catch (e) {
        return (e as Error).message;
      }
    }
    let p;
    try {
      p = parseTagPath(path);
    } catch (e) {
      return (e as Error).message;
    }
    const r = compileRef(scope, p, path, { rt: this.rt!, compileIndex: () => null });
    if (isRefError(r)) return r.error;
    if (r.kind !== 'atomic' || !r.tag?.module) return `'${path}' is not an I/O point; only module I/O can be forced`;
    if (r.tag.module.connection === 'C') return `'${path}': configuration data cannot be forced`;
    return r;
  }

  private rebindForces(): void {
    this.forces = [];
    if (!this.db) return;
    const keep: ForceEntry[] = [];
    for (const f of this.forceDefs) {
      const r = this.resolveForce(f.path);
      if (typeof r === 'string') continue;
      keep.push(f);
      this.forces.push({ ...f, ref: r, connection: r.tag!.module!.connection as 'I' | 'O' });
    }
    this.forceDefs = keep;
  }

  // ---------------------------------------------------------------- image transfer (controller side)

  /** Copy field inputs into input tags, then apply input (and output) forces. */
  readInputs(): void {
    for (const m of this.modules) {
      const tag = m.inTag;
      if (!tag) continue;
      const v = tag.holder.value as any;
      switch (m.entry.kind) {
        case 'DI':
          v.Data = m.field.inputs & 0xffff;
          break;
        case 'DO':
          v.Data = m.field.outputs & 0xffff;
          break;
        case 'AI':
          for (let c = 0; c < m.entry.size; c++) {
            const s = scaleToEngineering(m.channels[c], m.field.analogIn[c] ?? 0);
            v[`Ch${c}Data`] = Math.fround(s.value);
            v[`Ch${c}Underrange`] = s.under ? 1 : 0;
            v[`Ch${c}Overrange`] = s.over ? 1 : 0;
          }
          break;
        case 'AO':
          break;
      }
    }
    if (this.forcesEnabled) for (const f of this.forces) f.ref.set(f.value);
  }

  /**
   * Apply output forces, then copy output tags to the field. When the controller
   * is not running, field outputs are de-energized (Program / Faulted).
   */
  writeOutputs(running: boolean): void {
    if (this.forcesEnabled) for (const f of this.forces) if (f.connection === 'O') f.ref.set(f.value);
    for (const m of this.modules) {
      const out = m.outTag?.holder.value as any;
      // Outside Run the field gets the program-mode image (off / low end of range) with output forces on top
      // (forces act regardless of controller mode).
      const pm = running ? null : this.programModeImage(m);
      if (m.entry.kind === 'DO') {
        m.field.outputs = pm ? pm.bits : out ? out.Data & 0xffff : 0;
      } else if (m.entry.kind === 'AO') {
        const inV = m.inTag?.holder.value as any;
        for (let c = 0; c < m.entry.size; c++) {
          const eng = pm ? pm.eng[c] : out ? out[`Ch${c}Data`] : m.channels[c].lowEng;
          const s = scaleToSignal(m.channels[c], eng);
          m.field.analogOut[c] = s.value;
          if (inV) {
            inV[`Ch${c}Underrange`] = running && s.under ? 1 : 0;
            inV[`Ch${c}Overrange`] = running && s.over ? 1 : 0;
          }
        }
      }
    }
  }

  /** Field image of an output module outside Run: all off / low end of range, then output forces in list order. */
  private programModeImage(m: BoundModule): { bits: number; eng: number[] } {
    let bits = 0;
    const eng = m.channels.map((c) => c.lowEng);
    if (this.forcesEnabled && m.outTag) {
      for (const f of this.forces) {
        if (f.connection !== 'O' || f.ref.tag !== m.outTag) continue;
        const member = f.path.slice(f.path.indexOf('.') + 1); // 'Data', 'Data.4', 'Ch0Data'
        const bit = /^Data\.(\d+)$/i.exec(member);
        const ch = /^Ch(\d+)Data$/i.exec(member);
        if (bit) bits = f.value ? bits | (1 << Number(bit[1])) : bits & ~(1 << Number(bit[1]));
        else if (/^Data$/i.test(member)) bits = f.value | 0;
        else if (ch) eng[Number(ch[1])] = f.value;
      }
    }
    return { bits: bits & 0xffff, eng };
  }

  /** Called when outputs must drop immediately (fault / program mode). */
  deenergize(): void {
    this.writeOutputs(false);
  }
}
