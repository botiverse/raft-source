import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getDaemonMachineLockId } from "./machineLock.js";
import {
  detectLegacyDaemonSupervisor,
  legacyDaemonSupervisorFallbackCommands,
  type LegacyDaemonSupervisorGuidance,
} from "./legacySupervisor.js";

interface AdoptedComputerMatch {
  attachmentPath: string;
  serverId: string;
  serverSlug?: string;
  serverMachineId?: string;
}

export class LegacyDaemonKeyAdoptedByComputerError extends Error {
  readonly code = "LEGACY_DAEMON_KEY_ADOPTED_BY_COMPUTER";
  readonly attachmentPath: string;
  readonly serverId: string;

  constructor(
    match: AdoptedComputerMatch,
    supervisor: LegacyDaemonSupervisorGuidance | null = detectLegacyDaemonSupervisor() ??
      null,
  ) {
    const serverDisplay = match.serverSlug
      ? `/${match.serverSlug}`
      : match.serverId;
    const startCommand = match.serverSlug
      ? `raft-computer start /${match.serverSlug}`
      : "raft-computer start";
    const statusCommand = match.serverSlug
      ? `raft-computer status /${match.serverSlug}`
      : "raft-computer status";
    const supervisorGuidance = formatSupervisorGuidance(
      supervisor ?? undefined,
    );
    super(
      `Legacy Raft daemon startup refused: this machine key was already migrated to Raft Computer for ${serverDisplay}.\n` +
        `Raft Computer now owns this connection; do not restart raft-daemon with the migrated key.\n` +
        `${supervisorGuidance}\n` +
        `Then start and verify Raft Computer:\n  ${startCommand}\n  ${statusCommand}`,
    );
    this.name = "LegacyDaemonKeyAdoptedByComputerError";
    this.attachmentPath = match.attachmentPath;
    this.serverId = match.serverId;
  }
}

function formatSupervisorGuidance(
  supervisor: LegacyDaemonSupervisorGuidance | undefined,
): string {
  if (supervisor) {
    return (
      `${supervisor.detail}\n` +
      `Remove the old supervisor entry so it cannot auto-restart:\n` +
      supervisor.cleanupCommands.map((command) => `  ${command}`).join("\n")
    );
  }
  return (
    `If a process manager keeps restarting the old daemon, remove the entry you configured:\n` +
    legacyDaemonSupervisorFallbackCommands
      .map((command) => `  ${command}`)
      .join("\n")
  );
}

function daemonApiKeyFingerprint(apiKey: string): string {
  return getDaemonMachineLockId(apiKey).slice("machine-".length);
}

function findAdoptedComputerForLegacyFingerprint(
  slockHome: string,
  legacyApiKeyFingerprint: string,
): AdoptedComputerMatch | null {
  const serversDir = path.join(slockHome, "computer", "servers");
  if (!existsSync(serversDir)) return null;

  let serverDirs: string[];
  try {
    serverDirs = readdirSync(serversDir);
  } catch {
    return null;
  }

  for (const serverId of serverDirs) {
    const attachmentPath = path.join(serversDir, serverId, "runner.state.json");
    let raw: string;
    try {
      raw = readFileSync(attachmentPath, "utf8");
    } catch {
      continue;
    }

    try {
      const attachment = JSON.parse(raw) as Record<string, unknown>;
      if (
        attachment.kind === "computer-attachment" &&
        attachment.adoptedFromLegacy === true &&
        attachment.legacyApiKeyFingerprint === legacyApiKeyFingerprint
      ) {
        return {
          attachmentPath,
          serverId:
            typeof attachment.serverId === "string" &&
            attachment.serverId.length > 0
              ? attachment.serverId
              : serverId,
          serverSlug:
            typeof attachment.serverSlug === "string" &&
            attachment.serverSlug.length > 0
              ? attachment.serverSlug
              : undefined,
          serverMachineId:
            typeof attachment.serverMachineId === "string" &&
            attachment.serverMachineId.length > 0
              ? attachment.serverMachineId
              : undefined,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function assertLegacyDaemonKeyNotAdoptedByComputer(options: {
  slockHome: string;
  apiKey: string;
}): void {
  const legacyApiKeyFingerprint = daemonApiKeyFingerprint(options.apiKey);
  const match = findAdoptedComputerForLegacyFingerprint(
    options.slockHome,
    legacyApiKeyFingerprint,
  );
  if (match) throw new LegacyDaemonKeyAdoptedByComputerError(match);
}
