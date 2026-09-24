import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import { withComputerMutationLock, withMutationLock } from "./concurrency.js";
import { CliExit } from "./output.js";

// PR-H §3.2 regression guard — concurrency lock.

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "slock-pr-h-concurrency-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

function captureStderr(): { restore: () => void; text: () => string } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  const sink = ((c: unknown) => {
    buf += String(c);
    return true;
  });
  process.stderr.write = sink as typeof process.stderr.write;
  return {
    restore: () => {
      process.stderr.write = orig;
    },
    text: () => buf,
  };
}

test("withMutationLock: serial calls succeed and return values", async () => {
  await withHome(async () => {
    const a = await withMutationLock(async () => "first");
    const b = await withMutationLock(async () => "second");
    assert.equal(a, "first");
    assert.equal(b, "second");
  });
});

test("withMutationLock: lock released on fn throw — next call works", async () => {
  await withHome(async () => {
    await assert.rejects(
      withMutationLock(async () => {
        throw new Error("boom");
      }),
      (e) => (e as Error).message === "boom",
    );
    // The lock should be released, so a follow-up acquire works.
    const v = await withMutationLock(async () => "after-throw-ok");
    assert.equal(v, "after-throw-ok");
  });
});

test("withMutationLock: concurrent overlap → second fails with CONCURRENT_OPERATION", async () => {
  await withHome(async (home) => {
    // Hold the lock until we signal it, and wait until ownership is confirmed
    // before starting the contending CLI call. Without that acquisition barrier
    // this test can race itself and hang the full package suite.
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withComputerMutationLock(home, async () => {
      acquired();
      await releasePromise;
    });
    await Promise.race([
      acquiredPromise,
      holding.then(
        () => {
          throw new Error("holder exited before acquiring the mutation lock");
        },
        (err) => {
          throw err;
        },
      ),
    ]);

    // Race a second mutation against the held lock. With retry+timeout,
    // it should exhaust retries (~1.5s) and emit CONCURRENT_OPERATION.
    const cap = captureStderr();
    let secondErr: unknown = null;
    const second = withMutationLock(async () => "should-not-run");
    try {
      await Promise.race([
        second,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("second acquire did not finish before the test timeout")), 10_000);
        }),
      ]);
    } catch (e) {
      secondErr = e;
    } finally {
      cap.restore();
      release();
      await holding;
    }

    assert.ok(secondErr instanceof CliExit, "second call must throw CliExit");
    assert.match(cap.text(), /CONCURRENT_OPERATION/);
  });
});

test("withMutationLock: lock dir is `~/.slock/computer/.lock` (v7 §10 / @Jianwei msg=b79d7aff regression)", async () => {
  // Regression guard: proper-lockfile's default would put the lock at
  // sibling `~/.slock/computer.lock`. We MUST override with lockfilePath
  // so `cleanupStaleLock` (targeting the documented
  // `~/.slock/computer/.lock`) actually matches the real lock.
  await withHome(async (home) => {
    const { stat } = await import("node:fs/promises");
    // Hold lock and inspect filesystem
    let release: () => void = () => {};
    const holding = withMutationLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    // Give proper-lockfile a tick to materialize the lock dir
    await new Promise((r) => setTimeout(r, 50));
    // Expected: `~/.slock/computer/.lock` EXISTS
    const expected = join(home, "computer", ".lock");
    await assert.doesNotReject(() => stat(expected), `expected lock at ${expected}`);
    // Sibling `~/.slock/computer.lock` MUST NOT exist (regression guard
    // for the default proper-lockfile sibling-style behavior)
    const sibling = join(home, "computer.lock");
    await assert.rejects(() => stat(sibling), "sibling lock path must not be used");
    release();
    await holding;
  });
});

test("withComputerMutationLock: external lock deletion becomes typed process failure without data loss", async () => {
  await withHome(async (home) => {
    const runnerSentinel = join(home, "computer", "servers", "server-a", "runner-sentinel.json");
    const agentSentinel = join(home, "computer", "agents", "agent-a", "agent-sentinel.json");
    await mkdir(dirname(runnerSentinel), { recursive: true });
    await mkdir(dirname(agentSentinel), { recursive: true });
    await writeFile(runnerSentinel, '{"runner":"unchanged"}\n', "utf8");
    await writeFile(agentSentinel, '{"agent":"unchanged"}\n', "utf8");

    const fixture = join(import.meta.dirname, "test-fixtures", "mutationLockCompromiseChild.ts");
    const child = spawn(process.execPath, ["--import", "tsx", fixture, home], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("child did not acquire mutation lock")), 5_000);
      const inspect = () => {
        if (!stdout.includes("LOCK_HELD\n")) return;
        clearTimeout(timeout);
        child.stdout.off("data", inspect);
        resolve();
      };
      child.stdout.on("data", inspect);
      inspect();
    });

    const lockPath = join(home, "computer", ".lock");
    await assert.doesNotReject(() => stat(lockPath));
    await rm(lockPath, { recursive: true, force: true });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("compromised child did not terminate within the bounded window"));
      }, 8_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    if (process.env.RAFT_TEST_TRACE_LOCK_COMPROMISE === "1") {
      process.stdout.write(
        `LOCK_COMPROMISE_PROCESS_EVIDENCE ${JSON.stringify({ exitCode, stdout, stderr })}\n`,
      );
    }
    assert.equal(exitCode, 23);
    assert.match(stdout, /TYPED_ERROR MUTATION_LOCK_COMPROMISED/);
    assert.doesNotMatch(stderr, /ECOMPROMISED|uncaught|Unhandled/i);

    const recovered = await withComputerMutationLock(home, async () => "recovered");
    assert.equal(recovered, "recovered");
    assert.equal(await readFile(runnerSentinel, "utf8"), '{"runner":"unchanged"}\n');
    assert.equal(await readFile(agentSentinel, "utf8"), '{"agent":"unchanged"}\n');
  });
});
