import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// REGRESSION pin for #wg-raft-computer:f2a02081 BUG 5
//
// `spawnDetachedService` (packages/computer/src/service.ts) re-execs the
// menu-bar process with `process.execPath argv[1] __service` (and
// `__run <serverId>` for per-server runner spawns — see `buildResidentSpawn`
// in the same file, which mirrors the CLI's hidden `.command("__service")` /
// `.command("__run")` subcommands in packages/computer/src/cli.ts, dispatched
// to `runService()` / `runResident(serverId)`).
//
// The CLI binary picks up those subcommands via commander. The Electron
// menu-bar process MUST mirror that — without an argv gate that calls
// `runService()` / `runResident(serverId)` before `app.whenReady()`, the
// re-exec just boots another tray icon and the supervisor never starts.
// "Start Service" then silently times out (or, in test harnesses with
// `argv[1]` pointing at a JS file, fork-bombs as each new child re-spawns
// itself).
//
// This test asserts `src/main.ts` source contains the two argv-gated calls
// (`runService` and `runResident`), and that they are reachable BEFORE the
// `app.whenReady()` boot path runs (i.e. dispatched through a gate, not
// invoked unconditionally).
//
// Source-grep is sufficient here because the gate is a top-level program
// flow construct, not exercisable via unit-tested DSL the way menu-shape /
// action-routing are. The integration boundary (Electron re-execs the same
// binary) is what BUG 5 was about — pinning the gate's presence in source is
// the cheapest reliable regression guard.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_SRC = join(__dirname, "main.ts");
const ONBOARDING_IPC_SRC = join(__dirname, "onboardingIpc.ts");
const PACKAGE_JSON = join(__dirname, "..", "package.json");

test("main.ts dispatches __service / __run BEFORE app.whenReady() (BUG 5 regression)", async () => {
  const src = await readFile(MAIN_SRC, "utf8");

  // Locate the markers we care about. Strip line + block comments so the
  // dispatcher's own doc-comment (which mentions `app.whenReady()`) does not
  // count.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const idxArgvGate = codeOnly.search(/process\.argv\b/);
  const idxWhenReady = codeOnly.search(/\bapp\.whenReady\s*\(\s*\)/);

  assert.notEqual(idxArgvGate, -1, "main.ts must read process.argv for the __service/__run mode");
  assert.notEqual(idxWhenReady, -1, "main.ts must call app.whenReady()");
  assert.ok(
    idxArgvGate < idxWhenReady,
    "argv gate must precede app.whenReady() (so the headless dispatch wins before Electron boots the tray)",
  );

  // Both subcommands must be wired through.
  assert.match(src, /["']__service["']/, "main.ts must dispatch the __service hidden mode");
  assert.match(src, /["']__run["']/, "main.ts must dispatch the __run <serverId> hidden mode");
  assert.match(
    src,
    /runService\s*\(/,
    "main.ts must call runService() in the __service branch (BUG 5: spawned re-exec needs the supervisor entry)",
  );
  assert.match(
    src,
    /runResident\s*\(\s*serverId/,
    "main.ts must call runResident(serverId) in the __run branch (BUG 5: spawned re-exec needs the per-server runner entry)",
  );
});

test("main.ts answers --version before booting Electron or resolving resident runtime dependencies", async () => {
  const src = await readFile(MAIN_SRC, "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const idxVersionGate = codeOnly.search(/requestsVersion\s*\(\s*process\.argv\s*\)/);
  const idxCliResolution = codeOnly.search(/const\s+cliPath\s*=\s*resolveBundledCliPath\s*\(\s*\)/);
  const idxWhenReady = codeOnly.search(/\bapp\.whenReady\s*\(\s*\)/);

  assert.notEqual(idxVersionGate, -1, "main.ts must gate the packaged --version probe");
  assert.notEqual(idxCliResolution, -1, "main.ts must retain bundled CLI resolution");
  assert.notEqual(idxWhenReady, -1, "main.ts must retain the GUI boot path");
  assert.ok(idxVersionGate < idxCliResolution, "--version must exit before bundled CLI resolution");
  assert.ok(idxVersionGate < idxWhenReady, "--version must exit before app.whenReady()");
  assert.match(codeOnly, /process\.stdout\.write\s*\(\s*`\$\{app\.getVersion\(\)\}\\n`\s*\)/);
  assert.match(codeOnly, /process\.exit\s*\(\s*0\s*\)/);
});

test("main.ts scans argv for the mode token (argv-fidelity: SEA vs non-SEA vs packaged .app)", async () => {
  // Yingjun #wg-raft-computer:f2a02081 msg=1888833a — the lib's
  // `buildResidentSpawn` puts the mode token at a position that depends on
  // SEA-ness AND on `selfEntry` (argv[1] in SEA, argv[2] in non-SEA, possibly
  // shifted again in a packaged Electron .app where argv[1] may be empty or
  // an OS-injected path). Hard-coding `argv[2]` works in dev but is one
  // packaging change from regressing silently.
  //
  // Pin a scan-over-argv shape so the dispatcher tolerates all three layouts.
  // We don't constrain the exact iteration form — just require that the
  // dispatcher consults more than a single fixed index.
  const src = await readFile(MAIN_SRC, "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // Reject hard-coded single-index patterns like `process.argv[2] === "__service"`.
  // (The dispatcher may still index argv to read positional args AFTER scanning,
  // but the mode-token discovery itself must not be a single-index equality.)
  assert.doesNotMatch(
    codeOnly,
    /process\.argv\[\d+\]\s*===\s*["']__(service|run)["']/,
    "dispatcher must NOT hard-code a single argv index for the mode token — scan argv instead (packaging-fragile)",
  );

  // Require an iteration / membership / indexOf form over argv.
  const scansArgv =
    /for\s*\([^)]*process\.argv|process\.argv\.includes\s*\(\s*["']__/i.test(codeOnly) ||
    /process\.argv\.(some|find|findIndex|indexOf)\s*\(/i.test(codeOnly) ||
    // Or: the dispatcher delegates to a helper that takes argv (preferred shape)
    /findHeadlessMode\s*\(\s*process\.argv\s*\)/i.test(codeOnly);
  assert.ok(
    scansArgv,
    "dispatcher must scan argv (e.g. a `for (let i = 1; ...)` loop, `argv.includes(...)`, or a helper taking the array) so SEA/non-SEA/packaged layouts all dispatch",
  );
});

test("dev Electron declares the bundled Raft CLI package it resolves for agent spawn", async () => {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
    dependencies?: Record<string, string>;
  };

  assert.equal(
    pkg.dependencies?.["@botiverse/raft"],
    "workspace:*",
    "main.ts resolves @botiverse/raft/package.json in dev mode; pnpm only links packages declared as dependencies",
  );
});

test("onboarding start-service IPC forwards the selected server target", async () => {
  const src = await readFile(ONBOARDING_IPC_SRC, "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  assert.match(
    codeOnly,
    /ipcMain\.handle\s*\(\s*["']onboarding:start-service["'][\s\S]*?target\?/,
    "onboarding:start-service must accept an optional selected server target from the setup-progress surface",
  );
  assert.match(
    codeOnly,
    /api\.start\s*\(\s*\{[\s\S]*serverId:\s*target\?\.serverId\s*\?\?\s*null[\s\S]*serverLabel:\s*target\?\.serverLabel\s*\?\?\s*null[\s\S]*\}/,
    "onboarding:start-service must call api.start with the selected serverId/serverLabel, not an unscoped {} start",
  );
});
