import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { claudeAccountUsage } from "@botiverse/oar/runtimes/claude";
import { CLAUDE_FIVE_HOUR_WINDOW_LABEL, CLAUDE_OAUTH_APPS_WINDOW_LABEL, claudeFiveHourLimitOf, isClaudeOAuthAppsWindow } from "@botiverse/raft-shared";

import { projectOarAccountUsageSnapshot } from "./oarAdapter";

// The web leaves Claude's third-party OAuth apps' window out of every usage
// summary by its label (window ids on the wire are hashes of the label), and
// reads the 5-hour limit by the "Current session" label. Both labels are
// OAR's: this reads usage through OAR's real Claude reader, against a fake
// `claude` answering its control protocol, so an OAR that renames either
// window fails here instead of silently changing what the web shows.

const FAKE_CLAUDE = (node: string) => `#!${node}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\\n  --safe-mode  Run without hooks\\n");
  process.exit(0);
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.type !== "control_request") continue;
    const response = message.request.subtype === "initialize"
      ? { account: { email: "someone@example.com" } }
      : {
          rate_limits_available: true,
          subscription_type: "max",
          rate_limits: {
            five_hour: { utilization: 20, resets_at: "2026-11-12T20:00:00Z" },
            seven_day: { utilization: 60, resets_at: "2026-11-16T07:00:00Z" },
            seven_day_oauth_apps: { utilization: 10 },
            model_scoped: [{ display_name: "Opus", utilization: 100, resets_at: "2026-11-18T07:00:00Z" }],
          },
        };
    process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: message.request_id, subtype: "success", response } }) + "\\n");
  }
});
`;

test("OAR's Claude windows keep the labels the web matches: Current session, and the OAuth apps' window (seven_day_oauth_apps)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raft-oar-claude-windows-"));
  try {
    const command = path.join(dir, "claude");
    await writeFile(command, FAKE_CLAUDE(process.execPath));
    await chmod(command, 0o755);
    const snapshot = await claudeAccountUsage({ kind: "available", via: "executable", command, version: "2.1.330" }, { timeoutMs: 20_000 });
    assert.equal(snapshot.kind, "available");
    if (snapshot.kind !== "available") return;
    // OAR's own key for the window the web leaves out, and its label.
    const oauthApps = snapshot.windows.filter((window) => window.id === "seven_day_oauth_apps");
    assert.deepEqual(oauthApps.map((window) => window.label), [CLAUDE_OAUTH_APPS_WINDOW_LABEL]);
    assert.equal(oauthApps[0]!.scope, undefined, "neither the account's nor a model's");

    const wire = projectOarAccountUsageSnapshot({ provider: "claude", snapshot, localAccountSlot: "/tmp/slot", collectorVersion: "test", observedAtMs: Date.parse("2026-11-12T12:00:00Z") });
    const windows = wire.accounts[0]!.windows;
    assert.deepEqual(windows.filter(isClaudeOAuthAppsWindow).map((window) => window.label), [CLAUDE_OAUTH_APPS_WINDOW_LABEL], "exactly the OAuth apps' window matches");
    assert.equal(windows.filter((window) => window.label === CLAUDE_FIVE_HOUR_WINDOW_LABEL).length, 1);
    assert.equal(claudeFiveHourLimitOf(wire), "not_at_limit");
    assert.deepEqual(windows.map((window) => window.scope ?? null), [
      { kind: "account" },
      { kind: "account" },
      null,
      { kind: "model", name: "Opus" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
