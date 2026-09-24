import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  applyCapturedEnv,
  captureShellEnv,
  parseEnvFrame,
  serializeEnvFrame,
  SHELL_ENV_PROTECTED_KEYS,
} from "./shellEnvCapture.js";
import {
  bootstrapSupervisedServiceEnv,
  bootstrapThenRun,
  dispatchToKResident,
  stripForwardedCarrierName,
} from "./index.js";
import { pathToFileURL } from "node:url";

const resolveSyntheticRealPath = (file: string): string => path.resolve(file);

// ---------------------------------------------------------------------------
// Frame protocol (review SF1/SF2): nonce + NUL framing, strict parse.
// ---------------------------------------------------------------------------

test("env frame round-trips unicode, newlines, and '=' in values losslessly", () => {
  const env = {
    PLAIN: "value",
    UNICODE: "价值/🗡️",
    NEWLINES: "line1\nline2\n",
    EQUALS: "a=b=c",
    EMPTY: "",
  };
  const frame = serializeEnvFrame("nonce-1", env);
  assert.deepEqual(parseEnvFrame(frame, "nonce-1"), env);
});

test("strict parse rejects tampered or ambiguous frames", () => {
  const frame = serializeEnvFrame("n", { A: "1", B: "2" });
  // Leading rc noise before the header.
  assert.equal(parseEnvFrame(Buffer.concat([Buffer.from("noise"), frame]), "n"), null);
  // Trailing garbage after the trailer.
  assert.equal(parseEnvFrame(Buffer.concat([frame, Buffer.from("x")]), "n"), null);
  // Wrong nonce.
  assert.equal(parseEnvFrame(frame, "other"), null);
  // Missing final NUL inside the body.
  const header = Buffer.from("RAFT-ENV1 n\n");
  const trailer = Buffer.from("RAFT-ENV1-END n\n");
  const noNul = Buffer.concat([header, Buffer.from("A=1"), trailer]);
  assert.equal(parseEnvFrame(noNul, "n"), null);
  // Empty key.
  const emptyKey = Buffer.concat([header, Buffer.from("=v\0"), trailer]);
  assert.equal(parseEnvFrame(emptyKey, "n"), null);
  // Duplicate keys are ambiguous → reject whole frame, not last-wins.
  const dup = Buffer.concat([header, Buffer.from("A=1\0A=2\0"), trailer]);
  assert.equal(parseEnvFrame(dup, "n"), null);
});

// ---------------------------------------------------------------------------
// Replace-not-merge application (review B2).
// ---------------------------------------------------------------------------

test("applyCapturedEnv replaces: parent-only keys die, snapshot wins, protected keys survive", () => {
  const target: NodeJS.ProcessEnv = {
    PARENT_ONLY: "stale",
    SHARED: "old",
    SLOCK_HOME: "/canonical/home",
    RAFT_COMPUTER_SUPERVISOR_OWNER: "owner-token",
  };
  applyCapturedEnv(target, {
    SHARED: "new",
    FROM_RC: "hello",
    // rc tries to poison identity — must lose to the pre-capture values.
    SLOCK_HOME: "/rc/evil",
    RAFT_COMPUTER_SUPERVISOR_OWNER: "rc-forged",
  });
  assert.equal(target.PARENT_ONLY, undefined);
  assert.equal(target.SHARED, "new");
  assert.equal(target.FROM_RC, "hello");
  assert.equal(target.SLOCK_HOME, "/canonical/home");
  assert.equal(target.RAFT_COMPUTER_SUPERVISOR_OWNER, "owner-token");
});

test("applyCapturedEnv omission cannot resurrect protected keys the parent never had", () => {
  const target: NodeJS.ProcessEnv = { SLOCK_HOME: "/home" };
  applyCapturedEnv(target, { RAFT_COMPUTER_SUPERVISOR_OWNER: "rc-injected" });
  // rc injected a protected key the parent did not have → deleted last.
  assert.equal(target.RAFT_COMPUTER_SUPERVISOR_OWNER, undefined);
  assert.equal(target.SLOCK_HOME, "/home");
});

test("protected key set is the explicit seven-key closed set (review H2)", () => {
  assert.deepEqual([...SHELL_ENV_PROTECTED_KEYS].sort(), [
    "RAFT_COMPUTER_CLI_PATH",
    "RAFT_COMPUTER_OS_SUPERVISOR_KIND",
    "RAFT_COMPUTER_PARENT_MUTATION_LOCK_HELD",
    "RAFT_COMPUTER_SOURCE_SERVICE_PID",
    "RAFT_COMPUTER_SUPERVISOR_OWNER",
    "RAFT_HOME",
    "SLOCK_HOME",
  ]);
  // S1: the protected kind key is THE canonical lifecycle key, byte-equal —
  // pinning a phantom name here is exactly the bypass Sora caught.
  assert.ok(SHELL_ENV_PROTECTED_KEYS.includes("RAFT_COMPUTER_OS_SUPERVISOR_KIND" as never));
});

// ---------------------------------------------------------------------------
// B1 ordering teeth (review S3): module-scope env consumers must observe the
// post-capture world when imported after bootstrap — and the pre-import twin
// proves the tooth can actually go red.
// ---------------------------------------------------------------------------

test("modules first-evaluated after bootstrap observe the captured environment", async () => {
  const before = process.env.B1_ORDER_SENTINEL;
  try {
    await bootstrapSupervisedServiceEnv(
      ["node", "x", "__service"],
      Object.assign(process.env, { RAFT_COMPUTER_OS_SUPERVISOR_KIND: "launchd-user" }),
      async () => ({
        ok: true as const,
        env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), B1_ORDER_SENTINEL: "post-capture" },
        shell: "/bin/zsh",
        durationMs: 1,
      }),
    );
    const probe = await import("./fixtures/shell-env/envProbePost.js");
    assert.equal(probe.observedSentinel, "post-capture");
  } finally {
    if (before === undefined) delete process.env.B1_ORDER_SENTINEL;
    else process.env.B1_ORDER_SENTINEL = before;
    delete process.env.RAFT_COMPUTER_OS_SUPERVISOR_KIND;
  }
});

test("modules first-evaluated before bootstrap keep the stale environment (red-proof twin)", async () => {
  const before = process.env.B1_ORDER_SENTINEL;
  try {
    delete process.env.B1_ORDER_SENTINEL;
    const probe = await import("./fixtures/shell-env/envProbePre.js");
    process.env.B1_ORDER_SENTINEL = "set-after-first-eval";
    // Module cache froze the first observation — proving import ORDER is what
    // the bootstrap seam must control (a wrong implementation cannot pass the
    // post-import cell above while this cell still holds).
    assert.equal(probe.observedSentinel, "(unset)");
  } finally {
    if (before === undefined) delete process.env.B1_ORDER_SENTINEL;
    else process.env.B1_ORDER_SENTINEL = before;
  }
});

test("the thin entry never statically imports the CLI graph (B1 source tooth)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(codeOnly, /import[^;]*from\s+"\.\/cli\.js"/);
  // Ordering itself is pinned behaviorally by the bootstrapThenRun
  // composition teeth below (task #328); this tooth only bans a static
  // import edge, which would defeat the seam regardless of ordering.
  assert.match(codeOnly, /import\("\.\/cli\.js"\)/);
});

// ---------------------------------------------------------------------------
// B1 composition teeth (task #328, 铁根 mutation 9e984578): the earlier cells
// prove import ORDER matters, but never executed the real composed boot path —
// swapping the two awaits in the production composition stayed green. These
// cells run bootstrapThenRun itself; the probe module's first module-scope
// evaluation is the oracle, so the swap mutation flips the supervised cell RED.
// ---------------------------------------------------------------------------

async function freshCliProbe(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raft-b1-probe-"));
  const probePath = path.join(dir, "cliProbe.mjs");
  await writeFile(
    probePath,
    'export const observedSentinel = process.env.B1_ORDER_SENTINEL ?? "(unset)";\nexport function runCliAsMain() {}\n',
    "utf8",
  );
  return probePath;
}

test("bootstrapThenRun: supervised boot settles capture before the CLI graph first evaluates", async () => {
  const probePath = await freshCliProbe();
  const before = process.env.B1_ORDER_SENTINEL;
  const probe: { current: { observedSentinel?: string } | null } = { current: null };
  try {
    delete process.env.B1_ORDER_SENTINEL;
    await bootstrapThenRun(
      ["node", "x", "__service", "--os-supervised", "systemd-user"],
      process.env,
      async () => ({
        ok: true as const,
        env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), B1_ORDER_SENTINEL: "captured-before-cli" },
        shell: "/bin/zsh",
        durationMs: 1,
      }),
      async () => (probe.current = await import(pathToFileURL(probePath).href)),
    );
    assert.equal(probe.current?.observedSentinel, "captured-before-cli");
  } finally {
    if (before === undefined) delete process.env.B1_ORDER_SENTINEL;
    else process.env.B1_ORDER_SENTINEL = before;
    delete process.env.RAFT_COMPUTER_OS_SUPERVISOR_KIND;
    delete process.env.RAFT_COMPUTER_SHELL_ENV_STATE;
  }
});

test("dispatchToKResident: a cold SEA execs K stable with the exact user argv", async () => {
  let resolvedHome = "";
  let execCall: { file: string; args: string[]; env: Record<string, string> } | null = null;
  const env = { SLOCK_HOME: "/tmp/k-dispatch-home", KEEP: "yes" };

  const dispatched = await dispatchToKResident(
    ["/installed/raft-computer", "status", "--server", "abc"],
    env,
    {
      isSea: () => true,
      platform: "linux",
      currentBinary: "/installed/raft-computer",
      resolveRealPath: resolveSyntheticRealPath,
      resolveResident: async (home) => {
        resolvedHome = home;
        return "/tmp/k-dispatch-home/computer/k/slots/stable/artifact.bin";
      },
      execve: (file, args, childEnv) => {
        execCall = { file, args, env: childEnv };
      },
    },
  );

  assert.equal(dispatched, true);
  assert.equal(resolvedHome, "/tmp/k-dispatch-home");
  assert.deepEqual(execCall, {
    file: "/tmp/k-dispatch-home/computer/k/slots/stable/artifact.bin",
    args: [
      "/tmp/k-dispatch-home/computer/k/slots/stable/artifact.bin",
      "status",
      "--server",
      "abc",
    ],
    env: {
      ...env,
      RAFT_COMPUTER_DISPATCHER_PATH: "/installed/raft-computer",
    },
  });
});

test("dispatchToKResident: installer convergence stays on the verified candidate", async () => {
  let resolved = false;
  let spawned = false;
  const dispatched = await dispatchToKResident(
    [
      "/verified/raft-computer",
      "__installer-converge",
      "1.0.18",
      "a".repeat(64),
    ],
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "linux",
      currentBinary: "/verified/raft-computer",
      resolveResident: async () => {
        resolved = true;
        return "/raft-home/computer/k/slots/stable/artifact.bin";
      },
      execve: null,
      spawnReplacement: async () => { spawned = true; return 0; },
      setExitCode: () => {},
    },
  );
  assert.equal(dispatched, false);
  assert.equal(resolved, false);
  assert.equal(spawned, false);
});

test("dispatchToKResident: Windows uses a transient wrapper and preserves child exit status", async () => {
  let spawnCall: { file: string; args: string[]; env: Record<string, string> } | null = null;
  let exitCode: number | null = null;
  const env = { SLOCK_HOME: "/raft-home", KEEP: "yes" };

  const dispatched = await dispatchToKResident(
    ["/installed/raft-computer.exe", "doctor"],
    env,
    {
      isSea: () => true,
      platform: "win32",
      currentBinary: "/installed/raft-computer.exe",
      resolveRealPath: resolveSyntheticRealPath,
      resolveResident: async () => "/raft-home/computer/k/slots/stable/artifact.bin",
      spawnReplacement: async (file, args, childEnv) => {
        spawnCall = { file, args, env: childEnv };
        return 7;
      },
      setExitCode: (code) => { exitCode = code; },
      execve: () => { throw new Error("Windows must not call POSIX execve"); },
    },
  );

  assert.equal(dispatched, true);
  assert.deepEqual(spawnCall, {
    file: "/raft-home/computer/k/slots/stable/artifact.bin",
    args: ["doctor"],
    env: {
      ...env,
      RAFT_COMPUTER_DISPATCHER_PATH: "/installed/raft-computer.exe",
    },
  });
  assert.equal(exitCode, 7);
});

test("dispatchToKResident: the Node 20 SEA path falls back when execve is unavailable", async () => {
  let spawned = false;
  let exitCode = -1;
  assert.equal(await dispatchToKResident(
    ["/installed/raft-computer", "status"],
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "linux",
      currentBinary: "/installed/raft-computer",
      resolveRealPath: resolveSyntheticRealPath,
      resolveResident: async () => "/raft-home/computer/k/slots/stable/artifact.bin",
      execve: null,
      spawnReplacement: async () => { spawned = true; return 3; },
      setExitCode: (code) => { exitCode = code; },
    },
  ), true);
  assert.equal(spawned, true);
  assert.equal(exitCode, 3);
});

test("dispatchToKResident: native SEA self argv is not forwarded as a fake command", async () => {
  let args: string[] | null = null;
  await dispatchToKResident(
    ["/installed/raft-computer", "/installed/raft-computer", "status"],
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "linux",
      currentBinary: "/installed/raft-computer",
      resolveRealPath: resolveSyntheticRealPath,
      resolveResident: async () => "/raft-home/computer/k/slots/stable/artifact.bin",
      execve: null,
      spawnReplacement: async (_file, forwarded) => { args = forwarded; return 0; },
      setExitCode: () => {},
    },
  );
  assert.deepEqual(args, ["status"]);
});

test("dispatchToKResident: a macOS /var resident alias does not hand off to itself", async () => {
  const canonicalBinary = "/private/var/folders/fixture/raft-computer-darwin-arm64";
  const residentAlias = "/var/folders/fixture/raft-computer-darwin-arm64";
  const resolveRealPath = (file: string): string => {
    if (file === canonicalBinary || file === residentAlias) return canonicalBinary;
    throw new Error(`unexpected realpath lookup: ${file}`);
  };
  let spawned = false;

  const dispatched = await dispatchToKResident(
    [canonicalBinary, "status"],
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "darwin",
      currentBinary: canonicalBinary,
      resolveRealPath,
      resolveResident: async () => residentAlias,
      execve: null,
      spawnReplacement: async () => { spawned = true; return 0; },
      setExitCode: () => {},
    },
  );

  assert.equal(dispatched, false);
  assert.equal(spawned, false);
});

test("dispatchToKResident: an unresolvable resident identity never hands off", async () => {
  let spawned = false;
  const dispatched = await dispatchToKResident(
    ["/private/var/folders/fixture/raft-computer", "status"],
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "darwin",
      currentBinary: "/private/var/folders/fixture/raft-computer",
      resolveRealPath: () => { throw new Error("EACCES"); },
      resolveResident: async () => "/var/folders/fixture/raft-computer",
      execve: null,
      spawnReplacement: async () => { spawned = true; return 0; },
      setExitCode: () => {},
    },
  );

  assert.equal(dispatched, false);
  assert.equal(spawned, false);
});

test("dispatchToKResident: macOS /var candidate alias stays on installer convergence", async () => {
  let resolved = false;
  let spawned = false;
  const canonicalCandidate = "/private/var/folders/fixture/raft-computer-darwin-arm64";
  const installerCandidate = "/var/folders/fixture/raft-computer-darwin-arm64";
  const resolveRealPath = (file: string): string => {
    if (file === installerCandidate || file === canonicalCandidate) {
      return canonicalCandidate;
    }
    throw new Error(`unexpected realpath lookup: ${file}`);
  };

  const dispatched = await dispatchToKResident(
    [canonicalCandidate, installerCandidate, "__installer-converge", "1.0.20", "a".repeat(64)],
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "darwin",
      currentBinary: canonicalCandidate,
      resolveRealPath,
      resolveResident: async () => {
        resolved = true;
        return "/raft-home/computer/k/slots/stable/artifact.bin";
      },
      execve: null,
      spawnReplacement: async () => { spawned = true; return 0; },
      setExitCode: () => {},
    },
  );

  assert.equal(dispatched, false);
  assert.equal(resolved, false);
  assert.equal(spawned, false);
});

test("dispatchToKResident: real macOS mktemp alias stays on installer convergence", {
  skip: process.platform !== "darwin",
}, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "raft-computer-self-argv-"));
  try {
    const installerCandidate = path.join(tempDir, "raft-computer-darwin-arm64");
    await writeFile(installerCandidate, "fixture");
    const canonicalCandidate = await realpath(installerCandidate);
    assert.notEqual(installerCandidate, canonicalCandidate);

    let resolved = false;
    const dispatched = await dispatchToKResident(
      [canonicalCandidate, installerCandidate, "__installer-converge", "1.0.20", "a".repeat(64)],
      { SLOCK_HOME: "/raft-home" },
      {
        isSea: () => true,
        platform: "darwin",
        currentBinary: canonicalCandidate,
        resolveResident: async () => {
          resolved = true;
          return "/raft-home/computer/k/slots/stable/artifact.bin";
        },
        execve: null,
        spawnReplacement: async () => 0,
        setExitCode: () => {},
      },
    );

    assert.equal(dispatched, false);
    assert.equal(resolved, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchToKResident: a distinct absolute argv path is never swallowed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "raft-computer-other-argv-"));
  try {
    const currentBinary = path.join(tempDir, "raft-computer");
    const otherPath = path.join(tempDir, "other-command");
    await writeFile(currentBinary, "current");
    await writeFile(otherPath, "other");

    let args: string[] | null = null;
    const dispatched = await dispatchToKResident(
      [currentBinary, otherPath, "status"],
      { SLOCK_HOME: "/raft-home" },
      {
        isSea: () => true,
        platform: process.platform,
        currentBinary,
        resolveRealPath: resolveSyntheticRealPath,
        resolveResident: async () => "/raft-home/computer/k/slots/stable/artifact.bin",
        execve: null,
        spawnReplacement: async (_file, forwarded) => { args = forwarded; return 0; },
        setExitCode: () => {},
      },
    );

    assert.equal(dispatched, true);
    assert.deepEqual(args, [otherPath, "status"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchToKResident: an unresolvable absolute self spelling fails closed", async () => {
  const missingBinary = path.join(
    os.tmpdir(),
    `raft-computer-missing-${process.pid}-${Date.now()}`,
  );
  const argv = [missingBinary, missingBinary, "status"];
  const dispatched = await dispatchToKResident(
    argv,
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: process.platform,
      currentBinary: missingBinary,
      resolveResident: async () => "/raft-home/computer/k/slots/stable/artifact.bin",
      execve: null,
      spawnReplacement: async () => { throw new Error("unbound identity must not hand off"); },
      setExitCode: () => {},
    },
  );

  assert.equal(dispatched, false);
  assert.deepEqual(argv, [missingBinary, missingBinary, "status"]);
});

// task #423 regression: a shell PATH launch puts the BARE command name in the
// SEA self slot; forwarding it gave the K resident
// `raft-computer raft-computer restart` and a Commander unknown-command.
test("dispatchToKResident: bare PATH self name is stripped before handoff (task #423)", async () => {
  let args: string[] | null = null;
  await dispatchToKResident(
    ["/Users/me/.local/bin/raft-computer", "raft-computer", "restart"],
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "darwin",
      currentBinary: "/Users/me/.local/bin/raft-computer",
      resolveRealPath: resolveSyntheticRealPath,
      resolveResident: async () => "/raft-home/computer/k/slots/stable/artifact.bin",
      execve: null,
      spawnReplacement: async (_file, forwarded) => { args = forwarded; return 0; },
      setExitCode: () => {},
    },
  );
  assert.deepEqual(args, ["restart"]);
});

test("dispatchToKResident: a real positional first arg is never dropped", async () => {
  // The positional-consuming shape (`start <server>`) is the oracle here:
  // --version/--help succeed with either argv and cannot pin this.
  let args: string[] | null = null;
  await dispatchToKResident(
    ["/installed/raft-computer", "start", "raft-computer"],
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "linux",
      currentBinary: "/installed/raft-computer",
      resolveRealPath: resolveSyntheticRealPath,
      resolveResident: async () => "/raft-home/computer/k/slots/stable/artifact.bin",
      execve: null,
      spawnReplacement: async (_file, forwarded) => { args = forwarded; return 0; },
      setExitCode: () => {},
    },
  );
  // "start" is not the binary's name, so nothing is stripped — including the
  // positional VALUE that happens to spell the product name.
  assert.deepEqual(args, ["start", "raft-computer"]);
});

test("dispatchToKResident: bare launch without a K slot neither dispatches nor mutates argv", async () => {
  const argv = ["/installed/raft-computer", "raft-computer", "restart"];
  const dispatched = await dispatchToKResident(
    argv,
    { SLOCK_HOME: "/raft-home" },
    {
      isSea: () => true,
      platform: "darwin",
      currentBinary: "/installed/raft-computer",
      // Empty stable slot resolves to the current binary: fail closed.
      resolveResident: async (_home, binary) => binary,
      execve: null,
      spawnReplacement: async () => { throw new Error("must not hand off without a K slot"); },
      setExitCode: () => {},
    },
  );
  assert.equal(dispatched, false);
  assert.deepEqual(argv, ["/installed/raft-computer", "raft-computer", "restart"]);
});

test("stripForwardedCarrierName: rescues a pre-fix carrier's double-forwarded name", () => {
  const slot = "/home/u/.slock/computer/k/slots/stable/artifact.bin";
  const argv = ["/exec/artifact.bin", slot, "raft-computer", "restart"];
  const stripped = stripForwardedCarrierName(argv, {
    isSea: () => true,
    currentBinary: slot,
    platform: "darwin",
    resolveRealPath: resolveSyntheticRealPath,
  });
  assert.equal(stripped, true);
  assert.deepEqual(argv, ["/exec/artifact.bin", slot, "restart"]);
});

test("stripForwardedCarrierName: strips at most one token", () => {
  const slot = "/slots/stable/artifact.bin";
  const argv = ["/exec", slot, "raft-computer", "raft-computer", "restart"];
  assert.equal(
    stripForwardedCarrierName(argv, {
      isSea: () => true,
      currentBinary: slot,
      platform: "linux",
      resolveRealPath: resolveSyntheticRealPath,
    }),
    true,
  );
  assert.deepEqual(argv, ["/exec", slot, "raft-computer", "restart"]);
});

test("stripForwardedCarrierName: leaves real subcommands, non-SEA and non-self argv alone", () => {
  const slot = "/slots/stable/artifact.bin";

  const realCommand = ["/exec", slot, "restart"];
  assert.equal(
    stripForwardedCarrierName(realCommand, {
      isSea: () => true,
      currentBinary: slot,
      platform: "linux",
      resolveRealPath: resolveSyntheticRealPath,
    }),
    false,
  );
  assert.deepEqual(realCommand, ["/exec", slot, "restart"]);

  const notSea = ["/exec", slot, "raft-computer", "restart"];
  assert.equal(
    stripForwardedCarrierName(notSea, {
      isSea: () => false,
      currentBinary: slot,
      platform: "linux",
      resolveRealPath: resolveSyntheticRealPath,
    }),
    false,
  );
  assert.deepEqual(notSea, ["/exec", slot, "raft-computer", "restart"]);

  // Embedder/test shape: argv[1] is already a user arg, not the self slot.
  const embedder = ["/exec", "start", "raft-computer"];
  assert.equal(
    stripForwardedCarrierName(embedder, { isSea: () => true, currentBinary: slot, platform: "linux" }),
    false,
  );
  assert.deepEqual(embedder, ["/exec", "start", "raft-computer"]);

  // Renamed carriers forward a different token and are deliberately not rescued.
  const renamed = ["/exec", slot, "my-computer", "restart"];
  assert.equal(
    stripForwardedCarrierName(renamed, {
      isSea: () => true,
      currentBinary: slot,
      platform: "linux",
      resolveRealPath: resolveSyntheticRealPath,
    }),
    false,
  );
  assert.deepEqual(renamed, ["/exec", slot, "my-computer", "restart"]);
});

test("stripForwardedCarrierName: Windows folds case and .exe; POSIX does not", () => {
  const slot = "/slots/stable/artifact.bin";

  const win = ["/exec", slot, "Raft-Computer.EXE", "doctor"];
  assert.equal(
    stripForwardedCarrierName(win, {
      isSea: () => true,
      currentBinary: slot,
      platform: "win32",
      resolveRealPath: resolveSyntheticRealPath,
    }),
    true,
  );
  assert.deepEqual(win, ["/exec", slot, "doctor"]);

  const posix = ["/exec", slot, "Raft-Computer.EXE", "doctor"];
  assert.equal(
    stripForwardedCarrierName(posix, {
      isSea: () => true,
      currentBinary: slot,
      platform: "linux",
      resolveRealPath: resolveSyntheticRealPath,
    }),
    false,
  );
  assert.deepEqual(posix, ["/exec", slot, "Raft-Computer.EXE", "doctor"]);
});

test("bootstrapThenRun: double-forwarded name is stripped before the CLI parses", async () => {
  const slot = "/slots/stable/artifact.bin";
  const argv = ["/exec", slot, "raft-computer", "restart"];
  let argvAtCliRun: string[] | null = null;
  await bootstrapThenRun(
    argv,
    {},
    undefined,
    async () => ({ runCliAsMain: () => { argvAtCliRun = [...argv]; } }),
    () => {},
    async () => false,
    (target) => stripForwardedCarrierName(target, {
      isSea: () => true,
      currentBinary: slot,
      platform: "linux",
      resolveRealPath: resolveSyntheticRealPath,
    }),
  );
  assert.deepEqual(argvAtCliRun, ["/exec", slot, "restart"]);
});

test("bootstrapThenRun: K dispatch happens before shell capture and stale CLI import", async () => {
  let captureCalls = 0;
  let importCalls = 0;
  let dispatchCalls = 0;
  await bootstrapThenRun(
    ["/installed/raft-computer", "status"],
    {},
    async () => {
      captureCalls += 1;
      throw new Error("K dispatch must happen before capture");
    },
    async () => {
      importCalls += 1;
      throw new Error("K dispatch must happen before stale CLI import");
    },
    () => {},
    async () => {
      dispatchCalls += 1;
      return true;
    },
  );
  assert.equal(dispatchCalls, 1);
  assert.equal(captureCalls, 0);
  assert.equal(importCalls, 0);
});

test("bootstrapThenRun: foreground path never captures and the CLI graph sees inherited env", async () => {
  const probePath = await freshCliProbe();
  const before = process.env.B1_ORDER_SENTINEL;
  let captureCalls = 0;
  const probe: { current: { observedSentinel?: string } | null } = { current: null };
  try {
    delete process.env.RAFT_COMPUTER_OS_SUPERVISOR_KIND;
    process.env.B1_ORDER_SENTINEL = "inherited-baseline";
    await bootstrapThenRun(
      ["node", "x", "__service"],
      process.env,
      async () => {
        captureCalls += 1;
        return { ok: false as const, code: "SHELL_ENV_SPAWN_FAILED" as const, detail: "must not be called" };
      },
      async () => (probe.current = await import(pathToFileURL(probePath).href)),
    );
    assert.equal(captureCalls, 0, "foreground boot must not run shell capture");
    assert.equal(probe.current?.observedSentinel, "inherited-baseline");
  } finally {
    if (before === undefined) delete process.env.B1_ORDER_SENTINEL;
    else process.env.B1_ORDER_SENTINEL = before;
  }
});

test("bootstrapThenRun: complete legacy OS-manager service invocation exits before capture and CLI import", async () => {
  for (const kind of [
    "launchd-user",
    "systemd-user",
    "windows-task",
  ] as const) {
    const env: NodeJS.ProcessEnv = {};
    let captureCalls = 0;
    let importCalls = 0;
    const diagnostics: string[] = [];
    await bootstrapThenRun(
      [
        "node",
        "x",
        "__service",
        "--slock-home",
        "/frozen/home",
        "--os-supervised",
        kind,
      ],
      env,
      async () => {
        captureCalls += 1;
        throw new Error(
          "legacy tombstone must not capture a shell environment",
        );
      },
      async () => {
        importCalls += 1;
        throw new Error("legacy tombstone must not import the CLI graph");
      },
      (message) => {
        diagnostics.push(message);
      },
    );
    assert.equal(captureCalls, 0);
    assert.equal(importCalls, 0);
    assert.deepEqual(env, {});
    assert.deepEqual(diagnostics, [
      `raft-computer: retired_os_supervisor_entry_ignored kind=${kind}\n`,
    ]);
  }
});

test("bootstrapThenRun: incomplete or invalid marker shapes never swallow another CLI invocation", async () => {
  for (const argv of [
    ["node", "x", "start", "--os-supervised", "launchd-user"],
    ["node", "x", "__service", "--os-supervised"],
    ["node", "x", "__service", "--os-supervised", "foreign-manager"],
    ["node", "x", "__service", "--os-supervised", "launchd-user"],
    [
      "node",
      "x",
      "__service",
      "--slock-home",
      "/frozen/home",
      "--os-supervised",
      "launchd-user",
      "status",
    ],
  ]) {
    let importCalls = 0;
    await bootstrapThenRun(
      argv,
      {},
      async () => ({
        ok: true as const,
        env: {},
        shell: "/bin/zsh",
        durationMs: 1,
      }),
      async () => {
        importCalls += 1;
        return { runCliAsMain() {} };
      },
      () => {
        throw new Error(
          "invalid manager argv must not emit the retired-entry marker",
        );
      },
    );
    assert.equal(importCalls, 1);
  }
});

test("bootstrapThenRun: hostile ambient manager env cannot swallow foreground or incomplete argv", async () => {
  for (const kind of ["launchd-user", "systemd-user", "windows-task"]) {
    for (const argv of [
      ["node", "x", "start", "--foreground"],
      ["node", "x", "__service"],
      ["node", "x", "__service", "--os-supervised", kind],
    ]) {
      let captureCalls = 0;
      let importCalls = 0;
      let runCalls = 0;
      const diagnostics: string[] = [];
      await bootstrapThenRun(
        argv,
        { RAFT_COMPUTER_OS_SUPERVISOR_KIND: kind },
        async () => {
          captureCalls += 1;
          return {
            ok: false as const,
            code: "SHELL_ENV_SPAWN_FAILED" as const,
            detail: "hostile fixture",
          };
        },
        async () => {
          importCalls += 1;
          return { runCliAsMain: () => { runCalls += 1; } };
        },
        (message) => diagnostics.push(message),
      );
      assert.equal(importCalls, 1, `${kind} ${argv.join(" ")} must reach CLI import`);
      assert.equal(runCalls, 1, `${kind} ${argv.join(" ")} must run the normal CLI path`);
      assert.equal(diagnostics.length, 0, "ambient env must not emit retired-entry diagnostics");
      if (!argv.includes("__service") || kind === "windows-task")
        assert.equal(captureCalls, 0);
    }
  }
});

// ---------------------------------------------------------------------------
// Bounded capture against real fake-shell fixtures (review H3).
// The fixture IS an executable named `bash` so the supported-shell gate
// passes; each variant misbehaves in one specific way.
// ---------------------------------------------------------------------------

async function fakeShell(script: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raft-shellenv-"));
  const shellPath = path.join(dir, "bash");
  await writeFile(shellPath, `#!/bin/sh\n${script}`, "utf8");
  await chmod(shellPath, 0o755);
  return shellPath;
}

// 2.5s default: generous for healthy fixtures on a cold machine (Hao nit —
// 800ms hit a 810ms cold-start false red); hang/oversize cells pass their own
// short timeouts explicitly so the failure paths stay fast.

/** A fake self-exec "binary": sh shim exec'ing node with inline JS that
 *  receives (nonce, sockPath) from our argv contract. */
async function fakeSockBinary(js: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raft-shellenv-bin-"));
  const bin = path.join(dir, "raft-computer");
  const inline = [
    'const net = require("node:net");',
    'const nonce = process.argv[process.argv.indexOf("--nonce") + 1];',
    'const sock = process.argv[process.argv.indexOf("--sock") + 1];',
    js,
  ].join("");
  await writeFile(
    bin,
    `#!/bin/sh\nexec '${process.execPath}' -e '${inline.replaceAll("'", String.raw`'\''`)}' -- "$@"\n`,
    "utf8",
  );
  await chmod(bin, 0o755);
  return bin;
}

const CAPTURE_OPTS = { timeoutMs: 2500, platform: "linux" as const };

test("end-to-end success: real shell chain delivers a parsed, applied environment", async () => {
  const bin = await fakeSockBinary(
    'const s = net.connect(sock, () => { s.end(`RAFT-ENV1 ${nonce}\\n` + "FROM_SHELL=terminal-value\\0" + "PATH=/user/custom/bin:/usr/bin\\0" + `RAFT-ENV1-END ${nonce}\\n`); }); s.on("error", () => process.exit(8));',
  );
  const shell = await fakeShell('eval "$4"');
  const result = await captureShellEnv({
    ...CAPTURE_OPTS,
    resolveShell: () => shell,
    selfExec: [bin],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const env = (result as { env: Record<string, string> }).env;
  assert.equal(env.FROM_SHELL, "terminal-value");
  assert.equal(env.PATH, "/user/custom/bin:/usr/bin");
});

test("multi-element self-exec vectors are quoted per argv element (npm-wrapper shape)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raft-shellenv-vec-"));
  const script = path.join(dir, "entry with space.js");
  await writeFile(
    script,
    [
      'const net = require("node:net");',
      'if (!process.argv.includes("__print-env")) process.exit(9);',
      'const nonce = process.argv[process.argv.indexOf("--nonce") + 1];',
      'const sock = process.argv[process.argv.indexOf("--sock") + 1];',
      'const s = net.connect(sock, () => { s.end(`RAFT-ENV1 ${nonce}\n` + "VEC=ok\0" + `RAFT-ENV1-END ${nonce}\n`); });',
      's.on("error", () => process.exit(8));',
    ].join("\n"),
    "utf8",
  );
  const shell = await fakeShell('eval "$4"');
  const result = await captureShellEnv({
    ...CAPTURE_OPTS,
    timeoutMs: 5000,
    resolveShell: () => shell,
    selfExec: [process.execPath, script],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((result as { env: Record<string, string> }).env.VEC, "ok");
});

test("real tsx entry succeeds through the DEFAULT self-exec descriptor shape", async () => {
  // The truest npm/tsx-form tooth (Hao blocker): node + loader args + the
  // actual thin entry, exactly what buildSelfExecArgv() produces in dev — a
  // bare process.execPath here would exit nonzero and this cell would red.
  const entry = new URL("./index.ts", import.meta.url).pathname;
  const shell = await fakeShell('eval "$4"');
  const result = await captureShellEnv({
    ...CAPTURE_OPTS,
    timeoutMs: 15_000,
    resolveShell: () => shell,
    selfExec: [process.execPath, "--import", "tsx", entry],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const env = (result as { env: Record<string, string> }).env;
  assert.equal(typeof env.PATH, "string");
});

test("rc that exits 0 without the helper ever connecting settles via hard timeout", async () => {
  // Shell exits immediately, grandchild lingers, no socket connection is
  // ever made — only the timeout can settle (H3 family under the socket
  // transport).
  const shell = await fakeShell("sleep 60 &\nexit 0");
  const result = await captureShellEnv({ ...CAPTURE_OPTS, timeoutMs: 800, resolveShell: () => shell });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "SHELL_ENV_TIMEOUT");
});

test("oversized output settles typed failure without waiting for stream end", async () => {
  const bin = await fakeSockBinary(
    'const s = net.connect(sock, () => { const big = Buffer.alloc(65536, 65); for (let i = 0; i < 64; i++) s.write(big); });',
  );
  const shell = await fakeShell('eval "$4"');
  const result = await captureShellEnv({
    ...CAPTURE_OPTS,
    maxBytes: 16 * 1024,
    resolveShell: () => shell,
    selfExec: [bin],
  });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "SHELL_ENV_OUTPUT_TOO_LARGE");
});

test("garbage on the capture socket is a typed failure, not partial apply", async () => {
  const bin = await fakeSockBinary(
    'const s = net.connect(sock, () => { s.end("garbage-without-frame"); });',
  );
  const shell = await fakeShell('eval "$4"');
  const result = await captureShellEnv({ ...CAPTURE_OPTS, resolveShell: () => shell, selfExec: [bin] });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "SHELL_ENV_BAD_FRAME");
});

test("unsupported login shell is a typed failure", async () => {
  const result = await captureShellEnv({
    ...CAPTURE_OPTS,
    resolveShell: () => "/usr/bin/fish",
  });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "SHELL_ENV_UNSUPPORTED_SHELL");
});

test("non-POSIX platform is a typed failure before any spawn", async () => {
  const result = await captureShellEnv({ platform: "win32" });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "SHELL_ENV_UNSUPPORTED_PLATFORM");
});

// ---------------------------------------------------------------------------
// Bootstrap gate (review H1) + outcome recording (review B3, softened gate).
// ---------------------------------------------------------------------------

test("bootstrap only captures for OS-supervised POSIX service argv", async () => {
  let captureCalls = 0;
  const capture = async () => {
    captureCalls += 1;
    return { ok: true as const, env: { X: "1" }, shell: "/bin/zsh", durationMs: 1 };
  };
  // Not a service boot → skipped, env untouched (foreground H1 cell).
  const fg: NodeJS.ProcessEnv = { KEEP: "1" };
  assert.equal(await bootstrapSupervisedServiceEnv(["node", "x", "start", "--foreground"], fg, capture), "skipped");
  // Service boot without a supervised kind (CLI-detached) → skipped.
  const detached: NodeJS.ProcessEnv = { KEEP: "1" };
  assert.equal(await bootstrapSupervisedServiceEnv(["node", "x", "__service"], detached, capture), "skipped");
  // Windows task kind → skipped.
  const win: NodeJS.ProcessEnv = { RAFT_COMPUTER_OS_SUPERVISOR_KIND: "windows-task" };
  assert.equal(await bootstrapSupervisedServiceEnv(["node", "x", "__service"], win, capture), "skipped");
  assert.equal(captureCalls, 0);
  assert.equal(fg.KEEP, "1");
  assert.equal(detached.KEEP, "1");
});

test("bootstrap freezes --slock-home before capture and applies snapshot on success", async () => {
  const env: NodeJS.ProcessEnv = { RAFT_COMPUTER_OS_SUPERVISOR_KIND: "launchd-user", OLD: "gone" };
  const outcome = await bootstrapSupervisedServiceEnv(
    ["node", "x", "__service", "--slock-home", "/frozen/home"],
    env,
    async () => ({
      ok: true as const,
      env: { FROM_SHELL: "yes", SLOCK_HOME: "/rc/evil" },
      shell: "/bin/zsh",
      durationMs: 2,
    }),
  );
  assert.equal(outcome, "inherited");
  assert.equal(env.FROM_SHELL, "yes");
  assert.equal(env.OLD, undefined);
  // argv home frozen pre-capture beats the rc's poisoned value.
  assert.equal(env.SLOCK_HOME, "/frozen/home");
  assert.equal(env.RAFT_COMPUTER_SHELL_ENV_STATE, "inherited");
});

test("bootstrap failure records explicit degraded state and keeps baseline env", async () => {
  const env: NodeJS.ProcessEnv = { RAFT_COMPUTER_OS_SUPERVISOR_KIND: "systemd-user", BASE: "kept" };
  const outcome = await bootstrapSupervisedServiceEnv(
    ["node", "x", "__service"],
    env,
    async () => ({
      ok: false as const,
      code: "SHELL_ENV_TIMEOUT" as const,
      detail: "test",
    }),
  );
  assert.equal(outcome, "unavailable:SHELL_ENV_TIMEOUT");
  assert.equal(env.BASE, "kept");
  assert.equal(env.RAFT_COMPUTER_SHELL_ENV_STATE, "unavailable:SHELL_ENV_TIMEOUT");
});

// ---------------------------------------------------------------------------
// ② surface (xxchan ruling b48782f5): the import outcome must be readable by
// a LATER CLI process via the persisted service version evidence — codes
// only, never environment values.
// ---------------------------------------------------------------------------

test("service version evidence persists the shell env outcome for cross-process status", async () => {
  const { writeProcessVersionEvidence, readProcessVersionEvidence } = await import("./versionEvidence.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "raft-evidence-"));
  const file = path.join(dir, "service.version.json");
  await writeProcessVersionEvidence(file, {
    version: "1.0.5",
    installRoot: dir,
    pid: 123,
    writtenAt: "2026-07-19T00:00:00.000Z",
    shellEnvironment: "unavailable:SHELL_ENV_TIMEOUT",
  });
  const back = await readProcessVersionEvidence(file);
  assert.equal(back?.shellEnvironment, "unavailable:SHELL_ENV_TIMEOUT");
  // Closed-set round-trip: every legal outcome survives.
  const { SHELL_ENV_CAPTURE_FAILURE_CODES } = await import("./shellEnvCapture.js");
  for (const code of ["inherited", ...SHELL_ENV_CAPTURE_FAILURE_CODES.map((c) => `unavailable:${c}`)]) {
    await writeProcessVersionEvidence(file, {
      version: null, installRoot: dir, pid: 1, writtenAt: "t", shellEnvironment: code,
    });
    assert.equal((await readProcessVersionEvidence(file))?.shellEnvironment, code);
  }
  // Anything outside the closed set is DROPPED at the schema layer: unknown
  // tokens, ANSI/newline payloads, and an empty suffix can never render.
  for (const bad of [
    "unavailable:",
    "unavailable:NOT_A_CODE",
    "unavailable:SHELL_ENV_TIMEOUT\u001b[31mEVIL",
    "unavailable:line1\nline2",
    "totally-unknown",
  ]) {
    await writeProcessVersionEvidence(file, {
      version: null, installRoot: dir, pid: 1, writtenAt: "t", shellEnvironment: bad,
    });
    const reread = await readProcessVersionEvidence(file);
    assert.notEqual(reread, null, "evidence itself stays readable");
    assert.equal(reread?.shellEnvironment, undefined, `must drop: ${JSON.stringify(bad)}`);
  }
  // Non-string outcome is rejected wholesale, not partially applied.
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(file, `${JSON.stringify({ version: null, installRoot: dir, pid: 1, writtenAt: "x", shellEnvironment: 5 })}\n`);
  assert.equal(await readProcessVersionEvidence(file), null);
});

test("status renders the degraded warning gated on the unavailable prefix, codes only", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./status.ts", import.meta.url), "utf8");
  assert.match(src, /shellEnvironment\?\.startsWith\("unavailable:"\)/);
  assert.match(src, /terminal shell environment import failed/);
  // The rendered line interpolates only the parsed code slice — never any
  // captured environment value (which the evidence file cannot contain).
  assert.match(src, /slice\("unavailable:"\.length\)/);
});

// ---------------------------------------------------------------------------
// Real-bash rc hostility (Sora Linux-bed RED 91a16cbc): the exact rc patterns
// that killed the fixed-fd transport must be harmless under the socket sink.
// ---------------------------------------------------------------------------

async function realBashHome(rcBody: string): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "raft-rc-home-"));
  await writeFile(path.join(home, ".bashrc"), rcBody, "utf8");
  await writeFile(path.join(home, ".bash_profile"), '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n', "utf8");
  return home;
}

const SUCCESS_WRITER =
  'const s = net.connect(sock, () => { s.end(`RAFT-ENV1 ${nonce}\\n` + "RC_SURVIVED=yes\\0" + `RAFT-ENV1-END ${nonce}\\n`); }); s.on("error", () => process.exit(8));';

test("real bash rc with command substitution cannot break the socket sink", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return t.skip();
  const home = await realBashHome('eval "$(printf \'export SUBSTITUTED=1\')"\n');
  const bin = await fakeSockBinary(SUCCESS_WRITER);
  const result = await captureShellEnv({
    ...CAPTURE_OPTS,
    timeoutMs: 5000,
    platform: process.platform as "linux",
    resolveShell: () => "/bin/bash",
    selfExec: [bin],
    spawnEnv: { ...process.env, HOME: home },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((result as { env: Record<string, string> }).env.RC_SURVIVED, "yes");
});

test("real bash rc that explicitly closes fd3 cannot break the socket sink", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return t.skip();
  const home = await realBashHome("exec 3>&-\n");
  const bin = await fakeSockBinary(SUCCESS_WRITER);
  const result = await captureShellEnv({
    ...CAPTURE_OPTS,
    timeoutMs: 5000,
    platform: process.platform as "linux",
    resolveShell: () => "/bin/bash",
    selfExec: [bin],
    spawnEnv: { ...process.env, HOME: home },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((result as { env: Record<string, string> }).env.RC_SURVIVED, "yes");
});

test("nonzero shell exit reaps rc-spawned grandchildren before settlement", async () => {
  // Hao HOLD 290fa91f: settle() clears the hard timeout, so a detached
  // grandchild left after a nonzero exit would live forever. The group must
  // be reaped BEFORE settlement on every terminal failure path.
  const dir = await mkdtemp(path.join(os.tmpdir(), "raft-reap-"));
  const pidFile = path.join(dir, "grandchild.pid");
  const shell = await fakeShell(`sleep 60 &\necho $! > '${pidFile}'\nexit 7`);
  const result = await captureShellEnv({ ...CAPTURE_OPTS, resolveShell: () => shell });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "SHELL_ENV_SHELL_EXITED_NONZERO");
  const { readFile: rf } = await import("node:fs/promises");
  const pid = Number((await rf(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `grandchild pid recorded: ${pid}`);
  // TERM lands immediately on sleep; allow up to ~1.5s (grace + KILL).
  const deadline = Date.now() + 1500;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
      break;
    }
  }
  if (alive) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  assert.equal(alive, false, "grandchild must not survive settlement");
});

test("healthy success with an already-dead probe group arms no delayed SIGKILL", async () => {
  // Sora 33911406: after a clean capture the probe pgid is already gone
  // (ESRCH on group TERM, dead-child fallback false). A grace timer that
  // still fires SIGKILL at that negative pgid could hit an unrelated
  // process group if the kernel reuses the id within the 1s window.
  const calls: Array<{ pid: number; signal: string }> = [];
  const killFn = ((pid: number, signal?: string | number) => {
    calls.push({ pid, signal: String(signal) });
    return process.kill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  const bin = await fakeSockBinary(SUCCESS_WRITER);
  const shell = await fakeShell('eval "$4"');
  const result = await captureShellEnv({
    ...CAPTURE_OPTS,
    resolveShell: () => shell,
    selfExec: [bin],
    killFn,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const terms = calls.filter((c) => c.pid < 0 && c.signal === "SIGTERM");
  assert.equal(terms.length, 1, `exactly one group TERM attempt: ${JSON.stringify(calls)}`);
  // Outlive the 1s grace window: no KILL may ever be scheduled or sent.
  await new Promise((r) => setTimeout(r, 1300));
  const kills = calls.filter((c) => c.signal === "SIGKILL");
  assert.equal(kills.length, 0, `no delayed SIGKILL after no-target TERM: ${JSON.stringify(calls)}`);
});

test("a flushed valid frame followed by nonzero exit still fails (fd-transport parity)", async () => {
  // Hao c8aced7c: success requires BOTH authorities — valid frame AND child
  // close 0. A writer that delivers the frame then exits 7 must not pass.
  const bin = await fakeSockBinary(
    'const s = net.connect(sock, () => { s.end(`RAFT-ENV1 ${nonce}\\n` + "SNEAKY=frame\\0" + `RAFT-ENV1-END ${nonce}\\n`, () => process.exit(7)); });',
  );
  const shell = await fakeShell('eval "$4"');
  for (let i = 0; i < 3; i++) {
    const result = await captureShellEnv({ ...CAPTURE_OPTS, resolveShell: () => shell, selfExec: [bin] });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal((result as { code: string }).code, "SHELL_ENV_SHELL_EXITED_NONZERO");
  }
});
