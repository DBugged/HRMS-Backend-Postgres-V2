/**
 * Direct port of the old backend's `utils/formulaEngine.js`. Deliberately
 * NOT `eval()`/`Function()` — a hand-rolled tokenizer + recursive-descent
 * parser + tree evaluator, so a salary formula can never run arbitrary JS.
 *
 * Grammar (highest -> lowest precedence):
 *   primary    := NUMBER | IDENTIFIER | CALL | '(' comparison ')' | '-' unary
 *   term       := primary (('*'|'/'|'%') primary)*
 *   arith      := term (('+'|'-') term)*
 *   comparison := arith ( ('>'|'<'|'>='|'<='|'=='|'!=') arith )?
 *   CALL       := IDENTIFIER '(' (comparison (',' comparison)*)? ')'
 *
 * Identifiers are case-insensitive, normalized to uppercase at tokenize
 * time. `%` is a binary modulo operator on numbers, not a percent suffix.
 * Comparisons evaluate to 1/0, not booleans. Division/modulo by zero
 * returns 0 rather than throwing/Infinity/NaN.
 *
 * Money safety: a formula can never yield NaN/Infinity. Numeric literals
 * must be plain decimals (`12`, `12.5` — not `.`, `1.2.3` or `.5`), every
 * function call's argument count is checked at compile time (so `IF(a, b)`
 * and `MIN()` are rejected up front instead of evaluating to
 * undefined/±Infinity), and every intermediate and final value is checked
 * to be finite. Any violation throws, which lands that employee in the
 * payroll run's failures[] instead of saving and paying a NaN/Infinity
 * payslip.
 */

// The full set of non-component identifiers a formula may reference,
// ported verbatim from the old salaryComponentController.js. Note: the
// old system's real seed data (seedSalaryComponents.js) uses
// PT_SLAB1_UPTO/PT_SLAB1_AMOUNT/etc. in its PT formula, which are NOT in
// this list — payrollEngine.js flattens ptSlabs into those context vars at
// run time even though the static allow-list here doesn't know about
// them. This is a latent gap in the old system, ported as-is rather than
// silently "fixed" — it only matters once Payroll core (not built yet)
// evaluates formulas at run time.
export const SYSTEM_VARS = [
  'WORKING_DAYS',
  'TOTAL_DAYS_IN_MONTH',
  'PRESENT_DAYS',
  'PAID_LEAVE_DAYS',
  'UNPAID_LEAVE_DAYS',
  'HALF_DAYS',
  'OT_HOURS',
  // Approved overtime hours weighted by each record's rateMultiplier (1.5x
  // regular, 2x holiday/weekend, ...) — see computeAttendanceSummary.
  'OT_WEIGHTED_HOURS',
  'LATE_MARKS',
  'HOLIDAY_WORK_DAYS',
  'WEEKEND_WORK_DAYS',
  'LOP_DAYS',
  'PAYABLE_DAYS',
  'HOLIDAYS',
  'WEEKLY_OFFS',
  'GROSS_EARNINGS',
  'TOTAL_DEDUCTIONS',
  'PF_EMPLOYEE_RATE',
  'PF_EMPLOYER_RATE',
  'PF_WAGE_CEILING',
  'ESI_EMPLOYEE_RATE',
  'ESI_EMPLOYER_RATE',
  'ESI_WAGE_CEILING',
  'LWF_EMPLOYEE_AMOUNT',
  'LWF_EMPLOYER_AMOUNT',
  'NPS_EMPLOYER_RATE',
  'GRATUITY_RATE',
  // Statutory wage bases and inputs added with the Labour Codes / ESI / Bonus work — see
  // payroll/formula-context.ts (buildBaseContext + deriveStatutoryContext).
  'BASIC_DA',
  'PF_WAGES',
  'GRATUITY_WAGES',
  'NPS_WAGES',
  'ESI_APPLICABLE',
  'PF_EDLI_RATE',
  'PF_ADMIN_RATE',
  'PF_EDLI_MAX',
  'BONUS_RATE',
  'BONUS_ELIGIBILITY_CEILING',
  'BONUS_CALC_CEILING',
] as const;

type BinaryOp = '+' | '-' | '*' | '/' | '%';
type CompareOp = '>' | '<' | '>=' | '<=' | '==' | '!=';

type AstNode =
  | { type: 'num'; value: number }
  | { type: 'ident'; name: string }
  | { type: 'call'; name: string; args: AstNode[] }
  | { type: 'unary'; op: '-'; arg: AstNode }
  | { type: 'binary'; op: BinaryOp; left: AstNode; right: AstNode }
  | { type: 'compare'; op: CompareOp; left: AstNode; right: AstNode };

interface Token {
  type: 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
  value: string;
}

const OPERATORS = ['>=', '<=', '==', '!=', '+', '-', '*', '/', '%', '>', '<'];

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch });
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const raw = expr.slice(i, j);
      // Only plain decimals — a bare "." or "1.2.3" used to reach Number()
      // and become NaN, which then flowed straight into a saved payslip.
      if (!/^\d+(\.\d+)?$/.test(raw)) {
        throw new Error(`Invalid number "${raw}" in formula`);
      }
      tokens.push({ type: 'num', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
      tokens.push({ type: 'ident', value: expr.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    const twoChar = expr.slice(i, i + 2);
    if (OPERATORS.includes(twoChar)) {
      tokens.push({ type: 'op', value: twoChar });
      i += 2;
      continue;
    }
    const oneChar = expr[i];
    if (OPERATORS.includes(oneChar)) {
      tokens.push({ type: 'op', value: oneChar });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in formula`);
  }
  return tokens;
}

// Allowed argument counts per function (max undefined = no upper bound).
// Checked at compile time so a malformed call is rejected when the formula is
// saved/validated, not discovered as undefined/±Infinity on a payslip:
// IF(a, b) used to return undefined for a false condition, and MIN()/MAX()
// with no arguments returned Infinity/-Infinity.
const FUNCTION_ARITY: Record<string, { min: number; max?: number }> = {
  IF: { min: 3, max: 3 },
  AND: { min: 1 },
  OR: { min: 1 },
  NOT: { min: 1, max: 1 },
  ROUND: { min: 1, max: 2 },
  MIN: { min: 1 },
  MAX: { min: 1 },
  ABS: { min: 1, max: 1 },
  PERCENT: { min: 2, max: 2 },
  PT_SLAB_AMOUNT: { min: 1, max: 1 },
};

function plural(n: number): string {
  return `${n} argument${n === 1 ? '' : 's'}`;
}

function assertCallArity(name: string, count: number): void {
  const arity = FUNCTION_ARITY[name];
  if (!arity) throw new Error(`Unknown function "${name}" in formula`);
  const { min, max } = arity;
  if (count >= min && (max === undefined || count <= max)) return;
  const expected =
    max === undefined
      ? `at least ${plural(min)}`
      : min === max
        ? `exactly ${plural(min)}`
        : `between ${min} and ${max} arguments`;
  throw new Error(`${name}() expects ${expected}, got ${count}, in formula`);
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('Unexpected end of formula');
    this.pos++;
    return tok;
  }

  parse(): AstNode {
    const node = this.comparison();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token "${this.peek()?.value}" in formula`);
    }
    return node;
  }

  private comparison(): AstNode {
    const left = this.arith();
    const tok = this.peek();
    if (
      tok?.type === 'op' &&
      ['>', '<', '>=', '<=', '==', '!='].includes(tok.value)
    ) {
      this.consume();
      const right = this.arith();
      return { type: 'compare', op: tok.value as CompareOp, left, right };
    }
    return left;
  }

  private arith(): AstNode {
    let node = this.term();
    while (
      this.peek()?.type === 'op' &&
      ['+', '-'].includes(this.peek()!.value)
    ) {
      const op = this.consume().value as BinaryOp;
      node = { type: 'binary', op, left: node, right: this.term() };
    }
    return node;
  }

  private term(): AstNode {
    let node = this.primary();
    while (
      this.peek()?.type === 'op' &&
      ['*', '/', '%'].includes(this.peek()!.value)
    ) {
      const op = this.consume().value as BinaryOp;
      node = { type: 'binary', op, left: node, right: this.primary() };
    }
    return node;
  }

  private primary(): AstNode {
    const tok = this.peek();
    if (!tok) throw new Error('Unexpected end of formula');

    if (tok.type === 'op' && tok.value === '-') {
      this.consume();
      return { type: 'unary', op: '-', arg: this.primary() };
    }
    if (tok.type === 'num') {
      this.consume();
      const value = Number(tok.value);
      if (!Number.isFinite(value)) {
        throw new Error(`Number "${tok.value}" is too large in formula`);
      }
      return { type: 'num', value };
    }
    if (tok.type === 'lparen') {
      this.consume();
      const node = this.comparison();
      if (this.peek()?.type !== 'rparen')
        throw new Error('Expected ")" in formula');
      this.consume();
      return node;
    }
    if (tok.type === 'ident') {
      this.consume();
      if (this.peek()?.type === 'lparen') {
        this.consume();
        const args: AstNode[] = [];
        if (this.peek()?.type !== 'rparen') {
          args.push(this.comparison());
          while (this.peek()?.type === 'comma') {
            this.consume();
            args.push(this.comparison());
          }
        }
        if (this.peek()?.type !== 'rparen')
          throw new Error('Expected ")" in formula');
        this.consume();
        assertCallArity(tok.value, args.length);
        return { type: 'call', name: tok.value, args };
      }
      return { type: 'ident', name: tok.value };
    }
    throw new Error(`Unexpected token "${tok.value}" in formula`);
  }
}

function collectIdentifiers(node: AstNode, out: Set<string>): void {
  switch (node.type) {
    case 'ident':
      out.add(node.name);
      return;
    case 'num':
      return;
    case 'unary':
      collectIdentifiers(node.arg, out);
      return;
    case 'binary':
    case 'compare':
      collectIdentifiers(node.left, out);
      collectIdentifiers(node.right, out);
      return;
    case 'call':
      for (const arg of node.args) collectIdentifiers(arg, out);
      return;
  }
}

export interface CompiledFormula {
  ast: AstNode;
  referencedNames: string[];
}

export function compileFormula(expr: string): CompiledFormula {
  const tokens = tokenize(expr);
  const ast = new Parser(tokens).parse();
  const names = new Set<string>();
  collectIdentifiers(ast, names);
  return { ast, referencedNames: [...names] };
}

type Context = Record<string, number>;

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}
function safeMod(a: number, b: number): number {
  return b === 0 ? 0 : a % b;
}

const FUNCTIONS: Record<string, (args: number[], context: Context) => number> =
  {
    IF: (args) => (args[0] ? args[1] : args[2]),
    AND: (args) => (args.every((a) => a) ? 1 : 0),
    OR: (args) => (args.some((a) => a) ? 1 : 0),
    NOT: (args) => (args[0] ? 0 : 1),
    ROUND: (args) => {
      const decimals = args[1] ?? 0;
      // A huge/fractional decimals argument made 10 ** decimals overflow to
      // Infinity (and the result NaN/Infinity).
      if (!Number.isInteger(decimals) || decimals < -10 || decimals > 10) {
        throw new Error(
          'ROUND() decimals must be a whole number between -10 and 10',
        );
      }
      const factor = 10 ** decimals;
      return Math.round(args[0] * factor) / factor;
    },
    MIN: (args) => Math.min(...args),
    MAX: (args) => Math.max(...args),
    ABS: (args) => Math.abs(args[0]),
    PERCENT: (args) => (args[0] * args[1]) / 100,
    // Professional Tax for a given monthly gross, resolved against however
    // many PT slabs the org has configured (buildPtSlabContext puts them in
    // the context as PT_SLAB<n>_UPTO / PT_SLAB<n>_AMOUNT).
    //
    // The seeded PT formula used to spell the slabs out by hand and so was
    // welded to exactly three of them: a two-slab org threw
    // 'Unknown reference "PT_SLAB3_AMOUNT"' and dropped the employee into the
    // run's failures[], and a four-slab org silently taxed everyone above
    // slab 3's ceiling at slab 3's amount. Walking the context instead is
    // correct for any slab count.
    //
    // Slabs are in ascending order; the last one is open-ended (no _UPTO), so
    // running off the end returns the top slab's amount.
    PT_SLAB_AMOUNT: (args, context) => {
      const gross = args[0] ?? 0;
      let amount = 0;
      for (let n = 1; ; n += 1) {
        const amountKey = `PT_SLAB${n}_AMOUNT`;
        if (!(amountKey in context)) return amount;
        amount = context[amountKey];
        const upToKey = `PT_SLAB${n}_UPTO`;
        if (!(upToKey in context) || gross <= context[upToKey]) return amount;
      }
    },
  };

// Every node's value is checked, not just the final result — an
// intermediate Infinity/NaN can otherwise be laundered into a finite-looking
// number (e.g. `HUGE * HUGE > 0` evaluates to 1).
function evaluateNode(node: AstNode, context: Context): number {
  const value = evaluateNodeUnchecked(node, context);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Formula produced a non-finite value (${String(value)}) — check for overflow or an invalid calculation`,
    );
  }
  return value;
}

function evaluateNodeUnchecked(node: AstNode, context: Context): number {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'ident': {
      if (!(node.name in context)) {
        throw new Error(`Unknown reference "${node.name}" in formula`);
      }
      return context[node.name];
    }
    case 'unary':
      return -evaluateNode(node.arg, context);
    case 'binary': {
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return safeDiv(left, right);
        case '%':
          return safeMod(left, right);
      }
      break;
    }
    case 'compare': {
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);
      switch (node.op) {
        case '>':
          return left > right ? 1 : 0;
        case '<':
          return left < right ? 1 : 0;
        case '>=':
          return left >= right ? 1 : 0;
        case '<=':
          return left <= right ? 1 : 0;
        case '==':
          return left === right ? 1 : 0;
        case '!=':
          return left !== right ? 1 : 0;
      }
      break;
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`Unknown function "${node.name}" in formula`);
      // Normally already enforced by the parser; re-checked defensively.
      assertCallArity(node.name, node.args.length);
      const args = node.args.map((a) => evaluateNode(a, context));
      return fn(args, context);
    }
  }
  throw new Error('Unreachable formula node');
}

export function evaluateFormula(expr: string, context: Context): number {
  const { ast } = compileFormula(expr);
  return evaluateNode(ast, context);
}

/**
 * DFS topological sort with 3-state visited tracking (undefined =
 * unvisited, 0 = visiting/in-progress, 1 = done). Throws with the exact
 * cycle path on a circular reference — matches the old system's error
 * format `"Circular reference detected in salary formulas: A -> B -> C"`.
 * Only edges pointing at a key present in `edges` are followed, so
 * references to system variables never participate in cycle detection.
 */
export function topoSortComponents(edges: Record<string, string[]>): string[] {
  const state = new Map<string, 0 | 1>();
  const order: string[] = [];
  const path: string[] = [];

  function visit(code: string): void {
    const s = state.get(code);
    if (s === 1) return;
    if (s === 0) {
      const cycleStart = path.indexOf(code);
      const cycle = [...path.slice(cycleStart), code];
      throw new Error(
        `Circular reference detected in salary formulas: ${cycle.join(' -> ')}`,
      );
    }
    state.set(code, 0);
    path.push(code);
    for (const dep of edges[code] ?? []) {
      if (edges[dep] !== undefined) visit(dep);
    }
    path.pop();
    state.set(code, 1);
    order.push(code);
  }

  for (const code of Object.keys(edges)) visit(code);
  return order;
}
