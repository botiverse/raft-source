import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const raftdev = join(projectDir, "raftdev");
const raftdevScript = join(projectDir, "scripts", "dev", "raftdev.ts");

test("the exact repository Node pin is at least the supported package engine floor", () => {
  const packageJson = JSON.parse(
    readFileSync(join(projectDir, "package.json"), "utf8"),
  ) as {
    engines?: { node?: string };
  };
  const engineFloor = Number(
    packageJson.engines?.node?.match(/^>=(\d+)(?:\.\d+){0,2}$/)?.[1],
  );
  const pinMajor = Number(
    readFileSync(join(projectDir, ".node-version"), "utf8")
      .trim()
      .split(".")[0],
  );
  assert.equal(engineFloor, 24);
  assert.ok(pinMajor >= engineFloor);
});

/**
 * The Node contract is a pair: `engines.node` states a floor, `.node-version`
 * pins the exact runtime, and the floor must be no NEWER than the pin.
 *
 * The comparison is a full normalized triplet, not a major. Comparing majors
 * alone silently accepts `>=24.16.0` against pin `24.15.0` — a floor the repo
 * cannot actually satisfy — while the error text promises the opposite.
 */
function floorTripleOf(range: string): [number, number, number] | null {
  const m = range.match(/^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function pinTriple(): [number, number, number] {
  const [a, b, c] = readFileSync(join(projectDir, ".node-version"), "utf8")
    .trim()
    .split(".");
  return [Number(a), Number(b ?? 0), Number(c ?? 0)];
}

function floorSatisfiedByPin(range: string): boolean {
  const floor = floorTripleOf(range);
  if (!floor) return false; // unparsed ⇒ fail closed
  const pin = pinTriple();
  for (let i = 0; i < 3; i += 1) {
    if (floor[i]! > pin[i]!) return false;
    if (floor[i]! < pin[i]!) return true;
  }
  return true;
}

test("the engine floor parser accepts >=major with an optional minor/patch tail", () => {
  assert.deepEqual(floorTripleOf(">=24"), [24, 0, 0]);
  assert.deepEqual(floorTripleOf(">=24.0"), [24, 0, 0]);
  assert.deepEqual(floorTripleOf(">=24.0.0"), [24, 0, 0]);
});

test("a malformed or non-floor range stays unparsed so the contract fails closed", () => {
  for (const range of ["^24", "~24", "24", ">= 24", ">=v24", ">=24.0.0.0", ""]) {
    assert.equal(floorTripleOf(range), null, `${range} must not yield a floor`);
    assert.equal(floorSatisfiedByPin(range), false, `${range} must fail closed`);
  }
});

test("a floor NEWER than the repository pin is rejected, including same-major", () => {
  // The regression this pins: comparing majors alone accepts both of these.
  assert.equal(floorSatisfiedByPin(">=24.16.0"), false, "a newer minor must be refused");
  assert.equal(floorSatisfiedByPin(">=24.15.1"), false, "a newer patch must be refused");
  assert.equal(floorSatisfiedByPin(">=25"), false, "a newer major must be refused");
});

/**
 * The contract has a second half: the ACTIVE runtime must also satisfy the
 * floor. Comparing majors alone would let v24.14.9 satisfy >=24.15.0 — the same
 * defect as comparing floor to pin by major, one layer down.
 */
function versionTripleOf(version: string): [number, number, number] | null {
  const m = version.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function activeSatisfiesFloor(version: string, floor: string): boolean {
  const cur = versionTripleOf(version);
  const req = floorTripleOf(floor);
  if (!cur || !req) return false; // unparsed ⇒ fail closed
  for (let i = 0; i < 3; i += 1) {
    if (cur[i]! < req[i]!) return false;
    if (cur[i]! > req[i]!) return true;
  }
  return true;
}

test("the active Node version is compared to the floor as a full triplet", () => {
  // The regression this pins: major-only comparison accepts v24.14.9 here.
  assert.equal(activeSatisfiesFloor("v24.14.9", ">=24.15.0"), false, "an older patch line must be refused");
  assert.equal(activeSatisfiesFloor("v24.15.0", ">=24.15.0"), true, "exactly the floor is satisfied");
  assert.equal(activeSatisfiesFloor("v24.15.1", ">=24.15.0"), true, "a newer patch satisfies the floor");
  assert.equal(activeSatisfiesFloor("v23.99.99", ">=24.0.0"), false, "an older major must be refused");
});

test("a malformed active version or floor fails closed", () => {
  // Cases with a VALID triplet prefix and trailing garbage: these are the ones
  // an unanchored regex silently accepts, and the earlier list could not reach
  // because every entry already failed at the prefix.
  for (const v of ["", "v24", "v24.15", "24.15.0", "vX.Y.Z", "v24.15.0garbage", "v24.15.0.1", "v24.15.0-rc.1"]) {
    assert.equal(activeSatisfiesFloor(v, ">=24.0.0"), false, `${v} must fail closed`);
  }
  assert.equal(activeSatisfiesFloor("v24.15.0", "^24"), false, "a malformed floor must fail closed");
});

test("the authoritative floor is satisfied by the repository pin", () => {
  assert.equal(floorSatisfiedByPin(">=24.0.0"), true);
  assert.equal(floorSatisfiedByPin(">=24.15.0"), true, "a floor equal to the pin is satisfiable");
});

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function withFakeBin(run: (root: string, bin: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "raftdev-entry-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  try {
    run(root, bin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withFakeBinAsync(
  run: (root: string, bin: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "raftdev-entry-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  try {
    await run(root, bin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFakeStartTools(bin: string): void {
  writeExecutable(
    join(bin, "docker"),
    `#!/bin/sh
state="$RAFTDEV_FAKE_DOCKER_STATE"
has() { grep -qx "$1" "$state" 2>/dev/null; }
add() { has "$1" || printf '%s\n' "$1" >> "$state"; }
remove() { grep -vx "$1" "$state" > "$state.next" 2>/dev/null || true; mv "$state.next" "$state"; }

case "$1" in
  ps)
    for item in $(cat "$state"); do
      case "$item" in C:*) printf '%s\n' "$item" | sed 's/^C://' ;; esac
    done
    exit 0
    ;;
  inspect)
    name="$4"
    has "C:$name" || exit 1
    case "$*" in
      *Labels*) [ "\${RAFTDEV_FAKE_DOCKER_LABELS:-1}" = "0" ] || printf 'true\n' ;;
    esac
    exit 0
    ;;
  run)
    name=""
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--name" ]; then name="$2"; break; fi
      shift
    done
    [ -z "$name" ] || add "C:$name"
    exit 0
    ;;
  start|exec)
    exit 0
    ;;
  rm)
    remove "C:$3"
    exit 0
    ;;
  volume)
    case "$2" in
      inspect)
        if [ "$3" = "--format" ]; then name="$5"; else name="$3"; fi
        has "V:$name"
        status=$?
        [ "$status" -ne 0 ] || case "$*" in
          *Labels*) [ "\${RAFTDEV_FAKE_DOCKER_LABELS:-1}" = "0" ] || printf 'true\n' ;;
        esac
        exit "$status"
        ;;
      create) add "V:$5" ;;
      ls) for item in $(cat "$state"); do case "$item" in V:*) printf '%s\n' "$item" | sed 's/^V://' ;; esac; done ;;
      rm) remove "V:$3" ;;
    esac
    ;;
  network)
    case "$2" in
      inspect)
        if [ "$3" = "--format" ]; then name="$5"; else name="$3"; fi
        has "N:$name"
        status=$?
        [ "$status" -ne 0 ] || case "$*" in
          *Labels*) [ "\${RAFTDEV_FAKE_DOCKER_LABELS:-1}" = "0" ] || printf 'true\n' ;;
        esac
        exit "$status"
        ;;
      rm) remove "N:$3" ;;
    esac
    ;;
  image)
    exit 1
    ;;
esac
exit 0
`,
  );
  writeExecutable(
    join(bin, "tmux"),
    `#!/bin/sh
if [ -n "\${RAFTDEV_FAKE_TMUX_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$RAFTDEV_FAKE_TMUX_LOG"
fi
state="\${RAFTDEV_FAKE_TMUX_STATE:-}"
has() { grep -qx "$1" "$state" 2>/dev/null; }
add() { has "$1" || printf '%s\n' "$1" >> "$state"; }
remove() { grep -vx "$1" "$state" > "$state.next" 2>/dev/null || true; mv "$state.next" "$state"; }
arg_after() {
  wanted="$1"
  shift
  while [ "$#" -gt 1 ]; do
    if [ "$1" = "$wanted" ]; then printf '%s\n' "$2"; return; fi
    shift
  done
}

case "$1" in
  has-session)
    [ -n "$state" ] || exit 1
    has "$(arg_after -t "$@")"
    exit $?
    ;;
  list-sessions)
    [ -n "$state" ] || exit 1
    cat "$state"
    exit 0
    ;;
  new-session)
    if [ "\${RAFTDEV_FAKE_TMUX_KILL_PARENT:-0}" = "1" ]; then
      kill -KILL "$PPID"
      exit 137
    fi
    status="\${RAFTDEV_FAKE_TMUX_START_EXIT:-0}"
    if [ "$status" -eq 0 ] && [ -n "$state" ]; then
      add "$(arg_after -s "$@")"
    fi
    exit "$status"
    ;;
  list-windows)
    [ -n "$state" ] || exit 1
    has "$(arg_after -t "$@")" || exit 1
    printf '0\n'
    exit 0
    ;;
  kill-session)
    [ -n "$state" ] || exit 1
    remove "$(arg_after -t "$@")"
    exit 0
    ;;
esac
exit 0
`,
  );
  writeExecutable(join(bin, "lsof"), "#!/bin/sh\nexit 1\n");
  writeExecutable(
    join(bin, "npx"),
    `#!/bin/sh
if [ -n "\${RAFTDEV_FAKE_NPX_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$RAFTDEV_FAKE_NPX_LOG"
fi
if [ "$1" = "tsx" ] && [ "$2" = "scripts/seed.ts" ]; then
  if [ "\${RAFTDEV_FAKE_SEED_KILL_PARENT:-0}" = "1" ]; then
    rm -f \${RAFTDEV_FAKE_REMOVE_BEFORE_KILL:-}
    kill -KILL "$PPID"
    exit 137
  fi
  if [ -n "\${RAFTDEV_FAKE_SEED_PAUSE_FILE:-}" ]; then
    : > "$RAFTDEV_FAKE_SEED_PAUSE_FILE"
    while :; do sleep 1; done
  fi
  status="\${RAFTDEV_FAKE_SEED_EXIT:-0}"
  [ "$status" -eq 0 ] && printf '{"apiKey":"fake-machine-key"}\n' > "$4"
  exit "$status"
fi
exit 0
`,
  );
  writeExecutable(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
}

test("raftdev rejects an unsupported Node before loading tsx or touching services", () => {
  withFakeBin((root, bin) => {
    const log = join(root, "node.log");
    writeExecutable(
      join(bin, "node"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$RAFTDEV_FAKE_NODE_LOG"
if [ "$1" = "--version" ]; then
  printf '%s\n' "v18.19.1"
  exit 0
fi
exit 23
`,
    );

    const child = spawnSync(raftdev, ["status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        RAFTDEV_FAKE_NODE_LOG: log,
      },
    });

    assert.equal(child.status, 1);
    assert.match(child.stderr, /Node v18\.19\.1 is unsupported/);
    assert.match(child.stderr, /requires Node >=24/);
    assert.match(child.stderr, /Install\/activate Node 24\.15\.0/);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "--version",
    ]);
  });
});

test("raftdev accepts the supported Node engine floor and preserves implementation exit status", () => {
  withFakeBin((root, bin) => {
    const log = join(root, "node.log");
    writeExecutable(
      join(bin, "node"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$RAFTDEV_FAKE_NODE_LOG"
if [ "$1" = "--version" ]; then
  printf '%s\n' "v24.0.0"
  exit 0
fi
exit 23
`,
    );

    const child = spawnSync(raftdev, ["status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        RAFTDEV_FAKE_NODE_LOG: log,
      },
    });

    assert.equal(child.status, 23);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "--version",
      `--import tsx ${raftdevScript} status`,
    ]);
  });
});

test("raftdev keeps logs in the foreground instead of backgrounding the implementation", () => {
  withFakeBin((root, bin) => {
    const parentLog = join(root, "node-parent.log");
    writeExecutable(
      join(bin, "node"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' "v24.0.0"
  exit 0
fi
printf '%s\n' "$PPID" > "$RAFTDEV_FAKE_NODE_PARENT_LOG"
exit 23
`,
    );

    const child = spawnSync(raftdev, ["logs", "foreground-tooth"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        RAFTDEV_FAKE_NODE_PARENT_LOG: parentLog,
      },
    });

    assert.equal(child.status, 23);
    assert.equal(Number(readFileSync(parentLog, "utf8").trim()), process.pid);
  });
});

test("status reports a container-only environment as partial instead of claiming none exist", () => {
  withFakeBin((_root, bin) => {
    writeExecutable(
      join(bin, "docker"),
      `#!/bin/sh
if [ "$1" = "ps" ]; then
  case "$*" in
    *Status*) printf '  slock-dev-freshbox-pg\tUp 1 minute\t0.0.0.0:15432->5432/tcp\n' ;;
    *) printf 'slock-dev-freshbox-pg\n' ;;
  esac
  exit 0
fi
exit 1
`,
    );
    writeExecutable(join(bin, "tmux"), "#!/bin/sh\nexit 1\n");

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", raftdevScript, "status"],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Environment 'freshbox':/);
    assert.match(child.stdout, /Runtime\s+: partial\/orphan/);
    assert.match(child.stdout, /Recovery\s+: \.\/raftdev stop freshbox/);
    assert.doesNotMatch(child.stdout, /No active environments/);
  });
});

test("status reports a tmux-only environment as partial instead of healthy", () => {
  withFakeBin((_root, bin) => {
    writeExecutable(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
    writeExecutable(
      join(bin, "tmux"),
      `#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf 'slock-status-tmuxonly-tooth\n'
  exit 0
fi
exit 1
`,
    );

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", raftdevScript, "status"],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Environment 'status-tmuxonly-tooth':/);
    assert.match(
      child.stdout,
      /Runtime\s+: partial\/orphan \(tmux session present; 0\/3 required services ready; 0 Docker residue\(s\)\)/,
    );
    assert.match(
      child.stdout,
      /Recovery\s+: \.\/raftdev stop status-tmuxonly-tooth/,
    );
    assert.doesNotMatch(child.stdout, /Runtime\s+: running/);
  });
});

test("status accepts a listening external Redis with running PostgreSQL and RustFS", () => {
  withFakeBin((_root, bin) => {
    writeExecutable(
      join(bin, "docker"),
      `#!/bin/sh
if [ "$1" = "ps" ]; then
  case "$*" in
    *" -a "*)
      printf 'slock-dev-status-external-redis-pg\tUp 1 minute\t\n'
      printf 'slock-dev-status-external-redis-rustfs\tUp 1 minute\t\n'
      ;;
    *)
      printf 'slock-dev-status-external-redis-pg\n'
      printf 'slock-dev-status-external-redis-rustfs\n'
      ;;
  esac
  exit 0
fi
exit 1
`,
    );
    writeExecutable(
      join(bin, "tmux"),
      `#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf 'slock-status-external-redis\n'
  exit 0
fi
exit 1
`,
    );
    writeExecutable(
      join(bin, "lsof"),
      "#!/bin/sh\nprintf 'redis-listener\\n'\n",
    );

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", raftdevScript, "status"],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Environment 'status-external-redis':/);
    assert.match(
      child.stdout,
      /Runtime\s+: running \(tmux session \+ required services ready; Redis external\)/,
    );
    assert.doesNotMatch(child.stdout, /Recovery\s+:/);
  });
});

test("status reports stopped required containers as partial instead of healthy", () => {
  withFakeBin((_root, bin) => {
    writeExecutable(
      join(bin, "docker"),
      `#!/bin/sh
if [ "$1" = "ps" ]; then
  case "$*" in
    *" -a "*)
      printf 'slock-dev-status-stopped-pg\tExited (0) 1 minute ago\t\n'
      printf 'slock-dev-status-stopped-redis\tExited (0) 1 minute ago\t\n'
      printf 'slock-dev-status-stopped-rustfs\tExited (0) 1 minute ago\t\n'
      ;;
  esac
  exit 0
fi
exit 1
`,
    );
    writeExecutable(
      join(bin, "tmux"),
      `#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf 'slock-status-stopped\n'
  exit 0
fi
exit 1
`,
    );

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", raftdevScript, "status"],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Environment 'status-stopped':/);
    assert.match(
      child.stdout,
      /Runtime\s+: partial\/orphan \(tmux session present; 0\/3 required services ready; 3 Docker residue\(s\)\)/,
    );
    assert.match(child.stdout, /Recovery\s+: \.\/raftdev stop status-stopped/);
    assert.doesNotMatch(child.stdout, /Runtime\s+: running/);
  });
});

test("status discovers a managed volume-only environment as partial residue", () => {
  withFakeBin((_root, bin) => {
    writeExecutable(
      join(bin, "docker"),
      `#!/bin/sh
case "$1:$2" in
  volume:ls) printf 'slock-dev-status-volume-only-rustfs-data\n' ;;
  volume:inspect) printf 'true\n' ;;
esac
exit 0
`,
    );
    writeExecutable(join(bin, "tmux"), "#!/bin/sh\nexit 1\n");

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", raftdevScript, "status"],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Environment 'status-volume-only':/);
    assert.match(
      child.stdout,
      /Runtime\s+: partial\/orphan \(no tmux session; 0\/3 required services ready; 1 Docker residue\(s\)\)/,
    );
    assert.match(
      child.stdout,
      /Recovery\s+: \.\/raftdev stop status-volume-only/,
    );
  });
});

test("status discovers a managed network-only environment as partial residue", () => {
  withFakeBin((_root, bin) => {
    writeExecutable(
      join(bin, "docker"),
      `#!/bin/sh
case "$1:$2" in
  network:ls) printf 'slock-dev-status-network-only-risingwave-net\n' ;;
  network:inspect) printf 'true\n' ;;
esac
exit 0
`,
    );
    writeExecutable(join(bin, "tmux"), "#!/bin/sh\nexit 1\n");

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", raftdevScript, "status"],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Environment 'status-network-only':/);
    assert.match(
      child.stdout,
      /Runtime\s+: partial\/orphan \(no tmux session; 0\/3 required services ready; 1 Docker residue\(s\)\)/,
    );
    assert.match(
      child.stdout,
      /Recovery\s+: \.\/raftdev stop status-network-only/,
    );
  });
});

test("a seed failure preserves its exit code and removes every managed resource from the partial start", () => {
  withFakeBin((root, bin) => {
    const state = join(root, "docker.state");
    writeFileSync(state, "");
    writeFakeStartTools(bin);

    try {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", raftdevScript, "start", "cleanup-tooth"],
        {
          cwd: projectDir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            RAFTDEV_FAKE_DOCKER_STATE: state,
            RAFTDEV_FAKE_SEED_EXIT: "7",
            SLOCKDEV_TRACE_WORKER: "0",
            SLOCKDEV_TUNNEL: "0",
            SLOCKDEV_IDLE_TTL_SECONDS: "0",
          },
        },
      );

      assert.equal(child.status, 7, `${child.stdout}\n${child.stderr}`);
      assert.match(child.stdout, /Seeding test data/);
      assert.match(
        child.stdout,
        /Start failed; cleaning partial environment 'cleanup-tooth'/,
      );
      assert.match(child.stdout, /Partial environment cleanup complete/);
      assert.equal(readFileSync(state, "utf8").trim(), "");
    } finally {
      rmSync(join(projectDir, ".slockdev", "cleanup-tooth"), {
        recursive: true,
        force: true,
      });
    }
  });
});

test("a successful start disarms failure cleanup and retains its owned environment", () => {
  withFakeBin((root, bin) => {
    const dockerState = join(root, "docker.state");
    const tmuxState = join(root, "tmux.state");
    const environmentName = "success-retention-tooth";
    const environmentDir = join(projectDir, ".slockdev", environmentName);
    const seedFile = join(projectDir, `.dev-env-${environmentName}.json`);
    writeFileSync(dockerState, "");
    writeFileSync(tmuxState, "");
    writeFakeStartTools(bin);

    try {
      const child = spawnSync(raftdev, ["start", environmentName], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RAFTDEV_FAKE_DOCKER_STATE: dockerState,
          RAFTDEV_FAKE_TMUX_STATE: tmuxState,
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_TUNNEL: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      });

      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      assert.match(
        child.stdout,
        /=== Environment 'success-retention-tooth' is running ===/,
      );
      assert.doesNotMatch(child.stdout, /Start failed; cleaning/);
      assert.deepEqual(
        new Set(readFileSync(dockerState, "utf8").trim().split("\n")),
        new Set([
          `C:slock-dev-${environmentName}-pg`,
          `C:slock-dev-${environmentName}-redis`,
          `C:slock-dev-${environmentName}-rustfs`,
          `V:slock-dev-${environmentName}-rustfs-data`,
        ]),
      );
      assert.equal(
        readFileSync(tmuxState, "utf8").trim(),
        `slock-${environmentName}`,
      );
      assert.equal(existsSync(seedFile), true);
      assert.equal(existsSync(join(environmentDir, "last-activity")), true);
      assert.equal(existsSync(join(environmentDir, "idle-ttl-seconds")), true);
    } finally {
      rmSync(environmentDir, { recursive: true, force: true });
      rmSync(seedFile, { force: true });
    }
  });
});

test("start --with-onboarding forwards the deliberate fresh-owner fixture to seed", () => {
  withFakeBin((root, bin) => {
    const dockerState = join(root, "docker.state");
    const tmuxState = join(root, "tmux.state");
    const npxLog = join(root, "npx.log");
    const environmentName = "with-onboarding-tooth";
    const environmentDir = join(projectDir, ".slockdev", environmentName);
    const seedFile = join(projectDir, `.dev-env-${environmentName}.json`);
    writeFileSync(dockerState, "");
    writeFileSync(tmuxState, "");
    writeFakeStartTools(bin);

    try {
      const child = spawnSync(raftdev, ["start", environmentName, "--with-onboarding"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RAFTDEV_FAKE_DOCKER_STATE: dockerState,
          RAFTDEV_FAKE_TMUX_STATE: tmuxState,
          RAFTDEV_FAKE_NPX_LOG: npxLog,
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_TUNNEL: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      });

      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      assert.match(
        readFileSync(npxLog, "utf8"),
        new RegExp(`tsx scripts/seed\\.ts --output .*\\.dev-env-${environmentName}\\.json --with-onboarding`),
      );
    } finally {
      rmSync(environmentDir, { recursive: true, force: true });
      rmSync(seedFile, { force: true });
    }
  });
});

test("start forwards the managed MCP credential key to the server process", () => {
  withFakeBin((root, bin) => {
    const dockerState = join(root, "docker.state");
    const tmuxState = join(root, "tmux.state");
    const tmuxLog = join(root, "tmux.log");
    const environmentName = "managed-mcp-key-tooth";
    const environmentDir = join(projectDir, ".slockdev", environmentName);
    const seedFile = join(projectDir, `.dev-env-${environmentName}.json`);
    const credentialKey = "test-managed-mcp-key-not-a-real-secret";
    writeFileSync(dockerState, "");
    writeFileSync(tmuxState, "");
    writeFakeStartTools(bin);

    try {
      const child = spawnSync(raftdev, ["start", environmentName], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RAFTDEV_FAKE_DOCKER_STATE: dockerState,
          RAFTDEV_FAKE_TMUX_STATE: tmuxState,
          RAFTDEV_FAKE_TMUX_LOG: tmuxLog,
          SLOCK_MCP_CREDENTIAL_KEY: credentialKey,
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_TUNNEL: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      });

      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      const launchCommands = readFileSync(tmuxLog, "utf8");
      assert.match(
        launchCommands,
        new RegExp(`(?:^|\\s)SLOCK_MCP_CREDENTIAL_KEY=${credentialKey}(?:\\s|$)`),
      );
    } finally {
      rmSync(environmentDir, { recursive: true, force: true });
      rmSync(seedFile, { force: true });
    }
  });
});

test("a required tmux launch failure is not reported as running and is cleaned", () => {
  withFakeBin((root, bin) => {
    const state = join(root, "docker.state");
    const environmentName = "tmux-failure-tooth";
    writeFileSync(state, "");
    writeFakeStartTools(bin);

    try {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", raftdevScript, "start", environmentName],
        {
          cwd: projectDir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            RAFTDEV_FAKE_DOCKER_STATE: state,
            RAFTDEV_FAKE_TMUX_START_EXIT: "9",
            SLOCKDEV_TRACE_WORKER: "0",
            SLOCKDEV_TUNNEL: "0",
            SLOCKDEV_IDLE_TTL_SECONDS: "0",
          },
        },
      );

      assert.equal(child.status, 9, `${child.stdout}\n${child.stderr}`);
      assert.match(
        child.stdout,
        /ERROR: Failed to create required tmux window 'server'/,
      );
      assert.doesNotMatch(
        child.stdout,
        /Environment 'tmux-failure-tooth' is running/,
      );
      assert.match(child.stdout, /Partial environment cleanup complete/);
      assert.equal(readFileSync(state, "utf8").trim(), "");
    } finally {
      rmSync(join(projectDir, ".slockdev", environmentName), {
        recursive: true,
        force: true,
      });
      rmSync(join(projectDir, `.dev-env-${environmentName}.json`), {
        force: true,
      });
    }
  });
});

test("fresh-process fallback uses captured ownership and stops the current-run tunnel", () => {
  withFakeBin((root, bin) => {
    const state = join(root, "docker.state");
    const tunnelStopped = join(root, "tunnel.stopped");
    const environmentName = "legacy-cleanup-tooth";
    const seedFile = join(projectDir, `.dev-env-${environmentName}.json`);
    const environmentDir = join(projectDir, ".slockdev", environmentName);
    const risingWaveStateFile = join(environmentDir, "risingwave-state.json");
    writeFileSync(
      state,
      [
        `C:slock-dev-${environmentName}-pg`,
        `C:slock-dev-${environmentName}-redis`,
        `C:slock-dev-${environmentName}-rustfs`,
        `C:slock-dev-${environmentName}-risingwave`,
        `V:slock-dev-${environmentName}-rustfs-data`,
        `N:slock-dev-${environmentName}-risingwave-net`,
      ].join("\n") + "\n",
    );
    writeFakeStartTools(bin);
    writeExecutable(
      join(bin, "cloudflared"),
      `#!/bin/sh
printf 'https://fake-tunnel.trycloudflare.com\n'
trap ': > "$RAFTDEV_FAKE_TUNNEL_STOPPED"; exit 0' TERM
while :; do sleep 1; done
`,
    );
    mkdirSync(environmentDir, { recursive: true });
    writeFileSync(
      seedFile,
      JSON.stringify({
        server: { id: "legacy-server" },
        user: { id: "legacy-user" },
        apiKey: "legacy-machine-key",
      }),
    );
    writeFileSync(
      risingWaveStateFile,
      JSON.stringify({
        schemaVersion: 1,
        mode: "local",
        profile: "full",
        status: "serving-ready",
        managed: true,
        databaseName: "dev",
      }),
    );

    try {
      const child = spawnSync(raftdev, ["start", environmentName], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RAFTDEV_FAKE_DOCKER_STATE: state,
          RAFTDEV_FAKE_DOCKER_LABELS: "0",
          RAFTDEV_FAKE_TMUX_KILL_PARENT: "1",
          RAFTDEV_FAKE_TUNNEL_STOPPED: tunnelStopped,
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      });

      assert.equal(child.status, 137, `${child.stdout}\n${child.stderr}`);
      assert.match(
        child.stdout,
        /Start failed; cleaning partial environment 'legacy-cleanup-tooth'/,
      );
      assert.match(child.stdout, /Partial environment cleanup complete/);
      assert.doesNotMatch(child.stdout, /Unowned .* preserved/);
      assert.doesNotMatch(child.stdout, /External\/unmanaged .* preserved/);
      assert.match(child.stdout, /Cloudflared process \d+ stopped/);
      assert.equal(readFileSync(state, "utf8").trim(), "");
      for (
        let attempt = 0;
        attempt < 20 && !existsSync(tunnelStopped);
        attempt++
      ) {
        spawnSync("sleep", ["0.05"]);
      }
      assert.equal(existsSync(tunnelStopped), true, child.stdout);
    } finally {
      rmSync(environmentDir, { recursive: true, force: true });
      rmSync(seedFile, { force: true });
    }
  });
});

test("SIGTERM during a blocked start exits 143 and cleans managed partial resources", async () => {
  await withFakeBinAsync(async (root, bin) => {
    await new Promise<void>((resolve, reject) => {
      const state = join(root, "docker.state");
      const pauseFile = join(root, "seed.paused");
      const environmentName = "signal-cleanup-tooth";
      writeFileSync(state, "");
      writeFakeStartTools(bin);

      const child = spawn(raftdev, ["start", environmentName], {
        cwd: projectDir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RAFTDEV_FAKE_DOCKER_STATE: state,
          RAFTDEV_FAKE_SEED_PAUSE_FILE: pauseFile,
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_TUNNEL: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const deadline = Date.now() + 5_000;
      const waitForSeed = (): void => {
        if (existsSync(pauseFile)) {
          child.kill("SIGTERM");
          return;
        }
        if (Date.now() >= deadline) {
          child.kill("SIGKILL");
          reject(
            new Error(`start never reached seed pause\n${stdout}\n${stderr}`),
          );
          return;
        }
        setTimeout(waitForSeed, 20);
      };
      waitForSeed();

      child.once("error", reject);
      child.once("close", (code, signal) => {
        try {
          assert.equal(signal, null, `${stdout}\n${stderr}`);
          assert.equal(code, 143, `${stdout}\n${stderr}`);
          assert.match(
            stdout,
            /Start failed; cleaning partial environment 'signal-cleanup-tooth'/,
          );
          assert.match(stdout, /Partial environment cleanup complete/);
          assert.equal(readFileSync(state, "utf8").trim(), "");
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          rmSync(join(projectDir, ".slockdev", environmentName), {
            recursive: true,
            force: true,
          });
          rmSync(join(projectDir, `.dev-env-${environmentName}.json`), {
            force: true,
          });
        }
      });
    });
  });
});

test("SIGHUP during a blocked start exits 129 and cleans managed partial resources", async () => {
  await withFakeBinAsync(async (root, bin) => {
    await new Promise<void>((resolve, reject) => {
      const state = join(root, "docker.state");
      const pauseFile = join(root, "seed.paused");
      const environmentName = "hangup-cleanup-tooth";
      writeFileSync(state, "");
      writeFakeStartTools(bin);

      const child = spawn(raftdev, ["start", environmentName], {
        cwd: projectDir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RAFTDEV_FAKE_DOCKER_STATE: state,
          RAFTDEV_FAKE_SEED_PAUSE_FILE: pauseFile,
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_TUNNEL: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const deadline = Date.now() + 5_000;
      const waitForSeed = (): void => {
        if (existsSync(pauseFile)) {
          child.kill("SIGHUP");
          return;
        }
        if (Date.now() >= deadline) {
          child.kill("SIGKILL");
          reject(
            new Error(`start never reached seed pause\n${stdout}\n${stderr}`),
          );
          return;
        }
        setTimeout(waitForSeed, 20);
      };
      waitForSeed();

      child.once("error", reject);
      child.once("close", (code, signal) => {
        try {
          assert.equal(signal, null, `${stdout}\n${stderr}`);
          assert.equal(code, 129, `${stdout}\n${stderr}`);
          assert.match(
            stdout,
            /Start failed; cleaning partial environment 'hangup-cleanup-tooth'/,
          );
          assert.match(stdout, /Partial environment cleanup complete/);
          assert.equal(readFileSync(state, "utf8").trim(), "");
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          rmSync(join(projectDir, ".slockdev", environmentName), {
            recursive: true,
            force: true,
          });
          rmSync(join(projectDir, `.dev-env-${environmentName}.json`), {
            force: true,
          });
        }
      });
    });
  });
});
