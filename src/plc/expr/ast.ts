/** Expression and operand-path AST shared by ladder (CPT/CMP), ST and FBD. */

export type PathSeg =
  | { kind: 'member'; name: string }
  | { kind: 'index'; indices: Expr[] }
  | { kind: 'bit'; bit: number }
  | { kind: 'bitIndirect'; index: Expr };

export interface TagPath {
  base: string;
  segs: PathSeg[];
}

export type BinaryOp = '+' | '-' | '*' | '/' | 'MOD' | '**' | 'AND' | 'OR' | 'XOR' | '=' | '<>' | '<' | '<=' | '>' | '>=';
export type UnaryOp = '-' | 'NOT';

export type Expr =
  | { kind: 'num'; value: number; isReal: boolean; pos: number }
  | { kind: 'bool'; value: boolean; pos: number }
  | { kind: 'ref'; path: TagPath; text: string; pos: number; end: number }
  | { kind: 'unary'; op: UnaryOp; arg: Expr; pos: number }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; pos: number }
  | { kind: 'call'; name: string; args: Expr[]; pos: number; end: number };

/** Format a tag path in canonical text form, e.g. `Local:1:I.Data.8`, `Arr[2,1].Val`. */
export function formatPath(p: TagPath, formatIndex: (e: Expr) => string = formatExpr): string {
  let s = p.base;
  for (const seg of p.segs) {
    switch (seg.kind) {
      case 'member':
        s += '.' + seg.name;
        break;
      case 'index':
        s += '[' + seg.indices.map(formatIndex).join(',') + ']';
        break;
      case 'bit':
        s += '.' + seg.bit;
        break;
      case 'bitIndirect':
        s += '.[' + formatIndex(seg.index) + ']';
        break;
    }
  }
  return s;
}

const PREC: Record<BinaryOp, number> = {
  OR: 1,
  XOR: 2,
  AND: 3,
  '=': 4,
  '<>': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  MOD: 7,
  '**': 9,
};

export function binaryPrecedence(op: BinaryOp): number {
  return PREC[op];
}

/** Pretty-print an expression with minimal parentheses. */
export function formatExpr(e: Expr, parentPrec = 0): string {
  switch (e.kind) {
    case 'num': {
      const s = e.isReal && Number.isInteger(e.value) ? e.value.toFixed(1) : String(e.value);
      // a negative literal binds looser than '**': (-2)**2 must not print as -2**2
      return e.value < 0 && parentPrec > 8 ? `(${s})` : s;
    }
    case 'bool':
      return e.value ? 'TRUE' : 'FALSE';
    case 'ref':
      return formatPath(e.path);
    case 'call':
      return `${e.name}(${e.args.map((a) => formatExpr(a)).join(',')})`;
    case 'unary': {
      const inner = formatExpr(e.arg, 8);
      const s = e.op === 'NOT' ? `NOT ${inner}` : `-${inner}`;
      return parentPrec > 8 ? `(${s})` : s;
    }
    case 'binary': {
      const p = PREC[e.op];
      const opText = e.op === 'MOD' || e.op === 'AND' || e.op === 'OR' || e.op === 'XOR' ? ` ${e.op} ` : e.op;
      const s = `${formatExpr(e.left, p)}${opText}${formatExpr(e.right, p + 1)}`;
      return p < parentPrec ? `(${s})` : s;
    }
  }
}
