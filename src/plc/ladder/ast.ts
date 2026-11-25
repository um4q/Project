/** Ladder rung model shared by the editor and the compiler. */

export interface LadderInstr {
  kind: 'instr';
  mnemonic: string;
  /** Operand texts; '?' or '' means "missing" */
  operands: string[];
}

export interface LadderBranch {
  kind: 'branch';
  /** Each leg is a series of elements */
  legs: LadderElement[][];
}

export type LadderElement = LadderInstr | LadderBranch;

export interface Rung {
  comment?: string;
  elements: LadderElement[];
}

export interface WalkInfo {
  /** Pre-order element id within the rung (instructions and branches) */
  id: number;
  /** Nesting depth (0 = main rung) */
  depth: number;
}

/**
 * Visit every element of a rung in pre-order. Element ids produced here are the
 * ids used by the compiler's power-flow array, so the editor can map live
 * power-flow back to graphics.
 */
export function walkRung(elements: LadderElement[], cb: (el: LadderElement, info: WalkInfo) => void): number {
  let id = 0;
  const visit = (series: LadderElement[], depth: number) => {
    for (const el of series) {
      cb(el, { id: id++, depth });
      if (el.kind === 'branch') for (const leg of el.legs) visit(leg, depth + 1);
    }
  };
  visit(elements, 0);
  return id;
}

export function countElements(elements: LadderElement[]): number {
  return walkRung(elements, () => {});
}

export function isMissingOperand(op: string | undefined): boolean {
  return op === undefined || op.trim() === '' || op.trim() === '?';
}

export function cloneRung(r: Rung): Rung {
  return JSON.parse(JSON.stringify(r));
}
