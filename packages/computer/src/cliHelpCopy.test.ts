import { test } from "vitest";
import assert from "node:assert/strict";
import { program } from "./cli.js";

function visibleCommands(command = program): typeof program[] {
  return command.commands
    .filter((child) => !(child as unknown as { _hidden?: boolean })._hidden)
    .flatMap((child) => [child, ...visibleCommands(child as typeof program)]);
}

function commandHelp(...names: string[]): string {
  let command: typeof program = program;
  for (const name of names) {
    const next = command.commands.find((child) => child.name() === name);
    assert.ok(next, `missing command ${names.join(" ")}`);
    command = next as typeof program;
  }
  return command.helpInformation();
}

test("CLI help uses user-facing product copy, not implementation vocabulary", () => {
  const helpSurfaces = [
    ["root", program.helpInformation()],
    ...visibleCommands().map((command) => [command.name(), command.helpInformation()] as const),
  ] as const;

  const banned = [
    /control plane/i,
    /N per-server/i,
    /SLOCK_HOME/i,
    /§/,
    /migrate-prompt/i,
    /per-server runners?/i,
    /server-mediated/i,
    /orchestrator/i,
    /preflight/i,
    /auto-restart loop/i,
    /residue cleanup/i,
    /cascade record/i,
    /add-not-replace/i,
    /fresh-attach/i,
    /SEA/i,
    /single-binary/i,
    /single executable/i,
    /sha256/i,
    /UPGRADE_SEA_ONLY/i,
  ];

  for (const [name, help] of helpSurfaces) {
    for (const pattern of banned) {
      assert.doesNotMatch(help, pattern, `${name} help leaks ${pattern}`);
    }
  }
});

test("root help groups status after lifecycle controls", () => {
  const help = program.helpInformation();
  const start = help.indexOf("start [options]");
  const stop = help.indexOf("stop");
  const restart = help.indexOf("restart [options]");
  const status = help.indexOf("status");

  assert.ok(start >= 0, "root help should list start");
  assert.ok(stop >= 0, "root help should list stop");
  assert.ok(restart >= 0, "root help should list restart");
  assert.ok(status >= 0, "root help should list status");
  assert.ok(start < stop, "start should appear before stop");
  assert.ok(stop < restart, "stop should appear before restart");
  assert.ok(restart < status, "status should appear after restart");
  assert.doesNotMatch(help, /\n\s+reset\b/, "reset should not appear in primary help");
  assert.equal(
    program.commands.find((child) => child.name() === "reset"),
    undefined,
    "reset should not be registered as a user-facing CLI verb",
  );
});

test("root help does not expose a public JSON error flag", () => {
  const help = program.helpInformation();
  assert.doesNotMatch(help, /--json\b/);
  assert.doesNotMatch(help, /machine-readable JSON errors/);
});

test("channel help explains production, staging, and pinned release channels", () => {
  const channel = commandHelp("channel");
  const show = commandHelp("channel", "show");
  const set = commandHelp("channel", "set");
  const upgrade = commandHelp("upgrade");

  for (const help of [channel, set, upgrade]) {
    assert.match(help, /`latest` installs production\s+releases/);
    assert.match(help, /`alpha`\s+follows staging\s+builds/);
    assert.match(help, /`pinned:<semver>` stays on\s+one\s+version/);
  }

  assert.match(show, /If none is set, this prints `latest`/);
  assert.match(set, /future `raft-computer upgrade` commands/);
  assert.match(upgrade, /this invocation only/);
});
