import { createHash } from "node:crypto";
import path from "node:path";

/**
 * What the agent credential proxy remembers about a launch whose proxy token
 * it unregistered (#proj-raft-computer:#58): a process that outlived its
 * session keeps calling that launch's wrapper, and must learn why it fails
 * and where the agent's stable entry is, not see a bare "invalid token".
 *
 * A record holds no credential: the token is kept only as a hash, and a
 * retired token never authorizes anything again. It only selects which
 * refusal the proxy answers.
 */
export type RetiredLaunch = {
  agentId: string;
  launchId: string | null;
  /** The agent's stable entry wrapper, when the launch's transport wrote one. */
  stableEntryPath: string | null;
};

/** Enough for every launch a long-running daemon retires between restarts; the oldest record goes first. */
const RETIRED_LAUNCH_LIMIT = 4_096;
const retiredLaunches = new Map<string, RetiredLaunch>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function rememberRetiredLaunch(token: string, launch: RetiredLaunch): void {
  const key = tokenKey(token);
  retiredLaunches.delete(key);
  retiredLaunches.set(key, launch);
  while (retiredLaunches.size > RETIRED_LAUNCH_LIMIT) {
    const oldest = retiredLaunches.keys().next().value;
    if (oldest === undefined) break;
    retiredLaunches.delete(oldest);
  }
}

export function retiredLaunchForToken(token: string): RetiredLaunch | null {
  if (!token) return null;
  return retiredLaunches.get(tokenKey(token)) ?? null;
}

export function __resetRetiredLaunchesForTest(): void {
  retiredLaunches.clear();
}

export type LocalProxyRefusal = {
  status: number;
  body: {
    error: string;
    code: "launch_superseded" | "agent_not_running" | "agent_proxy_agent_mismatch";
    suggestedNextAction: string;
    stableEntry?: string;
  };
};

function stableEntryInstruction(stableEntryPath: string | null): string {
  if (!stableEntryPath) {
    return "call raft through the agent's stable entry, `cli-transport/<agent id>/current/raft` under the Raft home, instead of `raft`";
  }
  return `run \`${stableEntryPath} <command>\` instead of \`raft <command>\`, or put \`${path.dirname(stableEntryPath)}\` first on that process's PATH`;
}

/**
 * The request's launch ended and a newer launch of the same agent is live.
 * Names only the stable entry: never the newer launch or its credential.
 */
export function launchSupersededRefusal(stableEntryPath: string | null): LocalProxyRefusal {
  return {
    status: 410,
    body: {
      error: "This command ran through the Raft transport of a session of this agent that has ended; a newer session replaced it. Nothing was sent.",
      code: "launch_superseded",
      suggestedNextAction:
        "A process that outlives its session (nohup, a background job) must call raft through the agent's stable entry, "
        + `which always uses the agent's current session: ${stableEntryInstruction(stableEntryPath)}. Then run the command again.`,
      ...(stableEntryPath ? { stableEntry: stableEntryPath } : {}),
    },
  };
}

/** The request's launch ended and the agent has no live launch on this Computer (stopped, deleted, removed, or the Computer revoked). */
export function agentNotRunningRefusal(stableEntryPath: string | null): LocalProxyRefusal {
  return {
    status: 410,
    body: {
      error: "This agent has no running session on this Computer, so its Raft transport is closed. Nothing was sent.",
      code: "agent_not_running",
      suggestedNextAction:
        "Run the command again once the agent is running. A process that keeps working across the agent's sessions "
        + `must ${stableEntryInstruction(stableEntryPath)}; that entry works only while the agent has a running session.`,
      ...(stableEntryPath ? { stableEntry: stableEntryPath } : {}),
    },
  };
}

/** A stable-entry request named another agent than its credential's. */
export function stableEntryAgentMismatchRefusal(): LocalProxyRefusal {
  return {
    status: 403,
    body: {
      error: "This stable-entry request names a different agent than the session credential it carries. Nothing was sent.",
      code: "agent_proxy_agent_mismatch",
      suggestedNextAction:
        "Call the stable entry of the agent this process belongs to, and leave SLOCK_AGENT_ID as that entry sets it.",
    },
  };
}
