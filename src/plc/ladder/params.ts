/**
 * JSR / SBR / RET parameter passing.
 *
 * Atomic parameters are passed by value with Logix (MOV-style) conversion.
 * Structure and array parameters must match the receiving parameter's data
 * type and size exactly; a mismatch is major fault Type 4 Code 31.
 */
import type { Ref } from '../core/refs';
import { cloneValue, copyInto, sameType, type TypeInfo, type Value } from '../core/values';

/** A parameter value in flight: a number (atomic) or a typed deep copy. */
export type ParamValue = number | { info: TypeInfo; value: Value };

/** Read a value from a ref for parameter passing. */
export function readParam(r: Ref): ParamValue {
  if (r.kind === 'atomic') return r.get();
  return { info: r.info, value: cloneValue(r.get()) };
}

/** Write a parameter value into a ref. Returns false if the types do not match. */
export function writeParam(r: Ref, v: ParamValue): boolean {
  if (r.kind === 'atomic') {
    if (typeof v !== 'number') return false;
    r.set(v);
    return true;
  }
  if (typeof v === 'number') return false;
  if (!sameType(r.info, v.info)) return false;
  copyInto(r.get() as any, v.value as any);
  return true;
}
