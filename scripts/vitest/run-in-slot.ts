#!/usr/bin/env node
// `node --import @oxc-node/core/register scripts/vitest/run-in-slot.ts <command> [args...]`: runs a local test
// command in one of the host's test slots (testSlot.ts), as the web runner
// does: it waits in turn when both are taken, runs as its own process group,
// and the group dies with this launcher. The server and daemon `test` scripts
// go through it.
import { runInTestSlot } from "./testSlot";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: run-in-slot.ts <command> [args...]");
  process.exit(2);
}
const result = await runInTestSlot(command, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
