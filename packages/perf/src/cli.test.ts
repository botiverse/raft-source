import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/raft-perf.mjs", import.meta.url));

describe("bin/raft-perf.mjs", () => {
  it("prints top-level help and dispatches subcommand --help while keeping caller cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "raft-perf-cli-"));
    try {
      const rootHelp = execFileSync(process.execPath, [BIN, "--help"], { cwd, encoding: "utf8" });
      expect(rootHelp).toMatch(/raft-perf <command> \[options\]/);
      expect(rootHelp).toMatch(/bench-check/);
      expect(rootHelp).toMatch(/diagnose/);

      const subHelp = execFileSync(process.execPath, [BIN, "bench-check", "--help"], { cwd, encoding: "utf8" });
      expect(subHelp).toMatch(/raft-perf bench-check/);

      const diagHelp = execFileSync(process.execPath, [BIN, "diagnose", "--help"], { cwd, encoding: "utf8" });
      expect(diagHelp).toMatch(/raft-perf diagnose/);
      expect(diagHelp).toMatch(/--jsonl/);
      expect(diagHelp).toMatch(/--save-trace-gz/);

      for (const cmd of ["diagnose-backfill", "input", "resize", "soak"]) {
        const out = execFileSync(process.execPath, [BIN, cmd, "--help"], { cwd, encoding: "utf8" });
        expect(out).toMatch(new RegExp(`raft-perf ${cmd}`));
      }

      const abHelp = execFileSync(process.execPath, [BIN, "ab", "--help"], { cwd, encoding: "utf8" });
      expect(abHelp).toMatch(/--scenario <kind>/);
      expect(abHelp).toMatch(/--replay/);

      const suiteOut = execFileSync(
        process.execPath,
        [BIN, "suite", "--suite", "daily-staging", "--out-dir", join(cwd, "dry"), "--dry-run"],
        { cwd, encoding: "utf8" },
      );
      const parsed = JSON.parse(suiteOut) as { ok: boolean; dryRun: boolean; steps: unknown[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.steps.length).toBeGreaterThanOrEqual(5);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("exits 2 on an unknown command", () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [BIN, "no-such-cmd"], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      status = (err as { status?: number }).status ?? 2;
    }
    expect(status).toBe(2);
  });

  it("exits non-zero (143) instead of 0 when terminated by SIGTERM", async () => {
    // Launch a command that waits on network/browser startup (`bench-check` pointing to an unaccepting local port or slow child)
    const net = await import("node:net");
    const server = net.createServer((socket) => {
      // Hold TCP connection open without answering HTTP so child stays alive until SIGTERM
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const child = spawn(process.execPath, [BIN, "bench-check", "--api", `http://127.0.0.1:${port}`], {
        env: { ...process.env, RAFT_PERF_EMAIL: "test@example.com", RAFT_PERF_PASSWORD: "secret" },
        stdio: "pipe",
      });
      // Wait until the HTTP socket connects so we know the child subcommand is running
      await new Promise<void>((resolve) => server.once("connection", () => resolve()));
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
      expect(code).toBe(143);
    } finally {
      server.close();
    }
  });
});
