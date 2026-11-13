// `raft proc` starts jobs only for runtimes listed in procRuntimeAccess.ts
// (a job gets the daemon user's full access). This pins that table to what
// the drivers actually pass: a driver that drops its full-access flag, or a
// new driver that isn't listed, turns this RED.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_FULL_ACCESS, runtimeRunsWithFullAccess } from "../procRuntimeAccess";
import { registeredRuntimeIds } from "./index";
import { isOarOnlyRuntimeId } from "./oarOnly";

const source = (file: string) => readFileSync(path.join(import.meta.dirname, file), "utf8");

test("every registered runtime is either listed as full access or OAR-only (refused)", () => {
  for (const id of registeredRuntimeIds()) {
    const oarOnly = isOarOnlyRuntimeId(id);
    assert.equal(runtimeRunsWithFullAccess(id), !oarOnly, id);
  }
  assert.equal(runtimeRunsWithFullAccess(null), false);
  assert.equal(runtimeRunsWithFullAccess("toString"), false);
  assert.deepEqual(Object.keys(RUNTIME_FULL_ACCESS).filter((id) => !registeredRuntimeIds().includes(id)), []);
});

test("each listed driver passes the full-access setting the table names", () => {
  const expected: Record<string, [string, string[]]> = {
    claude: ["claudeLaunch.ts", ["\"--dangerously-skip-permissions\"", "\"--permission-mode\", \"bypassPermissions\""]],
    codex: ["codex.ts", ["approvalPolicy: \"never\"", "sandbox: \"danger-full-access\""]],
    grok: ["grok.ts", ["\"--always-approve\""]],
    copilot: ["copilot.ts", ["\"--allow-all-tools\"", "\"--allow-all-paths\""]],
    cursor: ["cursor.ts", ["\"--force\""]],
    gemini: ["gemini.ts", ["\"--yolo\""]],
    kimi: ["kimi.ts", ["\"--yolo\""]],
    "kimi-sdk": ["kimi-sdk.ts", ["setApprovalHandler(() => ({ decision: \"approved\""]],
    opencode: ["opencode.ts", ["\"--dangerously-skip-permissions\"", "\"--auto\""]],
    antigravity: ["antigravity.deprecated.ts", ["\"--dangerously-skip-permissions\""]],
  };
  for (const [runtime, [file, needles]] of Object.entries(expected)) {
    assert.ok(runtimeRunsWithFullAccess(runtime), runtime);
    const text = source(file);
    for (const needle of needles) assert.ok(text.includes(needle), `${runtime}: ${file} no longer has ${needle}`);
  }
  // pi/builtin: the bash tool runs in-process with no sandbox option at all.
  assert.equal(/sandbox/i.test(source("piCommandTool.ts")), false);
});
