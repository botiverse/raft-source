// Strict JSON for every App payload Raft parses or digests (RFC 076, protocol
// v3.2.3 §10.1). JSON.parse cannot be used for these: it silently keeps the
// last of two duplicate keys and accepts lone surrogates, so the object Raft
// hashes could differ from the one an App in another language hashes from the
// same bytes. This parser accepts RFC 8259 JSON and rejects, instead of
// repairing:
// - duplicate keys at any depth, compared after unescaping;
// - keys holding a C0 control character (U+0000-U+001F) after unescaping, at
//   any depth (protocol addendum 4 §4): `"\u001b"` and `"\t"` alike. Values
//   may still hold them. Node 24's JSON.parse can misdecode such a key as a
//   backslash, so the check is made here while decoding the raw text, never on
//   a parsed object;
// - lone or reversed surrogates, raw or escaped (a valid U+FFFD is fine);
// - numbers that are not finite doubles (I-JSON);
// - anything that is not a top-level object, and trailing content.
// Which value types a payload may contain is the schema's business, not the
// parser's: a confirmation description allows no numbers, booleans or null
// (linkCardDescription.ts), other payloads may (Tenny 77619123).
// Every key, `__proto__` included, becomes an own enumerable property, so
// canonicalJson sees exactly the keys that were sent.

export class StrictJsonError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "StrictJsonError";
  }
}

export type StrictJsonValue = string | number | boolean | null | StrictJsonValue[] | { [key: string]: StrictJsonValue };

const MAX_DEPTH = 32;
const LITERALS: readonly [string, StrictJsonValue][] = [["true", true], ["false", false], ["null", null]];
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes as UTF-8 (invalid bytes and a BOM are rejected), then parses strictly. */
export function parseStrictJsonBytes(bytes: Uint8Array): { [key: string]: StrictJsonValue } {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new StrictJsonError("invalid UTF-8", 0);
  }
  return parseStrictJson(text);
}

export function parseStrictJson(text: string): { [key: string]: StrictJsonValue } {
  let i = 0;

  const fail = (message: string): never => {
    throw new StrictJsonError(message, i);
  };
  const skipWhitespace = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      i++;
    }
  };

  const parseString = (): string => {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        break;
      }
      if (c < 0x20) fail("unescaped control character in string");
      if (c !== 0x5c) {
        out += text[i];
        i++;
        continue;
      }
      const e = text[i + 1];
      i += 2;
      switch (e) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail("invalid \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          i -= 2;
          fail("invalid escape");
      }
    }
    // Checked on the decoded string, so an escaped half pair and a raw one are
    // treated alike: either a full pair or nothing.
    for (let k = 0; k < out.length; k++) {
      const c = out.charCodeAt(k);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = out.charCodeAt(k + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("lone surrogate in string");
        k++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        fail("lone surrogate in string");
      }
    }
    return out;
  };

  const parseValue = (depth: number): StrictJsonValue => {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    skipWhitespace();
    const c = text[i];
    if (c === '"') return parseString();
    if (c === "{") return parseObject(depth);
    if (c === "[") return parseArray(depth);
    if (c === undefined) return fail("unexpected end of input");
    for (const [word, value] of LITERALS) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return value;
      }
    }
    return parseNumber();
  };

  const parseNumber = (): number => {
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (!match) return fail("invalid value");
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("number out of range");
    i += match[0].length;
    return value;
  };

  const parseObject = (depth: number): { [key: string]: StrictJsonValue } => {
    i++; // {
    const out: { [key: string]: StrictJsonValue } = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') fail("expected a string key");
      const start = i;
      const key = parseString();
      for (let k = 0; k < key.length; k++) {
        if (key.charCodeAt(k) < 0x20) {
          i = start;
          fail("control character in key");
        }
      }
      if (seen.has(key)) fail("duplicate key");
      seen.add(key);
      skipWhitespace();
      if (text[i] !== ":") fail("expected ':'");
      i++;
      const value = parseValue(depth + 1);
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return out;
      }
      fail("expected ',' or '}'");
    }
  };

  const parseArray = (depth: number): StrictJsonValue[] => {
    i++; // [
    const out: StrictJsonValue[] = [];
    skipWhitespace();
    if (text[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(parseValue(depth + 1));
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return out;
      }
      fail("expected ',' or ']'");
    }
  };

  skipWhitespace();
  if (text[i] !== "{") fail("top-level value must be an object");
  const value = parseObject(0);
  skipWhitespace();
  if (i !== text.length) fail("trailing content after the top-level object");
  return value;
}

/**
 * Whether any object key in this JSON text holds a C0 control character once
 * unescaped (protocol addendum 4 §4), for payloads that are still parsed with
 * JSON.parse (v1 preview answers). Read from the raw text, string by string,
 * because JSON.parse can already have misdecoded such a key: in valid JSON a
 * string is a key exactly when the next non-whitespace character is `:`. Never
 * a regex over the whole text, which would also match values and a literal
 * backslash. It does not validate: malformed text is JSON.parse's to refuse.
 */
export function hasControlCharacterKey(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x22) {
      i++;
      continue;
    }
    i++; // opening quote
    let control = false;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) control = true;
      if (c !== 0x5c) {
        i++;
        continue;
      }
      const e = text[i + 1];
      if (e === "b" || e === "f" || e === "n" || e === "r" || e === "t") control = true;
      if (e === "u" && /^00[01][0-9A-Fa-f]$/.test(text.slice(i + 2, i + 6))) control = true;
      i += 2; // the escape and its first character; \uXXXX digits are plain characters
    }
    i++; // closing quote
    let next = i;
    while (next < text.length && " \t\n\r".includes(text[next]!)) next++;
    if (control && text[next] === ":") return true;
  }
  return false;
}
