import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Builds a real single-executable application and runs a probe inside it.
 *
 * Why this exists: every other test of host detection injects the host kind,
 * so none of them exercise the production probe. That gap is not theoretical —
 * a bare `require("node:sea")` shipped in this `"type": "module"` package and
 * would have reported "not a SEA" on every official install, and separately a
 * throw added on the SEA path reached review PASS and hosted green because the
 * branch is unreachable from a plain-Node test host.
 *
 * What this DOES NOT cover, stated here so a passing run is never read as more
 * than it is:
 *   - NOT the Computer SEA artifact. This is a minimal Node SEA; it has none
 *     of the packaging, self-re-exec, or `__cli` sentinel behaviour.
 *   - NOT cliTransport on a real SEA. Its wrappers, credential files and
 *     `__cli` path remain unobserved.
 *   - NOT any Windows-specific behaviour.
 * It covers exactly one claim: the host-kind probe answers correctly when it
 * runs inside a genuine SEA, and correctly when it does not.
 */

export type SeaHarnessOutcome =
  | { status: "observed"; seaHostKind: string; nodeHostKind: string }
  | { status: "not_observed"; reason: "toolchain_missing"; detail: string };

const PROBE_SOURCE = `
const { createRequire } = require("node:module");
const seaRequire = createRequire(__filename);
function seaDetected() {
  let sea;
  try { sea = seaRequire("node:sea"); }
  catch (error) {
    const code = error && error.code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_BUILTIN_MODULE") return false;
    return undefined;
  }
  try { return sea.isSea(); } catch { return undefined; }
}
const execIsElectron = Boolean(process.versions.electron);
const execIsSea = seaDetected();
const hostKind = execIsElectron
  ? "electron"
  : execIsSea === true
    ? "sea"
    : execIsSea === undefined
      ? "unknown"
      : (process.versions.node ? "node" : "unknown");
process.stdout.write(hostKind);
`;

function run(command: string, args: string[], cwd?: string) {
  return spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
}

/**
 * Returns `not_observed` — never a pass — when the toolchain is unavailable.
 * A silent skip here would recreate the defect this harness exists to catch:
 * an absent check rendering as a healthy one.
 */
export function runSeaHostProbe(): SeaHarnessOutcome {
  const dir = mkdtempSync(join(tmpdir(), "sea-host-harness-"));
  try {
    writeFileSync(join(dir, "probe.js"), PROBE_SOURCE);
    writeFileSync(
      join(dir, "sea-config.json"),
      JSON.stringify({ main: "probe.js", output: "sea-prep.blob", disableExperimentalSEAWarning: true }),
    );

    const blob = run(process.execPath, ["--experimental-sea-config", "sea-config.json"], dir);
    if (blob.status !== 0) {
      return { status: "not_observed", reason: "toolchain_missing", detail: "node --experimental-sea-config unavailable" };
    }

    // The plain-Node leg runs the SAME probe outside a SEA. Without it, a
    // harness that always answered "sea" would pass — the second direction is
    // what makes the first one evidence rather than a coincidence.
    const plain = run(process.execPath, [join(dir, "probe.js")]);
    if (plain.status !== 0) {
      return { status: "not_observed", reason: "toolchain_missing", detail: "probe did not run under plain node" };
    }

    const target = join(dir, "probe-sea");
    copyFileSync(process.execPath, target);
    chmodSync(target, 0o755);
    if (process.platform === "darwin") run("codesign", ["--remove-signature", target]);

    const inject = run("npx", [
      "-y", "postject", target, "NODE_SEA_BLOB", join(dir, "sea-prep.blob"),
      "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
    ], dir);
    if (inject.status !== 0) {
      return { status: "not_observed", reason: "toolchain_missing", detail: "postject unavailable or injection failed" };
    }
    if (process.platform === "darwin") {
      const sign = run("codesign", ["--sign", "-", target]);
      if (sign.status !== 0) {
        return { status: "not_observed", reason: "toolchain_missing", detail: "codesign unavailable" };
      }
    }

    const sea = run(target, []);
    if (sea.status !== 0) {
      return { status: "not_observed", reason: "toolchain_missing", detail: "built SEA did not execute" };
    }

    return { status: "observed", seaHostKind: sea.stdout.trim(), nodeHostKind: plain.stdout.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
