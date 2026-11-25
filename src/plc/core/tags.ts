/**
 * Tag database: controller and program scopes, aliases, descriptions and
 * initial values.
 */
import { MAX_ARRAY_DIMS, TypeRegistry, type DataType } from './datatypes';
import { validateName, nameKey } from './names';
import { applyInitialValue, createValue, type TypeInfo, type Value } from './values';
import { Runtime } from './runtime';

export type TagUsage = 'Local' | 'Input' | 'Output' | 'InOut' | 'Public';

/** Largest tag LogixSim will create, counted in atomic values (keeps verify from exhausting memory). */
export const MAX_TAG_ATOMS = 1_000_000;

function elementCountOf(dims: number[] | null): number {
  return dims ? dims.reduce((a, x) => a * x, 1) : 1;
}

const leafCache = new WeakMap<DataType, number>();
/** Number of atomic values in one instance of a type (structures counted recursively). */
export function atomicLeafCount(reg: TypeRegistry, type: DataType): number {
  if (type.kind === 'atomic') return 1;
  const hit = leafCache.get(type);
  if (hit !== undefined) return hit;
  let n = 0;
  for (const m of type.members) {
    const mt = reg.get(m.dataType);
    n += (m.dims && m.dims.length ? elementCountOf(m.dims) : 1) * (mt ? atomicLeafCount(reg, mt) : 1);
  }
  leafCache.set(type, n);
  return n;
}

/** A tag as stored in a project file. */
export interface TagDef {
  name: string;
  /** Data type name. Ignored for alias tags (type comes from the target). */
  dataType: string;
  /** Array dimensions (1..3) */
  dims?: number[];
  description?: string;
  /** Alias target operand, e.g. `Local:1:I.Data.6` */
  alias?: string;
  /** Initial value (number, array, or object of member values) */
  value?: unknown;
  /** Constant tags cannot be written by logic */
  constant?: boolean;
  usage?: TagUsage;
}

export interface ModuleTagInfo {
  slot: number;
  /** 'I' input, 'O' output, 'C' configuration */
  connection: 'I' | 'O' | 'C';
  catalog: string;
}

export class Tag {
  readonly key: string;
  /** Resolved data type (null for alias tags until resolved through refs) */
  type: DataType | null;
  dims: number[] | null;
  /** Container holding the tag's value: `holder.value` */
  readonly holder: { value: Value };
  constructor(
    readonly name: string,
    readonly scope: Scope,
    readonly def: TagDef,
    type: DataType | null,
    dims: number[] | null,
    value: Value,
    readonly module?: ModuleTagInfo,
  ) {
    this.key = nameKey(name);
    this.type = type;
    this.dims = dims;
    this.holder = { value };
  }
  get isAlias(): boolean {
    return !!this.def.alias;
  }
  get description(): string | undefined {
    return this.def.description;
  }
  get info(): TypeInfo | null {
    return this.type ? { type: this.type, dims: this.dims } : null;
  }
}

export class Scope {
  readonly tags = new Map<string, Tag>();
  constructor(
    readonly name: string,
    readonly kind: 'controller' | 'program',
    readonly parent: Scope | null,
    readonly types: TypeRegistry,
  ) {}

  /** Look up a tag in this scope, then in the controller scope. */
  lookup(name: string): Tag | undefined {
    const k = nameKey(name);
    return this.tags.get(k) ?? this.parent?.lookup(name);
  }

  own(name: string): Tag | undefined {
    return this.tags.get(nameKey(name));
  }
}

export interface TagProblem {
  scope: string;
  tag: string;
  message: string;
}

export class TagDatabase {
  readonly types: TypeRegistry;
  readonly controller: Scope;
  readonly programs = new Map<string, Scope>();

  constructor(
    readonly rt: Runtime = new Runtime(),
    types?: TypeRegistry,
  ) {
    this.types = types ?? new TypeRegistry();
    this.controller = new Scope('Controller', 'controller', null, this.types);
  }

  addProgramScope(name: string): Scope {
    const k = nameKey(name);
    let s = this.programs.get(k);
    if (!s) {
      s = new Scope(name, 'program', this.controller, this.types);
      this.programs.set(k, s);
    }
    return s;
  }

  /** Scope for a program name, or the controller scope when omitted. */
  scope(program?: string | null): Scope {
    if (!program) return this.controller;
    const s = this.programs.get(nameKey(program));
    if (!s) throw new Error(`Unknown program '${program}'`);
    return s;
  }

  /**
   * Create a tag. Problems are appended to `problems`; returns null if the tag
   * could not be created.
   */
  createTag(scope: Scope, def: TagDef, problems: TagProblem[], module?: ModuleTagInfo): Tag | null {
    const report = (message: string) => problems.push({ scope: scope.name, tag: def.name, message });
    if (!module) {
      const nameErr = validateName(def.name, 'Tag name');
      if (nameErr) {
        report(nameErr);
        return null;
      }
    }
    if (scope.own(def.name)) {
      report(`Duplicate tag '${def.name}' in ${scope.name} scope`);
      return null;
    }
    if (def.alias) {
      const tag = new Tag(def.name, scope, def, null, null, 0, module);
      scope.tags.set(tag.key, tag);
      return tag;
    }
    const type = this.types.get(def.dataType);
    if (!type) {
      report(`Undefined data type '${def.dataType}'`);
      return null;
    }
    let dims: number[] | null = null;
    if (def.dims && def.dims.length) {
      if (def.dims.length > MAX_ARRAY_DIMS) {
        report(`Arrays support at most ${MAX_ARRAY_DIMS} dimensions`);
        return null;
      }
      if (def.dims.some((n) => !Number.isInteger(n) || n < 1)) {
        report('Array dimensions must be positive integers');
        return null;
      }
      dims = [...def.dims];
    }
    const atoms = elementCountOf(dims) * atomicLeafCount(this.types, type);
    if (atoms > MAX_TAG_ATOMS) {
      report(`Tag is too large (${atoms} values; the limit is ${MAX_TAG_ATOMS})`);
      return null;
    }
    const value = createValue(this.types, type, dims);
    const tag = new Tag(def.name, scope, def, type, dims, value, module);
    if (def.value !== undefined) {
      const msgs: string[] = [];
      applyInitialValue(this.types, { type, dims }, { holder: tag.holder, key: 'value' }, def.value, msgs, def.name);
      for (const m of msgs) report(m);
    }
    scope.tags.set(tag.key, tag);
    return tag;
  }

  /** All scopes (controller first). */
  allScopes(): Scope[] {
    return [this.controller, ...this.programs.values()];
  }
}
