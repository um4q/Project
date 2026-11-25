/**
 * LogixSim PLC engine - public API. Runs headless (no UI dependencies).
 */
import './ladder/instructions';

export * from './core/datatypes';
export * from './core/values';
export * from './core/faults';
export * from './core/runtime';
export * from './core/names';
export { Tag, Scope, TagDatabase, type TagDef, type TagUsage, type ModuleTagInfo, type TagProblem } from './core/tags';
export { compileRef, constRef, isRefError, type Ref, type AtomicRef, type StructRef, type ArrayRef, type RefResult } from './core/refs';
export * from './expr/ast';
export { tokenize, type Token } from './expr/lexer';
export { parseExpression, parseTagPath, parseLiteral, ParseError, TokenStream } from './expr/parser';
export { compileExpr, type CompiledExpr, type ExprEnv, type ExprClass } from './expr/compile';
export * from './ladder/ast';
export { parseRung, serializeRung, parseRoutineText, serializeRoutineText, NeutralParseError, type NeutralStyle } from './ladder/neutral';
export {
  getInstruction,
  allInstructions,
  instructionsByCategory,
  CATEGORIES,
  type InstructionDef,
  type Executable,
  type InstrCompiler,
  type InstrCategory,
  type OperandSpec,
  type Span,
} from './ladder/instructions';
export * from './engine/project';
export * from './engine/io';
export { compileProject, verifyProject, type CompiledProject, type CompiledProgram, type CompiledTask, type CompileResult } from './engine/compileProject';
export { registerRoutineCompiler, type VerifyError, type CompiledRoutine, type LadderLiveState, type RoutineCompileEnv, type RoutineCompiler } from './engine/routines';
export { Controller, type ControllerMode, type ScanStats, type DownloadResult } from './engine/controller';
