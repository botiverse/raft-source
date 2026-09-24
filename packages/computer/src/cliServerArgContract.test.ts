// Contract test — the server-arg consistency rule (CLI-consistency pass).
//
// The team's locked design (release-polish unification): the server slug
// is ALWAYS a POSITIONAL `[serverSlug]` argument, never a `--server`
// option — on every ordinary per-server command, whether the server is the
// verb's direct object (attach/start/…) or a filter that narrows an
// otherwise-global action (runners list/stop). The `--server`
// flag was dropped everywhere.
//
// This test inspects the configured commander `program` (exported from
// index.ts) and pins the rule so a future subcommand can't silently drift
// to the wrong shape. It does NOT execute the CLI — importing index.ts is
// import-safe (the argv parse is guarded behind an entrypoint check).

import { test } from "vitest";
import assert from "node:assert/strict";
import type { Command } from "commander";

import { program } from "./cli.js";

// Every per-server command takes the server slug as a POSITIONAL
// argument. `runners` subcommands are addressed as "runners list" /
// "runners stop".
const POSITIONAL_SLUG_COMMANDS = [
  "attach",
  "setup",
  "start",
  "restart",
  "doctor",
  "logs",
  "runners list",
  "runners stop",
];

/** Resolve a (possibly nested) command by its space-separated path. */
function findCommand(root: Command, path: string): Command {
  const parts = path.split(" ");
  let current: Command = root;
  for (const part of parts) {
    const next = current.commands.find((c) => c.name() === part);
    assert.ok(next, `command not found: ${path} (missing segment "${part}")`);
    current = next;
  }
  return current;
}

/** Positional argument names for a command (commander ≥9 API + fallback). */
function argNames(cmd: Command): string[] {
  const reg = (cmd as unknown as { registeredArguments?: { name(): string }[] }).registeredArguments
    ?? (cmd as unknown as { _args?: { name(): string }[] })._args
    ?? [];
  return reg.map((a) => a.name());
}

/** Long option flags (e.g. "--server") registered on a command. */
function optionLongs(cmd: Command): string[] {
  return cmd.options.map((o) => o.long).filter((l): l is string => typeof l === "string");
}

function hasServerSlugPositional(cmd: Command): boolean {
  return argNames(cmd).some((n) => n.includes("serverSlug"));
}

function hasServerOption(cmd: Command): boolean {
  return optionLongs(cmd).includes("--server");
}

for (const name of POSITIONAL_SLUG_COMMANDS) {
  test(`server-arg contract: \`${name}\` takes server as a positional, not --server`, () => {
    const cmd = findCommand(program, name);
    assert.ok(
      hasServerSlugPositional(cmd),
      `\`${name}\` must register a serverSlug positional argument; got args [${argNames(cmd).join(", ")}]`,
    );
    assert.ok(
      !hasServerOption(cmd),
      `\`${name}\` must NOT have a --server option (server slug is always positional now)`,
    );
  });
}

test("channel versions contract: optional channel plus JSON and bounded limit flags", () => {
  const cmd = findCommand(program, "channel versions");
  assert.deepEqual(argNames(cmd), ["channel"]);
  assert.deepEqual(optionLongs(cmd).sort(), ["--json", "--limit"].sort());
});

test("operation acknowledge contract requires one exact receipt id and no override flags", () => {
  const cmd = findCommand(program, "operation acknowledge");
  assert.deepEqual(argNames(cmd), ["operationId"]);
  assert.deepEqual(optionLongs(cmd), []);
  assert.match(cmd.helpInformation(), /without deleting its audit record/);
});
