import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { integrationAppRotateSecretCommand } from "./app.js";

// Task #94. The Manual told every agent to run `rotate-secret --output <path>` with no
// way to tell whether their own carrier has that flag. Carriers are not uniform: on
// 2026-08-03 this agent's own CLI (daemon 1.0.14) offered only `--client`/`--json`, and
// on such a build the secret can come back in the command's own output — the exact
// thing the surrounding paragraph forbids. The docs now tell the reader to read the
// flag list. These tests keep that instruction true by binding it to the real spec:
// prose that names a flag the CLI does not define is the defect, restated.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../..");

const DOCS = [
  "manual/agent-knowledge/integration.md",
  "manual/recipes/technique/login-with-raft.md",
] as const;

async function readDoc(relativePath: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

function definedFlagNames(): Set<string> {
  const options = integrationAppRotateSecretCommand.spec.options ?? [];
  // `--output <new-private-path>` -> `--output`
  return new Set(options.map((option) => option.flags.split(/[ ,]/)[0]));
}

test("the manual locates the repo it documents", async () => {
  // Positive control for the path walk above: without it, a wrong REPO_ROOT would make
  // every readDoc throw and the suite would fail loudly — but a future refactor that
  // swallowed the error would leave the other tests vacuously green.
  for (const doc of DOCS) {
    const text = await readDoc(doc);
    assert.ok(text.includes("rotate-secret"), `${doc} must be the file that documents rotate-secret`);
  }
});

// Paragraphs (blank-line-separated blocks) that give rotate-secret guidance. Scoping matters:
// these files also document other commands, whose flags are legitimately not on rotate-secret's
// spec. @Wug's CHANGES on PR #7193 was that my first version handled that noise by FILTERING OUT
// every unrecognised flag before asserting — which deleted exactly the failing case, so a
// documented-but-unsupported flag passed. He proved it by adding a backticked
// `--bogus-review-probe` to the Manual and watching all four tests still pass.
function rotateSecretGuidance(text: string): string[] {
  return text.split(/\n\s*\n/).filter((block) => block.includes("rotate-secret"));
}

function flagsNamedIn(blocks: string[]): Set<string> {
  const flags = new Set<string>();
  for (const block of blocks) {
    for (const span of block.matchAll(/`([^`]+)`/g)) {
      const code = span[1]!;
      // A span invoking some OTHER command carries that command's flags, not rotate-secret's:
      // `raft --version` is named here to explain why a version number is useless, and its flag
      // must not be attributed to this spec. A span naming no command (a bare `--output`) is
      // talking about the command under discussion.
      if (/^raft\b/.test(code.trim()) && !code.includes("rotate-secret")) continue;
      for (const flag of code.matchAll(/(--[a-z][a-z-]*)/g)) {
        flags.add(flag[1]!);
      }
    }
  }
  return flags;
}

// `--help` is registered by the command framework rather than declared in `spec.options`, so it
// is absent from the spec by construction, not by omission. It is the only exception, and it is
// enumerated here rather than filtered out at the comparison — an exception you can read is
// auditable; a filter that silently drops every non-match is what @Wug rejected.
const FLAGS_NOT_ON_THE_SPEC = new Set(["--help"]);

function undefinedFlags(blocks: string[], defined: Set<string>): string[] {
  return [...flagsNamedIn(blocks)]
    .filter((flag) => !defined.has(flag) && !FLAGS_NOT_ON_THE_SPEC.has(flag))
    .sort();
}

test("every rotate-secret flag the manual names is a flag the CLI defines", async () => {
  const defined = definedFlagNames();
  assert.ok(defined.has("--output"), "sanity: the command defines --output");
  for (const doc of DOCS) {
    const blocks = rotateSecretGuidance(await readDoc(doc));
    assert.ok(blocks.length > 0, `${doc} must contain rotate-secret guidance to scope to`);
    assert.ok(flagsNamedIn(blocks).has("--output"), `${doc} must still name --output`);
    assert.deepEqual(
      undefinedFlags(blocks, defined),
      [],
      `${doc} tells the reader to use flags rotate-secret does not define`,
    );
  }
});

test("NEGATIVE CONTROL: a documented flag the CLI lacks is actually rejected", () => {
  // The assertion above is only worth having if it can fail. This runs the same validator over
  // a synthetic block carrying @Wug's exact probe. Without it, "the assertion passed" and "the
  // assertion could never fail" are the same reading — which is what shipped the first time.
  // It also pins a second bug the first version had: a regex that captured only the FIRST flag
  // per backtick span, so a bogus flag sitting beside a valid one was invisible.
  const synthetic = ["Use `raft integration app rotate-secret --client <k> --bogus-review-probe`."];
  assert.deepEqual(rotateSecretGuidance(synthetic.join("\n\n")), synthetic, "block must be in scope");
  assert.deepEqual(
    undefinedFlags(synthetic, definedFlagNames()),
    ["--bogus-review-probe"],
    "a flag absent from the spec must be reported, not filtered away",
  );
});

test("the manual pairs --output with the flag-list self-check, not a version number", async () => {
  for (const doc of DOCS) {
    const text = await readDoc(doc);
    assert.match(
      text,
      /raft integration app rotate-secret --help/,
      `${doc} must tell the reader how to check their own carrier`,
    );
    // The decision must not be routed through a version comparison: `raft --version`
    // reports the CLI while this surface's release notes are in Computer/daemon
    // numbering, so a reader cannot place themselves on either side of a pinned number.
    const versionPin = text.match(/(?:arrived|introduced|added|shipped|available)\s+in\s+\*?\*?\d+\.\d+\.\d+/i);
    assert.equal(
      versionPin,
      null,
      `${doc} decides carrier support by version number (${versionPin?.[0]}); use the flag list`,
    );
  }
});

test("the manual warns that probing costs the live secret", async () => {
  // Rotation invalidates the current secret whether or not the caller was ready, so
  // "just try it and see" is not a free experiment. Named explicitly because the
  // obvious way to test for a flag is to run the command.
  const text = await readDoc("manual/agent-knowledge/integration.md");
  assert.match(text, /[Nn]ever probe by running a real rotation/);
});
