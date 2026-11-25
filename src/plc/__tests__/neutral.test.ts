/**
 * Neutral (ASCII) rung text: parse, serialize, whole-routine text and walkRung.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRung,
  serializeRung,
  parseRoutineText,
  serializeRoutineText,
  NeutralParseError,
  walkRung,
  countElements,
  isMissingOperand,
  cloneRung,
  type Rung,
  type LadderElement,
  type LadderInstr,
  type LadderBranch,
} from '../index';

// ----------------------------------------------------------------------------- builders

const I = (mnemonic: string, ...operands: string[]): LadderInstr => ({ kind: 'instr', mnemonic, operands });
const BR = (...legs: LadderElement[][]): LadderBranch => ({ kind: 'branch', legs });
const R = (...elements: LadderElement[]): Rung => ({ elements });

const EXAMPLE = '[XIC Start ,XIC Run ] XIC Stop OTE Run ;';
const EXAMPLE_PAREN = '[XIC(Start) ,XIC(Run) ]XIC(Stop)OTE(Run);';
const EXAMPLE_AST = R(BR([I('XIC', 'Start')], [I('XIC', 'Run')]), I('XIC', 'Stop'), I('OTE', 'Run'));

function parseError(fn: () => unknown): NeutralParseError {
  try {
    fn();
  } catch (e) {
    if (e instanceof NeutralParseError) return e;
    throw e;
  }
  throw new Error('expected a NeutralParseError');
}

// ============================================================================ parseRung

describe('parseRung', () => {
  it('parses the spec example in spaced form', () => {
    expect(parseRung(EXAMPLE)).toEqual(EXAMPLE_AST);
  });

  it('parses the same rung in paren (L5K) form', () => {
    expect(parseRung(EXAMPLE_PAREN)).toEqual(EXAMPLE_AST);
    expect(parseRung('[XIC(Start),XIC(Run)]XIC(Stop)OTE(Run);')).toEqual(EXAMPLE_AST);
  });

  it('accepts mixed forms, extra whitespace, tabs and newlines', () => {
    expect(parseRung('[ XIC(Start) , XIC Run ]\tXIC Stop\nOTE(Run)  ;  ')).toEqual(EXAMPLE_AST);
    expect(parseRung('XIC (Start) OTE ( Run )')).toEqual(R(I('XIC', 'Start'), I('OTE', 'Run')));
  });

  it('mnemonics are upper-cased; operand text is kept as written', () => {
    expect(parseRung('xic start ote MyOut ;')).toEqual(R(I('XIC', 'start'), I('OTE', 'MyOut')));
    expect(parseRung('Xic(Local:1:I.Data.8)Ote(Out);')).toEqual(R(I('XIC', 'Local:1:I.Data.8'), I('OTE', 'Out')));
  });

  it('the trailing ; is optional', () => {
    expect(parseRung('XIC A OTE B')).toEqual(R(I('XIC', 'A'), I('OTE', 'B')));
    expect(parseRung('XIC(A)OTE(B)')).toEqual(R(I('XIC', 'A'), I('OTE', 'B')));
  });

  it('empty rungs', () => {
    expect(parseRung('')).toEqual(R());
    expect(parseRung(';')).toEqual(R());
    expect(parseRung('   ;  ')).toEqual(R());
  });

  it('nested branches', () => {
    const text = '[XIC A [XIC B ,XIC C [XIC D ,XIC E ] ] ,XIC F ] OTE G ;';
    expect(parseRung(text)).toEqual(
      R(BR([I('XIC', 'A'), BR([I('XIC', 'B')], [I('XIC', 'C'), BR([I('XIC', 'D')], [I('XIC', 'E')])])], [I('XIC', 'F')]), I('OTE', 'G')),
    );
  });

  it('branches with three or more legs', () => {
    expect(parseRung('[XIC A ,XIC B ,XIC C ,XIC D ] OTE E ;').elements[0]).toEqual(BR([I('XIC', 'A')], [I('XIC', 'B')], [I('XIC', 'C')], [I('XIC', 'D')]));
  });

  it('empty branch legs', () => {
    expect(parseRung('[ ,XIC A ] OTE B ;')).toEqual(R(BR([], [I('XIC', 'A')]), I('OTE', 'B')));
    expect(parseRung('[XIC A , ] OTE B ;')).toEqual(R(BR([I('XIC', 'A')], []), I('OTE', 'B')));
    expect(parseRung('[,]OTE(B);')).toEqual(R(BR([], []), I('OTE', 'B')));
    expect(parseRung('[ ]OTE(B);')).toEqual(R(BR([]), I('OTE', 'B')));
  });

  it('branches with outputs, and a branch at the end of the rung', () => {
    expect(parseRung('XIC A [OTE B ,OTL C ,XIC D OTU E ] ;')).toEqual(R(I('XIC', 'A'), BR([I('OTE', 'B')], [I('OTL', 'C')], [I('XIC', 'D'), I('OTU', 'E')])));
    expect(parseRung('XIC(A)[OTE(B),OTE(C)];')).toEqual(R(I('XIC', 'A'), BR([I('OTE', 'B')], [I('OTE', 'C')])));
  });

  it('missing operands: explicit ? and implicit (spaced form pads to the operand count)', () => {
    expect(parseRung('XIC ? OTE ? ;')).toEqual(R(I('XIC', '?'), I('OTE', '?')));
    expect(parseRung('XIC ;')).toEqual(R(I('XIC', '?')));
    expect(parseRung('XIC')).toEqual(R(I('XIC', '?')));
    expect(parseRung('OSR Storage ;')).toEqual(R(I('OSR', 'Storage', '?')));
    expect(parseRung('[XIC ,XIC B ] OTE ;')).toEqual(R(BR([I('XIC', '?')], [I('XIC', 'B')]), I('OTE', '?')));
    expect(parseRung('OSR(?,Out);')).toEqual(R(I('OSR', '?', 'Out')));
    expect(parseRung('OSR(,Out);')).toEqual(R(I('OSR', '?', 'Out')));
    expect(parseRung('OSR(Sto,);')).toEqual(R(I('OSR', 'Sto', '?')));
  });

  it('spaced form uses the instruction operand count, even when an operand looks like a mnemonic', () => {
    expect(parseRung('OSR Sto Out OTE X ;')).toEqual(R(I('OSR', 'Sto', 'Out'), I('OTE', 'X')));
    expect(parseRung('XIC OTE OTE XIC ;')).toEqual(R(I('XIC', 'OTE'), I('OTE', 'XIC')));
    expect(parseRung('TON T1 1000 0 ;')).toEqual(R(I('TON', 'T1', '1000', '0')));
    expect(parseRung('TON(T1,1000,0);')).toEqual(R(I('TON', 'T1', '1000', '0')));
  });

  it('spaced variadic instructions stop at the next mnemonic', () => {
    expect(parseRung('JSR Sub 0 ;')).toEqual(R(I('JSR', 'Sub', '0')));
    expect(parseRung('JSR Sub 1 In1 Ret1 OTE X ;')).toEqual(R(I('JSR', 'Sub', '1', 'In1', 'Ret1'), I('OTE', 'X')));
    expect(parseRung('XIC A JSR Sub 0 ;')).toEqual(R(I('XIC', 'A'), I('JSR', 'Sub', '0')));
    expect(parseRung('JSR(Sub,2,A,B,C);')).toEqual(R(I('JSR', 'Sub', '2', 'A', 'B', 'C')));
  });

  it('operands with subscripts containing commas and spaces (spaced form)', () => {
    expect(parseRung('XIC Arr[1,2] OTE X[0] ;')).toEqual(R(I('XIC', 'Arr[1,2]'), I('OTE', 'X[0]')));
    expect(parseRung('XIC Arr[1, 2] OTE Out ;')).toEqual(R(I('XIC', 'Arr[1, 2]'), I('OTE', 'Out')));
    expect(parseRung('[XIC A3[0,1,2] ,XIC B[Idx+1].3 ] OTE C.[Idx] ;')).toEqual(R(BR([I('XIC', 'A3[0,1,2]')], [I('XIC', 'B[Idx+1].3')]), I('OTE', 'C.[Idx]')));
    expect(parseRung('XIC Arr[1,2];').elements).toEqual([I('XIC', 'Arr[1,2]')]);
  });

  it('paren operands containing parentheses, brackets and commas', () => {
    expect(parseRung('CPT(Dest,(A+B)*Arr[1,2]);')).toEqual(R(I('CPT', 'Dest', '(A+B)*Arr[1,2]')));
    expect(parseRung('CMP(ABS(A - B) > 2)OTE(X);')).toEqual(R(I('CMP', 'ABS(A - B) > 2'), I('OTE', 'X')));
    expect(parseRung('JSR(Sub,1,Arr[1,2],Ret);')).toEqual(R(I('JSR', 'Sub', '1', 'Arr[1,2]', 'Ret')));
    expect(parseRung('XIC( Start )OTE(  Run  );')).toEqual(R(I('XIC', 'Start'), I('OTE', 'Run')));
    expect(parseRung('NOP();')).toEqual(R(I('NOP')));
    expect(parseRung('NOP ;')).toEqual(R(I('NOP')));
  });

  describe('errors', () => {
    it('unclosed branch', () => {
      const e1 = parseError(() => parseRung('[XIC A ,XIC B OTE C ;'));
      expect(e1.message).toMatch(/Missing '\]' to close branch/);
      expect(e1.pos).toBeGreaterThanOrEqual(0);
      expect(e1.pos).toBeLessThanOrEqual(21);
      const e2 = parseError(() => parseRung('XIC A [XIC B'));
      expect(e2.message).toMatch(/Missing '\]'/);
      expect(e2.rung).toBeUndefined();
    });

    it("stray ']' with its position", () => {
      const e = parseError(() => parseRung('XIC A ] OTE B ;'));
      expect(e.message).toBe("Unexpected ']' outside a branch");
      expect(e.pos).toBe(6);
    });

    it("stray ',' with its position", () => {
      const e = parseError(() => parseRung('XIC A , OTE B ;'));
      expect(e.message).toBe("Unexpected ',' outside a branch");
      expect(e.pos).toBe(6);
      expect(parseError(() => parseRung('[XIC A ,XIC B ] ]')).pos).toBe(16);
    });

    it("junk after ';' with its position", () => {
      const e = parseError(() => parseRung('XIC A OTE B ; XIC C'));
      expect(e.message).toBe('Unexpected text after end of rung');
      expect(e.pos).toBe(14);
      expect(parseError(() => parseRung('XIC A OTE B ;;')).pos).toBe(13);
    });

    it("missing ')' points at the '('", () => {
      const e = parseError(() => parseRung('XIC(A OTE(B);'));
      expect(e.message).toBe("Missing ')'");
      expect(e.pos).toBe(3);
    });

    it('unexpected characters', () => {
      expect(parseError(() => parseRung('123 OTE A ;'))).toMatchObject({ message: "Unexpected character '1'", pos: 0 });
      expect(parseError(() => parseRung('XIC A # ;'))).toMatchObject({ message: "Unexpected character '#'", pos: 6 });
    });
  });
});

// ============================================================================ serializeRung

describe('serializeRung', () => {
  it('spaced output matches the spec example exactly', () => {
    expect(serializeRung(parseRung(EXAMPLE))).toBe(EXAMPLE);
    expect(serializeRung(EXAMPLE_AST, 'spaced')).toBe('[XIC Start ,XIC Run ] XIC Stop OTE Run ;');
  });

  it('paren output matches the L5K style exactly', () => {
    expect(serializeRung(EXAMPLE_AST, 'paren')).toBe('[XIC(Start) ,XIC(Run) ]XIC(Stop)OTE(Run);');
    expect(serializeRung(parseRung(EXAMPLE), 'paren')).toBe(EXAMPLE_PAREN);
  });

  it('accepts an element list', () => {
    expect(serializeRung(EXAMPLE_AST.elements)).toBe(EXAMPLE);
  });

  it('empty rungs', () => {
    expect(serializeRung(R())).toBe(';');
    expect(serializeRung(R(), 'paren')).toBe(';');
  });

  it('missing operands are written as ?', () => {
    expect(serializeRung(R(I('XIC', ''), I('OTE', '?')))).toBe('XIC ? OTE ? ;');
    expect(serializeRung(R(I('OSR', ' ', 'Out')), 'paren')).toBe('OSR(?,Out);');
  });

  it('instructions without operands', () => {
    expect(serializeRung(R(I('NOP')))).toBe('NOP ;');
    expect(serializeRung(R(I('NOP')), 'paren')).toBe('NOP();');
  });

  it('operands that cannot be written spaced fall back to paren form', () => {
    expect(serializeRung(R(I('XIC', 'Arr[1,2]'), I('OTE', 'Out')))).toBe('XIC(Arr[1,2]) OTE Out ;');
    expect(serializeRung(R(I('CPT', 'Dest', 'A + B')))).toBe('CPT(Dest,A + B) ;');
    expect(serializeRung(R(I('CMP', '(A+B)>2'), I('OTE', 'X')))).toBe('CMP((A+B)>2) OTE X ;');
    expect(serializeRung(R(I('XIC', 'Arr[Idx]'), I('OTE', 'B.[Idx]')))).toBe('XIC Arr[Idx] OTE B.[Idx] ;');
  });

  it('nested and empty legs', () => {
    const r = R(BR([], [I('XIC', 'A'), BR([I('XIC', 'B')], [I('XIC', 'C')])]), I('OTE', 'D'));
    expect(serializeRung(r)).toBe('[ ,XIC A [XIC B ,XIC C ] ] OTE D ;');
    expect(serializeRung(r, 'paren')).toBe('[ ,XIC(A)[XIC(B) ,XIC(C) ] ]OTE(D);');
  });

  const ROUND_TRIP: Rung[] = [
    EXAMPLE_AST,
    R(),
    R(I('XIC', 'A'), I('OTE', 'B')),
    R(I('XIC', '?'), I('OTE', '?')),
    R(I('NOP')),
    R(I('OSR', 'Sto', 'Out')),
    R(I('OSR', '?', 'Out'), I('OTE', 'X')),
    R(I('TON', 'T1', '1000', '0')),
    R(I('JSR', 'Sub', '0')),
    R(I('JSR', 'Sub', '2', 'In1', 'Arr[1,2]', 'Ret1')),
    R(I('XIC', 'Arr[1,2]'), I('OTE', 'X[0]')),
    R(I('XIC', 'Local:1:I.Data.8'), I('OTE', 'Local:2:O.Data.0')),
    R(I('XIC', 'Data[0].3'), I('XIO', 'W.[Idx]'), I('OTE', 'S:N')),
    R(I('CPT', 'Dest', '(A + B) * Arr[1, 2]')),
    R(I('CMP', 'ABS(A-B)>2'), I('OTE', 'X')),
    R(BR([], [I('XIC', 'A')]), I('OTE', 'B')),
    R(BR([I('XIC', 'A')], []), I('OTE', 'B')),
    R(BR([], [])),
    R(I('XIC', 'A'), BR([I('OTE', 'B')], [I('OTL', 'C')], [I('XIC', 'D'), I('OTU', 'E')])),
    R(BR([I('XIC', 'A'), BR([I('XIC', 'B')], [I('XIC', 'C'), BR([I('XIC', 'D')], [I('XIO', 'E')])])], [I('XIC', 'F')]), I('OTE', 'G')),
    R(BR([I('XIC', 'A')], [I('XIC', 'B')], [I('XIC', 'C')]), BR([I('OTE', 'D')], [I('OTE', 'E')])),
    R(I('XIC', 'Start'), I('ONS', 'Ons1'), I('OSF', 'S2', 'O2'), I('OTE', 'Pulse')),
  ];

  it.each(ROUND_TRIP.map((r) => [serializeRung(r), r] as const))('round trip spaced: %s', (_t, r) => {
    expect(parseRung(serializeRung(r, 'spaced'))).toEqual(r);
  });

  it.each(ROUND_TRIP.map((r) => [serializeRung(r, 'paren'), r] as const))('round trip paren: %s', (_t, r) => {
    expect(parseRung(serializeRung(r, 'paren'))).toEqual(r);
  });

  it('variadic operands named like a mnemonic still round trip in spaced style', () => {
    // 'Ret', 'Add' and 'Res' are valid tag names that are also mnemonics
    const rungs = [R(I('JSR', 'Sub', '1', 'In', 'Ret')), R(I('JSR', 'Sub', '2', 'Add', 'Res')), R(I('SBR', 'Ret'), I('OTE', 'X'))];
    for (const r of rungs) {
      expect(parseRung(serializeRung(r, 'paren'))).toEqual(r);
      expect(parseRung(serializeRung(r, 'spaced'))).toEqual(r);
    }
  });

  it('serialize(parse(text)) is stable', () => {
    for (const r of ROUND_TRIP) {
      for (const style of ['spaced', 'paren'] as const) {
        const t = serializeRung(r, style);
        expect(serializeRung(parseRung(t), style)).toBe(t);
      }
    }
  });
});

// ============================================================================ routines

describe('parseRoutineText', () => {
  it('one rung per ;, multiple rungs per line, blank lines', () => {
    const rungs = parseRoutineText('XIC A OTE B; XIC C OTE D;\n\n\n  XIC(E)OTE(F);\r\n\r\n');
    expect(rungs).toEqual([R(I('XIC', 'A'), I('OTE', 'B')), R(I('XIC', 'C'), I('OTE', 'D')), R(I('XIC', 'E'), I('OTE', 'F'))]);
  });

  it('a ; inside an operand list does not end the rung', () => {
    expect(parseRoutineText('[XIC A ,XIC B ] OTE C ;\nCPT(D,(A+B));')).toEqual([R(BR([I('XIC', 'A')], [I('XIC', 'B')]), I('OTE', 'C')), R(I('CPT', 'D', '(A+B)'))]);
  });

  it('// comment lines attach to the next rung', () => {
    const rungs = parseRoutineText('// Start / stop\n// seal-in\n[XIC Start ,XIC Run ] XIC Stop OTE Run ;\nXIC Run OTE Lamp ;\n// last\nXIC A OTE B ;');
    expect(rungs).toHaveLength(3);
    expect(rungs[0]).toEqual({ ...EXAMPLE_AST, comment: 'Start / stop\nseal-in' });
    expect(rungs[1].comment).toBeUndefined();
    expect(rungs[2].comment).toBe('last');
  });

  it('comment text keeps all but one leading space and strips CR', () => {
    const rungs = parseRoutineText('//no space\r\n//   indented\r\nXIC A OTE B ;');
    expect(rungs[0].comment).toBe('no space\n  indented');
  });

  it('a missing ; before a comment line still ends the rung', () => {
    expect(parseRoutineText('XIC A OTE B\n// next\nXIC C OTE D')).toEqual([R(I('XIC', 'A'), I('OTE', 'B')), { ...R(I('XIC', 'C'), I('OTE', 'D')), comment: 'next' }]);
  });

  it('a trailing comment becomes an empty commented rung', () => {
    expect(parseRoutineText('XIC A OTE B ;\n// to do')).toEqual([R(I('XIC', 'A'), I('OTE', 'B')), { comment: 'to do', elements: [] }]);
  });

  it('empty rungs are kept', () => {
    expect(parseRoutineText(';\n;\nXIC A OTE B ;')).toEqual([R(), R(), R(I('XIC', 'A'), I('OTE', 'B'))]);
    expect(parseRoutineText('')).toEqual([]);
    expect(parseRoutineText('  \n\n ')).toEqual([]);
  });

  it('L5K RC: / N: lines with $N, $Q, $T, $$ and $\' escapes', () => {
    const text = [
      'RC: "Start/stop seal-in$NPress $QStart$Q to run";',
      'N: [XIC(Start) ,XIC(Run) ]XIC(Stop)OTE(Run);',
      'N: XIC(Run)OTE(Lamp);',
      'RC: "Tab$there, cost 5$$, it$\'s fine";',
      'N: XIC(A)OTE(B);',
    ].join('\n');
    const rungs = parseRoutineText(text);
    expect(rungs).toHaveLength(3);
    expect(rungs[0]).toEqual({ ...EXAMPLE_AST, comment: 'Start/stop seal-in\nPress "Start" to run' });
    expect(rungs[1]).toEqual(R(I('XIC', 'Run'), I('OTE', 'Lamp')));
    expect(rungs[2].comment).toBe("Tab\there, cost 5$, it's fine");
  });

  it('several RC: lines join into one comment; N: may be indented', () => {
    const rungs = parseRoutineText('  RC: "one";\n  RC: "two";\n    N: XIC(A)OTE(B);');
    expect(rungs).toEqual([{ ...R(I('XIC', 'A'), I('OTE', 'B')), comment: 'one\ntwo' }]);
  });

  it('errors carry the rung index and the absolute position', () => {
    const text = 'XIC A OTE B;\nXIC C ] OTE D;';
    const e = parseError(() => parseRoutineText(text));
    expect(e.rung).toBe(1);
    expect(e.message).toBe("Rung 1: Unexpected ']' outside a branch");
    expect(e.pos).toBe(text.indexOf(']'));
    const e2 = parseError(() => parseRoutineText('// c\nXIC A OTE B;\n;\n[XIC C OTE D;'));
    expect(e2.rung).toBe(2);
    expect(e2.message).toMatch(/^Rung 2: Missing '\]'/);
  });

  it('bad RC: comments are errors', () => {
    expect(parseError(() => parseRoutineText('RC: no quotes;'))).toMatchObject({ rung: 0 });
    expect(parseError(() => parseRoutineText('XIC A OTE B;\nRC: "never closed'))).toBeInstanceOf(NeutralParseError);
  });
});

describe('serializeRoutineText', () => {
  it('writes // comments and one rung per line', () => {
    const rungs: Rung[] = [{ ...EXAMPLE_AST, comment: 'Seal-in\nsecond line' }, R(I('XIC', 'Run'), I('OTE', 'Lamp')), R()];
    expect(serializeRoutineText(rungs)).toBe('// Seal-in\n// second line\n[XIC Start ,XIC Run ] XIC Stop OTE Run ;\nXIC Run OTE Lamp ;\n;\n');
    expect(serializeRoutineText(rungs, 'paren')).toBe('// Seal-in\n// second line\n[XIC(Start) ,XIC(Run) ]XIC(Stop)OTE(Run);\nXIC(Run)OTE(Lamp);\n;\n');
    expect(serializeRoutineText([])).toBe('');
  });

  const ROUTINE: Rung[] = [
    { ...EXAMPLE_AST, comment: 'Motor 1\nstart / stop' },
    R(I('XIC', 'Run'), I('OTE', 'Lamp')),
    R(),
    { comment: 'only a comment', elements: [] },
    { ...R(I('XIC', 'Arr[1,2]'), BR([I('OTE', 'A')], [], [I('OTL', 'B')])), comment: '  indented // with slashes; and ; semicolons' },
    R(I('CPT', 'Dest', '(A + B) * 2')),
    { ...R(I('JSR', 'Sub', '1', 'In', 'RetVal')), comment: 'RC: "looks like L5K"' },
    R(I('XIC', 'Data[0].3'), I('OTE', 'Local:2:O.Data.0')),
  ];

  it.each(['spaced', 'paren'] as const)('round trip (%s)', (style) => {
    const text = serializeRoutineText(ROUTINE, style);
    expect(parseRoutineText(text)).toEqual(ROUTINE);
    expect(serializeRoutineText(parseRoutineText(text), style)).toBe(text);
  });
});

// ============================================================================ walkRung & helpers

describe('walkRung', () => {
  it('visits elements in pre-order with ids and depths', () => {
    const rung = parseRung('XIC A [XIC B [XIC C ,XIC D ] ,XIO E ] [OTE F ,OTE G ] ;');
    const seen: string[] = [];
    const n = walkRung(rung.elements, (el, info) => {
      seen.push(`${info.id}:${info.depth}:${el.kind === 'instr' ? `${el.mnemonic} ${el.operands[0]}` : 'branch'}`);
    });
    expect(seen).toEqual(['0:0:XIC A', '1:0:branch', '2:1:XIC B', '3:1:branch', '4:2:XIC C', '5:2:XIC D', '6:1:XIO E', '7:0:branch', '8:1:OTE F', '9:1:OTE G']);
    expect(n).toBe(10);
    expect(countElements(rung.elements)).toBe(10);
  });

  it('the spec example has ids branch=0, XIC Start=1, XIC Run=2, XIC Stop=3, OTE Run=4', () => {
    const ids: string[] = [];
    walkRung(parseRung(EXAMPLE).elements, (el, { id }) => ids.push(`${id}=${el.kind === 'instr' ? el.mnemonic + ' ' + el.operands[0] : 'branch'}`));
    expect(ids).toEqual(['0=branch', '1=XIC Start', '2=XIC Run', '3=XIC Stop', '4=OTE Run']);
  });

  it('empty rungs and empty legs', () => {
    expect(walkRung([], () => {
      throw new Error('no elements');
    })).toBe(0);
    expect(countElements(parseRung('[ , ] OTE X ;').elements)).toBe(2);
  });

  it('isMissingOperand and cloneRung', () => {
    expect(isMissingOperand(undefined)).toBe(true);
    expect(isMissingOperand('')).toBe(true);
    expect(isMissingOperand('  ')).toBe(true);
    expect(isMissingOperand(' ? ')).toBe(true);
    expect(isMissingOperand('A')).toBe(false);
    const r = { ...EXAMPLE_AST, comment: 'c' };
    const c = cloneRung(r);
    expect(c).toEqual(r);
    expect(c.elements).not.toBe(r.elements);
    (c.elements[1] as LadderInstr).operands[0] = 'Changed';
    expect((r.elements[1] as LadderInstr).operands[0]).toBe('Stop');
  });
});
