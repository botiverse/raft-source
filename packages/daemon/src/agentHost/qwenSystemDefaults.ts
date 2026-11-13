// Qwen Code's own background memory (auto-memory, auto-dream, auto-skill) is
// on by default and spends an extra model call after turns. A Raft agent
// already keeps its memory in MEMORY.md, so a Raft launch turns these off at
// Qwen's lowest settings layer, "system defaults" (Qwen merges system
// defaults < user < workspace < system): anyone who wants them back sets them
// in their own Qwen settings (Tenny, #proj-runtime:a5762001).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const QWEN_SYSTEM_DEFAULTS_PATH_ENV = "QWEN_CODE_SYSTEM_DEFAULTS_PATH";
export const QWEN_RAFT_SYSTEM_DEFAULTS_FILE = path.join("qwen", "system-defaults.json");

export const QWEN_RAFT_SYSTEM_DEFAULTS = {
  memory: {
    enableManagedAutoMemory: false,
    enableManagedAutoDream: false,
    enableAutoSkill: false,
  },
} as const;

/** Where Qwen Code 0.26 reads system defaults when the env var is not set (its getSystemDefaultsPath). */
export function qwenPlatformSystemDefaultsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/QwenCode/system-defaults.json";
  if (platform === "win32") return "C:\\ProgramData\\qwen-code\\system-defaults.json";
  return "/etc/qwen-code/system-defaults.json";
}

/**
 * The launch env with Raft's system defaults for Qwen, or unchanged when
 * someone already chose them: the launch env (agent settings, machine env)
 * names a system-defaults file, or the machine has one at Qwen's own path.
 */
export function withQwenRaftSystemDefaults(
  launchEnv: NodeJS.ProcessEnv,
  raftHome: string,
  deps: { exists?: (file: string) => boolean; write?: (file: string, content: string) => void; platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const exists = deps.exists ?? existsSync;
  if (launchEnv[QWEN_SYSTEM_DEFAULTS_PATH_ENV]?.trim()) return launchEnv;
  if (exists(qwenPlatformSystemDefaultsPath(deps.platform))) return launchEnv;
  const file = path.join(raftHome, QWEN_RAFT_SYSTEM_DEFAULTS_FILE);
  const write = deps.write ?? ((target: string, content: string) => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  });
  write(file, `${JSON.stringify(QWEN_RAFT_SYSTEM_DEFAULTS, null, 2)}\n`);
  return { ...launchEnv, [QWEN_SYSTEM_DEFAULTS_PATH_ENV]: file };
}
