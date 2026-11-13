import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_OOM_SCORE_ADJ } from "../drivers/oomScore";
import type { OarLaunch } from "./oarLaunch";
import { withOarOomPreference, writeOomWrapper } from "./oarOomPreference";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "oar-oom-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const launch = (installation: OarLaunch["installation"]): OarLaunch =>
  ({ runtimeId: "codex", installation, options: { cwd: "/w" } }) as unknown as OarLaunch;
const executable = (command: string) => launch({ kind: "available", via: "executable", command } as OarLaunch["installation"]);

describe("OAR OOM preference", () => {
  const LINUX = process.platform === "linux";

  /** Runs the wrapper from a known starting score: the ambient one is already 500 on an agent host. */
  function runWrapped(startingScore: number): { pid: string; arg: string; own: number; child: number; shellPid: string; stderr: string } {
    const fake = path.join(dir, "it's a runtime");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s|' "$$" "$1" "$(cat /proc/self/oom_score_adj)" "$(sh -c 'cat /proc/self/oom_score_adj')"\n`);
    chmodSync(fake, 0o755);
    const wrapper = writeOomWrapper(path.join(dir, "bin"), fake);
    const run = spawnSync("/bin/sh", ["-c", `echo ${startingScore} 2>/dev/null > /proc/self/oom_score_adj; "$0" "two words" & echo "pid=$!"; wait`, wrapper], { encoding: "utf8" });
    const [shellPid, output] = run.stdout.split("\n");
    const [pid, arg, own, child] = output!.split("|");
    return { pid: pid!, arg: arg!, own: Number(own), child: Number(child), shellPid: shellPid!, stderr: run.stderr };
  }

  it.runIf(LINUX)("raises the score before the runtime starts, for it and what it starts, with the same pid and args", () => {
    const wrapped = runWrapped(100);

    expect(`pid=${wrapped.pid}`).toBe(wrapped.shellPid);
    expect(wrapped.arg).toBe("two words");
    expect(wrapped.own).toBe(RUNTIME_OOM_SCORE_ADJ);
    expect(wrapped.child).toBe(RUNTIME_OOM_SCORE_ADJ);
    expect(wrapped.stderr).toBe("");
  });

  it.runIf(LINUX)("keeps a score already above it", () => {
    const wrapped = runWrapped(RUNTIME_OOM_SCORE_ADJ + 300);

    expect(wrapped.own).toBe(RUNTIME_OOM_SCORE_ADJ + 300);
    expect(wrapped.child).toBe(RUNTIME_OOM_SCORE_ADJ + 300);
  });

  it("wraps an executable on Linux, sharing one script per command", () => {
    const first = withOarOomPreference(executable("/usr/bin/codex"), dir, "linux");
    const second = withOarOomPreference(executable("/usr/bin/codex"), dir, "linux");
    const other = withOarOomPreference(executable("/opt/codex"), dir, "linux");
    const file = (first.installation as { command: string }).command;

    expect(file.startsWith(dir)).toBe(true);
    expect((second.installation as { command: string }).command).toBe(file);
    expect((other.installation as { command: string }).command).not.toBe(file);
    expect(readFileSync(file, "utf8")).toContain("exec '/usr/bin/codex' \"$@\"");
    expect(statSync(file).mode & 0o111).toBe(0o111);
    expect(first.options).toEqual({ cwd: "/w" });
  });

  it("leaves other platforms and bundled installations alone", () => {
    const original = executable("/usr/bin/codex");
    expect(withOarOomPreference(original, dir, "darwin")).toBe(original);
    expect(withOarOomPreference(original, dir, "win32")).toBe(original);
    const bundled = launch({ kind: "available", via: "bundled" } as OarLaunch["installation"]);
    expect(withOarOomPreference(bundled, dir, "linux")).toBe(bundled);
  });

  it("repairs a script that lost its exec bit, and runs the launch as it is on a home that can't execute", () => {
    const original = executable("/usr/bin/codex");
    const file = (withOarOomPreference(original, dir, "linux").installation as { command: string }).command;
    chmodSync(file, 0o644);

    expect((withOarOomPreference(original, dir, "linux").installation as { command: string }).command).toBe(file);
    expect(statSync(file).mode & 0o111).toBe(0o111);
    expect(withOarOomPreference(original, dir, "linux", () => false)).toBe(original);
  });

  it("runs the launch as it is when the script can't be written", () => {
    const blocked = path.join(dir, "file");
    writeFileSync(blocked, "");
    mkdirSync(path.join(dir, "ok"));
    const original = executable("/usr/bin/codex");

    expect(withOarOomPreference(original, path.join(blocked, "under-a-file"), "linux")).toBe(original);
  });
});
