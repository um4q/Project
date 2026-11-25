/** JSR / SBR / RET parameter passing helpers. */
import type { Ref } from '../core/refs';
import { cloneValue, copyInto, type Value } from '../core/values';

/** Read a value from a ref for parameter passing. */
export function readParam(r: Ref): number | Value {
  if (r.kind === 'atomic') return r.get();
  return cloneValue(r.get());
}

/** Write a parameter value into a ref. Returns false if the shapes are incompatible. */
export function writeParam(r: Ref, v: unknown): boolean {
  if (r.kind === 'atomic') {
    if (typeof v !== 'number') return false;
    r.set(v);
    return true;
  }
  if (typeof v !== 'object' || v === null) return false;
  if (r.kind === 'array' !== Array.isArray(v)) return false;
  copyInto(r.get() as any, v as any);
  return true;
}
