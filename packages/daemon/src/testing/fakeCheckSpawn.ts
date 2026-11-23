import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { CheckChildProcess, CheckSpawn } from "../computerChecks/context";

export type FakeCommand = { stdout: string; exitCode?: number } | "enoent" | "hang";

/**
 * A spawn that answers by argv (`"gh --version"`); unlisted commands are not
 * installed. Records every call with the env and cwd it got.
 */
export function fakeSpawn(commands: Record<string, FakeCommand>) {
  const calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
  let running = 0;
  let maxRunning = 0;
  const spawn: CheckSpawn = (command, args, options) => {
    const argv = [command, ...args];
    calls.push({ argv, env: options.env, cwd: options.cwd });
    const behaviour = commands[argv.join(" ")] ?? "enoent";
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      kill: () => {
        if (behaviour === "hang") done(null);
        return true;
      },
    });
    let finished = false;
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      running -= 1;
      child.emit("close", code);
    };
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    setTimeout(() => {
      if (behaviour === "enoent") {
        finished = true;
        running -= 1;
        child.emit("error", Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }));
      } else if (behaviour !== "hang") {
        child.stdout.end(behaviour.stdout);
        setTimeout(() => done(behaviour.exitCode ?? 0), 5);
      }
    }, 5);
    return child as unknown as CheckChildProcess;
  };
  return { spawn, calls, maxRunning: () => maxRunning };
}
