import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import test from "node:test";

import { NL, axSurface, writeText } from "./core/renderer.js";
import { formatTaskStatusUpdated } from "./commands/task/_format.js";

// --- Print-seam contracts (spec: notes cli-print-seam v0, D6) ---
// Zero-tolerance rules below protect the actual output boundary. Migration of
// legacy adoptCliReplyText call sites is reviewed by responsibility and seam,
// not by a repository-wide source count.
const DIRECT_WRITE_SITES = 0;

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function countMatches(files: string[], re: RegExp): { total: number; byFile: Map<string, number> } {
  const byFile = new Map<string, number>();
  let total = 0;
  for (const f of files) {
    const n = (readFileSync(f, "utf8").match(re) ?? []).length;
    if (n > 0) byFile.set(f.slice(SRC.length + 1), n);
    total += n;
  }
  return { total, byFile };
}

test("gate-2b: no direct stdout/stderr/console writes beyond the pinned stragglers", () => {
  const files = [join(SRC, "commands"), join(SRC, "apps")].flatMap(sourceFiles);
  const { total, byFile } = countMatches(files, /io\.(?:stdout|stderr)\.write\(|console\.log\(/g);
  assert.ok(
    total <= DIRECT_WRITE_SITES,
    `direct write sites grew to ${total} (> pinned ${DIRECT_WRITE_SITES}); go through writeText/writeDiagnostic. Sites: ${[...byFile].map(([f, n]) => `${f}:${n}`).join(", ")}`,
  );
  assert.equal(
    total,
    DIRECT_WRITE_SITES,
    `direct write sites shrank to ${total}; ratchet the pin down to record the progress`,
  );
});

test("gate-2c: axSurface definitions live only in _format.ts modules", () => {
  // axSurface is the sole public brand outlet; defining surfaces outside the
  // _format.ts modules would put reply text where the manifest generator and
  // reviewers do not look.
  const files = sourceFiles(SRC).filter(
    (f) => !f.endsWith("/_format.ts") && !f.endsWith("core/renderer.ts"),
  );
  const { total, byFile } = countMatches(files, /axSurface\(/g);
  assert.equal(
    total,
    0,
    `axSurface outside _format.ts defeats manifest completeness: ${[...byFile].map(([f, n]) => `${f}:${n}`).join(", ")}`,
  );
});

test("byte-neutral positive control: writeText with NL reproduces the old template bytes", () => {
  // Pre-seam call sites wrote `${formatX(...)}\n`; post-seam they write
  // writeText(io, formatX(...), NL). This control proves the two are
  // byte-identical through the real seam plumbing.
  const formatted = formatTaskStatusUpdated(42, "in_review");
  let captured = "";
  const io = {
    stdout: { write: (chunk: string) => { captured += chunk; return true; } },
    stderr: { write: () => true },
  };
  writeText(io as never, formatted, NL);
  assert.equal(captured, `${formatted}\n`);
  assert.notEqual(captured.length, 1, "positive control must exercise real formatter output");

  // And multi-part composition is plain concatenation:
  const a = axSurface("test-only surface a", () => "a", { examples: [{ args: [] }] });
  const b = axSurface("test-only surface b", () => "b", { examples: [{ args: [] }] });
  captured = "";
  writeText(io as never, a(), b(), NL);
  assert.equal(captured, "ab\n");
});
