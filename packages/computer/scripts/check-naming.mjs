#!/usr/bin/env node
/**
 * §5.5 wire-naming convention CI gate (RFC v9.8).
 *
 * Wire format (kebab-case): RequestMethodMap keys, ServiceEvent.kind,
 * IPC topic strings, IPC frame `type` field values.
 * TypeScript identifier (camelCase): function names, const/let names,
 * interface field names, parameter names.
 *
 * Gate scope: detect post-v9-sign reintroduction of a camelCase literal
 * at a designated wire-format position, OR a hyphenated TS identifier at
 * a top-level declaration. Designed to mirror check-boundaries.mjs:
 * lightweight static scan, no AST, runnable locally + in CI.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scanRoot = join(repoRoot, "packages", "computer", "src");

// A literal "looks wire-shaped" if it's only alphanumeric + hyphens with
// at least one letter — i.e. it could plausibly be a wire enum value.
// Anything else (URLs, paths, messages, dotted keys, etc.) is excluded
// from the kebab-case check.
const WIRE_SHAPED = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/;
const KEBAB_OK = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const isWireKebab = (s) => WIRE_SHAPED.test(s) && KEBAB_OK.test(s);
const isWireCamel = (s) => WIRE_SHAPED.test(s) && !KEBAB_OK.test(s);

// Axis 1 — discriminant wire literals at fixed property positions.
// `kind:` and `topic:` are designated wire positions per §5.5. `type:` is
// also a §5.5 wire position for IPC frame envelopes; scope is wider so we
// only flag wire-shaped values with uppercase (the kebab-case violation).
const WIRE_LITERAL_AXES = [
  { prop: "kind", re: /\bkind\s*:\s*"([^"]+)"/g },
  { prop: "topic", re: /\btopic\s*:\s*"([^"]+)"/g },
  { prop: "type", re: /\btype\s*:\s*"([^"]+)"/g },
];

// Axis 2 — RequestMethodMap interface keys. Scoped to the interface body
// so we don't flag every quoted object key in the tree. Body is extracted
// via brace-walk (counting `{`/`}` from the interface opener until depth=0)
// because key values contain nested `{ params: …; result: … }` shapes that
// would short-circuit a naive non-greedy regex match.
const RMM_OPEN_RE = /interface\s+RequestMethodMap\s*\{/m;
const RMM_KEY_RE = /"([^"]+)"\s*:/g;

function extractRmmBody(src) {
  const open = src.match(RMM_OPEN_RE);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const c = src[i++];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
  }
  return depth === 0 ? src.slice(start, i - 1) : null;
}

// Axis 3 — top-level TS identifier with hyphen. TS would reject these at
// parse time, so the cost of the scan is near-zero — purpose is to pin
// the rule explicitly so a future contributor cannot quietly add a
// `function foo-bar` shape via a build hack.
const ID_AXES = [
  { kind: "function", re: /\bfunction\s+([A-Za-z][A-Za-z0-9_-]*)/g },
  { kind: "const", re: /\b(?:const|let|var)\s+([A-Za-z][A-Za-z0-9_-]*)/g },
];

function walk(d) {
  const out = [];
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      out.push(...walk(p));
    } else if (/\.(ts|mts|cts)$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

let violations = 0;
const report = (file, msg) => {
  const rel = relative(repoRoot, file);
  console.error(`§5.5 VIOLATION ${rel}: ${msg}`);
  violations += 1;
};

for (const file of walk(scanRoot)) {
  const src = readFileSync(file, "utf8");

  // Axis 1 — wire-position literal scan.
  for (const axis of WIRE_LITERAL_AXES) {
    for (const m of src.matchAll(axis.re)) {
      const lit = m[1];
      if (isWireCamel(lit)) {
        report(file, `\`${axis.prop}: "${lit}"\` — wire literal must be kebab-case (§5.5)`);
      }
    }
  }

  // Axis 2 — RequestMethodMap keys.
  const rmmBody = extractRmmBody(src);
  if (rmmBody !== null) {
    for (const m of rmmBody.matchAll(RMM_KEY_RE)) {
      const key = m[1];
      if (isWireCamel(key)) {
        report(file, `RequestMethodMap key "${key}" — must be kebab-case (§5.5)`);
      }
    }
  }

  // Axis 3 — hyphen in TS identifier declarations.
  for (const axis of ID_AXES) {
    for (const m of src.matchAll(axis.re)) {
      const id = m[1];
      if (id.includes("-")) {
        report(file, `${axis.kind} \`${id}\` — TS identifier must be camelCase (§5.5)`);
      }
    }
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} §5.5 wire-naming violation(s). Wire format MUST be kebab-case ` +
      `(RequestMethodMap keys, ServiceEvent.kind, IPC topic, IPC frame type); ` +
      `TypeScript identifiers MUST be camelCase. See RFC v9.8 §5.5.`,
  );
  process.exit(1);
}
console.log("✓ §5.5 wire-naming: kebab-case wire literals + camelCase TS identifiers.");
