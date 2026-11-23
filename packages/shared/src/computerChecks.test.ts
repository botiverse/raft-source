import assert from "node:assert/strict";
import { test } from "vitest";

import {
  COMPUTER_CHECKS_REPORT_MAX_WIRE_BYTES,
  DAEMON_CAPABILITY_COMPUTER_CHECKS,
  parseComputerChecksReport,
  type ComputerChecksReport,
} from "./computerChecks";
import type { MachineToServerMessage, ServerToMachineMessage } from "./index";

const report = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  checkedAt: "2026-11-19T10:00:00.000Z",
  plugins: [
    { id: "github", items: [{ key: "gh.version", label: "GitHub CLI", value: "2.60.0", status: "ok" }, { key: "git.name", label: "Git name", value: "<b>Ada</b>", displayText: true, status: "local" }], durationMs: 12 },
    { id: "aws", items: [], durationMs: 0, disabledByOwner: true },
    { id: "docker", items: [{ key: "docker.check", label: "docker", status: "unconfirmed", reason: "run_folder_unavailable" }], durationMs: 0, error: "run_folder_unavailable" },
  ],
  ownerSwitch: { disabled: ["aws"], previous: "all", changedAt: "2026-11-19T09:00:00.000Z" },
  ...overrides,
});

test("the capability and the wire messages", () => {
  assert.equal(DAEMON_CAPABILITY_COMPUTER_CHECKS, "computer-checks@1");
  const config: ServerToMachineMessage = { type: "computer:checks:config", enabled: { github: true, aws: false } };
  const refresh: ServerToMachineMessage = { type: "computer:checks:refresh" };
  const sent: MachineToServerMessage = { type: "computer:checks:report", report: report() as unknown as ComputerChecksReport };
  assert.deepEqual([config.type, refresh.type, sent.type], ["computer:checks:config", "computer:checks:refresh", "computer:checks:report"]);
});

test("a report reads with its rows, owner switch and display text kept as plain data", () => {
  const parsed = parseComputerChecksReport(report());
  assert.ok(parsed);
  assert.deepEqual(parsed, report());
});

test("ids, statuses and reasons a newer Computer adds keep the report; fields it adds are dropped", () => {
  const parsed = parseComputerChecksReport(report({
    plugins: [{ id: "system", items: [{ key: "disk.free", label: "Disk", status: "expired", reason: "something_new", extra: "x" }], durationMs: 1, extra: 1 }],
    extra: true,
  }));
  assert.ok(parsed);
  assert.equal(parsed.plugins[0]!.id, "system");
  assert.equal("extra" in parsed, false);
  assert.equal("extra" in parsed.plugins[0]!, false);
  assert.equal("extra" in parsed.plugins[0]!.items[0]!, false);
});

test("what is not a report, or too large, is not read", () => {
  for (const bad of [
    null,
    "report",
    report({ schemaVersion: 2 }),
    report({ checkedAt: "yesterday" }),
    report({ plugins: [{ id: "rm -rf /", items: [], durationMs: 0 }] }),
    report({ plugins: [{ id: "github", items: [{ key: "k", label: "l", value: "x".repeat(121), status: "ok" }], durationMs: 0 }] }),
    report({ plugins: [{ id: "github", items: Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, label: "l", status: "ok" })), durationMs: 0 }] }),
    report({ plugins: [{ id: "github", items: [{ key: "k", label: "l", status: "OK; drop" }], durationMs: 0 }] }),
    report({ padding: "x".repeat(COMPUTER_CHECKS_REPORT_MAX_WIRE_BYTES) }),
  ]) {
    assert.equal(parseComputerChecksReport(bad), null, JSON.stringify(bad)?.slice(0, 120));
  }
});
