// Whether a web upgrade's installer could move out of this Computer's systemd
// unit, told up front on `ready.upgradeScope` so the server refuses the web
// upgrade early and the web hides Upgrade. The service refuses such an upgrade
// right before spawning the installer anyway (service.ts `vetoInstaller`,
// `scope_unavailable`); this reports the same answer before anyone clicks.
//
// Run afresh for every ready the runner sends (its first connection, every
// reconnect, every runner start, so after every service start and upgrade):
// a passing failure at boot does not stick for the runner's life. The server
// replaces what it held with each ready's answer.
//
// The probe is the upgrade's own (`runSystemdScopeProbe`):
// `systemd-run [--user] --scope --quiet --collect --no-ask-password -- true`.
// It leaves nothing behind: `true` runs in the transient scope and exits at
// once, the scope ends with it, and `--collect` has systemd drop the unit even
// when it failed. `--no-ask-password` means no polkit agent is asked, so a
// refusal is answered at once and nobody is prompted. Bounded like every
// systemctl call (15 s, then SIGKILL).
//
// Result mapping (only an explicit refusal is reported):
//   exit 0                        → allowed: null (nothing to report)
//   exit non-zero                 → refused (what vetoInstaller refuses on):
//                                   { ok: false, reason: systemd-run's first line }
//   no exit code (spawn error such as systemd-run missing, killed on the
//   bound, killed by a signal)    → the probe did not run: null (unknown)
// Not probed (null): not Linux, root (root's scope is always granted), or not
// running under a systemd unit, i.e. no supervisor record from THIS runner's
// own service (the service writes the record before it starts runners and
// clears it when it is not under systemd; the record's pid must be our parent).
import { boundComputerUpgradeScopeReason, clearClockTimeout, setClockTimeout, type ComputerUpgradeScopeUnavailable } from "@botiverse/raft-shared";
import {
  readSupervisorRecord,
  runSystemdScopeProbe,
  type ExternalSupervisorRecord,
  type SystemctlResult,
  type SystemdScopeProbe,
} from "./externalSupervisor";

export interface UpgradeScopeProbeDeps {
  platform?: NodeJS.Platform;
  /** Effective uid; undefined where the platform has none. */
  uid?: number | undefined;
  /** The service that started this runner. */
  parentPid?: number;
  readSupervisorRecord?: (slockHome: string) => Promise<ExternalSupervisorRecord | null>;
  probe?: SystemdScopeProbe;
}

/** What one probe run says: a refusal, or null for allowed and for a probe that did not run. */
export function upgradeScopeFromProbe(result: SystemctlResult): ComputerUpgradeScopeUnavailable | null {
  if (result.code === null || result.code === 0) return null;
  const firstLine = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
  return { ok: false, reason: boundComputerUpgradeScopeReason(firstLine) || `systemd-run exited with ${result.code}` };
}

export async function probeUpgradeScope(
  slockHome: string,
  deps: UpgradeScopeProbeDeps = {},
): Promise<ComputerUpgradeScopeUnavailable | null> {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  const uid = "uid" in deps ? deps.uid : process.getuid?.();
  if (uid === undefined || uid === 0) return null;
  const record = await (deps.readSupervisorRecord ?? readSupervisorRecord)(slockHome).catch(() => null);
  if (!record || record.pid !== (deps.parentPid ?? process.ppid)) return null;
  try {
    return upgradeScopeFromProbe(await (deps.probe ?? runSystemdScopeProbe)(record.scope));
  } catch {
    return null;
  }
}

/**
 * How long a `ready` waits for the probe: past this, that ready reports
 * unknown (as an older Computer would) instead of holding the connection up
 * to the probe's own 15 s bound.
 */
export const UPGRADE_SCOPE_READY_WAIT_MS = 3_000;

/** The probe's answer if it has one within `waitMs`, else null (unknown). */
export async function upgradeScopeForReady(
  probe: Promise<ComputerUpgradeScopeUnavailable | null>,
  waitMs: number = UPGRADE_SCOPE_READY_WAIT_MS,
): Promise<ComputerUpgradeScopeUnavailable | null> {
  let timer: unknown;
  const unknown = new Promise<null>((resolve) => { timer = setClockTimeout(() => resolve(null), waitMs); });
  try {
    return await Promise.race([probe.catch(() => null), unknown]);
  } finally {
    clearClockTimeout(timer);
  }
}
