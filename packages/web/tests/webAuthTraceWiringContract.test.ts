import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scan contract for the L4 web auth trace producer wiring (phase 2).
 * Per rfcs/016-auth-session-contract.md (Observability Contract):
 *  - restore transitions, verdicts, and clear-session sinks must emit the
 *    bounded `slock.auth.*` events;
 *  - `slock.auth.session_cleared` must always carry clearSessionCaller + logoutTrigger;
 *  - emits must be fire-and-forget (never awaited / returned);
 *  - internal terminal logout callsites must carry a trigger, never bare logout().
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const WEB_ROOT = join(SRC, "..");
const strykerBackupSrc = () => {
  const tmp = join(WEB_ROOT, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? join(tmp, backup, "src") : null;
};
const read = (p: string) => readFileSync(join(strykerBackupSrc() ?? SRC, p), "utf8");
const stripLineComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("restore transitions emit slock.auth.restore via the transitionRestore choke-point", () => {
  const authStore = stripLineComments(read("store/authStore.ts"));
  assert.match(authStore, /function transitionRestore\(/, "transitionRestore choke-point helper must exist");
  assert.match(authStore, /emitAuthTrace\("slock\.auth\.restore"/, "transitionRestore must emit slock.auth.restore");
  // All inline transitions must route through the choke-point (no raw nextAuthRestoreState(get()...)).
  assert.doesNotMatch(
    authStore,
    /nextAuthRestoreState\(get\(\)\.restoreState/,
    "restore transitions must go through transitionRestore(), not raw nextAuthRestoreState(get().restoreState, ...)",
  );
});

test("getAuthVerdict callers emit slock.auth.verdict (>=4), urgent terminal logout verdicts, and the pure oracle stays trace-free", () => {
  const callerFiles = [
    "utils/authSessionPolicy.ts",
    "utils/protectedRequestAuthPolicy.ts",
    "utils/socketSessionPolicy.ts",
  ];
  const count = callerFiles.reduce(
    (n, f) => n + (read(f).match(/emitAuthTrace\("slock\.auth\.verdict"/g) ?? []).length,
    0,
  );
  assert.ok(count >= 4, `expected >=4 slock.auth.verdict emits across the getAuthVerdict callers, found ${count}`);
  for (const f of callerFiles) {
    const src = stripLineComments(read(f));
    assert.match(src, /verdict\s*===\s*"logout"/, `${f}: terminal verdict branch must be explicit`);
    assert.match(
      src,
      /emitAuthTraceAndFlush\("slock\.auth\.verdict"/,
      `${f}: terminal logout verdict must use emitAuthTraceAndFlush so it is not lost before session_cleared`,
    );
  }
  assert.doesNotMatch(read("utils/authVerdict.ts"), /emitAuthTrace/, "the pure getAuthVerdict oracle must not emit traces");
});

test("socket terminal logout carries terminal_verdict trigger", () => {
  const socket = stripLineComments(read("api/socket.ts"));
  assert.match(
    socket,
    /logout\("terminal_verdict"\)/,
    "socket auth terminal outcome must classify its clear-session trace as terminal_verdict, not explicit_user_logout",
  );
});

test("every clear-session sink emits slock.auth.session_cleared via immediate terminal-safe flush with caller + trigger", () => {
  for (const f of ["api/client.ts", "store/authStore.ts", "App.tsx"]) {
    const src = stripLineComments(read(f));
    // Must use the immediate-flush variants: a deferred batch flush would read
    // a missing token after the synchronous removeItem and drop the trace.
    // `api/client.ts` uses the terminal-only before-unload helper because it
    // immediately navigates away after clearing auth.
    const blocks = [...src.matchAll(/emitAuthTraceAndFlush(?:BeforeUnload)?\("slock\.auth\.session_cleared",\s*\{([\s\S]*?)\}\s*\)/g)];
    assert.ok(blocks.length >= 1, `${f} must emit slock.auth.session_cleared via an immediate auth-trace flush at its clear-session sink`);
    for (const b of blocks) {
      assert.match(b[1], /clearSessionCaller:/, `${f}: session_cleared emit missing clearSessionCaller`);
      assert.match(b[1], /logoutTrigger:/, `${f}: session_cleared emit missing logoutTrigger`);
    }
    // The deferred (non-immediate) variant must NOT be used for session_cleared.
    // `emitAuthTrace(` requires `(` right after the name, so it does not match
    // `emitAuthTraceAndFlush(`.
    assert.doesNotMatch(
      src,
      /emitAuthTrace\("slock\.auth\.session_cleared"/,
      `${f}: session_cleared must use emitAuthTraceAndFlush (immediate), not the deferred emitAuthTrace`,
    );
  }
});

test("auth trace emits are fire-and-forget (never awaited, never returned)", () => {
  const files = [
    "store/authStore.ts",
    "api/client.ts",
    "App.tsx",
    "utils/refreshCoordinator.ts",
    "utils/authSessionPolicy.ts",
    "utils/protectedRequestAuthPolicy.ts",
    "utils/socketSessionPolicy.ts",
  ];
  for (const f of files) {
    const src = stripLineComments(read(f));
    assert.doesNotMatch(src, /await\s+emitAuthTrace(?:AndFlush)?\(/, `${f}: emitAuthTrace must not be awaited`);
    assert.doesNotMatch(src, /return\s+emitAuthTrace(?:AndFlush)?\(/, `${f}: emitAuthTrace must not be returned (must be fire-and-forget)`);
  }
});

test("browser auth refresh request is timeout-bounded so Web Locks cannot wedge every tab", () => {
  const refreshCoordinator = stripLineComments(read("utils/refreshCoordinator.ts"));
  assert.match(
    refreshCoordinator,
    /AUTH_REFRESH_REQUEST_TIMEOUT_MS/,
    "refreshCoordinator must use the shared auth refresh request timeout",
  );
  assert.match(
    refreshCoordinator,
    /axios\.post\(\s*`\$\{API_BASE\}\/auth\/refresh`\s*,\s*\{\s*refreshToken\s*\}\s*,\s*\{[\s\S]*?timeout:\s*AUTH_REFRESH_REQUEST_TIMEOUT_MS/,
    "browser /auth/refresh POST must pass an explicit timeout while held under the cross-tab refresh lock",
  );
});

test("internal terminal logout callsites carry a trigger, never bare logout()", () => {
  const authStore = stripLineComments(read("store/authStore.ts"));
  assert.doesNotMatch(
    authStore,
    /get\(\)\.logout\(\)/,
    "internal terminal logout must pass a LogoutTrigger (e.g. get().logout(\"terminal_verdict\")), not bare get().logout()",
  );
});
