// Vitest setup (computer, daemon): keep tests out of the live Computer.
//
// An agent's shell carries RAFT_HOME and SLOCK_HOME pointing at the Computer
// that runs it, and RAFT_HOME wins over the SLOCK_HOME a test sets for its temp
// dir (packages/computer/src/paths.ts resolveRaftHome). A fake server
// attachment from adoptLegacy.test.ts once landed in a live Computer this way
// and made its next upgrade roll back. Code that falls back to
// os.homedir() (a test passing an empty env, say) reached it too: test
// launches kept landing in ~/.slock/cli-transport/agent-1 with this file in
// place, so HOME is a temp dir as well.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Knobs CI sets on purpose for these suites.
const KEEP = new Set(["RAFT_COMPUTER_VERSION", "SLOCK_COMPUTER_VERSION"]);

// Read once per worker: this file runs again for each test file in a worker,
// after the first run already replaced HOME and dropped RAFT_HOME.
const LIVE_HOMES_ENV = "RAFT_TEST_LIVE_HOMES";
process.env[LIVE_HOMES_ENV] ??= JSON.stringify([...new Set(
  [process.env.RAFT_HOME, process.env.SLOCK_HOME, path.join(os.homedir(), ".slock"), path.join(os.homedir(), ".raft")]
    .filter((home): home is string => Boolean(home?.trim()))
    .map((home) => path.resolve(home)),
)]);
const liveHomes = JSON.parse(process.env[LIVE_HOMES_ENV]) as string[];

for (const name of Object.keys(process.env)) {
  if (!/^(RAFT|SLOCK)_/.test(name) || KEEP.has(name) || name.startsWith("RAFT_TEST_")) continue;
  delete process.env[name];
}
// A test that sets no home gets a temp one, not ~/.slock; os.homedir() too
// (it reads HOME on Linux/macOS, USERPROFILE on Windows).
const tempHome = mkdtempSync(path.join(os.tmpdir(), "raft-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.SLOCK_HOME = path.join(tempHome, ".slock");

// Guard: what a test leak looked like must not appear in a live home under a
// test file: a server attachment or a login pointing at a loopback test
// server, or a non-UUID agent id in cli-transport (real agents' are UUIDs;
// agent-1, contract-agent and the like came from tests). The owner may log
// in or attach for real meanwhile, so only these shapes are compared.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOPBACK = /^https?:\/\/(127\.|localhost|\[::1\])/;
function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
function serverUrl(file: string): string {
  try {
    return String((JSON.parse(readFileSync(file, "utf8")) as { serverUrl?: unknown }).serverUrl ?? "");
  } catch {
    return "";
  }
}
function liveState(): string {
  return liveHomes.map((home) => {
    const servers = path.join(home, "computer", "servers");
    const loopbackServers = entries(servers)
      .filter((id) => LOOPBACK.test(serverUrl(path.join(servers, id, "runner.state.json"))));
    const login = serverUrl(path.join(home, "computer", "user-session.json"));
    return [
      `${home} loopback servers: ${loopbackServers.join(",")}`,
      `${home} loopback login: ${LOOPBACK.test(login) ? login : ""}`,
      `${home} test agents in cli-transport: ${entries(path.join(home, "cli-transport")).filter((name) => !UUID.test(name)).join(",")}`,
    ].join("\n");
  }).join("\n");
}
const before = liveState();
afterAll(() => {
  const after = liveState();
  if (after !== before) {
    throw new Error(`a test changed a live Raft home:\nbefore\n${before}\nafter\n${after}`);
  }
});
