/**
 * What a gated call carries, as text Raft's confirm dialog shows (ArtifactFrameConfirm): a copy of
 * Porthole 0.14.17's `formatBounded` and `cutText` (src/bridge/bounded-text.ts, navigation.ts;
 * Apache-2.0, P095), which its default dialog uses and its package doesn't export. Drop this for
 * Porthole's own once it exports them (a Porthole follow-up, #proj-workspace:#252).
 *
 * A frame's arguments come structured-cloned: a cycle, a BigInt, or a graph billions of nodes long
 * as a tree. A string is as it is, cut. Anything else is written the way JSON writes it, each
 * object read once (`"[Circular]"`, `"[Repeated]"`), at most `nodes` values (`…` where it stops)
 * and `depth` levels, a BigInt as `"5n"`, a Date as its time, an Error as its name and message,
 * any other object as its kind (`"[Map]"`), anything whose read throws as `"[unreadable]"`. Never
 * throws. `whole` is false whenever the text isn't all of the value: the dialog then says so.
 */

export interface TextLimits {
  readonly chars: number;
  readonly nodes: number;
  readonly depth: number;
}

/** Porthole's dialog's bounds (`DIALOG_TEXT_LIMITS`). */
export const CONFIRM_TEXT_LIMITS: TextLimits = { chars: 20_000, nodes: 2_000, depth: 24 };

export interface BoundedText {
  readonly text: string;
  readonly whole: boolean;
}

/** A sealed address's access (P083), cut off by the end of the text. */
const UNFINISHED = /\/__porthole\/f\/[A-Za-z0-9_-]*$/u;

/** At most `max` characters; a cut inside a sealed address's access drops what is left of it. */
export const cutText = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max).replace(UNFINISHED, "");

const BIGGEST = 10n ** 2_000n;

function unboxed(kind: string, boxed: object): unknown {
  switch (kind) {
    case "String":
      return String.prototype.valueOf.call(boxed);
    case "Number":
      return Number.prototype.valueOf.call(boxed);
    case "Boolean":
      return Boolean.prototype.valueOf.call(boxed);
    default:
      return BigInt.prototype.valueOf.call(boxed);
  }
}

const UNREADABLE: unique symbol = Symbol("unreadable");

/** `value` as bounded text; with `indent`, laid out as `JSON.stringify(value, null, indent)`. */
export function formatBounded(value: unknown, limits: TextLimits, indent = 0): BoundedText {
  if (typeof value === "string") {
    const text = cutText(value, limits.chars);
    return { text, whole: text === value };
  }
  let out = "";
  let nodes = limits.nodes;
  let stopped = false;
  let whole = true;
  const written = new WeakSet<object>();
  const inside = new WeakSet<object>();
  const colon = indent > 0 ? ": " : ":";
  const quoted = (text: string) => {
    const room = Math.max(0, limits.chars - out.length);
    if (text.length > room) whole = false;
    return JSON.stringify(cutText(text, room));
  };
  const line = (depth: number) => (indent > 0 ? `\n${" ".repeat(indent * depth)}` : "");
  const room = (separator: string): boolean => {
    nodes -= 1;
    if (!stopped && (nodes < 0 || out.length >= limits.chars)) {
      stopped = true;
      whole = false;
      out += `${separator}…`;
    }
    return !stopped;
  };
  const unwritten = (each: unknown): boolean =>
    each === undefined || typeof each === "function" || typeof each === "symbol";

  function write(each: unknown, depth: number): void {
    switch (typeof each) {
      case "string":
        out += quoted(each);
        return;
      case "number":
        out += Number.isFinite(each) ? String(each) : "null";
        return;
      case "boolean":
        out += each ? "true" : "false";
        return;
      case "bigint":
        whole = false;
        out += each < BIGGEST && each > -BIGGEST ? `"${String(each)}n"` : '"[BigInt]"';
        return;
      case "object":
        break;
      default:
        out += "null";
        return;
    }
    if (each === null) {
      out += "null";
      return;
    }
    if (inside.has(each)) {
      whole = false;
      out += '"[Circular]"';
      return;
    }
    if (written.has(each)) {
      whole = false;
      out += '"[Repeated]"';
      return;
    }
    written.add(each);
    if (Array.isArray(each)) {
      if (depth >= limits.depth) {
        whole = false;
        out += '"[Array]"';
        return;
      }
      const list = each as readonly unknown[];
      inside.add(list);
      out += "[";
      const inner = line(depth + 1);
      for (let index = 0; index < list.length && room(index === 0 ? inner : `,${inner}`); index += 1) {
        out += index === 0 ? inner : `,${inner}`;
        guarded(list[index], depth + 1);
      }
      out += list.length === 0 ? "]" : `${line(depth)}]`;
      inside.delete(list);
      return;
    }
    const kind = Object.prototype.toString.call(each).slice(8, -1);
    const proto: unknown = Object.getPrototypeOf(each);
    if (kind === "String" || kind === "Number" || kind === "Boolean" || kind === "BigInt") {
      write(unboxed(kind, each), depth);
      return;
    }
    if (kind === "Date") {
      const time = Date.prototype.getTime.call(each);
      out += quoted(Number.isFinite(time) ? new Date(time).toISOString() : "Invalid Date");
      return;
    }
    if (kind === "Error") {
      whole = false;
      const { name, message } = each as { name?: unknown; message?: unknown };
      out += quoted(
        `${typeof name === "string" ? cutText(name, 100) : "Error"}: ${typeof message === "string" ? cutText(message, limits.chars) : ""}`,
      );
      return;
    }
    if (proto !== Object.prototype && proto !== null) {
      whole = false;
      out += quoted(`[${kind}]`);
      return;
    }
    if (depth >= limits.depth) {
      whole = false;
      out += '"[Object]"';
      return;
    }
    inside.add(each);
    out += "{";
    const inner = line(depth + 1);
    let first = true;
    for (const key of Object.keys(each)) {
      if (!room(first ? inner : `,${inner}`)) {
        first = false;
        break;
      }
      let field: unknown;
      try {
        field = (each as Record<string, unknown>)[key];
      } catch {
        field = UNREADABLE;
      }
      if (field !== UNREADABLE && unwritten(field)) continue;
      out += `${first ? inner : `,${inner}`}${quoted(key)}${colon}`;
      first = false;
      guarded(field, depth + 1);
    }
    out += first ? "}" : `${line(depth)}}`;
    inside.delete(each);
  }

  function guarded(each: unknown, depth: number): void {
    if (each === UNREADABLE) {
      out += '"[unreadable]"';
      return;
    }
    const before = out.length;
    try {
      write(each, depth);
    } catch {
      whole = false;
      out = `${out.slice(0, before)}"[unreadable]"`;
    }
  }

  nodes -= 1;
  guarded(value, 0);
  const text = out.length <= limits.chars ? out : `${cutText(out, limits.chars - 1)}…`;
  return { text, whole: whole && text === out };
}
