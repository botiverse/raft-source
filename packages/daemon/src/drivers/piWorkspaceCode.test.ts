import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { ignoredWorkspacePiCode } from "./piBuiltInSessionInputs";

test("ignoredWorkspacePiCode names a workspace's Pi extensions and settings code keys, nothing else", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-ws-code-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(ignoredWorkspacePiCode(root), []);
  mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true });
  assert.deepEqual(ignoredWorkspacePiCode(root), [], "an empty folder loads nothing");
  writeFileSync(path.join(root, ".pi", "extensions", "noname.ts"), "export default () => {}");
  writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:x"], theme: "dark", npmCommand: ["pnpm"] }));
  assert.deepEqual(ignoredWorkspacePiCode(root), [".pi/extensions", ".pi/settings.json packages", ".pi/settings.json npmCommand"]);
  writeFileSync(path.join(root, ".pi", "settings.json"), "{ not json");
  assert.deepEqual(ignoredWorkspacePiCode(root), [".pi/extensions"]);
});
