// Tenny's rule for the publish check (task #proj-workspace:#130): only the
// server's durable task signs a check's ticket (viewer `system:check`); no
// route or API a user or an agent can call signs one. Held in three places,
// every runtime file of packages/server (src and scripts; tests are not
// scanned, they sign to verify):
// - checkFrame.ts (signCheckFrame) is imported by CHECK_FRAME_IMPORTERS only:
//   the check's durable task (checkTask.ts; the check Worker's lease route,
//   behind its own token, calls it: no user's or agent's credential reaches it);
// - contentWorker.ts signCheckContentFrame, the one signer that makes a check
//   ticket, is named by checkFrame.ts only (and defined in contentWorker.ts);
// - the shared ticket signer is called by contentWorker.ts only, so nothing
//   signs a ticket around both.
// A frame route signs with signContentFrame, which refuses a check viewer or
// subject (checkFrame.test.ts). A check ticket names no ancestor (the check
// opens it top-level), so the shared signer can't tell one apart: the rule is
// these imports and contentWorker.ts's two signers.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");
const SCRIPTS = path.resolve(SRC, "../scripts");

/** The modules that may import checkFrame.ts, relative to packages/server/src: the check's durable task alone. */
const CHECK_FRAME_IMPORTERS: readonly string[] = ["apps/artifacts/checkTask.ts"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== "__fixtures__") out.push(...sourceFiles(full));
    } else if (/\.[cm]?[jt]sx?$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** A static import, a re-export, a dynamic import or a require of a module named checkFrame. */
const IMPORTS_CHECK_FRAME = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`][^"'`]*\/checkFrame(?:\.[cm]?[jt]s)?["'`]/m;
const NAMES_CHECK_SIGNER = /\bsignCheckContentFrame\b/;
const NAMES_TICKET_SIGNER = /\bsignArtifactContentTicket\b/;

const files = [...sourceFiles(SRC), ...sourceFiles(SCRIPTS)];
const relative = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const filesMatching = (pattern: RegExp) => files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map(relative).sort();

test("only the check's durable task imports checkFrame.ts", () => {
  assert.ok(files.some((file) => relative(file) === "apps/artifacts/checkFrame.ts"), "checkFrame.ts must be scanned");
  assert.ok(files.some((file) => relative(file) === "apps/artifacts/mount.ts"), "the routes must be scanned");
  assert.deepEqual(filesMatching(IMPORTS_CHECK_FRAME), [...CHECK_FRAME_IMPORTERS].sort(), "only the publish check's durable task may sign a check ticket (Tenny)");
});

test("only checkFrame.ts names signCheckContentFrame, and only contentWorker.ts the shared ticket signer", () => {
  assert.deepEqual(filesMatching(NAMES_CHECK_SIGNER), ["apps/artifacts/checkFrame.ts", "apps/artifacts/contentWorker.ts"]);
  assert.deepEqual(filesMatching(NAMES_TICKET_SIGNER), ["apps/artifacts/contentWorker.ts"]);
});

test("the scan catches every way of importing checkFrame.ts, and nothing else", () => {
  for (const line of [
    `import { signCheckFrame } from "./checkFrame";`,
    `import { signCheckFrame } from "../apps/artifacts/checkFrame.ts";`,
    `import type { ArtifactCheckFrame } from './checkFrame';`,
    `export { signCheckFrame } from "./checkFrame";`,
    `export * from "./checkFrame.js";`,
    `const { signCheckFrame } = await import("./checkFrame");`,
    "const loaded = await import(`./checkFrame`);",
    `const { signCheckFrame } = require("./checkFrame");`,
    `import "./checkFrame";`,
  ]) assert.ok(IMPORTS_CHECK_FRAME.test(line), line);
  for (const line of [
    `import { checkContentSubject } from "./contentWorker";`,
    `import { x } from "./checkFrames";`,
    `// checkFrame.ts signs it`,
    `const checkFrame = "./checkFrame";`,
  ]) assert.ok(!IMPORTS_CHECK_FRAME.test(line), line);
});
