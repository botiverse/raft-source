/**
 * Runtime form protocol v3 conditions (contract `Condition`, `Rule`,
 * `ConditionalRequired`): a small JSON Schema subset, no AJV. Supported
 * keywords: const, enum, pattern, not, anyOf, allOf, properties. An absent
 * value is evaluated as "". Any other keyword, or a pattern outside the
 * portable subset (`isPortableRuntimeFormV3Pattern`), makes the schema
 * unsupported: the parser then treats the whole form as unavailable (fail
 * closed), since a client must never render a form whose rules it cannot
 * evaluate. const/enum compare structurally (object key order does not count).
 *
 * fixtures/v3.conditions.conformance.json is the shared conformance table
 * (TS here, Kotlin on mobile).
 */

export type RuntimeFormV3Schema = Record<string, unknown>;

/** A parsed rule condition: `key` null means the whole values object (scope "#"). */
export type RuntimeFormV3Condition = { key: string | null; schema: RuntimeFormV3Schema };

const SUPPORTED_KEYWORDS = new Set(["const", "enum", "pattern", "not", "anyOf", "allOf", "properties"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether `schema` uses only the supported keywords, with well-formed operands, all the way down. */
export function isSupportedRuntimeFormV3Schema(schema: unknown): schema is RuntimeFormV3Schema {
  if (!isRecord(schema)) return false;
  for (const [keyword, operand] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) return false;
    switch (keyword) {
      case "enum":
        if (!Array.isArray(operand)) return false;
        break;
      case "pattern":
        if (typeof operand !== "string" || !isPortableRuntimeFormV3Pattern(operand)) return false;
        break;
      case "not":
        if (!isSupportedRuntimeFormV3Schema(operand)) return false;
        break;
      case "anyOf":
      case "allOf":
        if (!Array.isArray(operand) || operand.length === 0 || !operand.every(isSupportedRuntimeFormV3Schema)) return false;
        break;
      case "properties":
        if (!isRecord(operand) || !Object.values(operand).every(isSupportedRuntimeFormV3Schema)) return false;
        break;
    }
  }
  return true;
}

/** Characters that must be backslash-escaped to be literal (and the only ones that may be). */
const SYNTAX_CHARACTERS = new Set([..."^$\\.*+?()[]{}|/"]);

/**
 * Whether `pattern` stays inside the portable regex subset that evaluates the
 * same in ECMAScript (`u` flag) and Java/Kotlin: `^`/`$`, literals and
 * backslash-escaped syntax characters, character classes (`[…]`, `[^…]`,
 * ranges), `.`, quantifiers `* + ? {m} {m,} {m,n}` after an atom, groups `( )`
 * and `|`. Everything else (`(?…)` lookarounds, named or non-capturing groups
 * and inline flags, backreferences, `\d`/`\p{…}` and other escapes, lazy or
 * possessive quantifiers, nested classes or `&&` in a class, a bare `]`, `{`
 * or `}`) is rejected. A tiny recognizer, not a full regex parser.
 */
export function isPortableRuntimeFormV3Pattern(pattern: string): boolean {
  const chars = Array.from(pattern);
  let i = 0;
  let depth = 0;
  // Whether the previous token can take a quantifier (a literal, ., a class or a group).
  let quantifiable = false;

  /** An escaped syntax character (and `-` inside a class) at chars[i] === "\\"; returns it or null. */
  const escaped = (inClass: boolean): string | null => {
    const next = chars[i + 1];
    if (next === undefined || !(SYNTAX_CHARACTERS.has(next) || (inClass && next === "-"))) return null;
    i += 2;
    return next;
  };

  /** One class member at chars[i]; returns its code point and whether it is an unescaped "-", or null. */
  const classAtom = (): { code: number; dash: boolean } | null => {
    const char = chars[i];
    if (char === undefined || char === "[" || char === "]") return null;
    if (char === "\\") {
      const literal = escaped(true);
      return literal === null ? null : { code: literal.codePointAt(0)!, dash: false };
    }
    if (char === "&" && chars[i + 1] === "&") return null;
    i += 1;
    return { code: char.codePointAt(0)!, dash: char === "-" };
  };

  /** A class at chars[i] === "["; consumes it, false when outside the subset. */
  const characterClass = (): boolean => {
    i += 1;
    if (chars[i] === "^") i += 1;
    let first = true;
    while (chars[i] !== "]") {
      const start = classAtom();
      if (start === null) return false;
      if (start.dash) {
        // A literal "-" only first or last, never a range endpoint.
        if (!first && chars[i] !== "]") return false;
      } else if (chars[i] === "-" && chars[i + 1] !== "]") {
        i += 1;
        const end = classAtom();
        if (end === null || end.dash || end.code < start.code) return false;
      }
      first = false;
    }
    if (first) return false; // [] / [^]
    i += 1;
    return true;
  };

  /** A brace quantifier at chars[i] === "{": {m}, {m,} or {m,n} with m <= n. */
  const braceQuantifier = (): boolean => {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(chars.slice(i).join(""));
    if (!match) return false;
    if (match[3] && Number(match[3]) < Number(match[1])) return false;
    i += match[0].length;
    return true;
  };

  while (i < chars.length) {
    const char = chars[i];
    switch (char) {
      case "^":
      case "$":
        i += 1;
        quantifiable = false;
        break;
      case "|":
        i += 1;
        quantifiable = false;
        break;
      case "(":
        if (chars[i + 1] === "?") return false;
        i += 1;
        depth += 1;
        quantifiable = false;
        break;
      case ")":
        if (depth === 0) return false;
        i += 1;
        depth -= 1;
        quantifiable = true;
        break;
      case "*":
      case "+":
      case "?":
      case "{":
        if (!quantifiable) return false;
        if (char === "{") {
          if (!braceQuantifier()) return false;
        } else {
          i += 1;
        }
        quantifiable = false; // no lazy (*?), possessive (*+) or stacked quantifiers
        break;
      case "[":
        if (!characterClass()) return false;
        quantifiable = true;
        break;
      case "]":
      case "}":
        return false;
      case "\\":
        if (escaped(false) === null) return false;
        quantifiable = true;
        break;
      default:
        i += 1;
        quantifiable = true;
    }
  }
  if (depth !== 0) return false;
  try {
    new RegExp(pattern, "u");
  } catch {
    return false;
  }
  return true;
}

/** Structural JSON equality: object key order does not count, array order does. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

/** Evaluate a supported schema against a value (absent = ""). */
export function evaluateRuntimeFormV3Schema(schema: RuntimeFormV3Schema, value: unknown): boolean {
  const subject = value === undefined || value === null ? "" : value;
  for (const [keyword, operand] of Object.entries(schema)) {
    switch (keyword) {
      case "const":
        if (!sameJson(subject, operand)) return false;
        break;
      case "enum":
        if (!(operand as unknown[]).some((candidate) => sameJson(subject, candidate))) return false;
        break;
      case "pattern":
        if (typeof subject !== "string" || !new RegExp(operand as string, "u").test(subject)) return false;
        break;
      case "not":
        if (evaluateRuntimeFormV3Schema(operand as RuntimeFormV3Schema, subject)) return false;
        break;
      case "anyOf":
        if (!(operand as RuntimeFormV3Schema[]).some((item) => evaluateRuntimeFormV3Schema(item, subject))) return false;
        break;
      case "allOf":
        if (!(operand as RuntimeFormV3Schema[]).every((item) => evaluateRuntimeFormV3Schema(item, subject))) return false;
        break;
      case "properties": {
        // A non-object subject has no properties: each one is absent ("").
        const record = isRecord(subject) ? subject : {};
        for (const [key, sub] of Object.entries(operand as Record<string, RuntimeFormV3Schema>)) {
          if (!evaluateRuntimeFormV3Schema(sub, record[key])) return false;
        }
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/** The field key a scope names: "#" → null (whole values), "#/properties/<key>" → key; anything else → undefined. */
export function runtimeFormV3ScopeKey(scope: unknown): string | null | undefined {
  if (scope === "#") return null;
  if (typeof scope !== "string" || !scope.startsWith("#/properties/")) return undefined;
  const key = scope.slice("#/properties/".length);
  return key && !key.includes("/") ? key : undefined;
}

/** Evaluate a condition against the form values. */
export function evaluateRuntimeFormV3Condition(condition: RuntimeFormV3Condition, values: Record<string, unknown>): boolean {
  return evaluateRuntimeFormV3Schema(condition.schema, condition.key === null ? values : values[condition.key]);
}
