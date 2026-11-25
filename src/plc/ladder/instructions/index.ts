/**
 * Registers every ladder instruction group. Import this module (directly or via
 * `src/plc`) before parsing or compiling ladder logic.
 */
import { registerInstructions, getInstruction, allInstructions, instructionsByCategory, CATEGORIES } from './registry';
import { bitInstructions } from './bit';
import { timerInstructions } from './timer';
import { counterInstructions } from './counter';
import { compareInstructions } from './compare';
import { mathInstructions } from './math';
import { moveInstructions } from './move';
import { fileInstructions } from './file';
import { programInstructions } from './program';

let registered = false;
export function ensureInstructionsRegistered(): void {
  if (registered) return;
  registered = true;
  registerInstructions([
    ...bitInstructions,
    ...timerInstructions,
    ...counterInstructions,
    ...compareInstructions,
    ...mathInstructions,
    ...moveInstructions,
    ...fileInstructions,
    ...programInstructions,
  ]);
}
ensureInstructionsRegistered();

export { getInstruction, allInstructions, instructionsByCategory, CATEGORIES };
export type { InstructionDef, Executable, InstrCompiler, InstrCategory, OperandSpec, Span } from './registry';
