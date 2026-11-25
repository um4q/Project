/**
 * Test helpers: build a single-program ladder project, download it, go to Run.
 */
import { Controller, ladderProject, type TagDef, type RoutineDef, type ModuleDef, type UDTDef, type RungDef, type VerifyError } from '../index';

export interface LadderSetup {
  tags?: TagDef[];
  programTags?: TagDef[];
  rungs: (string | RungDef)[];
  routines?: RoutineDef[];
  modules?: ModuleDef[];
  dataTypes?: UDTDef[];
  scanPeriodMs?: number;
}

/** Compile + download; throws with the verify errors if download fails. */
export function load(setup: LadderSetup): Controller {
  const c = new Controller();
  const res = c.download(ladderProject(setup));
  if (!res.ok) throw new Error('Download failed:\n' + res.errors.map((e) => e.message).join('\n'));
  return c;
}

/** Download and go to Run (prescan done, no scan executed yet). */
export function run(setup: LadderSetup): Controller {
  const c = load(setup);
  const err = c.setMode('RUN');
  if (err) throw new Error(err);
  return c;
}

/** Verify errors for a setup (empty when valid). */
export function verifyErrors(setup: LadderSetup): VerifyError[] {
  return new Controller().verify(ladderProject(setup)).errors;
}

/** Run n continuous scans (each advances time by the scan period). */
export function scans(c: Controller, n = 1): void {
  for (let i = 0; i < n; i++) c.scan();
}

export const dint = (name: string, value?: number, description?: string): TagDef => ({ name, dataType: 'DINT', value, description });
export const bool = (name: string, value?: number | boolean): TagDef => ({ name, dataType: 'BOOL', value });
export const real = (name: string, value?: number): TagDef => ({ name, dataType: 'REAL', value });
export const int = (name: string, value?: number): TagDef => ({ name, dataType: 'INT', value });
export const sint = (name: string, value?: number): TagDef => ({ name, dataType: 'SINT', value });
export const timer = (name: string): TagDef => ({ name, dataType: 'TIMER' });
export const counter = (name: string): TagDef => ({ name, dataType: 'COUNTER' });
export const control = (name: string): TagDef => ({ name, dataType: 'CONTROL' });
export const arr = (name: string, dataType: string, dims: number[], value?: unknown): TagDef => ({ name, dataType, dims, value });
