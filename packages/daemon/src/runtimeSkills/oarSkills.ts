import { createHash } from "node:crypto";
import path from "node:path";

import type { AvailableInstallation, InventoryReader, InventoryResult, SkillEntry } from "@botiverse/oar";
import { clearClockTimeout, setClockTimeout, type SkillInfo } from "@botiverse/raft-shared";

import { logger } from "../logger";
import { cursorAuthEnv } from "../agentHost/oarCursorLaunch";
import { ANTIGRAVITY_ENV_OVERRIDES, openCodeWorkspaceProcessEnv } from "../drivers";
import { loadOarRuntime } from "../oarLoader";

/**
 * An agent's skill list read through OAR's skills inventory
 * (`runtime.skills(installation, { cwd })`), for the runtimes whose OAR
 * adapter implements it and that the daemon loads through `oarLoader`
 * (Antigravity, Claude Code, Codex, Cursor, Grok, Kimi, OpenCode). Raft
 * reads skills only this way: no folder scan of its own (xxchan,
 * #oar-raft:7e06ebc9). A failed read (no installation, `unsupported`,
 * `unavailable`, our deadline, a throw) is reported as unavailable with its
 * reason, never filled in from elsewhere.
 *
 * Cost: Claude's reader starts a short `claude` process (its
 * `get_context_usage` control request), which can start the user's MCP
 * servers, and Codex's starts an app-server. So one read per (agent,
 * runtime) runs at a time, joined by every caller meanwhile, and a successful
 * read is kept for `ttlMs`. Kimi's starts `kimi web` on 127.0.0.1 (no
 * session or prompt); it registers the workspace and removes it after, but a
 * read cut off by the deadline can leave that registration in Kimi's web UI.
 *
 * OpenCode's starts `opencode serve` in the workspace, so it gets the
 * launch's config isolation (drivers/opencode.ts openCodeWorkspaceProcessEnv:
 * no project config, an empty config dir, no `plugin` list in the agent's
 * OPENCODE_CONFIG_CONTENT): a plugin the agent
 * wrote into its workspace must not run here when the agent's own sessions
 * never load it. 1.x is read with `opencode debug skill`, which starts no
 * server, in the agent's own env.
 *
 * Cursor's (OAR 0.113) reads the SDK's skill folders under the workspace and
 * the child's HOME, with no SDK import, session, hook, MCP server or model
 * request; to find nested roots it runs `git rev-parse` in the workspace and,
 * in a repository, the SDK's bundled ripgrep over it (bounded by our
 * deadline). It gets a Cursor session child's environment without
 * `CURSOR_API_KEY` (oarCursorLaunch.ts `cursorAuthEnv`; the read needs no key,
 * and sessions keep it out of child environments too), so it reads the same
 * HOME. Where the SDK is absent (a single-file build) the load throws: folder
 * scan.
 *
 * Antigravity's (OAR 0.113+) runs `agy models` to check the sign-in, then
 * `agy --print=/skills` in the workspace: agy's own list, built-in skills and
 * its `disable-slash-command` filter included. It gets the launch's
 * environment (drivers/antigravity.ts ANTIGRAVITY_ENV_OVERRIDES, as
 * the model listing does): no SSH variables, so agy reads the sign-in its
 * agents run on, plus the agent's env vars; and the same workspace, whose
 * `.agents` config the agent's sessions read too. OAR refuses a HOME that is
 * not agy's default (`scope_unavailable`): then nothing is listed. Raft has
 * no other source for it: OAR's list is the list.
 * The other readers OAR 0.113 added (Devin, DSH, Factory) start a native
 * process in the workspace, so they join only with their launch's isolation
 * here.
 */
export type OarSkillsRuntimeId = "antigravity" | "claude" | "codex" | "cursor" | "grok" | "kimi" | "opencode";

const OAR_SKILLS_RUNTIMES: ReadonlySet<string> = new Set<OarSkillsRuntimeId>(["antigravity", "claude", "codex", "cursor", "grok", "kimi", "opencode"]);

export function isOarSkillsRuntime(runtime: string): runtime is OarSkillsRuntimeId {
  return OAR_SKILLS_RUNTIMES.has(runtime);
}

export interface RuntimeSkillLists {
  global: SkillInfo[];
  workspace: SkillInfo[];
  /** Skills the runtime itself ships; only from an OAR read. */
  builtin?: SkillInfo[];
  /** OAR could not read this runtime's skills: why (a short code, e.g. `deadline`, `unsupported:version_unsupported`). The lists are empty. */
  unavailable?: { reason: string };
}

/** What an OAR read gives a caller: the lists, or why there are none. */
export type OarSkillsOutcome = { kind: "ok"; lists: RuntimeSkillLists } | { kind: "unavailable"; reason: string };

/** The runtime's skills reader and an available installation, or null when there is none. */
export type OarSkillsSourceResolver = (
  runtime: OarSkillsRuntimeId,
  env: Record<string, string> | undefined,
) => Promise<{ read: InventoryReader<SkillEntry>; installation: AvailableInstallation } | null>;

export interface OarSkillsRequest {
  agentId: string;
  runtime: string;
  /** The agent's workspace: the reader's cwd, and what counts as a workspace skill. */
  workspaceDir: string;
  /** Shortened to `~` in source paths. */
  homeDir: string;
  /** Overlay on the daemon's environment (the agent's env vars, its runtime home). */
  env?: Record<string, string>;
  /** The Raft home (OpenCode's empty config dir lives there); the daemon's when absent. */
  slockHome?: string;
}

/**
 * What the read adds to the env so it sees what the agent's own sessions see,
 * or null when it cannot be made to (then: unavailable). Added last, as the
 * launch adds it after the agent's env vars.
 */
export type OarSkillsLaunchEnv = (
  runtime: OarSkillsRuntimeId,
  installation: AvailableInstallation,
  slockHome: string | undefined,
  agentEnv: Readonly<Record<string, string>> | undefined,
) => Record<string, string | null> | null;

export const defaultLaunchEnv: OarSkillsLaunchEnv = (runtime, installation, slockHome, agentEnv) => {
  if (runtime === "antigravity") {
    // As a launch: agy keeps a separate sign-in under SSH, which its agents never read.
    return { NO_COLOR: "1", ...Object.fromEntries(Object.keys(ANTIGRAVITY_ENV_OVERRIDES).map((name) => [name, null])) };
  }
  if (runtime === "cursor") {
    const env = cursorAuthEnv(agentEnv);
    delete env.CURSOR_API_KEY;
    return env;
  }
  if (runtime !== "opencode") return {};
  // 2.x: OAR starts `opencode serve` in the workspace, so it gets the
  // launch's config isolation. 1.x: OAR runs `opencode debug skill` (no
  // server; Cindy 164cbd44), read in the agent's own env.
  return openCodeWorkspaceProcessEnv(installation.via === "executable" ? installation.version : undefined, slockHome, agentEnv) ?? {};
};

export const OAR_SKILLS_TIMEOUT_MS = 20_000;
export const OAR_SKILLS_CACHE_TTL_MS = 5 * 60_000;

type Group = "builtin" | "workspace" | "global";

/** A stable digest of the env overlay, for the cache key only (never logged). */
function envKey(env: Readonly<Record<string, string | null>> | undefined): string {
  if (!env) return "";
  const sorted = Object.keys(env).sort().map((name) => [name, env[name]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

function isInside(dir: string, target: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

/** The entry's path when it is an absolute file path (not a URI such as OpenCode's `skill://…`). */
function fileSystemPath(entry: SkillEntry): string | undefined {
  return entry.path && path.isAbsolute(entry.path) ? entry.path : undefined;
}

/**
 * OAR's `scope` (0.112+, mapped by each runtime from its own classification)
 * decides the group. Without one (`other`, or a source OAR does not map, such
 * as a Claude plugin skill): a path inside the workspace is a workspace
 * skill; any other path, or none, global.
 */
export function classifyOarSkill(entry: SkillEntry, workspaceDir: string): Group {
  switch (entry.scope) {
    case "builtin":
      return "builtin";
    case "project":
      return "workspace";
    case "user":
    case "managed":
      return "global";
    default:
      break;
  }
  const filePath = fileSystemPath(entry);
  return filePath && isInside(workspaceDir, filePath) ? "workspace" : "global";
}

/** The directory the skill was found in (`…/skills` for `…/skills/<name>/SKILL.md`). */
function sourceDirOf(skillPath: string): string {
  const dir = path.dirname(skillPath);
  return path.basename(skillPath) === "SKILL.md" ? path.dirname(dir) : dir;
}

function shortenHome(dir: string, homeDir: string): string {
  return homeDir && isInside(homeDir, dir) ? "~" + path.resolve(dir).slice(path.resolve(homeDir).length) : dir;
}

/**
 * OAR entries as Raft's lists, as OAR reports them: nothing is added from
 * Raft's own reading of the runtime's folders (xxchan, #oar-raft:7e06ebc9).
 * Fields OAR does not report stay at their plain value: the name as display
 * name, no description. `userInvocable` is true only where OAR says so
 * (absent is unknown, Cindy fc4657fb; of the runtimes read here, OAR 0.120
 * reports it for Claude and Grok), so the `/name` badge never claims a
 * command the runtime doesn't list. Disabled entries (`enabled: false`, Codex) are dropped: the
 * runtime will not use them. First occurrence of a name wins within a group.
 */
export function mapOarSkills(
  entries: readonly SkillEntry[],
  request: Pick<OarSkillsRequest, "workspaceDir" | "homeDir">,
): Required<Pick<RuntimeSkillLists, "builtin" | "global" | "workspace">> {
  const lists = { builtin: [] as SkillInfo[], global: [] as SkillInfo[], workspace: [] as SkillInfo[] };
  const seen = { builtin: new Set<string>(), global: new Set<string>(), workspace: new Set<string>() };
  for (const entry of entries) {
    if (entry.enabled === false || !entry.name) continue;
    const group = classifyOarSkill(entry, request.workspaceDir);
    if (seen[group].has(entry.name)) continue;
    seen[group].add(entry.name);
    const filePath = fileSystemPath(entry);
    const sourcePath = filePath ? shortenHome(sourceDirOf(filePath), request.homeDir) : undefined;
    lists[group].push({
      name: entry.name,
      displayName: entry.name,
      description: entry.description ?? "",
      userInvocable: entry.userInvocable === true,
      ...(sourcePath ? { sourcePath } : {}),
    });
  }
  return lists;
}

const defaultResolveSource: OarSkillsSourceResolver = async (runtime, env) => {
  const oarRuntime = await loadOarRuntime(runtime);
  if (!oarRuntime.installation) return null;
  const installation = await oarRuntime.installation(env ? { env } : undefined);
  if (installation.kind !== "available") return null;
  return { read: oarRuntime.skills, installation };
};

type ReadOutcome = { kind: "ok"; items: readonly SkillEntry[]; partial: boolean } | { kind: "skipped"; reason: string };

const DEADLINE = Symbol("deadline");

export class OarSkillCatalog {
  private readonly resolveSource: OarSkillsSourceResolver;
  private readonly launchEnv: OarSkillsLaunchEnv;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** The read running per (agent, runtime), until it settles (our deadline only stops waiting). */
  private readonly running = new Map<string, Promise<ReadOutcome>>();
  private readonly cache = new Map<string, { items: readonly SkillEntry[]; expiresAt: number }>();

  constructor(deps: {
    resolveSource?: OarSkillsSourceResolver;
    launchEnv?: OarSkillsLaunchEnv;
    timeoutMs?: number;
    ttlMs?: number;
    now?: () => number;
  } = {}) {
    this.resolveSource = deps.resolveSource ?? defaultResolveSource;
    this.launchEnv = deps.launchEnv ?? defaultLaunchEnv;
    this.timeoutMs = deps.timeoutMs ?? OAR_SKILLS_TIMEOUT_MS;
    this.ttlMs = deps.ttlMs ?? OAR_SKILLS_CACHE_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /**
   * The agent's skills from OAR: the lists, or why OAR could not read them.
   * Null for a runtime OAR's skills reader does not cover here. Never throws.
   */
  async list(request: OarSkillsRequest): Promise<OarSkillsOutcome | null> {
    const { runtime } = request;
    if (!isOarSkillsRuntime(runtime)) return null;
    // The env is part of the key: a changed CODEX_HOME / CLAUDE_CONFIG_DIR is a different list.
    const key = `${request.agentId}\0${runtime}\0${envKey(request.env)}`;
    let items: readonly SkillEntry[];
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      items = cached.items;
    } else {
      if (cached) this.cache.delete(key);
      const outcome = await this.readWithDeadline(key, runtime, request);
      if (outcome.kind !== "ok") {
        logger.info(`[Skills] OAR skills for ${runtime} unavailable (${outcome.reason})`);
        return { kind: "unavailable", reason: outcome.reason };
      }
      items = outcome.items;
    }
    return { kind: "ok", lists: mapOarSkills(items, request) };
  }

  private async readWithDeadline(key: string, runtime: OarSkillsRuntimeId, request: OarSkillsRequest): Promise<ReadOutcome> {
    let timer: unknown;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setClockTimeout(() => resolve(DEADLINE), this.timeoutMs);
    });
    try {
      const result = await Promise.race([this.joinOrStartRead(key, runtime, request), deadline]);
      return result === DEADLINE ? { kind: "skipped", reason: "deadline" } : result;
    } finally {
      clearClockTimeout(timer);
    }
  }

  private joinOrStartRead(key: string, runtime: OarSkillsRuntimeId, request: OarSkillsRequest): Promise<ReadOutcome> {
    const running = this.running.get(key);
    if (running) return running;
    const started = this.read(runtime, request).then((outcome) => {
      if (outcome.kind === "ok") {
        this.cache.set(key, { items: outcome.items, expiresAt: this.now() + this.ttlMs });
        logger.info(`[Skills] OAR skills for ${runtime}: ${outcome.items.length} entries${outcome.partial ? " (partial)" : ""}`);
      }
      return outcome;
    });
    this.running.set(key, started);
    const clear = () => {
      if (this.running.get(key) === started) this.running.delete(key);
    };
    started.then(clear, clear);
    return started;
  }

  private async read(runtime: OarSkillsRuntimeId, request: OarSkillsRequest): Promise<ReadOutcome> {
    try {
      const source = await this.resolveSource(runtime, request.env);
      if (!source) return { kind: "skipped", reason: "no_installation" };
      const launch = this.launchEnv(runtime, source.installation, request.slockHome, request.env);
      if (!launch) return { kind: "skipped", reason: "no_launch_isolation" };
      const env = { ...request.env, ...launch };
      const result: InventoryResult<SkillEntry> = await source.read(source.installation, {
        cwd: request.workspaceDir,
        timeoutMs: this.timeoutMs,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });
      if (result.kind === "ok") return { kind: "ok", items: result.items, partial: result.partial };
      return { kind: "skipped", reason: `${result.kind}:${result.code}` };
    } catch (err) {
      return { kind: "skipped", reason: `threw:${err instanceof Error ? err.name : "unknown"}` };
    }
  }
}
