import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readPlainSmallFile } from "../agentStateFiles";

/**
 * Pi reads more than models.json from a Built-in agent's workspace
 * (piBuiltInModelsJson.ts): `.builtin-runtime/` is Pi's agent dir and the
 * workspace is its project dir, and the agent writes both. In the daemon
 * process, where Raft holds the provider key it seeds, that would let the
 * agent:
 * - load code: Pi imports every extension in `<agentDir>/extensions/` and
 *   `.pi/extensions/`, and those a settings file names;
 * - run commands with the daemon's env: a settings file's `packages` are
 *   installed (`npmCommand`), and an `auth.json` key may be `!command` or
 *   `$VAR`.
 * So a Built-in session loads no extension but the daemon's own and the
 * host ones its owner opted into (`noExtensions` keeps Pi's
 * `additionalExtensionPaths`), reads settings without those keys, and keeps
 * credentials in pi-ai's in-memory store: Raft seeds every key it uses
 * (seedPiSessionModelRuntime).
 *
 * The Pi runtime runs the owner's own Pi: its agent dir is the host's
 * (`~/.pi/agent`), and its auth, models, settings and extensions apply. Only
 * the workspace, which the agent writes, is held to the same rule: its
 * extensions do not load and its settings lose the dropped keys. The rest of
 * the workspace's `.pi/` (skills, prompts, other settings) applies as
 * before: none of it runs code.
 */

/** Settings keys that load or install code; dropped from a Built-in session's settings. */
export const BUILTIN_DROPPED_SETTINGS_KEYS = ["packages", "extensions", "npmCommand"] as const;

const SETTINGS_MAX_BYTES = 1024 * 1024;

/**
 * A settings file's text without the dropped keys; undefined when missing or
 * too large. Text that is not a JSON object passes through as is, so Pi
 * reports its load error as before (and loads no setting from it).
 */
export function readBuiltInSettingsText(file: string): string | undefined {
  const raw = readPlainSmallFile(file, SETTINGS_MAX_BYTES);
  if (raw === null) return undefined;
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text;
  const kept = Object.entries(parsed).filter(([key]) => !(BUILTIN_DROPPED_SETTINGS_KEYS as readonly string[]).includes(key));
  return JSON.stringify(Object.fromEntries(kept));
}

/**
 * What the agent's workspace asks Pi to load that Raft no longer does
 * (#14771, #14773): extensions under `.pi/extensions`, and the code keys of
 * `.pi/settings.json`. A model only they defined is missing from the session
 * (#proj-raft-computer:1bfb0122); the start failure says where it went.
 * Names only, never contents.
 */
export function ignoredWorkspacePiCode(workingDirectory: string): string[] {
  const found: string[] = [];
  try {
    const extensions = path.join(workingDirectory, CONFIG_DIR_NAME, "extensions");
    if (statSync(extensions).isDirectory() && readdirSync(extensions).length > 0) found.push(`${CONFIG_DIR_NAME}/extensions`);
  } catch {
    // none
  }
  const raw = readPlainSmallFile(path.join(workingDirectory, CONFIG_DIR_NAME, "settings.json"), SETTINGS_MAX_BYTES);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const key of BUILTIN_DROPPED_SETTINGS_KEYS) {
          if (key in parsed) found.push(`${CONFIG_DIR_NAME}/settings.json ${key}`);
        }
      }
    } catch {
      // not JSON: Pi reports it
    }
  }
  return found;
}

/**
 * The session's settings: a snapshot of the agent dir's and the workspace's
 * settings files, read once without the dropped keys. Pi's own writes stay
 * in memory; nothing is written back to the workspace.
 */
export function createBuiltInSettingsManager(workingDirectory: string, agentDir: string): SettingsManager {
  const contents = {
    global: readBuiltInSettingsText(path.join(agentDir, "settings.json")),
    project: readBuiltInSettingsText(path.join(workingDirectory, CONFIG_DIR_NAME, "settings.json")),
  };
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      const next = fn(contents[scope]);
      if (next !== undefined) contents[scope] = next;
    },
  });
}

type PiSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

/**
 * The Pi runtime's settings: the host agent dir's file through Pi's own file
 * storage (its lock keeps a concurrent `pi` CLI write whole), and the
 * workspace's `.pi/settings.json` without the dropped keys, read fresh on
 * every load; Pi's writes to the workspace scope stay in memory.
 */
export function createPiRuntimeSettingsManager(workingDirectory: string, agentDir: string): SettingsManager {
  // Pi exports only SettingsManager; its file storage is the manager's own field.
  const hostStorage = (SettingsManager.create(workingDirectory, agentDir, { projectTrusted: false }) as unknown as { storage?: PiSettingsStorage }).storage;
  if (!hostStorage) throw new Error("Pi's SettingsManager no longer holds its file storage in `storage`");
  const projectFile = path.join(workingDirectory, CONFIG_DIR_NAME, "settings.json");
  let projectWritten: string | undefined;
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      if (scope === "global") {
        hostStorage.withLock("global", fn);
        return;
      }
      const next = fn(projectWritten ?? readBuiltInSettingsText(projectFile));
      if (next !== undefined) projectWritten = next;
    },
  });
}
