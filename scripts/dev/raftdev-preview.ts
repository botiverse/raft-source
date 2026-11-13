/**
 * `raftdev preview`: a raftdev environment started for a reviewer, with a
 * public tunnel, a hard deadline, a registry record and a verified cleanup.
 *
 * The record follows IT's preview cleanup contract (record schemaVersion 1;
 * per-user registry written only through `raft-preview-cleaner register`;
 * systemd user unit `raft-preview-<id>.service`).
 * This module holds the logic that decides things (durations, profiles, the
 * registry path, the record shape and its validation, the unit/cgroup check,
 * the janitor's stop decision, the login-link rule, cleanup verification and
 * the reminder CLI calls) as pure or injectable functions, so they are
 * unit-testable without systemd, Docker, tmux or processes.
 * scripts/dev/raftdev.ts wires them into `start`, `stop` and the janitor.
 * Guard: scripts/dev/raftdev-preview.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const PREVIEW_RECORD_SCHEMA_VERSION = 1;
export const PREVIEW_DEFAULT_SECONDS = 2 * 60 * 60;
export const PREVIEW_MAX_SECONDS = 8 * 60 * 60;
/** The contract accepts only the one-hour idle TTL (or none); previews pin raftdev's default. */
export const PREVIEW_IDLE_TTL_SECONDS = 60 * 60;
/** The owner's reminder fires this long after the deadline, once the cleaner had its chance. */
export const PREVIEW_REMINDER_DELAY_SECONDS = 10 * 60;
/** IT's installed helper, the only record writer: locked atomic `register`, verified `stop <id>`. */
export const PREVIEW_CLEANER_PATH = "/usr/local/libexec/raft-preview-cleaner";
/** Job-local invalid session bus: tmux cannot move itself into a D-Bus scope outside the unit. */
export const PREVIEW_INVALID_DBUS_ADDRESS = "unix:path=/nonexistent";

// ───────────────── durations ─────────────────

/**
 * `--for` value: `90m`, `2h`, `1h30m`, `45s` (units h/m/s, in that order).
 * Absent → 2h. Zero, malformed, or more than 8h is refused.
 */
export function parsePreviewDuration(raw: string | undefined): number {
  if (raw === undefined) return PREVIEW_DEFAULT_SECONDS;
  const value = raw.trim();
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!value || !match) {
    throw new Error(`--for must be a duration like 90m, 2h or 1h30m; got ${JSON.stringify(raw)}`);
  }
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  if (seconds <= 0) throw new Error(`--for must be longer than zero; got ${JSON.stringify(raw)}`);
  if (seconds > PREVIEW_MAX_SECONDS) {
    throw new Error(`--for is capped at 8h; got ${JSON.stringify(raw)} (${formatDuration(seconds)})`);
  }
  return seconds;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** ISO-8601 UTC without milliseconds (`2026-11-01T14:00:00Z`). */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ───────────────── resources ─────────────────

/**
 * Reusable resource profiles (IT): the unit's MemoryMax. `local-stack` is the
 * raftdev default; `frontend` fits a web-only run. `--memory-max` overrides
 * the value and is recorded as the override.
 */
export const PREVIEW_RESOURCE_PROFILES: Readonly<Record<string, string>> = {
  frontend: "2G",
  "local-stack": "4G",
};
export const PREVIEW_DEFAULT_PROFILE = "local-stack";

/**
 * Docker services run in dockerd's cgroups, not the unit's, so MemoryMax does
 * not cover them. Previews cap each container they create (`--memory` and
 * `--memory-swap`, i.e. no swap); RisingWave keeps its own existing cap.
 * Plain `start` is unchanged (no caps).
 */
export const PREVIEW_DOCKER_MEMORY_CAPS = {
  postgres: "1g",
  redis: "256m",
  rustfs: "512m",
  otelcol: "256m",
} as const;
export type PreviewDockerService = keyof typeof PREVIEW_DOCKER_MEMORY_CAPS;

/** Inserts `--memory <cap> --memory-swap <cap>` right after `run` in a `docker run` argv. */
export function withDockerMemoryCap(args: readonly string[], cap: string | undefined): string[] {
  const run = args.indexOf("run");
  if (!cap || run < 0) return [...args];
  return [...args.slice(0, run + 1), "--memory", cap, "--memory-swap", cap, ...args.slice(run + 1)];
}

export interface PreviewResources {
  profile: string;
  memoryMax: string;
  /** The `--memory-max` value when given, else null (the profile's value applies). */
  memoryMaxOverride: string | null;
}

/** systemd-style size: `3G`, `2048M`, `512K`, `1T`, or bare bytes (1024-based). */
export function parseMemorySize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(raw.trim());
  if (!match) throw new Error(`--memory-max must be a size like 3G or 2048M; got ${JSON.stringify(raw)}`);
  const exponent = { "": 0, K: 1, M: 2, G: 3, T: 4 }[match[2]!.toUpperCase() as "" | "K" | "M" | "G" | "T"];
  const bytes = Math.floor(Number(match[1]) * 1024 ** exponent);
  if (bytes <= 0) throw new Error(`--memory-max must be larger than zero; got ${JSON.stringify(raw)}`);
  return bytes;
}

export function resolvePreviewResources(profileArg: string | undefined, memoryMaxArg: string | undefined): PreviewResources {
  if (profileArg !== undefined && !Object.hasOwn(PREVIEW_RESOURCE_PROFILES, profileArg)) {
    throw new Error(
      `unknown --profile ${JSON.stringify(profileArg)}; known: ${Object.keys(PREVIEW_RESOURCE_PROFILES).join(", ")}`,
    );
  }
  const profile = profileArg ?? PREVIEW_DEFAULT_PROFILE;
  const override = memoryMaxArg?.trim().toUpperCase() ?? null;
  if (override !== null) parseMemorySize(override);
  return { profile, memoryMax: override ?? PREVIEW_RESOURCE_PROFILES[profile]!, memoryMaxOverride: override };
}

// ───────────────── notify target ─────────────────

/** Contract `notify`: the conversation the preview was requested in, and the source message. */
export interface PreviewNotify {
  /** The conversation (`#triage`, `dm:@Artea`), passed to `raft reminder --channel`. */
  target: string;
  /** The thread's message id (short or full), or null for the conversation itself. */
  messageId: string | null;
}

const MESSAGE_ID_RE = /^(?:[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * `--notify "#triage:f85040e1"` → `{ target: "#triage", messageId: "f85040e1" }`.
 * Only a trailing hex id is split off, so `dm:@Artea` stays one target.
 */
export function parseNotifyTarget(raw: string): PreviewNotify {
  const value = raw.trim();
  if (!value || /\s/.test(value)) {
    throw new Error(`--notify must be a conversation like "#triage:f85040e1" or "dm:@name:abcd1234"; got ${JSON.stringify(raw)}`);
  }
  if (value.endsWith(":")) throw new Error(`--notify has an empty message id: ${JSON.stringify(raw)}`);
  const colon = value.lastIndexOf(":");
  if (colon > 0) {
    const head = value.slice(0, colon);
    const tail = value.slice(colon + 1);
    if (MESSAGE_ID_RE.test(tail) && head !== "dm") return { target: head, messageId: tail };
  }
  return { target: value, messageId: null };
}

// ───────────────── registry ─────────────────

/** The timer's registry override file (contract): one `RAFT_PREVIEW_REGISTRY=/absolute/path` line. */
export function previewCleanerEnvFile(home: string): string {
  return join(home, ".config", "raft", "preview-cleaner.env");
}

/** As the cleaner does (`Path(registry).expanduser().absolute()`): `~` → home, relative → from cwd. */
export function normalizeRegistryPath(value: string, home: string, cwd: string): string {
  const expanded = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** `RAFT_PREVIEW_REGISTRY` from the cleaner env file's text, or null. */
export function registryFromCleanerEnv(text: string | null): string | null {
  if (text === null) return null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("RAFT_PREVIEW_REGISTRY=")) continue;
    const value = line.slice("RAFT_PREVIEW_REGISTRY=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) return value;
  }
  return null;
}

/**
 * Per-user registry, resolved as the cleaner resolves it:
 * `$RAFT_PREVIEW_REGISTRY`, else the cleaner env file's value, else
 * `${XDG_STATE_HOME:-~/.local/state}/raft/previews`. The timer follows an
 * override only through ~/.config/raft/preview-cleaner.env.
 */
export function previewRegistryDir(
  env: NodeJS.ProcessEnv,
  home: string,
  cleanerEnvText: string | null = null,
  cwd: string = process.cwd(),
): string {
  const override = env.RAFT_PREVIEW_REGISTRY?.trim();
  if (override) return normalizeRegistryPath(override, home, cwd);
  const configured = registryFromCleanerEnv(cleanerEnvText);
  if (configured) return normalizeRegistryPath(configured, home, cwd);
  const stateHome = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  return join(stateHome, "raft", "previews");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function previewRecordPath(registryDir: string, id: string): string {
  return join(registryDir, `${id}.json`);
}

export function previewUnitName(id: string): string {
  return `raft-preview-${id}.service`;
}

export function previewTmuxSocket(id: string): string {
  return `raft-preview-${id}`;
}

export interface PreviewProcess {
  pid: number;
  /** /proc/<pid>/stat field 22 (clock ticks since boot), as a string; pid + starttime + bootId is the identity. */
  starttime: string;
  role: string;
}

export interface PreviewOwner {
  agentId: string | null;
  name: string;
  serverId: string | null;
}

export type PreviewStage = "starting" | "running";

export interface PreviewRecord {
  schemaVersion: 1;
  id: string;
  kind: "raftdev";
  name: string;
  owner: PreviewOwner;
  /** Absolute path of the checkout that started it. */
  repo: string;
  branch: string;
  commit: string;
  /** null until the final register (stage "running"); never published before the cgroup check. */
  url: string | null;
  /**
   * "starting": registered before anything is created and re-registered as
   * each container/volume/process appears, so a SIGKILL at any point leaves
   * every created resource recorded. "running": the final register.
   */
  stage: PreviewStage;
  createdAt: string;
  deadlineAt: string;
  // lastActivityAt is deliberately absent: it may only be written under the
  // cleaner's lock, and raftdev's own janitor already enforces the idle TTL.
  idleTtlSeconds: number;
  withAgentRuns: boolean;
  profile: string;
  memoryMax: string;
  memoryMaxOverride: string | null;
  dockerMemoryCaps: Record<string, string>;
  bootId: string;
  unitName: string;
  unitInvocationId: string;
  processes: PreviewProcess[];
  containerIds: string[];
  volumeNames: string[];
  /** Where the owner asked for the preview (contract's normalized form). */
  notify: PreviewNotify | null;
  /** The owner's own Raft reminder at deadline + 10 minutes, or null. */
  reminderId: string | null;
}

/**
 * Owner from the Raft agent environment the CLI/daemon set
 * (SLOCK_AGENT_ID / SLOCK_CURRENT_AGENT_ID, SLOCK_CURRENT_SERVER_ID /
 * SLOCK_SERVER_ID); the name falls back to $USER. Nothing is invented.
 */
export function previewOwner(env: NodeJS.ProcessEnv): PreviewOwner {
  const agentId = (env.SLOCK_AGENT_ID || env.SLOCK_CURRENT_AGENT_ID || "").trim().toLowerCase();
  const serverId = (env.SLOCK_CURRENT_SERVER_ID || env.SLOCK_SERVER_ID || "").trim().toLowerCase();
  return {
    agentId: UUID_RE.test(agentId) ? agentId : null,
    name: env.SLOCK_AGENT_NAME?.trim() || env.RAFT_AGENT_NAME?.trim() || env.USER?.trim() || "unknown",
    serverId: UUID_RE.test(serverId) ? serverId : null,
  };
}

export interface PreviewRecordInput {
  id: string;
  name: string;
  owner: PreviewOwner;
  repo: string;
  branch: string;
  commit: string;
  url: string;
  createdAt: Date;
  deadlineAt: Date;
  withAgentRuns: boolean;
  resources: PreviewResources;
  dockerMemoryCaps: Record<string, string>;
  bootId: string;
  unitInvocationId: string;
  processes: PreviewProcess[];
  containerIds: string[];
  volumeNames: string[];
  notify: PreviewNotify | null;
  reminderId: string | null;
}

/** The record holds identities, URLs and ids only: no tokens, keys, passwords or shell commands. */
export function buildPreviewRecord(input: PreviewRecordInput): PreviewRecord {
  const processes = new Map<number, PreviewProcess>();
  for (const p of input.processes) if (!processes.has(p.pid)) processes.set(p.pid, p);
  return {
    schemaVersion: PREVIEW_RECORD_SCHEMA_VERSION,
    id: input.id,
    kind: "raftdev",
    name: input.name,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    commit: input.commit,
    url: input.url,
    stage: "running",
    createdAt: isoSeconds(input.createdAt),
    deadlineAt: isoSeconds(input.deadlineAt),
    idleTtlSeconds: PREVIEW_IDLE_TTL_SECONDS,
    withAgentRuns: input.withAgentRuns,
    profile: input.resources.profile,
    memoryMax: input.resources.memoryMax,
    memoryMaxOverride: input.resources.memoryMaxOverride,
    dockerMemoryCaps: input.dockerMemoryCaps,
    bootId: input.bootId,
    unitName: previewUnitName(input.id),
    unitInvocationId: input.unitInvocationId,
    processes: [...processes.values()],
    containerIds: [...new Set(input.containerIds)],
    volumeNames: [...new Set(input.volumeNames)],
    notify: input.notify,
    reminderId: input.reminderId,
  };
}

/** What a preview is from its first register on; the cleaner refuses a change to the immutable part. */
export interface PreviewIdentity {
  id: string;
  name: string;
  owner: PreviewOwner;
  repo: string;
  branch: string;
  commit: string;
  createdAt: Date;
  deadlineAt: Date;
  withAgentRuns: boolean;
  resources: PreviewResources;
  dockerMemoryCaps: Record<string, string>;
  bootId: string;
  unitInvocationId: string;
  notify: PreviewNotify | null;
  reminderId: string | null;
}

/** Fields `raft-preview-cleaner register` refuses to change for an existing id (preview_cleaner.py register). */
export const PREVIEW_IMMUTABLE_FIELDS = ["bootId", "unitName", "unitInvocationId", "owner.agentId", "createdAt"] as const;

/**
 * The record registered first thing in the unit, before any container,
 * volume or process exists: url null, stage "starting", and only the
 * supervisor itself in `processes` (when known).
 */
export function provisionalPreviewRecord(identity: PreviewIdentity, supervisor?: PreviewProcess): PreviewRecord {
  return {
    ...buildPreviewRecord({
      ...identity,
      url: "",
      processes: supervisor ? [supervisor] : [],
      containerIds: [],
      volumeNames: [],
    }),
    url: null,
    stage: "starting",
  };
}

/** Adds a just-created container and its `volume` mounts. Append-only: nothing recorded is ever dropped. */
export function withPreviewContainer(record: PreviewRecord, containerId: string, volumeNames: readonly string[]): PreviewRecord {
  return {
    ...record,
    containerIds: [...new Set([...record.containerIds, containerId])],
    volumeNames: [...new Set([...record.volumeNames, ...volumeNames])],
  };
}

/** Adds a just-created named volume (e.g. before any container mounts it). */
export function withPreviewVolume(record: PreviewRecord, volumeName: string): PreviewRecord {
  return { ...record, volumeNames: [...new Set([...record.volumeNames, volumeName])] };
}

/**
 * Adds processes as they start. A pid already recorded keeps its first entry;
 * at most 256 identities (the contract's limit), earlier ones first.
 */
export function withPreviewProcesses(record: PreviewRecord, processes: readonly PreviewProcess[]): PreviewRecord {
  const byPid = new Map(record.processes.map((p) => [p.pid, p] as const));
  for (const p of processes) if (!byPid.has(p.pid)) byPid.set(p.pid, p);
  return { ...record, processes: [...byPid.values()].slice(0, 256) };
}

/** The final register: url set, stage "running"; every container, volume and process recorded so far is kept. */
export function runningPreviewRecord(
  record: PreviewRecord,
  update: {
    url: string;
    processes: readonly PreviewProcess[];
    containerIds: readonly string[];
    volumeNames: readonly string[];
    dockerMemoryCaps: Record<string, string>;
  },
): PreviewRecord {
  let next = withPreviewProcesses(record, update.processes);
  for (const id of update.containerIds) next = withPreviewContainer(next, id, []);
  for (const name of update.volumeNames) next = withPreviewVolume(next, name);
  return { ...next, url: update.url, stage: "running", dockerMemoryCaps: update.dockerMemoryCaps };
}

/** Immutable fields that differ between two registers of the same id (must be empty). */
export function previewIdentityChanges(previous: PreviewRecord, next: PreviewRecord): string[] {
  const changes: string[] = [];
  if (previous.id !== next.id) changes.push("id");
  if (previous.bootId !== next.bootId) changes.push("bootId");
  if (previous.unitName !== next.unitName) changes.push("unitName");
  if (previous.unitInvocationId !== next.unitInvocationId) changes.push("unitInvocationId");
  if (previous.owner.agentId !== next.owner.agentId) changes.push("owner.agentId");
  if (Date.parse(previous.createdAt) !== Date.parse(next.createdAt)) changes.push("createdAt");
  return changes;
}

/** Recorded ids/volumes/pids present in `previous` but missing from `next` (must be empty). */
export function previewDroppedResources(previous: PreviewRecord, next: PreviewRecord): string[] {
  const nextContainers = new Set(next.containerIds);
  const nextVolumes = new Set(next.volumeNames);
  const nextPids = new Set(next.processes.map((p) => p.pid));
  return [
    ...previous.containerIds.filter((id) => !nextContainers.has(id)).map((id) => `container ${id}`),
    ...previous.volumeNames.filter((name) => !nextVolumes.has(name)).map((name) => `volume ${name}`),
    ...previous.processes.filter((p) => !nextPids.has(p.pid)).map((p) => `process ${p.pid}`),
  ];
}

const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoTime(value: unknown): number | null {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The contract checks (IT's preview_cleaner.py `validate`), so a record is
 * refused before it is registered rather than by the cleaner later. This is
 * only an early failure: IT's `raft-preview-cleaner register` is
 * authoritative, and its refusal fails the preview the same way.
 */
export function previewRecordProblems(record: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(record) || record.schemaVersion !== PREVIEW_RECORD_SCHEMA_VERSION) return ["schemaVersion must be 1"];
  const id = record.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) problems.push("id must be a canonical lowercase UUID");
  const owner = record.owner;
  if (!isObject(owner) || typeof owner.name !== "string" || !owner.name) problems.push("owner.name is required");
  else if (typeof owner.agentId !== "string" || !UUID_RE.test(owner.agentId)) {
    problems.push("owner.agentId must be a UUID (SLOCK_AGENT_ID)");
  }
  // Records from before staged registration have no stage: they were final.
  const stage = record.stage ?? "running";
  if (stage !== "starting" && stage !== "running") problems.push('stage must be "starting" or "running"');
  if (stage === "running" ? typeof record.url !== "string" || !record.url : !(record.url === null || typeof record.url === "string")) {
    problems.push("url must be set once running (null while starting)");
  }
  const created = isoTime(record.createdAt);
  const deadline = isoTime(record.deadlineAt);
  if (created === null || deadline === null) problems.push("createdAt/deadlineAt must be ISO-8601 with a timezone");
  else if (!(deadline - created > 0 && deadline - created <= PREVIEW_MAX_SECONDS * 1000)) {
    problems.push("deadlineAt must be after createdAt and at most 8h later");
  }
  if (record.idleTtlSeconds !== undefined && record.idleTtlSeconds !== PREVIEW_IDLE_TTL_SECONDS) {
    problems.push("idleTtlSeconds must be 3600");
  }
  if (typeof record.bootId !== "string" || !UUID_RE.test(record.bootId)) problems.push("bootId must be the boot_id UUID");
  if (typeof id === "string" && record.unitName !== previewUnitName(id)) problems.push("unitName must be raft-preview-<id>.service");
  if (typeof record.unitInvocationId !== "string" || !/^[0-9a-f]{32}$/.test(record.unitInvocationId)) {
    problems.push("unitInvocationId must be the unit's 32-hex InvocationID");
  }
  const processes = record.processes;
  if (!Array.isArray(processes) || processes.length > 256) problems.push("processes must be a list of at most 256");
  else {
    for (const p of processes) {
      if (!isObject(p) || !Number.isInteger(p.pid) || (p.pid as number) <= 1) problems.push(`invalid process pid ${JSON.stringify(isObject(p) ? p.pid : p)}`);
      else if (typeof p.starttime !== "string" || !/^\d+$/.test(p.starttime)) problems.push(`process ${p.pid as number} starttime must be a digit string`);
      else if (typeof p.role !== "string" || !p.role) problems.push(`process ${p.pid as number} needs a role`);
    }
  }
  const containerIds = record.containerIds ?? [];
  if (!Array.isArray(containerIds) || containerIds.length > 32 || containerIds.some((c) => typeof c !== "string" || !/^[0-9a-f]{64}$/.test(c))) {
    problems.push("containerIds must be full 64-hex Docker ids");
  } else if (new Set(containerIds).size !== containerIds.length) problems.push("containerIds must be unique");
  const volumeNames = record.volumeNames ?? [];
  if (!Array.isArray(volumeNames) || volumeNames.length > 256 || volumeNames.some((v) => typeof v !== "string" || !VOLUME_NAME_RE.test(v))) {
    problems.push("volumeNames must be Docker volume names");
  } else if (new Set(volumeNames).size !== volumeNames.length) problems.push("volumeNames must be unique");
  const notify = record.notify;
  if (notify !== undefined && notify !== null) {
    if (
      !isObject(notify) ||
      typeof notify.target !== "string" || !notify.target ||
      !(notify.messageId === null || typeof notify.messageId === "string")
    ) {
      problems.push("notify must be {target, messageId}");
    }
  }
  if (record.reminderId !== undefined && record.reminderId !== null && typeof record.reminderId !== "string") {
    problems.push("reminderId must be a string or null");
  }
  return problems;
}

export function parsePreviewRecord(text: string, filenameId?: string): PreviewRecord | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (previewRecordProblems(value).length > 0) return null;
  const record = value as PreviewRecord;
  if (filenameId !== undefined && record.id !== filenameId) return null;
  return record;
}

export function readPreviewRecord(path: string, filenameId?: string): PreviewRecord | null {
  try { return parsePreviewRecord(readFileSync(path, "utf8"), filenameId); } catch { return null; }
}

/** `<uuid>.json` files only (the cleaner's own subdirectories and temp files are skipped). */
export function listPreviewRecords(registryDir: string): { id: string; path: string; record: PreviewRecord | null }[] {
  let entries: string[];
  try { entries = readdirSync(registryDir); } catch { return []; }
  return entries
    .filter((entry) => entry.endsWith(".json") && UUID_RE.test(entry.slice(0, -5)))
    .sort()
    .map((entry) => {
      const id = entry.slice(0, -5);
      const path = join(registryDir, entry);
      return { id, path, record: readPreviewRecord(path, id) };
    });
}

/**
 * `preview stop <name|id>`: an id selects its record; a name selects the
 * record of that name, preferring this checkout's when several share it.
 */
export function selectPreviewRecord(
  records: readonly PreviewRecord[],
  nameOrId: string,
  projectDir: string,
): { record: PreviewRecord } | { error: string } {
  if (UUID_RE.test(nameOrId)) {
    const record = records.find((r) => r.id === nameOrId);
    return record ? { record } : { error: `no preview record with id ${nameOrId}` };
  }
  const named = records.filter((r) => r.name === nameOrId);
  const local = named.filter((r) => r.repo === projectDir);
  const pick = local.length > 0 ? local : named;
  if (pick.length === 1) return { record: pick[0]! };
  if (pick.length === 0) return { error: `no preview record named '${nameOrId}'` };
  return { error: `several previews are named '${nameOrId}'; stop one by id: ${pick.map((r) => r.id).join(", ")}` };
}

// ───────────────── per-environment preview state (.slockdev/<name>/preview.json) ─────────────────

/** What raftdev needs locally: the record id, the deadline, the registry and the tmux socket. */
export interface PreviewState {
  schemaVersion: 1;
  id: string;
  deadlineAt: string;
  registryDir: string;
  tmuxSocket: string;
}

export function parsePreviewState(text: string): PreviewState | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  if (typeof value.id !== "string" || !UUID_RE.test(value.id)) return null;
  if (typeof value.deadlineAt !== "string" || !Number.isFinite(Date.parse(value.deadlineAt))) return null;
  if (typeof value.registryDir !== "string" || !value.registryDir) return null;
  if (typeof value.tmuxSocket !== "string" || value.tmuxSocket !== previewTmuxSocket(value.id)) return null;
  return { schemaVersion: 1, id: value.id, deadlineAt: value.deadlineAt, registryDir: value.registryDir, tmuxSocket: value.tmuxSocket };
}

// tmux subcommands (and aliases) whose `-s` takes a session or source-target
// value. Everywhere else `-s` is a bare flag (`list-panes -s`: every pane of
// the target session).
const TMUX_S_TAKES_VALUE = new Set([
  "new-session", "new",
  "move-window", "movew", "link-window", "linkw", "swap-window", "swapw",
  "join-pane", "joinp", "move-pane", "movep", "swap-pane", "swapp",
]);

/**
 * The session a tmux argv addresses (`-t slock-x:web`, `new-session -s
 * slock-x`), or null. Parsed per subcommand, so the bare flag in `list-panes
 * -s -t slock-x` is not mistaken for a value. raftdev routes tmux calls for a
 * preview's session to its dedicated socket.
 */
export function tmuxSessionFromArgs(args: readonly string[]): string | null {
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  const sTakesValue = subcommand !== undefined && TMUX_S_TAKES_VALUE.has(subcommand);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-t" || (sTakesValue && args[i] === "-s")) return args[i + 1]!.split(":")[0]!;
  }
  return null;
}

// ───────────────── /proc and cgroups ─────────────────

export interface ProcStat {
  comm: string;
  state: string;
  ppid: number;
  starttime: string;
}

/**
 * Parses /proc/<pid>/stat. comm (field 2) is parenthesised and may itself
 * contain spaces and parentheses, so fields are counted after the LAST ')':
 * that remainder starts at field 3 (state), so ppid (field 4) is index 1 and
 * starttime (field 22) is index 19.
 */
export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const starttime = rest[19];
  if (!rest[0] || !Number.isInteger(ppid) || !starttime || !/^\d+$/.test(starttime)) return null;
  return { comm: text.slice(open + 1, close), state: rest[0], ppid, starttime };
}

export function readProcStat(pid: number, read: (path: string) => string = (p) => readFileSync(p, "utf8")): ProcStat | null {
  try { return parseProcStat(read(`/proc/${pid}/stat`)); } catch { return null; }
}

/** A live (not zombie/dead) process's starttime, else null. */
export function liveStarttime(stat: ProcStat | null): string | null {
  return stat && stat.state !== "Z" && stat.state !== "X" ? stat.starttime : null;
}

/** All descendants of `roots` in a pid → ppid table (roots excluded). */
export function descendantPids(roots: readonly number[], parentOf: ReadonlyMap<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parentOf) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const seen = new Set<number>(roots);
  const result: number[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}

/**
 * Alive only when the boot is the recorded one and the pid has the recorded
 * starttime: a reused pid or a new boot is the old process gone, never a
 * process to signal.
 */
export function isRecordedProcessAlive(
  p: PreviewProcess,
  recordBootId: string,
  currentBootId: string,
  starttimeOf: (pid: number) => string | null,
): boolean {
  return recordBootId === currentBootId && starttimeOf(p.pid) === p.starttime;
}

/** The unified (v2) cgroup path from /proc/<pid>/cgroup, or the v1 name=systemd path. */
export function cgroupPathFromProcCgroup(text: string): string | null {
  const lines = text.split("\n");
  const v2 = lines.find((line) => line.startsWith("0::"));
  if (v2) return v2.slice(3).trim();
  const v1 = lines.find((line) => line.includes(":name=systemd:"));
  return v1 ? v1.slice(v1.indexOf(":name=systemd:") + ":name=systemd:".length).trim() : null;
}

/** True when the process's cgroup is the unit's own (path ends in `/<unitName>`). */
export function isInUnitCgroup(procCgroupText: string | null, unitName: string): boolean {
  if (procCgroupText === null) return false;
  const path = cgroupPathFromProcCgroup(procCgroupText);
  return path !== null && path.endsWith(`/${unitName}`);
}

/** Recorded processes whose cgroup is not the unit's (or unreadable): the preview must not be published. */
export function processesOutsideUnit(
  processes: readonly PreviewProcess[],
  unitName: string,
  cgroupOf: (pid: number) => string | null,
): PreviewProcess[] {
  return processes.filter((p) => !isInUnitCgroup(cgroupOf(p.pid), unitName));
}

// ───────────────── systemd ─────────────────

/**
 * `systemd-run --user` argv that launches the preview supervisor as
 * `raft-preview-<id>.service`. The command systemd runs sets a job-local
 * invalid DBUS_SESSION_BUS_ADDRESS (after systemd-run itself has connected),
 * so tmux and anything else inside cannot ask the user manager for a scope of
 * their own outside the unit. The shared user environment is untouched.
 */
export function previewSystemdRunArgs(options: {
  id: string;
  memoryMax: string;
  runtimeMaxSeconds: number;
  workingDirectory: string;
  /** The unit's stdout/stderr, which the launcher follows. */
  logFile: string;
  command: readonly string[];
}): string[] {
  return [
    "--user",
    `--unit=${previewUnitName(options.id)}`,
    "--collect",
    "-p", `MemoryMax=${options.memoryMax}`,
    "-p", "MemorySwapMax=0",
    "-p", `RuntimeMaxSec=${options.runtimeMaxSeconds}`,
    "-p", "KillMode=control-group",
    "-p", "TimeoutStopSec=15s",
    "-p", `StandardOutput=append:${options.logFile}`,
    "-p", `StandardError=append:${options.logFile}`,
    `--working-directory=${options.workingDirectory}`,
    "--",
    "/usr/bin/env", `DBUS_SESSION_BUS_ADDRESS=${PREVIEW_INVALID_DBUS_ADDRESS}`,
    ...options.command,
  ];
}

// What `start` and the processes it launches read, by exact name or prefix.
const UNIT_ENV_ALLOWED_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ", "TMPDIR", "XDG_RUNTIME_DIR",
  "COREPACK_HOME",
  "RISINGWAVE_DATABASE_URL",
]);
const UNIT_ENV_ALLOWED_PREFIXES = ["LC_", "NODE_", "PNPM_", "npm_config_", "RAFTDEV_", "SLOCKDEV_", "VITE_"];
// Never passed, whatever the prefix: secrets and the launching agent's own
// Raft/CLI credentials and profile.
const UNIT_ENV_DENIED = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|^RAFT_|^SLOCK_AGENT|^CLAUDE_/i;

/**
 * Model/runtime credentials the daemon's agent runtimes read from the
 * environment (packages/daemon: Pi/Qwen OPENAI_*, Pi/Claude ANTHROPIC_*,
 * Kimi KIMI_API_KEY, CODEX_HOME/KIMI_CODE_HOME/GROK_HOME). Passed only with
 * --with-agent-runs; the runtimes' logins under HOME need no variable.
 * Never Raft CLI credentials (RAFT_*, SLOCK_AGENT*, CLAUDE_CODE_*).
 */
export const PREVIEW_AGENT_RUNTIME_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "KIMI_API_KEY",
  "CODEX_HOME", "KIMI_CODE_HOME", "GROK_HOME",
] as const;

/**
 * The unit's environment (systemd-run --user does not pass the caller's).
 * An allowlist of what `start` needs, minus anything secret-shaped; the
 * daemon's model/runtime variables only with --with-agent-runs. The session
 * bus and systemd/tmux job variables are never passed (the unit sets its own).
 */
export function previewUnitEnv(env: NodeJS.ProcessEnv, options: { withAgentRuns: boolean }): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const allowed = UNIT_ENV_ALLOWED_NAMES.has(key) || UNIT_ENV_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (allowed && !UNIT_ENV_DENIED.test(key)) result[key] = value;
  }
  if (options.withAgentRuns) {
    for (const key of PREVIEW_AGENT_RUNTIME_ENV) {
      const value = env[key];
      if (value !== undefined) result[key] = value;
    }
  }
  return result;
}

// ───────────────── docker ─────────────────

/** Volume names from `docker inspect --format '{{json .Mounts}}'`: Type "volume" only (anonymous included), never bind paths. */
export function volumesFromMounts(mountsJson: string): string[] {
  let mounts: unknown;
  try { mounts = JSON.parse(mountsJson); } catch { return []; }
  if (!Array.isArray(mounts)) return [];
  return mounts
    .filter((m): m is { Type: string; Name: string } => isObject(m) && m.Type === "volume" && typeof m.Name === "string" && m.Name !== "")
    .map((m) => m.Name);
}

export type ResourceState = "present" | "gone" | "unknown";

/** Classifies a `docker container|volume inspect <id>` result; a Docker error is not proof of absence. */
export function dockerInspectState(result: { code: number; stderr: string }): ResourceState {
  if (result.code === 0) return "present";
  return /no such (object|container|volume)/i.test(result.stderr) ? "gone" : "unknown";
}

export type ContainerInspection =
  | { state: "present"; id: string; volumeNames: string[] }
  | { state: "gone" }
  | { state: "unknown"; error: string };

/**
 * `docker container inspect --format '{{.Id}}\t{{json .Mounts}}' <name>`.
 * Only a "No such" answer is absence; a daemon, socket or permission error,
 * or output that is not a 64-hex id, is "unknown" and must fail the preview
 * rather than register an incomplete id/volume list.
 */
export function parseContainerInspect(result: { code: number; stdout: string; stderr: string }): ContainerInspection {
  const state = dockerInspectState(result);
  if (state === "gone") return { state: "gone" };
  if (state === "unknown") return { state: "unknown", error: (result.stderr.trim() || `exit ${result.code}`).slice(0, 240) };
  const line = result.stdout.trim();
  const tab = line.indexOf("\t");
  const id = tab > 0 ? line.slice(0, tab) : "";
  if (!/^[0-9a-f]{64}$/.test(id)) return { state: "unknown", error: `unexpected docker inspect output: ${line.slice(0, 120)}` };
  let mounts: unknown;
  try { mounts = JSON.parse(line.slice(tab + 1)); } catch {
    return { state: "unknown", error: "docker inspect printed unparsable Mounts" };
  }
  if (!Array.isArray(mounts)) return { state: "unknown", error: "docker inspect printed no Mounts list" };
  return { state: "present", id, volumeNames: volumesFromMounts(JSON.stringify(mounts)) };
}

// ───────────────── janitor ─────────────────

export type JanitorDecision =
  | { action: "stop"; reason: "deadline" | "idle"; idleSeconds: number }
  | { action: "wait"; sleepSeconds: number };

/**
 * One janitor tick. The hard deadline stops the environment even when it is
 * not idle; the idle TTL (0 = disabled) stops it after inactivity; whichever
 * comes first wins. Without a deadline this is the pre-preview behaviour:
 * stop at idle >= TTL, otherwise sleep min(60, time to TTL), at least 1s.
 */
export function janitorDecision(input: {
  nowSeconds: number;
  lastActivitySeconds: number;
  idleTtlSeconds: number;
  deadlineAtSeconds: number | null;
}): JanitorDecision {
  const idleSeconds = input.nowSeconds - input.lastActivitySeconds;
  if (input.deadlineAtSeconds !== null && input.nowSeconds >= input.deadlineAtSeconds) {
    return { action: "stop", reason: "deadline", idleSeconds };
  }
  if (input.idleTtlSeconds > 0 && idleSeconds >= input.idleTtlSeconds) {
    return { action: "stop", reason: "idle", idleSeconds };
  }
  let sleepSeconds = 60;
  if (input.idleTtlSeconds > 0) sleepSeconds = Math.min(sleepSeconds, Math.max(1, input.idleTtlSeconds - idleSeconds));
  if (input.deadlineAtSeconds !== null) {
    sleepSeconds = Math.min(sleepSeconds, Math.max(1, input.deadlineAtSeconds - input.nowSeconds));
  }
  return { action: "wait", sleepSeconds };
}

/**
 * The janitor lives inside the preview unit, which a stop kills, so its stop
 * runs as a separate transient unit that outlives it:
 * `raftdev preview stop <id>` (the cleaner's verified stop).
 */
export function previewStopUnitArgs(options: {
  id: string;
  reason: "deadline" | "idle";
  nodePath: string;
  raftdevScript: string;
  workingDirectory: string;
  registryDir: string;
  path: string;
  /** DOCKER_HOST/DOCKER_CONTEXT when set, so the stop reaches the same daemon. */
  dockerEnv?: Record<string, string>;
}): string[] {
  return [
    "--user",
    `--unit=raft-preview-${options.id}-stop.service`,
    "--collect",
    `--working-directory=${options.workingDirectory}`,
    `--setenv=RAFT_PREVIEW_REGISTRY=${options.registryDir}`,
    `--setenv=PATH=${options.path}`,
    ...Object.entries(options.dockerEnv ?? {})
      .filter(([key]) => key === "DOCKER_HOST" || key === "DOCKER_CONTEXT")
      .map(([key, value]) => `--setenv=${key}=${value}`),
    "--",
    options.nodePath, "--import", "@oxc-node/core/register", options.raftdevScript,
    "preview", "stop", options.id, "--reason", options.reason,
  ];
}

// ───────────────── login links ─────────────────

/**
 * Web auto-login env for the `web` window, in the order `start` always added
 * them. `start` (preview: false) passes the caller's values through unchanged.
 *
 * HARD RULE (Tenny, #triage:f85040e1): a preview started --with-agent-runs
 * runs agents on this machine's model/runtime credentials, so a leaked link
 * must not be able to drive them. Its web is built with
 * VITE_SLOCKDEV_SKIP_AUTO_LOGIN=1 and no VITE_SLOCKDEV_EMAIL, whatever the
 * caller's environment says, so only the seed-account password login works,
 * and previewLoginLines prints no passwordless link for it.
 */
export function webAutoLoginEnv(options: {
  preview: boolean;
  withAgentRuns: boolean;
  env: NodeJS.ProcessEnv;
}): [string, string][] {
  if (options.preview && options.withAgentRuns) return [["VITE_SLOCKDEV_SKIP_AUTO_LOGIN", "1"]];
  const assignments: [string, string][] = [];
  if (options.env.VITE_SLOCKDEV_SKIP_AUTO_LOGIN) {
    assignments.push(["VITE_SLOCKDEV_SKIP_AUTO_LOGIN", options.env.VITE_SLOCKDEV_SKIP_AUTO_LOGIN]);
  }
  if (options.env.VITE_SLOCKDEV_EMAIL) assignments.push(["VITE_SLOCKDEV_EMAIL", options.env.VITE_SLOCKDEV_EMAIL]);
  return assignments;
}

/**
 * Seed password for a preview. With --with-agent-runs the instance runs agents
 * with this machine's model/runtime credentials behind a public URL (Tenny,
 * #triage:f85040e1), so it gets a random password instead of the public
 * default; the password goes only to the seed output file and the launcher's
 * terminal, never into the registry record.
 */
export function previewSeedPasswordEnv(options: {
  preview: boolean;
  withAgentRuns: boolean;
  randomPassword: () => string;
}): [string, string][] {
  if (options.preview && options.withAgentRuns) return [["RAFTDEV_SEED_PASSWORD", options.randomPassword()]];
  return [];
}

export interface SeedAccount {
  role: string;
  email: string;
  password: string;
}

/** `accounts` from the seed output file (`.dev-env-<name>.json`). */
export function seedAccountsFromSeedFile(text: string): SeedAccount[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return []; }
  if (!isObject(value) || !isObject(value.accounts)) return [];
  return Object.entries(value.accounts).flatMap(([role, account]) =>
    isObject(account) && typeof account.email === "string" && typeof account.password === "string"
      ? [{ role: typeof account.role === "string" ? account.role : role, email: account.email, password: account.password }]
      : []);
}

/**
 * The login block printed for a preview. The web bakes one auto-login account
 * per environment (VITE_SLOCKDEV_EMAIL, default dev@slock.ai), so the
 * passwordless link is the tunnel URL for that account's role; the other
 * roles sign in with the seed password. With agent runs: no passwordless
 * link at all (see webAutoLoginEnv).
 */
export function previewLoginLines(options: {
  url: string;
  withAgentRuns: boolean;
  accounts: readonly SeedAccount[];
  env: NodeJS.ProcessEnv;
}): string[] {
  const lines: string[] = [];
  if (options.withAgentRuns) {
    lines.push("  Login:     seed-account password only (--with-agent-runs: auto-login is off, no link signs anyone in).");
  } else {
    const autoEmail = options.env.VITE_SLOCKDEV_SKIP_AUTO_LOGIN === "1"
      ? null
      : options.env.VITE_SLOCKDEV_EMAIL?.trim() || "dev@slock.ai";
    if (autoEmail) {
      const role = options.accounts.find((a) => a.email === autoEmail)?.role ?? "account";
      lines.push(`  Passwordless link (${role}, ${autoEmail}): ${options.url}`);
      lines.push("             Other roles: Log out, then sign in with a seed account below.");
    } else {
      lines.push("  Login:     password only (VITE_SLOCKDEV_SKIP_AUTO_LOGIN=1).");
    }
  }
  if (options.accounts.length > 0) {
    lines.push("  Seed accounts:");
    for (const a of options.accounts) lines.push(`    ${a.role.padEnd(7)} ${a.email} / ${a.password}`);
  }
  lines.push("  Post links only in the requester's thread.");
  return lines;
}

// ───────────────── cleanup verification (raftdev's own check after the cleaner's stop) ─────────────────

export interface CleanupProbes {
  bootId: string;
  starttimeOf(pid: number): string | null;
  unitActive(unitName: string): ResourceState;
  containerState(id: string): ResourceState;
  volumeState(name: string): ResourceState;
}

export interface CleanupVerification {
  ok: boolean;
  unit: ResourceState;
  processes: PreviewProcess[];
  containers: { id: string; state: ResourceState }[];
  volumes: { name: string; state: ResourceState }[];
}

/**
 * Every recorded identity is checked individually: the unit, each process
 * (pid + starttime + boot), container (id) and volume (name). "unknown"
 * (systemd/Docker could not answer) counts as left over: the record is
 * removed only on proof.
 */
export function verifyPreviewCleanup(record: PreviewRecord, probes: CleanupProbes): CleanupVerification {
  const unit = probes.unitActive(record.unitName);
  const processes = record.processes.filter((p) =>
    isRecordedProcessAlive(p, record.bootId, probes.bootId, probes.starttimeOf));
  const containers = record.containerIds
    .map((id) => ({ id, state: probes.containerState(id) }))
    .filter((c) => c.state !== "gone");
  const volumes = record.volumeNames
    .map((name) => ({ name, state: probes.volumeState(name) }))
    .filter((v) => v.state !== "gone");
  return {
    ok: unit === "gone" && processes.length === 0 && containers.length === 0 && volumes.length === 0,
    unit,
    processes,
    containers,
    volumes,
  };
}

export function formatCleanupLeftovers(result: CleanupVerification, unitName: string): string[] {
  return [
    ...(result.unit === "gone" ? [] : [`  unit ${unitName} ${result.unit === "present" ? "is still active" : "could not be checked"}`]),
    ...result.processes.map((p) => `  process pid ${p.pid} starttime ${p.starttime} (${p.role}) is still running`),
    ...result.containers.map((c) => `  container ${c.id.slice(0, 12)} ${c.state === "present" ? "still exists" : "could not be checked"}`),
    ...result.volumes.map((v) => `  volume ${v.name} ${v.state === "present" ? "still exists" : "could not be checked"}`),
  ];
}

/** `raft-preview-cleaner stop <id>` prints its result JSON (null when the record is already gone). */
export function parseCleanerStopOutput(stdout: string): { outcome: string; detail: string[] } {
  let value: unknown;
  try { value = JSON.parse(stdout.trim() || "null"); } catch { return { outcome: "unparsable", detail: [stdout.trim().slice(0, 240)] }; }
  if (value === null) return { outcome: "absent", detail: [] };
  if (!isObject(value)) return { outcome: "unparsable", detail: [] };
  const detail: string[] = [];
  if (Array.isArray(value.errors)) for (const e of value.errors) detail.push(`  error: ${String(e)}`);
  if (isObject(value.residual)) {
    for (const [kind, items] of Object.entries(value.residual)) detail.push(`  residual ${kind}: ${JSON.stringify(items)}`);
  }
  return { outcome: typeof value.outcome === "string" ? value.outcome : "unknown", detail };
}

// ───────────────── list ─────────────────

export interface PreviewSummary {
  id: string;
  owner: string;
  name: string;
  branch: string;
  url: string | null;
  stage: PreviewStage;
  deadlineAt: string;
  remainingSeconds: number;
  processesAlive: number;
  processesRecorded: number;
  withAgentRuns: boolean;
  profile: string;
  memoryMax: string;
  unitName: string;
  repo: string;
}

export function summarizePreviewRecord(
  record: PreviewRecord,
  nowMs: number,
  currentBootId: string,
  starttimeOf: (pid: number) => string | null,
): PreviewSummary {
  return {
    id: record.id,
    owner: record.owner.name,
    name: record.name,
    branch: record.branch,
    url: record.url,
    stage: record.stage,
    deadlineAt: record.deadlineAt,
    remainingSeconds: Math.max(0, Math.floor((Date.parse(record.deadlineAt) - nowMs) / 1000)),
    processesAlive: record.processes.filter((p) => isRecordedProcessAlive(p, record.bootId, currentBootId, starttimeOf)).length,
    processesRecorded: record.processes.length,
    withAgentRuns: record.withAgentRuns,
    profile: record.profile,
    memoryMax: record.memoryMax,
    unitName: record.unitName,
    repo: record.repo,
  };
}

// ───────────────── reminder (raft CLI) ─────────────────

export type CommandRunner = (command: string, args: string[]) => { code: number; stdout: string; stderr: string };

/**
 * `raft reminder schedule` arguments (flags per `raft reminder schedule --help`):
 *   --title <t>          what the reminder is about
 *   --fire-at <iso>      absolute UTC time: deadlineAt + 10 minutes (contract)
 *   --channel <ref>      conversation to anchor to (#channel, dm:@name)
 *   --message-id <id>    the source message; required for agent-created reminders
 * The reminder is created by whoever runs raftdev (the owner) and fires to them;
 * when it fires they read the cleaner's results/<id>.json.
 */
export function previewReminderScheduleArgs(options: {
  id: string;
  name: string;
  deadlineAt: Date;
  notify: PreviewNotify;
}): string[] {
  const fireAt = new Date(options.deadlineAt.getTime() + PREVIEW_REMINDER_DELAY_SECONDS * 1000);
  const args = [
    "reminder", "schedule",
    "--title", `raftdev preview '${options.name}' (${options.id}) passed its deadline: read the cleaner's results/${options.id}.json; if it has not swept yet, run ./raftdev preview stop ${options.id}`,
    "--fire-at", isoSeconds(fireAt),
    "--channel", options.notify.target,
  ];
  if (options.notify.messageId) args.push("--message-id", options.notify.messageId);
  return args;
}

/** Reads the id from `Reminder scheduled: #<8-hex> ...` (packages/cli reminder/_format.ts). */
export function parseScheduledReminderId(stdout: string): string | null {
  return /Reminder scheduled: #([0-9a-f]{8})\b/i.exec(stdout)?.[1] ?? null;
}

export function schedulePreviewReminder(
  options: { id: string; name: string; deadlineAt: Date; notify: PreviewNotify },
  run: CommandRunner,
): { reminderId: string | null; warning: string | null } {
  const result = run("raft", previewReminderScheduleArgs(options));
  if (result.code !== 0) {
    return { reminderId: null, warning: `raft reminder schedule failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}` };
  }
  const reminderId = parseScheduledReminderId(result.stdout);
  return reminderId
    ? { reminderId, warning: null }
    : { reminderId: null, warning: "raft reminder schedule succeeded but printed no reminder id; none recorded" };
}

/** `raft reminder cancel --id <id>` for a recorded reminder; nothing to do without one. */
export function cancelPreviewReminder(
  reminderId: string | null,
  run: CommandRunner,
): { attempted: boolean; ok: boolean; message: string } {
  if (!reminderId) return { attempted: false, ok: true, message: "no reminder recorded" };
  const result = run("raft", ["reminder", "cancel", "--id", reminderId]);
  return result.code === 0
    ? { attempted: true, ok: true, message: `reminder #${reminderId} cancelled` }
    : {
      attempted: true,
      ok: false,
      message: `raft reminder cancel --id ${reminderId} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`,
    };
}

// ───────────────── arguments ─────────────────

export interface PreviewStartArgs {
  name: string;
  forSeconds: number;
  withAgentRuns: boolean;
  resources: PreviewResources;
  notify: PreviewNotify | null;
  /** Remaining options, passed to `start` unchanged (e.g. --description, --no-risingwave). */
  startArgs: string[];
}

const RESERVED_PREVIEW_NAMES = new Set(["stop", "list"]);

/** `preview <name> [--for D] [--with-agent-runs] [--profile P] [--memory-max S] [--notify T] [start options]`. */
export function parsePreviewStartArgs(args: readonly string[]): PreviewStartArgs {
  const name = args[0];
  if (!name || name.startsWith("-")) throw new Error("preview needs an environment name first: ./raftdev preview <name> [options]");
  if (RESERVED_PREVIEW_NAMES.has(name)) throw new Error(`'${name}' is a preview subcommand, not an environment name`);
  let forRaw: string | undefined;
  let profile: string | undefined;
  let memoryMax: string | undefined;
  let notifyRaw: string | undefined;
  let withAgentRuns = false;
  const startArgs: string[] = [];
  const valued: Record<string, (v: string) => void> = {
    "--for": (v) => { forRaw = v; },
    "--profile": (v) => { profile = v; },
    "--memory-max": (v) => { memoryMax = v; },
    "--notify": (v) => { notifyRaw = v; },
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (Object.hasOwn(valued, flag)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      valued[flag]!(value);
    } else if (a === "--with-agent-runs") {
      withAgentRuns = true;
    } else {
      startArgs.push(a);
    }
  }
  return {
    name,
    forSeconds: parsePreviewDuration(forRaw),
    withAgentRuns,
    resources: resolvePreviewResources(profile, memoryMax),
    notify: notifyRaw === undefined ? null : parseNotifyTarget(notifyRaw),
    startArgs,
  };
}

// ───────────────── launch decisions ─────────────────

export interface ExistingResource {
  kind: "container" | "volume";
  name: string;
  state: ResourceState;
}

/**
 * A preview never adopts resources it did not create (contract), and a
 * reused database keeps old sessions and refresh tokens even after a seed
 * password reset. Any existing container or volume of the name, or one Docker
 * could not answer for, refuses the launch. Returns the refusal, or null.
 */
export function previewAdoptionRefusal(name: string, resources: readonly ExistingResource[]): string[] | null {
  const blocking = resources.filter((r) => r.state !== "gone");
  if (blocking.length === 0) return null;
  return [
    `ERROR: preview '${name}' would reuse resources it did not create:`,
    ...blocking.map((r) => `  ${r.kind} ${r.name} ${r.state === "present" ? "exists" : "could not be checked (Docker did not answer)"}`),
    `  Stop and remove them (./raftdev stop ${name}), or use a new preview name.`,
  ];
}

/**
 * The daemon window runs agents on this machine's model credentials, so a
 * preview starts it only with --with-agent-runs (whose links are never
 * passwordless). Plain `start` always starts it.
 */
export function shouldStartDaemonWindow(options: { preview: boolean; withAgentRuns: boolean }): boolean {
  return !options.preview || options.withAgentRuns;
}

/** Docker endpoint overrides a preview refuses (see previewDockerEndpointRefusal). */
export const PREVIEW_REFUSED_DOCKER_ENV = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"] as const;

/**
 * IT's timer cleans with the user's default Docker endpoint. A preview started
 * against another daemon would be looked up on the wrong one, where "no such
 * container" would read as cleaned (IT, dm:@IT-hetzer-host:8b5b2ca2), so a
 * preview refuses these caller overrides instead of carrying them.
 */
export function previewDockerEndpointRefusal(env: NodeJS.ProcessEnv): string[] | null {
  const set = PREVIEW_REFUSED_DOCKER_ENV.filter((key) => (env[key] ?? "") !== "");
  if (set.length === 0) return null;
  return [
    `ERROR: previews use the default Docker endpoint only; ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set.`,
    "  The cleanup timer checks the default daemon, so a preview on another endpoint could not be verified.",
    `  Unset ${set.join(" and ")} and launch again.`,
  ];
}

/** `raftdev seed` on a preview: refused; previews are seeded only at launch. */
export function previewSeedRefusal(name: string, state: PreviewState | null): string[] | null {
  if (!state) return null;
  return [
    `ERROR: '${name}' is a preview (${state.id}); previews are seeded only at launch.`,
    `  Stop it (./raftdev preview stop ${name}) and launch a new preview instead.`,
  ];
}

/** Everything the unit needs from the launcher. Mode 600; the unit deletes it on read. */
export interface PreviewUnitSpec {
  schemaVersion: 1;
  id: string;
  name: string;
  startArgs: string[];
  withAgentRuns: boolean;
  createdAt: string;
  deadlineAt: string;
  registryDir: string;
  resources: PreviewResources;
  owner: PreviewOwner;
  notify: PreviewNotify | null;
  reminderId: string | null;
  env: Record<string, string>;
}

const PREVIEW_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Shape check of the spec the unit reads; throws with the first problem. */
export function parsePreviewUnitSpec(text: string): PreviewUnitSpec {
  const value: unknown = JSON.parse(text);
  const fail = (what: string): never => { throw new Error(`invalid preview unit spec: ${what}`); };
  if (!isObject(value) || value.schemaVersion !== 1) fail("schemaVersion");
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !UUID_RE.test(v.id)) fail("id");
  if (typeof v.name !== "string" || !PREVIEW_NAME_RE.test(v.name) || v.name === "." || v.name === "..") fail("name");
  if (!Array.isArray(v.startArgs) || !v.startArgs.every((a) => typeof a === "string")) fail("startArgs");
  if (typeof v.withAgentRuns !== "boolean") fail("withAgentRuns");
  if (isoTime(v.createdAt) === null || isoTime(v.deadlineAt) === null) fail("createdAt/deadlineAt");
  if (typeof v.registryDir !== "string" || !isAbsolute(v.registryDir)) fail("registryDir");
  const r = v.resources;
  if (!isObject(r) || typeof r.profile !== "string" || typeof r.memoryMax !== "string" ||
    !(r.memoryMaxOverride === null || typeof r.memoryMaxOverride === "string")) fail("resources");
  const o = v.owner;
  if (!isObject(o) || typeof o.name !== "string" || !o.name ||
    !(o.agentId === null || (typeof o.agentId === "string" && UUID_RE.test(o.agentId))) ||
    !(o.serverId === null || typeof o.serverId === "string")) fail("owner");
  const n = v.notify;
  if (!(n === null || (isObject(n) && typeof n.target === "string" && (n.messageId === null || typeof n.messageId === "string")))) fail("notify");
  if (!(v.reminderId === null || typeof v.reminderId === "string")) fail("reminderId");
  if (!isObject(v.env) || !Object.values(v.env).every((x) => typeof x === "string")) fail("env");
  return v as unknown as PreviewUnitSpec;
}
