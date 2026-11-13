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
import { buildStatusReport, type StatusReportDeps } from "./status";
import { describeDuplicateKeyHolder, findDuplicateKeyHolder } from "./duplicateKeyGuard";
import { describeRaftHomeConflict, findRaftHomeConflictFor, serverRunnerLockConflictPath, serverRunnerMemoryPath, serviceMemoryPath } from "./paths";
import { lockOwnerCheckCommand, readRunnerLockConflictMarker } from "./runnerLockConflict";
import { buildLockConflictMessage } from "./services/start";
import { describeRunnerMemory, readRunnerMemorySample } from "./runnerMemory";
import type { ServerStatusRow } from "./status";
import {
  ComputerAttachClient,
  ComputerSelfClient,
  LegacyMachinesClient,
  ServerMachinesClient,
  type ComputerSelfResult,
  type ServerMachinesResult,
} from "./apiClient";
import { detectLegacyMigration, type LegacyMachineRosterClientFactory } from "./lib/migration";
import type { MigrationDetection } from "./lib/types";
import { readUserSessionAuth } from "./lib/userSession";
import { describeOomPolicyRequirement, readSupervisorOomPolicy } from "./externalSupervisor";
import type { ServerAttachment } from "./serverState";
import { formatServerSlugDisplay, listServerAttachments } from "./serverState";
import { hasUnlinkedComputerHandshake, readRunnerLogTail } from "./internal/runner-log-diagnostics";

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

interface DoctorDeps extends StatusReportDeps {
  /** task #914 seam: another live service on this host holding the same machine key. */
  findDuplicateKeyHolder?: typeof findDuplicateKeyHolder;
  /** task #915 seam: both default homes hold Raft data and nothing picks one. */
  findRaftHomeConflict?: typeof findRaftHomeConflictFor;
  detectMigration?: (
    slockHome: string,
    serverSlug: string,
    clientFactory: LegacyMachineRosterClientFactory,
  ) => Promise<MigrationDetection>;
  listServerMachines?: (attachment: ServerAttachment) => Promise<ServerMachinesResult>;
  /** How the server sees this Computer, read with its own key (GET /internal/computer/self). */
  readComputerSelf?: (attachment: ServerAttachment) => Promise<ComputerSelfResult>;
  readSupervisorOomPolicy?: typeof readSupervisorOomPolicy;
}

/**
 * The "this Computer on the server" check, by the attachment's own
 * sk_computer_* key (device-auth PR 3c), so it needs no user session. An
 * older server without the route is a note, not a failure.
 */
function computerSelfCheck(
  attachment: ServerAttachment,
  label: string,
  self: ComputerSelfResult,
): DoctorCheck {
  const name = `computer ${label}`;
  if (self.status === "route_unavailable") {
    return { name, ok: true, detail: "skipped (this server is older and cannot answer it with this machine's key)" };
  }
  if (self.status === "unauthorized") {
    return { name, ok: false, detail: `server refused this Computer's key (${self.code}) — see the preflight line above` };
  }
  if (self.status === "error") {
    return { name, ok: false, detail: `could not read how the server sees this Computer (${self.code}) — check serverUrl / network` };
  }
  const { computer } = self;
  if (attachment.machineId && attachment.machineId !== computer.machineId) {
    return {
      name,
      ok: false,
      detail:
        `the server ties this key to machine ${computer.machineId}, but the local attachment says ${attachment.machineId} — ` +
        `run \`raft-computer doctor ${label} --migration-details\` before changing anything`,
    };
  }
  const agents = `${computer.agentCount} agent${computer.agentCount === 1 ? "" : "s"}`;
  // A server-set display name: no control characters reach the terminal.
  const machineName = computer.machineName.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return { name, ok: true, detail: `the server knows this Computer as "${machineName}" (${agents})` };
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

/**
 * What to do about a runner that runs but is not connected. One the service
 * started is restarted by `start`. A lock owner the service deferred to is
 * not: `start` and `restart` never touch it.
 */
function notConnectedAdvice(server: ServerStatusRow, label: string, serviceRunning: boolean): string {
  const pid = server.daemon.running ? server.daemon.pid : 0;
  const afterEnding = serviceRunning
    ? `ending pid ${pid} lets the Computer service start a new one`
    : `end pid ${pid}, then run \`raft-computer start ${label}\``;
  switch (server.deferredOwner) {
    case undefined:
      return `restart with \`raft-computer start ${label}\``;
    case "own-runner":
      return `this runner was started by an earlier Computer service and cannot be restarted from here: ${afterEnding}`;
    // Its start could not be read: nothing says what it is, only that this service did not start it.
    case "unread":
      return (
        `pid ${pid} holds this machine's daemon lock and was not started by this Computer service, so it cannot be restarted from here: ` +
        `check it with ${lockOwnerCheckCommand(pid)}; if it is this server's runner, ${afterEnding}`
      );
    // Not shown as running (status.ts): listed so a new identity cannot fall through.
    case "another-program":
    case "unknown":
      return `check pid ${pid} with ${lockOwnerCheckCommand(pid)}`;
  }
}

async function runnerDetail(slockHome: string, server: ServerStatusRow, serviceRunning: boolean): Promise<{ ok: boolean; detail: string }> {
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
  if (server.lockHeldByPid !== undefined) {
    // What `start` says when the service defers: who holds the lock, how to check that process, and the way back.
    const lockPath = readRunnerLockConflictMarker(serverRunnerLockConflictPath(slockHome, server.serverId))?.lockPath ?? null;
    return {
      ok: false,
      detail: buildLockConflictMessage(
        slockHome,
        [{ code: "runner-lock-conflict", serverId: server.serverId, ownerPid: server.lockHeldByPid, lockPath }],
        { serverId: server.serverId, serverLabel: label },
        !serviceRunning,
      ),
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
      detail: `process running (pid ${server.daemon.pid}) but not connected to the server — ${logHint}; ${notConnectedAdvice(server, label, serviceRunning)}`,
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
  const report = await buildStatusReport(slockHome, opts);
  const checks: DoctorCheck[] = [];

  checks.push({ name: "SLOCK_HOME", ok: true, detail: report.slockHome });

  // task #915: the home above may be a guess between two that hold Raft data.
  const homeConflict = (opts.findRaftHomeConflict ?? findRaftHomeConflictFor)(slockHome);
  if (homeConflict) {
    checks.push({ name: "Raft home", ok: false, detail: describeRaftHomeConflict(homeConflict) });
  }

  // task #914: two services on one key make the server send commands to
  // either of them. Name the other holder so the owner can stop or re-bind.
  const duplicateHolder = await (opts.findDuplicateKeyHolder ?? findDuplicateKeyHolder)(slockHome);
  checks.push(
    duplicateHolder
      ? { name: "machine key holders", ok: false, detail: describeDuplicateKeyHolder(duplicateHolder) }
      : { name: "machine key holders", ok: true, detail: "no other live Computer service on this host holds this machine key" },
  );

  // A machine attached by one-time approval keeps no user session: its
  // per-server sk_computer_* key is what it runs on. A missing or unusable
  // session only fails doctor when nothing is attached at all.
  const allAttachments = await listServerAttachments(slockHome);
  const attachedWithMachineKey = allAttachments.some((a) => a.apiKey.startsWith("sk_computer_"));
  const sessionUsable = report.loggedIn && !report.userSessionError;
  checks.push(
    sessionUsable
      ? { name: "user session", ok: true, detail: `logged in (user ${report.userId ?? "?"})` }
      : attachedWithMachineKey
      ? { name: "user session", ok: true, detail: "not needed (attached with this machine's key)" }
      : report.userSessionError
      ? { name: "user session", ok: false, detail: "invalid user session file — run `raft-computer attach /<serverSlug>`" }
      : { name: "user session", ok: false, detail: "not attached to any server — run `raft-computer attach /<serverSlug>`" },
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
  if (report.service.running) {
    checks.push({
      name: "service memory",
      ok: true,
      detail: describeRunnerMemory(
        await readRunnerMemorySample(serviceMemoryPath(slockHome)),
        report.service.pid,
        Date.now(),
        "service",
      ),
    });
    // The record is trusted only when it names the running service. `stop`
    // and `kill` both end every process in the unit when one agent is OOM-killed.
    const oom = await (opts.readSupervisorOomPolicy ?? readSupervisorOomPolicy)(slockHome).catch(() => null);
    if (oom?.record.pid === report.service.pid && (oom.oomPolicy === "stop" || oom.oomPolicy === "kill")) {
      checks.push({ name: "service OOM policy", ok: false, detail: describeOomPolicyRequirement(oom) });
    }
  }

  // Per-server preflight loop (contract v4 §9): isolated per serverId,
  // uses THAT server's own sk_computer_*; never a shared key.
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
  // The legacy-daemon roster and the server's Computers list below are
  // user-session routes (machine-key versions come in PR 3c). Without a
  // session they are skipped with one note, never failed.
  if (!sessionUsable) {
    checks.push({
      name: "legacy migration checks",
      ok: true,
      detail: "skipped (they need a user session, which this machine does not keep)",
    });
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
    // Older attachments hold a legacy machine key, which this route refuses.
    const self: ComputerSelfResult | null = a.apiKey.startsWith("sk_computer_")
      ? await (opts.readComputerSelf
        ?? ((attachment: ServerAttachment) => new ComputerSelfClient(attachment.serverUrl, attachment.apiKey).self()))(a)
        .catch((): ComputerSelfResult => ({ status: "error", code: "request_failed" }))
      : null;
    if (self) checks.push(computerSelfCheck(a, label, self));
    let runnerOk = false;
    if (statusRow) {
      const runner = await runnerDetail(slockHome, statusRow, report.service.running);
      runnerOk = runner.ok;
      checks.push({
        name: `runner ${label}`,
        ok: runner.ok,
        detail: runner.detail,
      });
      // Informational: memory never fails doctor.
      if (statusRow.daemon.running) {
        const sample = await readRunnerMemorySample(serverRunnerMemoryPath(slockHome, a.serverId));
        checks.push({
          name: `memory ${label}`,
          ok: true,
          detail: describeRunnerMemory(sample, statusRow.daemon.pid, Date.now()),
        });
      }
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
    const regret = await regretSwitchDetail(slockHome, a, opts, migration, runnerOk, self);
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
  self: ComputerSelfResult | null = null,
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
  // This Computer's own row comes from its own key when the server can answer
  // (GET /internal/computer/self); the legacy candidates below still come
  // from the person's roster and Computers list.
  const ownRow = self?.status === "success" && self.computer.machineId === attachment.machineId
    ? { id: self.computer.machineId, name: self.computer.machineName, agentCount: self.computer.agentCount }
    : null;
  const current = ownRow ?? (attachment.machineId ? machines.get(attachment.machineId) ?? null : null);
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
