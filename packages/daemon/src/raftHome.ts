import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

export const SLOCK_HOME_ENV = "SLOCK_HOME";
export const RAFT_HOME_ENV = "RAFT_HOME";

export function resolveDefaultRaftHome(homeDir: string = os.homedir()): string {
  return path.resolve(path.join(homeDir, ".slock"));
}

export function resolveRaftHome(
  env: Partial<Pick<NodeJS.ProcessEnv, typeof SLOCK_HOME_ENV | typeof RAFT_HOME_ENV>> = process.env,
  homeDir: string = os.homedir(),
): string {
  // RAFT_HOME wins over legacy SLOCK_HOME, matching @botiverse/raft (cli) and
  // @botiverse/raft-computer precedence. Only machines that set BOTH variables
  // to different values see a behavior change.
  const raw = env[RAFT_HOME_ENV]?.trim() || env[SLOCK_HOME_ENV]?.trim();
  const root = raw && raw.length > 0 ? raw : resolveDefaultRaftHome(homeDir);
  return path.resolve(root);
}

export function resolveRaftHomePath(
  childPath: string,
  raftHome: string = resolveRaftHome(),
): string {
  return path.join(raftHome, childPath);
}

export interface LegacyRaftStatePath {
  path: string;
  destination: string;
  description: string;
}

export function listLegacyRaftStatePaths(
  raftHome: string = resolveRaftHome(),
  homeDir: string = os.homedir(),
): LegacyRaftStatePath[] {
  const defaultHome = resolveDefaultRaftHome(homeDir);
  if (path.resolve(raftHome) === defaultHome) return [];

  const candidates: LegacyRaftStatePath[] = [
    {
      path: path.join(defaultHome, "agents"),
      destination: path.join(raftHome, "agents"),
      description: "agent workspaces and per-agent runtime wrapper state",
    },
    {
      path: path.join(defaultHome, "machines"),
      destination: path.join(raftHome, "machines"),
      description: "daemon machine locks, local traces, and machine-scoped state",
    },
    {
      path: path.join(defaultHome, "attachments"),
      destination: path.join(raftHome, "attachments"),
      description: "chat bridge attachment download cache",
    },
  ];

  return candidates.filter((candidate) => existsSync(candidate.path));
}
