/** Logix identifier rules (tags, routines, programs, labels, UDTs). */

export const MAX_NAME_LENGTH = 40;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Words that may not be used as tag names (operators and ST keywords). */
export const RESERVED_WORDS = new Set(
  [
    'AND', 'OR', 'XOR', 'NOT', 'MOD',
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
    'EXIT', 'RETURN', 'TRUE', 'FALSE',
  ].map((s) => s.toUpperCase()),
);

/** Returns an error message, or null if the name is valid. */
export function validateName(name: string, what = 'Name'): string | null {
  if (!name) return `${what} is empty`;
  if (name.length > MAX_NAME_LENGTH) return `${what} '${name}' is longer than ${MAX_NAME_LENGTH} characters`;
  if (!IDENT.test(name)) return `${what} '${name}' contains invalid characters (letters, digits and _ only; must not start with a digit)`;
  if (name.includes('__')) return `${what} '${name}' must not contain consecutive underscores`;
  if (name.endsWith('_')) return `${what} '${name}' must not end with an underscore`;
  if (RESERVED_WORDS.has(name.toUpperCase())) return `${what} '${name}' is a reserved word`;
  return null;
}

export function nameKey(name: string): string {
  return name.toLowerCase();
}
