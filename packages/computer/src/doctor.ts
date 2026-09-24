// `raft-computer doctor` — Computer-level health diagnostics (RFC v0.8
// contract v4 §7). Reports login + per-server attachment + per-server
// §9 preflight + service — with an ACTIONABLE next step per failing
// check, all under a Computer (one SLOCK_HOME).
//
// SECRET REDLINE (§3.3.1, double-layer with the server-side §12
// whitelist): doctor reads each per-server sk_computer_* (to run that
// server's preflight) and the user token (login state) but NEVER prints
// them. As defense-in-depth EVERY emitted line is additionally run
// through `redactSecrets()` so even a future bug that drops a credential
// into a check `detail` cannot leak it.
import { buildStatusReport } from "./status.js";
import type { ServerStatusRow } from "./status.js";
import {
  ComputerAttachClient,
  LegacyMachinesClient,
  ServerMachinesClient,
  type ServerMachinesResult,
} from "./apiClient.js";
import { detectLegacyMigration, type LegacyMachineRosterClientFactory } from "./lib/migration.js";
import type { MigrationDetection } from "./lib/types.js";
import { readUserSessionAuth } from "./lib/userSession.js";
import type { ServerAttachment } from "./serverState.js";
import { formatServerSlugDisplay, listServerAttachments } from "./serverState.js";
import { hasUnlinkedComputerHandshake, readRunnerLogTail } from "./internal/runner-log-diagnostics.js";

// The CLI presenters (`runDoctor` / `runDoctorMigrationDetails`) live in
// doctorCli.ts (decycle R0, #wg-raft-computer:18ab6541). The pure check
// builder below (`runDoctorChecks`) takes slockHome explicitly so a
// service-axis caller can't silently regress to `~/.slock`.
// (#wg-raft-computer:f2a02081 BUG 3 sweep.)

// Anything shaped like a Raft credential, JWT, or long opaque token.
const SECRET_PATTERNS: RegExp[] = [
  /sk_[a-z]+_[A-Za-z0-9._-]+/g, // sk_computer_* / sk_agent_* / sk_machine_*
  /\beyJ[A-Za-z0-9._-]{20,}/g, // JWT-ish (base64url header)
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs
];

export function redactSecrets(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "***REDACTED***");
  return out;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  kind?: "check" | "section";
}

interface DoctorDeps {
  detectMigration?: (
    slockHome: string,
    serverSlug: string,
    clientFactory: LegacyMachineRosterClientFactory,
  ) => Promise<MigrationDetection>;
  listServerMachines?: (attachment: ServerAttachment) => Promise<ServerMachinesResult>;
}

const PREFLIGHT_AUTH_REJECT_CODES = new Set([
  "computer_key_revoked",
  "computer_not_found",
  "computer_key_hash_mismatch",
  "invalid_principal",
  "unauthorized",
  "forbidden",
  "http_401",
  "http_403",
]);

function preflightRejectedDetail(code: string): string {
  if (PREFLIGHT_AUTH_REJECT_CODES.has(code)) {
    return (
      `preflight rejected (${code}) — saved Computer credential is no longer accepted. ` +
      `Computer identity is the server-issued id, not the display name; creating a fresh attachment with the same name may hit ` +
      `COMPUTER_NAME_COLLISION. Use a new --name only if you intend to create a new Computer identity, or ask an admin ` +
      `to revoke/clean up the old row before recovering this one.`
    );
  }
  return `preflight rejected (${code}) — upgrade the server or retry after checking server compatibility`;
}

async function runnerDetail(slockHome: string, server: ServerStatusRow): Promise<{ ok: boolean; detail: string }> {
  const logHint = `inspect ${server.serverRunnerLogPath}`;
  const label = formatServerSlugDisplay(server.serverSlug);
  if (server.health === "unlinked") {
    return {
      ok: false,
      detail:
        `server rejected the Computer WebSocket as computer_machine_unlinked — run \`raft-computer setup ${label}\` to recover/rebind, ` +
        `then verify with \`raft-computer status ${label}\`; diagnostics are in ${server.serverRunnerLogPath}`,
    };
  }
  if (server.health === "degraded") {
    return {
      ok: false,
      detail: `degraded after repeated crashes — ${logHint}; after fixing, run \`raft-computer restart ${label}\` to try again`,
    };
  }
  if (!server.daemon.running) {
    return {
      ok: false,
      detail: `stopped — run \`raft-computer start ${label}\` and ${logHint}`,
    };
  }
  if (!server.serverConnected) {
    const logTail = await readRunnerLogTail([server.serverRunnerLogPath]);
    if (hasUnlinkedComputerHandshake(logTail)) {
      return {
        ok: false,
        detail:
          `server rejected the Computer WebSocket as computer_machine_unlinked — run \`raft-computer setup ${label}\` to recover/rebind, ` +
          `then verify with \`raft-computer status ${label}\`; diagnostics are in ${server.serverRunnerLogPath}`,
      };
    }
    return {
      ok: false,
      detail: `process running (pid ${server.daemon.pid}) but not connected to the server — ${logHint}; restart with \`raft-computer start ${label}\``,
    };
  }
  return {
    ok: true,
    detail: `running and connected (pid ${server.daemon.pid})`,
  };
}

export async function runDoctorChecks(
  slockHome: string,
  opts: { serverId?: string } & DoctorDeps = {},
): Promise<DoctorCheck[]> {
  const report = await buildStatusReport(slockHome);
  const checks: DoctorCheck[] = [];

  checks.push({ name: "SLOCK_HOME", ok: true, detail: report.slockHome });

  checks.push(
    report.userSessionError
      ? { name: "user session", ok: false, detail: "invalid user session file — re-run `raft-computer login`" }
      : report.loggedIn
      ? { name: "user session", ok: true, detail: `logged in (user ${report.userId ?? "?"})` }
      : { name: "user session", ok: false, detail: "not logged in — run `raft-computer login`" },
  );

  // Service presence is informational — the per-server daemons can
  // also be run via --foreground, so missing service is not a fail.
  checks.push(
    report.service.running
      ? { name: "service", ok: true, detail: `running (pid ${report.service.pid})` }
      : {
          name: "service",
          ok: true,
          detail: "stopped (run `raft-computer start` when you want background)",
        },
  );

  if (report.hostLifecycle) {
    checks.push({
      name: "macOS login carrier",
      ok: false,
      detail:
        `${report.hostLifecycle.status} (${report.hostLifecycle.errorCode ?? "replacement interrupted"}) — `
        + "the enabled owner marker is not trusted; repair the saved login carrier before retrying start or upgrade",
    });
  }

  if (report.upgrade) {
    const upgrade = report.upgrade;
    checks.push({
      name: "K upgrade receipt",
      ok: false,
      detail: upgrade.outcome === null
        ? `${upgrade.scope} operation ${upgrade.requestId} is active in phase ${upgrade.phase}`
        : `${upgrade.scope} operation ${upgrade.requestId} is terminal ${upgrade.outcome} and unacknowledged; `
          + `verify the running Computer, then run \`raft-computer operation acknowledge ${upgrade.requestId}\``,
    });
  }

  // Per-server preflight loop (contract v4 §9): isolated per serverId,
  // uses THAT server's own sk_computer_*; never a shared key.
  const allAttachments = await listServerAttachments(slockHome);
  const attachments = opts.serverId
    ? allAttachments.filter((a) => a.serverId === opts.serverId)
    : allAttachments;
  if (attachments.length === 0) {
    checks.push({
      name: "attachments",
      ok: false,
      detail: opts.serverId
        ? `no attachment found for selected server (${opts.serverId}) — run \`raft-computer attach /<serverSlug>\` for that server`
        : "no attachments — run `raft-computer attach /<serverSlug>` (e.g. `/myserver`)",
    });
    return checks;
  }
  for (const a of attachments) {
    // Canonical `/<slug>` for user-facing labels; serverId fallback only
    // for pre-PR-G attachments not yet refreshed.
    const label = a.serverSlug ? formatServerSlugDisplay(a.serverSlug) : a.serverId;
    const statusRow = report.servers.find((s) => s.serverId === a.serverId);
    checks.push({
      kind: "section",
      name: `server ${label}`,
      ok: true,
      detail: a.serverId,
    });
    checks.push({
      name: `attach ${label}`,
      ok: true,
      detail: `machine ${a.serverMachineId} @ ${a.serverUrl}`,
    });
    try {
      // accessToken arg unused for preflight; pass empty.
      const client = new ComputerAttachClient(a.serverUrl, "");
      const r = await client.preflight(a.apiKey);
      checks.push(
        r.ok
          ? {
              name: `preflight ${label}`,
              ok: true,
              detail: "server recognizes this computer's credentials",
            }
          : {
              name: `preflight ${label}`,
              ok: false,
              detail: preflightRejectedDetail(r.code),
            },
      );
    } catch (err) {
      checks.push({
        name: `preflight ${label}`,
        ok: false,
        detail: `server unreachable (${err instanceof Error ? err.message : String(err)}) — check serverUrl / network`,
      });
    }
    let runnerOk = false;
    if (statusRow) {
      const runner = await runnerDetail(slockHome, statusRow);
      runnerOk = runner.ok;
      checks.push({
        name: `runner ${label}`,
        ok: runner.ok,
        detail: runner.detail,
      });
    }
    const migration = await legacyMigrationForDoctor(slockHome, a, opts);
    const setupBlocker = setupBlockingIdentityDetail(a, migration, runnerOk);
    if (setupBlocker) {
      checks.push({
        name: `identity ${label}`,
        ok: false,
        detail: setupBlocker,
      });
      continue;
    }
    const regret = await regretSwitchDetail(slockHome, a, opts, migration, runnerOk);
    if (regret) {
      checks.push({
        name: `identity ${label}`,
        ok: false,
        detail: regret,
      });
    }
  }
  return checks;
}

async function legacyMigrationForDoctor(
  slockHome: string,
  attachment: ServerAttachment,
  deps: DoctorDeps,
): Promise<MigrationDetection | null> {
  if (!attachment.serverSlug) return null;
  const session = await readUserSessionAuth(slockHome).catch(() => null);
  if (!session?.accessToken) return null;
  const detect = deps.detectMigration ?? detectLegacyMigration;
  return await detect(
    slockHome,
    attachment.serverSlug,
    () => new LegacyMachinesClient(attachment.serverUrl, session.accessToken),
  ).catch(() => null);
}

function setupBlockingIdentityDetail(
  attachment: ServerAttachment,
  migration: MigrationDetection | null,
  runnerOk: boolean,
): string | null {
  if (!migration || migration.kind !== "zero_match") return null;
  // Historical daemon traces only constrain a future setup/adoption choice.
  // They are not a defect in an already-running attachment. Treating them as
  // a doctor failure made every healthy server in a shared SLOCK_HOME inherit
  // every unrelated legacy trace on that host (task #369 real macOS case).
  if (runnerOk) return null;
  if (!attachment.serverSlug) return null;
  const label = formatServerSlugDisplay(attachment.serverSlug);
  return (
    `setup would stop: this computer has local legacy evidence for ${label}, but none of it matches this server — ` +
    `run \`raft-computer doctor ${label} --migration-details\` before choosing fresh setup`
  );
}

async function regretSwitchDetail(
  slockHome: string,
  attachment: ServerAttachment,
  deps: DoctorDeps,
  migration: MigrationDetection | null,
  runnerOk: boolean,
): Promise<string | null> {
  if (!attachment.serverSlug) return null;
  let machinesResult: ServerMachinesResult;
  if (deps.listServerMachines) {
    machinesResult = await deps.listServerMachines(attachment);
  } else {
    const session = await readUserSessionAuth(slockHome).catch(() => null);
    if (!session?.accessToken) return null;
    machinesResult = await new ServerMachinesClient(attachment.serverUrl, session.accessToken).list(attachment.serverId);
  }
  if (machinesResult.status !== "success") return null;
  if (!migration || migration.kind !== "matched") return null;

  // Older attachment files may predate the linked machines.id field. A live,
  // connected runner is current runtime authority; absence of that optional
  // historical field cannot prove that the active Computer row is missing or
  // empty. Keep true regret detection below when machineId is present, but do
  // not turn an incomplete local projection into a RED diagnosis.
  if (!attachment.machineId && runnerOk) return null;

  const machines = new Map(machinesResult.machines.map((machine) => [machine.id, machine]));
  const current = attachment.machineId ? machines.get(attachment.machineId) ?? null : null;
  if (current !== null && current.agentCount !== 0) return null;
  const candidate = migration.candidates
    .map((legacy) => {
      const machine = machines.get(legacy.daemonId);
      return machine ? { legacy, machine } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> =>
      entry !== null &&
      entry.machine.id !== attachment.machineId &&
      entry.machine.agentCount > 0,
    )
    .sort((a, b) => b.machine.agentCount - a.machine.agentCount)[0];
  if (!candidate) return null;
  const label = formatServerSlugDisplay(attachment.serverSlug);
  if (current === null) {
    return (
      `saved Computer identity ${attachment.machineId ?? "(missing machine id)"} is not visible in the server Computers list yet, ` +
      `while your agents currently appear on "${candidate.machine.name}" ` +
      `(${candidate.machine.agentCount} agent${candidate.machine.agentCount === 1 ? "" : "s"}) — this can be a setup or migration reconciliation window. ` +
      `Do not delete any Computer from this diagnosis alone; wait briefly, rerun \`raft-computer doctor ${label}\`, and inspect ` +
      `\`raft-computer doctor ${label} --migration-details\` if it persists.`
    );
  }
  return (
    `you are connected as "${current.name}" (0 agents), but your agents currently appear on "${candidate.machine.name}" ` +
    `(${candidate.machine.agentCount} agent${candidate.machine.agentCount === 1 ? "" : "s"}) — this can be a setup or migration reconciliation window. ` +
    `Do not delete any Computer from this diagnosis alone; wait briefly, rerun \`raft-computer doctor ${label}\`, and inspect ` +
    `\`raft-computer doctor ${label} --migration-details\` if it persists.`
  );
}
