// `raft-computer doctor` / `doctor --migration-details` — CLI presenters over
// the ComputerApi. The check BUILDER core (`runDoctorChecks` + helpers) stays
// in doctor.ts so the facade consumes it without importing this presenter
// layer (import-cycle decycle R0, #wg-raft-computer:18ab6541). All user-visible
// output lines are byte-identical to the pre-split doctor.ts.
import {
  LegacyMachinesClient,
  ServerMachinesClient,
  ServersClient,
  type ServerMachineEntry,
  type UserServerEntry,
} from "./apiClient.js";
import { adjudicate, collectDetectionEvidence } from "./lib/migration.js";
import type { LocalCandidateEvidence } from "./lib/types.js";
import { readUserSessionAuth } from "./lib/userSession.js";
import { formatServerSlugDisplay, listServerAttachments } from "./serverState.js";
import { formatRaftHomeForDisplay, resolveRaftHome } from "./paths.js";
import { info, present } from "./output.js";
import { createComputerApi } from "./lib/api.js";
import { resolveServerUrl, resolveServerUrlEnv } from "./serverUrl.js";
import { redactSecrets } from "./doctor.js";

export async function runDoctor(opts: {
  cleanup?: boolean;
  serverId?: string;
  serverLabel?: string;
}): Promise<void> {
  // CLI presenter over `api.doctor`. The api builds the diagnostic report
  // (running the residue cleanup pass when `--fix`/`cleanup` is set — a
  // LOCAL-STATE-ONLY pass scoped to `~/.slock/computer/`, never server-side
  // state). This presenter formats every line
  // through `redactSecrets()` (§3.3.1 defense-in-depth) and sets the process
  // exit code from `allOk`.
  const slockHome = resolveRaftHome();
  const api = createComputerApi(slockHome);
  await present(async () => {
    const report = await api.doctor({
      cleanup: opts.cleanup,
      ...(opts.serverId ? { serverId: opts.serverId } : {}),
      ...(opts.serverLabel ? { serverLabel: opts.serverLabel } : {}),
    });
    const { checks, allOk, cleanup: cleanupReport, crashes } = report;

    info("");
    info(`Using state at ${formatRaftHomeForDisplay(slockHome)}`);
    for (const c of checks) {
      if (c.kind === "section") {
        const heading = `Server ${c.name.replace(/^server\s+/, "")} (${c.detail})`;
        info("");
        info(redactSecrets(heading));
        info("-".repeat(Math.min(72, heading.length)));
      } else {
        info(redactSecrets(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(48)} ${c.detail}`));
      }
    }
    info("");
    info(allOk ? "All checks passed." : "Some checks failed — see the actionable hints above.");

    if (crashes.length > 0) {
      info("");
      info(`Recent crashes for server ${opts.serverLabel ?? opts.serverId} (within 60s window):`);
      for (const c of crashes) {
        const sig = c.signal ? ` signal=${c.signal}` : "";
        const code = c.exitCode !== null ? ` exitCode=${c.exitCode}` : "";
        info(`  - ${c.at}${code}${sig}`);
      }
      info(`  → Once you fix the underlying issue, run`);
      info(`    \`raft-computer restart ${opts.serverLabel ?? opts.serverId}\` to try again.`);
    }

    if (cleanupReport) {
      info("");
      info("Cleanup pass:");
      if (cleanupReport.anyAction) {
        if (cleanupReport.stalePidfiles.length > 0) {
          info(`  - Stale pidfiles cleared (${cleanupReport.stalePidfiles.length}):`);
          for (const p of cleanupReport.stalePidfiles) info(`      ${p}`);
        }
        if (cleanupReport.orphanProcesses.length > 0) {
          info(`  - Orphan processes signaled (${cleanupReport.orphanProcesses.length}): ${cleanupReport.orphanProcesses.join(", ")}`);
        }
        if (cleanupReport.powerLossRecovered.length > 0) {
          info(`  - Partial state quarantined (${cleanupReport.powerLossRecovered.length} server(s)):`);
          for (const sid of cleanupReport.powerLossRecovered) info(`      ${sid}`);
          info(`    (quarantine dir: ~/.slock/computer/.quarantine/<ts>-<serverId>/)`);
        }
        if (cleanupReport.tmpFilesCleared.length > 0) {
          info(`  - Tmp files cleared (${cleanupReport.tmpFilesCleared.length}):`);
          for (const p of cleanupReport.tmpFilesCleared) info(`      ${p}`);
        }
        if (cleanupReport.staleLocks.length > 0) {
          info(`  - Stale locks released (${cleanupReport.staleLocks.length}):`);
          for (const p of cleanupReport.staleLocks) info(`      ${p}`);
        }
      } else {
        info("  No residue found — clean baseline.");
      }
    }

    process.exitCode = allOk ? 0 : 1;
  });
}

function migrationReasonByPath(evidence: Awaited<ReturnType<typeof collectDetectionEvidence>>): Map<string, string> {
  const reasons = new Map<string, string>();
  const adjudication = adjudicate(evidence);
  if (adjudication.kind === "matched") {
    for (const candidate of adjudication.candidates) reasons.set(candidate.localPath, "matched");
    for (const excluded of adjudication.excluded) reasons.set(excluded.evidence.localPath, excluded.reasons.join(",") || "excluded");
  } else if (adjudication.kind === "zero_match") {
    for (const excluded of adjudication.excluded) reasons.set(excluded.evidence.localPath, excluded.reasons.join(",") || "excluded");
  } else if (adjudication.kind === "roster_unavailable") {
    for (const local of evidence.localCandidates) reasons.set(local.localPath, `roster_unavailable:${adjudication.localCount}`);
  }
  return reasons;
}

function shortMachineName(dirName: string): string {
  if (dirName.length <= 16) return dirName;
  const prefix = dirName.startsWith("machine-") ? "machine-" : "";
  const rest = prefix ? dirName.slice(prefix.length) : dirName;
  return `${prefix}${rest.slice(0, 8)}…`;
}

function humanEvidenceReason(local: LocalCandidateEvidence, reason: string, targetServerUrl?: string): string {
  if (reason.includes("server_url_mismatch") && local.ownerServerUrl) {
    const loggedInto = targetServerUrl ? ` (you are logged into ${targetServerUrl})` : "";
    return `belongs to ${local.ownerServerUrl}${loggedInto}`;
  }
  if (local.ownerState === "absent" || local.ownerState === "missing_fingerprint") {
    return "old daemon format (no fingerprint) — dir-name fallback not known either";
  }
  if (local.ownerState === "unreadable") return "owner file unreadable";
  if (local.ownerState === "malformed_json") return "owner file malformed";
  if (reason.includes("matched")) return "recognized by this server";
  if (reason.includes("not_in_roster")) return "fingerprint not known to this server";
  if (reason.includes("no_fingerprint_evidence")) return "no fingerprint evidence";
  if (reason.includes("roster_unavailable")) return "server roster unavailable";
  return reason || "no exclusion reason";
}

function localEvidenceLine(
  index: number,
  local: LocalCandidateEvidence,
  reason: string | null,
  targetServerUrl?: string,
): string {
  const ownerState = local.ownerState === "ok" ? "owner file ok" : local.ownerState;
  // reason === null ⇔ no-server mode: the roster was never consulted, so an
  // exclusion verdict here would be a structural lie (the 0.71 case,
  // #wg-raft-computer:13e4a209). Say "not evaluated", never "not known".
  const verdict = reason === null
    ? "(pass /<server> to evaluate)"
    : humanEvidenceReason(local, reason, targetServerUrl);
  return `  ${index}. ${shortMachineName(local.dirName).padEnd(16)} — ${ownerState} — ${verdict}`;
}

async function resolveDetailsServer(
  accessToken: string,
  baseUrl: string,
  serverLabel: string | undefined,
): Promise<UserServerEntry | null> {
  const servers = await new ServersClient(baseUrl, accessToken).list();
  if (servers.status !== "success") return null;
  if (serverLabel) {
    const slug = serverLabel.replace(/^\//, "");
    return servers.servers.find((server) => server.slug === slug) ?? null;
  }
  return servers.servers.length === 1 ? servers.servers[0] ?? null : null;
}

function serverMachinesLine(label: string, machines: ServerMachineEntry[]): string {
  const rendered = machines.length === 0
    ? "none"
    : machines.map((machine) => `${machine.name} (${machine.agentCount} agent${machine.agentCount === 1 ? "" : "s"})`).join(", ");
  return `Server side: your account has ${machines.length} Computer${machines.length === 1 ? "" : "s"} on ${label}: ${rendered}.`;
}

export async function runDoctorMigrationDetails(opts: { serverLabel?: string }): Promise<void> {
  await present(async () => {
    const slockHome = resolveRaftHome();
    let label = opts.serverLabel ? formatServerSlugDisplay(opts.serverLabel) : "";
    let evidence: Awaited<ReturnType<typeof collectDetectionEvidence>>;
    let machines: ServerMachineEntry[] | null = null;

    const session = await readUserSessionAuth(slockHome).catch(() => null);
    if (session?.accessToken) {
      const baseUrl = resolveServerUrl(undefined, session.serverUrl, resolveServerUrlEnv());
      const server = await resolveDetailsServer(session.accessToken, baseUrl, opts.serverLabel);
      if (server && !label) label = formatServerSlugDisplay(server.slug);
      const rosterSlug = (server?.slug ?? opts.serverLabel ?? "").replace(/^\//, "");
      evidence = rosterSlug.length > 0
        ? await collectDetectionEvidence(
            slockHome,
            rosterSlug,
            () => new LegacyMachinesClient(baseUrl, session.accessToken),
          )
        : await collectDetectionEvidence(slockHome, "", () => ({
            list: async () => ({ status: "success", entries: [] }),
          }));
      if (server) {
        const serverMachines = await new ServerMachinesClient(baseUrl, session.accessToken).list(server.id);
        if (serverMachines.status === "success") machines = serverMachines.machines;
      }
    } else {
      evidence = await collectDetectionEvidence(slockHome, "", () => ({
        list: async () => ({ status: "success", entries: [] }),
      }));
    }

    if (!label) label = "(server not specified)";
    const normalizedLabel = label === "(server not specified)" ? null : label.replace(/^\//, "");
    const attached = normalizedLabel !== null && (await listServerAttachments(slockHome)).some(
      (attachment) => attachment.serverSlug?.replace(/^\//, "") === normalizedLabel,
    );
    for (const line of renderMigrationDetailsBody({
      label,
      evidence,
      machines,
      slockHomeDisplay: formatRaftHomeForDisplay(slockHome),
      attached,
    })) {
      info(line);
    }
  });
}

/**
 * Pure render seam for `doctor --migration-details` (TUI law 1: decisions and
 * text projection unit-testable without HTTP/session fixtures).
 *
 * Honesty contract (#wg-raft-computer:13e4a209 / the 0.71 case):
 *   - No-server mode never consulted a roster → per-trace verdicts are
 *     "(pass /<server> to evaluate)" and the ONLY Next is the slugged rerun.
 *     The string "not known to this server" must not appear (pinned).
 *   - Slugged + unattached mode leads with the executable identity-carried
 *     migration path (`setup --machine <id>`). An already-attached server
 *     never receives that instruction: setup rejects --machine in that state,
 *     and starting a legacy connect command would create a second owner.
 *   - "delete the empty Computer" arm only renders when an empty (0-agent)
 *     Computer actually exists — it presumed the regret shape and misled the
 *     0.71 case where both rows were populated.
 *   - "no fingerprint" arm only renders when a local trace lacks fingerprint
 *     evidence (update-daemon-and-run-once recovery, task #239 ③).
 */
export function renderMigrationDetailsBody(input: {
  label: string;
  evidence: Awaited<ReturnType<typeof collectDetectionEvidence>>;
  machines: ServerMachineEntry[] | null;
  slockHomeDisplay: string;
  attached?: boolean;
}): string[] {
  const { label, evidence, machines } = input;
  const noServer = label === "(server not specified)";
  const localCount = evidence.localCandidates.length;
  const lines: string[] = [];
  lines.push("");
  lines.push(`Using state at ${input.slockHomeDisplay}`);
  lines.push(`Migration evidence for ${label} (${localCount} local trace${localCount === 1 ? "" : "s"}):`);
  if (localCount === 0) lines.push("  none found");
  const reasons = noServer ? null : migrationReasonByPath(evidence);
  evidence.localCandidates.forEach((local, index) => {
    lines.push(
      redactSecrets(
        localEvidenceLine(
          index + 1,
          local,
          reasons === null ? null : reasons.get(local.localPath) ?? "(none)",
          evidence.targetServerUrl,
        ),
      ),
    );
  });
  if (machines) {
    lines.push(serverMachinesLine(label, machines));
  }
  if (noServer) {
    lines.push("Next: rerun with your server for roster-relative reasons and server-side Computer counts:");
    lines.push("        raft-computer doctor --migration-details /<server>");
  } else if (input.attached === true) {
    lines.push(
      `Next: ${label} is already attached; the legacy traces above are historical setup evidence, not a repair instruction for the active Computer.`,
    );
    lines.push(
      `      if \`raft-computer status\` shows this runner healthy and connected, no local recovery action is required; do not run a legacy connect command, \`setup --machine\`, or \`--fresh\` from this report`,
    );
    lines.push(
      `      if the current runner is unhealthy, follow \`raft-computer doctor ${label}\`; recovery must be driven by the failing current attachment, not by hostname alone`,
    );
  } else {
    const computersUrl = `https://app.raft.build/s/${encodeURIComponent(label.replace(/^\//, ""))}/computers`;
    lines.push(
      `Next: one of these should be this computer → find the legacy row by hostname at ${computersUrl}, then use its “Migrate to Computer” setup command (\`raft-computer setup ${label} --machine <machineId>\`)`,
    );
    if (evidence.localCandidates.some((local) => !local.effectiveFingerprint)) {
      lines.push(
        `      a trace shows "no fingerprint" → update that computer's daemon to the latest version and run it once, then rerun raft-computer setup ${label}`,
      );
    }
    if (machines?.some((machine) => machine.isComputer && machine.agentCount === 0)) {
      lines.push(
        `      a 0-agent Computer is visible → do not delete it from this output alone; wait briefly, rerun doctor, and confirm it is a stable orphan before any destructive cleanup`,
      );
    }
    lines.push(`      none of them → raft-computer setup ${label} --fresh`);
  }
  lines.push("Help: https://app.raft.build/s/community/");
  return lines;
}
