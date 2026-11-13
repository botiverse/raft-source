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
import { fileURLToPath } from "node:url";

import { computeOffset, janitorStopCommand, replicaServerPort, waitForQueryReady, webWindowCommand } from "./raftdev";

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
  // Derived from the pin so a routine Node bump does not have to edit this test.
  const [major, minor, patch] = pinTriple();
  assert.equal(floorSatisfiedByPin(`>=${major}.${minor + 1}.0`), false, "a newer minor must be refused");
  assert.equal(floorSatisfiedByPin(`>=${major}.${minor}.${patch + 1}`), false, "a newer patch must be refused");
  assert.equal(floorSatisfiedByPin(`>=${major + 1}`), false, "a newer major must be refused");
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
  const [major, minor, patch] = pinTriple();
  assert.equal(floorSatisfiedByPin(">=24.0.0"), true);
  assert.equal(floorSatisfiedByPin(`>=${major}.${minor}.${patch}`), true, "a floor equal to the pin is satisfiable");
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
  info)
    if [ "\${RAFTDEV_FAKE_DOCKER_INFO_EXIT:-0}" != "0" ]; then
      printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n' >&2
      exit "$RAFTDEV_FAKE_DOCKER_INFO_EXIT"
    fi
    printf '29.0.0\n'
    exit 0
    ;;
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
  start)
    exit 0
    ;;
  exec)
    # raftdev's migration-state probe of Postgres: "<public tables>,<has
    # drizzle.__drizzle_migrations>", then that table's row count.
    case "$*" in
      *pg_tables*) printf '%s\n' "\${RAFTDEV_FAKE_PG_SCHEMA:-0,false}" ;;
      *"FROM drizzle.__drizzle_migrations"*) printf '%s\n' "\${RAFTDEV_FAKE_PG_APPLIED:-0}" ;;
    esac
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
    join(bin, "pnpm"),
    `#!/bin/sh
if [ -n "\${RAFTDEV_FAKE_PNPM_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$RAFTDEV_FAKE_PNPM_LOG"
fi
if [ "$1" = "exec" ] && [ "$5" = "\${RAFTDEV_FAKE_FAIL_SCRIPT:-}" ]; then
  exit 9
fi
if [ "$1" = "exec" ] && [ "$5" = "scripts/seed.ts" ]; then
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
  [ "$status" -eq 0 ] && printf '{"apiKey":"fake-machine-key"}\n' > "$7"
  exit "$status"
fi
exit 0
`,
  );
  writeExecutable(join(bin, "npx"), "#!/bin/sh\nexit 0\n");
}

test("raftdev rejects an unsupported Node before loading the TS loader or touching services", () => {
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
    const pin = readFileSync(join(projectDir, ".node-version"), "utf8").trim();
    assert.ok(child.stderr.includes(`Install/activate Node ${pin}`), "raftdev must recommend the pinned Node");
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
      `--import @oxc-node/core/register ${raftdevScript} status`,
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
      ["--import", "@oxc-node/core/register", raftdevScript, "status"],
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
      ["--import", "@oxc-node/core/register", raftdevScript, "status"],
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

// The C-c that `stop` sends can end the session before kill-session runs; a
// session that is gone is stopped. One that is still there is not.
for (const outcome of ["gone", "alive"] as const) {
  test(`stop after kill-session fails: session ${outcome}`, () => {
    withFakeBin((root, bin) => {
      writeExecutable(join(bin, "docker"), "#!/bin/sh\n[ \"$1\" = network ] && exit 1\nexit 0\n");
      writeExecutable(
        join(bin, "tmux"),
        `#!/bin/sh
case "$1" in
  has-session) [ -e "${root}/gone" ] && exit 1; exit 0 ;;
  list-windows) printf 'server\\n'; exit 0 ;;
  send-keys) exit 0 ;;
  kill-session)
    ${outcome === "gone" ? `touch "${root}/gone"` : ":"}
    echo "kill-session failed" >&2
    exit 1 ;;
esac
exit 1
`,
      );

      const child = spawnSync(
        process.execPath,
        ["--import", "@oxc-node/core/register", raftdevScript, "stop", `stop-race-${outcome}`],
        {
          cwd: projectDir,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        },
      );

      if (outcome === "gone") {
        assert.equal(child.status, 0, child.stdout + child.stderr);
        assert.match(child.stdout, /tmux session 'slock-stop-race-gone' stopped\./);
        assert.match(child.stdout, /Done\./);
      } else {
        assert.equal(child.status, 1, child.stdout + child.stderr);
        assert.match(child.stdout, /ERROR: Failed to stop tmux session 'slock-stop-race-alive'\./);
      }
    });
  });
}

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
      ["--import", "@oxc-node/core/register", raftdevScript, "status"],
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
      /Runtime\s+: running \(tmux session \+ required services ready; application ports listening; Redis external\)/,
    );
    assert.doesNotMatch(child.stdout, /Recovery\s+:/);
  });
});

// A surviving tmux shell/watch parent and healthy backing containers do not
// imply that the API or web child still has a listening socket.
for (const missing of ["server", "web", "server-2", "none"] as const) {
  test(`status checks application listeners with surviving tmux: ${missing}`, () => {
    withFakeBin((_root, bin) => {
      const offset = computeOffset("liveness");
      const e = { OFFSET: offset, SERVER_PORT: 13001 + offset, WEB_PORT: 15173 + offset };
      const ports = { server: e.SERVER_PORT, web: e.WEB_PORT, "server-2": replicaServerPort(e.OFFSET, 2) };
      writeExecutable(join(bin, "docker"), `#!/bin/sh
[ "$1" = ps ] || exit 1
printf '%s\\n' slock-dev-liveness-pg slock-dev-liveness-redis slock-dev-liveness-rustfs
`);
      writeExecutable(join(bin, "tmux"), `#!/bin/sh
case "$1" in
  list-sessions) printf 'slock-liveness\\n' ;;
  list-windows) printf 'server\\nweb\\nserver-2\\n' ;;
  *) exit 1 ;;
esac
`);
      writeExecutable(join(bin, "lsof"), `#!/bin/sh
${missing === "none" ? "" : `[ "$1" != "-iTCP:${ports[missing]}" ] || exit 1`}
printf 'listener\\n'
`);
      const child = spawnSync(process.execPath,
        ["--import", "@oxc-node/core/register", raftdevScript, "status"], {
          cwd: projectDir, encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
      assert.equal(child.status, 0, child.stderr);
      if (missing === "none") {
        assert.match(child.stdout, /Runtime\s+: running .*application ports listening/);
        assert.doesNotMatch(child.stdout, /Recovery\s+:/);
      } else {
        assert.match(child.stdout, /Runtime\s+: partial\/orphan/);
        assert.doesNotMatch(child.stdout, /Runtime\s+: running/);
        assert.ok(child.stdout.includes(`${missing} :${ports[missing]} (no listener detected)`), child.stdout);
        assert.match(child.stdout, /Recovery\s+: \.\/raftdev stop liveness/);
      }
    });
  });
}

test("start with a stale tmux session reports no start and missing API without mutating it", () => {
  withFakeBin((root, bin) => {
    const offset = computeOffset("liveness");
    const e = { SERVER_PORT: 13001 + offset, WEB_PORT: 15173 + offset };
    const log = join(root, "mutations");
    writeExecutable(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
exit 1
`);
    writeExecutable(join(bin, "tmux"), `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  list-windows) printf 'server\\nweb\\n' ;;
  *) printf '%s\\n' "$*" >> '${log}'; exit 1 ;;
esac
`);
    writeExecutable(join(bin, "lsof"), `#!/bin/sh
[ "$1" = "-iTCP:${e.WEB_PORT}" ] || exit 1
printf 'web-listener\\n'
`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawnSync(process.execPath,
        ["--import", "@oxc-node/core/register", raftdevScript, "start", "liveness"], {
          cwd: projectDir, encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, SLOCKDEV_TUNNEL: "0" },
        });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stdout, /tmux session already exists; no processes were started/);
      assert.doesNotMatch(child.stdout, /already running/);
      assert.ok(child.stdout.includes(`server :${e.SERVER_PORT} (no listener detected)`), child.stdout);
      assert.match(child.stdout, /Stop:.*raftdev stop liveness/);
    }
    assert.equal(existsSync(log), false, "status rejection must not stop/respawn or touch Docker");
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
      ["--import", "@oxc-node/core/register", raftdevScript, "status"],
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
      ["--import", "@oxc-node/core/register", raftdevScript, "status"],
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
      ["--import", "@oxc-node/core/register", raftdevScript, "status"],
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
        ["--import", "@oxc-node/core/register", raftdevScript, "start", "cleanup-tooth"],
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
            // Backend-only start (fake Docker cannot run RisingWave).
            RAFTDEV_RISINGWAVE: "0",
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

test("start refuses an unreachable Docker daemon before any port check or container", () => {
  withFakeBin((root, bin) => {
    const state = join(root, "docker.state");
    writeFileSync(state, "");
    writeFakeStartTools(bin);
    const child = spawnSync(
      process.execPath,
      ["--import", "@oxc-node/core/register", raftdevScript, "start", "daemon-down", "--no-risingwave"],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RAFTDEV_FAKE_DOCKER_STATE: state,
          RAFTDEV_FAKE_DOCKER_INFO_EXIT: "1",
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_TUNNEL: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      },
    );
    assert.equal(child.status, 1, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /needs a reachable Docker daemon/);
    assert.match(child.stdout, /Cannot connect to the Docker daemon/);
    assert.match(child.stdout, /No containers or local processes were started/);
    assert.equal(readFileSync(state, "utf8").trim(), "");
    rmSync(join(projectDir, ".slockdev", "daemon-down"), { recursive: true, force: true });
  });
});

test("Postgres readiness waits for a passing query and reports the last error at the deadline", () => {
  let clock = 0;
  let probes = 0;
  const failing = waitForQueryReady({
    timeoutMs: 3_000,
    probe: () => { probes += 1; return { ok: false, error: `refused ${probes}` }; },
    now: () => clock,
    sleep: () => { clock += 1_000; },
  });
  assert.deepEqual(failing, { ready: false, lastError: "refused 4" });

  clock = 0;
  probes = 0;
  const passing = waitForQueryReady({
    timeoutMs: 3_000,
    probe: () => { probes += 1; return probes < 3 ? { ok: false, error: "refused" } : { ok: true, error: "" }; },
    now: () => clock,
    sleep: () => { clock += 1_000; },
  });
  assert.deepEqual(passing, { ready: true, lastError: "" });
  assert.equal(probes, 3);
});

function startWithFakeDatabase(name: string, env: Record<string, string>): { status: number | null; stdout: string; pnpmLog: string; dockerState: string } {
  let result: { status: number | null; stdout: string; pnpmLog: string; dockerState: string } | undefined;
  withFakeBin((root, bin) => {
    const dockerState = join(root, "docker.state");
    const pnpmLog = join(root, "pnpm.log");
    writeFileSync(dockerState, "");
    writeFileSync(pnpmLog, "");
    writeFakeStartTools(bin);
    try {
      const child = spawnSync(raftdev, ["start", name, "--no-risingwave"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RAFTDEV_FAKE_DOCKER_STATE: dockerState,
          RAFTDEV_FAKE_PNPM_LOG: pnpmLog,
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_TUNNEL: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
          ...env,
        },
      });
      result = {
        status: child.status,
        stdout: `${child.stdout}\n${child.stderr}`,
        pnpmLog: readFileSync(pnpmLog, "utf8"),
        dockerState: readFileSync(dockerState, "utf8").trim(),
      };
    } finally {
      rmSync(join(projectDir, ".slockdev", name), { recursive: true, force: true });
      rmSync(join(projectDir, `.dev-env-${name}.json`), { force: true });
    }
  });
  return result!;
}

test("start builds Postgres with the deploy migrator and its index steps before seeding", () => {
  const run = startWithFakeDatabase("migrate-order-tooth", { RAFTDEV_FAKE_SEED_EXIT: "7" });
  assert.equal(run.status, 7, run.stdout);
  const scripts = run.pnpmLog.split("\n").filter((line) => line.startsWith("exec node")).map((line) => line.split(" ")[4]);
  const migrate = scripts.indexOf("scripts/migrate-deploy.ts");
  const verify = scripts.indexOf("scripts/verify-post-migration-indexes.ts");
  const seed = scripts.indexOf("scripts/seed.ts");
  assert.ok(migrate !== -1 && migrate < verify && verify < seed, run.pnpmLog);
  assert.ok(!scripts.includes("scripts/migration-preflight.ts"), run.pnpmLog);
  assert.doesNotMatch(run.pnpmLog, /drizzle-kit|apply-change-log/);
  assert.match(run.stdout, /Migrating database from empty\.\.\.[\s\S]*Database migrated \(/);
  // --no-risingwave: no RisingWave container, and the opt-out names what breaks.
  assert.match(run.stdout, /RisingWave : disabled \(--no-risingwave\)/);
  assert.match(run.stdout, /Activity endpoints \(inbox, followed threads, unread summary, channel unread\)\s+will return 503/);
  assert.doesNotMatch(run.stdout, /Creating RisingWave/);
});

test("a failed migration step stops start before seeding, without reporting a migrated database", () => {
  const run = startWithFakeDatabase("migrate-failure-tooth", { RAFTDEV_FAKE_FAIL_SCRIPT: "scripts/migrate-deploy.ts" });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /ERROR: Database migration step scripts\/migrate-deploy\.ts failed \(exit 9\)/);
  assert.doesNotMatch(run.stdout, /Database migrated|Schema is up to date|Seeding test data/);
  assert.doesNotMatch(run.pnpmLog, /scripts\/seed\.ts|verify-post-migration-indexes/);
  assert.match(run.stdout, /Partial environment cleanup complete/);
  assert.equal(run.dockerState, "");
});

test("a failed post-migration index check also stops start before seeding", () => {
  const run = startWithFakeDatabase("migrate-index-failure-tooth", { RAFTDEV_FAKE_FAIL_SCRIPT: "scripts/verify-post-migration-indexes.ts" });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /ERROR: Database migration step scripts\/verify-post-migration-indexes\.ts failed/);
  assert.doesNotMatch(run.stdout, /Database migrated|Seeding test data/);
});

test("start refuses a Postgres built by drizzle-kit push and names the command that recreates it", () => {
  const run = startWithFakeDatabase("pushed-db-tooth", { RAFTDEV_FAKE_PG_SCHEMA: "307,false" });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /ERROR: Postgres in 'slock-dev-pushed-db-tooth-pg' was built by `drizzle-kit push`/);
  assert.match(run.stdout, /Recovery: \.\/raftdev stop pushed-db-tooth && \.\/raftdev start pushed-db-tooth/);
  assert.doesNotMatch(run.pnpmLog, /scripts\/(migrate-deploy|seed)\.ts/);
  assert.doesNotMatch(run.stdout, /Database migrated|Seeding test data/);
});

test("start on an already migrated Postgres applies only pending migrations", () => {
  const run = startWithFakeDatabase("migrated-db-tooth", { RAFTDEV_FAKE_PG_SCHEMA: "318,true", RAFTDEV_FAKE_PG_APPLIED: "508", RAFTDEV_FAKE_SEED_EXIT: "7" });
  assert.equal(run.status, 7, run.stdout);
  assert.match(run.stdout, /Applying pending database migrations\.\.\.[\s\S]*Database migrated \(/);
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
          // Backend-only start (fake Docker cannot run RisingWave).
          RAFTDEV_RISINGWAVE: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      });

      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      assert.match(
        child.stdout,
        /=== Environment 'success-retention-tooth' is running ===/,
      );
      // RAFTDEV_RISINGWAVE=0: the final summary repeats the 503 warning.
      assert.match(
        child.stdout.slice(child.stdout.indexOf("is running ===")),
        /RisingWave: disabled \(--no-risingwave\)[\s\S]*will return 503/,
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
    const pnpmLog = join(root, "pnpm.log");
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
          RAFTDEV_FAKE_PNPM_LOG: pnpmLog,
          SLOCKDEV_TRACE_WORKER: "0",
          SLOCKDEV_TUNNEL: "0",
          // Backend-only start (fake Docker cannot run RisingWave).
          RAFTDEV_RISINGWAVE: "0",
          SLOCKDEV_IDLE_TTL_SECONDS: "0",
        },
      });

      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      assert.match(
        readFileSync(pnpmLog, "utf8"),
        new RegExp(`exec node --import @oxc-node/core/register scripts/seed\\.ts --output .*\\.dev-env-${environmentName}\\.json --with-onboarding`),
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
          // Backend-only start (fake Docker cannot run RisingWave).
          RAFTDEV_RISINGWAVE: "0",
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

test("the web window pre-bundles Vite deps in a separate process, then starts the dev server with the same env", () => {
  const env = "VITE_DEV_PORT=15221 VITE_SLOCKDEV_ENV_NAME='a b' ";
  const command = webWindowCommand(env);
  assert.ok(command.includes(`; ${env}pnpm --filter @botiverse/raft-web exec vite optimize; `), command);
  assert.ok(command.includes(`${env}pnpm --filter @botiverse/raft-web dev; fi`), command);
  const run = (optimizeExit: number | "interrupted") => {
    const bin = mkFakeBin(optimizeExit);
    const result = spawnSync("bash", ["-c", webWindowCommand("").replaceAll("pnpm --filter @botiverse/raft-web", "fake")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    rmSync(bin, { recursive: true, force: true });
    return { stdout: result.stdout, status: result.status };
  };
  // The window's exit status is the dev server's.
  assert.deepEqual(run(0), { stdout: "exec vite optimize\ndev\n", status: 7 });
  // A failed optimize is not fatal: the dev server pre-bundles itself.
  assert.deepEqual(run(1), {
    stdout: "exec vite optimize\n[raftdev] vite optimize failed; the dev server will pre-bundle dependencies itself\ndev\n",
    status: 7,
  });
  // Ctrl-C during optimize stops the window instead of starting the dev server.
  // pnpm exits 1 on SIGINT, so this is told apart by the interrupt, not the status.
  assert.deepEqual(run("interrupted"), { stdout: "exec vite optimize\n", status: 130 });
});

function mkFakeBin(optimizeExit: number | "interrupted"): string {
  const dir = mkdtempSync(join(tmpdir(), "raftdev-web-window-"));
  const exit = optimizeExit === "interrupted" ? "kill -INT $PPID; exit 1" : `exit ${optimizeExit}`;
  writeFileSync(join(dir, "fake"), `#!/bin/sh\necho "$*"\n[ "$1" = dev ] && exit 7\n${exit}\n`);
  chmodSync(join(dir, "fake"), 0o755);
  return dir;
}

test("a required tmux launch failure is not reported as running and is cleaned", () => {
  withFakeBin((root, bin) => {
    const state = join(root, "docker.state");
    const environmentName = "tmux-failure-tooth";
    writeFileSync(state, "");
    writeFakeStartTools(bin);

    try {
      const child = spawnSync(
        process.execPath,
        ["--import", "@oxc-node/core/register", raftdevScript, "start", environmentName],
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
            // Backend-only start (fake Docker cannot run RisingWave).
            RAFTDEV_RISINGWAVE: "0",
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
          RAFTDEV_RISINGWAVE: "0",
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
          // Backend-only start (fake Docker cannot run RisingWave).
          RAFTDEV_RISINGWAVE: "0",
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
          // Backend-only start (fake Docker cannot run RisingWave).
          RAFTDEV_RISINGWAVE: "0",
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

test("the idle janitor's stop command is raftdev stop with the repo's TS loader", () => {
  assert.deepEqual(
    janitorStopCommand({ nodePath: "/usr/bin/node", raftdevScript: "/w/scripts/dev/raftdev.ts", name: "feat-x" }),
    {
      command: "/usr/bin/node",
      args: ["--import", "@oxc-node/core/register", "/w/scripts/dev/raftdev.ts", "stop", "feat-x"],
    },
  );
});
