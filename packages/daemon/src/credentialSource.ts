// Reconciler step 15 (B7 / B8 / B9): where each runtime keeps the credential
// an agent runs on, how to tell that it changed on disk, and which provider
// account it signs in as.
//
// Everything read here stays in daemon memory. A credential file is read only
// to hash it (never parsed); an account file is parsed only for its account id
// (hashed at once). No path, digest, account or content is ever traced, sent
// or written: a caller reports the runtime and the source kind only.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, type Dirent, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ambientProcessEnv } from "./processEnvPatch";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig, type RuntimeAuthRuntime } from "@botiverse/raft-shared";

/** The env a runtime of an agent sees: the daemon's, under the agent's own env vars. */
export type CredentialEnv = Readonly<Record<string, string | undefined>>;

/**
 * One place a credential lives:
 * - `file`: a credential file (hashed when its stat changes);
 * - `dir`: a directory whose file names are not known; its entries
 *   (names, and for files size and mtime) are the fingerprint. `json_files`
 *   keeps only `*.json` entries (Kimi: its temp and pending-rotation files
 *   are not credentials);
 * - `keychain`: a macOS Keychain item, by its modification date only.
 */
export type CredentialSourcePart =
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string; entries: "all" | "json_files" }
  | { kind: "keychain"; service: string };

export interface CredentialSource {
  /** The Raft runtime id (`claude`, `codex`, `kimi-sdk`, `qoder`, `qwen`, `grok`). */
  runtime: string;
  parts: readonly CredentialSourcePart[];
}

export interface CredentialLocationContext {
  env: CredentialEnv;
  /** The home a runtime defaults to when the env sets no HOME. */
  homeDir: string;
  platform: NodeJS.Platform;
  /** Relative overrides resolve against it (as the drivers resolve CODEX_HOME / GROK_HOME). */
  cwd: string;
}

/** The Raft runtime a shared sign-in belongs to (`shared:<authRuntime>`). */
const RAFT_RUNTIME_BY_AUTH_RUNTIME: Readonly<Record<RuntimeAuthRuntime, string>> = {
  claude: "claude",
  codex: "codex",
  kimi: "kimi-sdk",
  qoder: "qoder",
  qwen: "qwen",
  antigravity: "antigravity",
  pi: "pi",
  grok: "grok",
  opencode: "opencode",
  codebuddy: "codebuddy",
};

export function raftRuntimeOfAuthRuntime(authRuntime: RuntimeAuthRuntime): string {
  return RAFT_RUNTIME_BY_AUTH_RUNTIME[authRuntime];
}

/** `baseEnv` under the agent's own env vars (what its runtime process sees). */
export function agentCredentialEnv(config: AgentConfig | null | undefined, baseEnv: CredentialEnv): CredentialEnv {
  if (!config) return baseEnv;
  const envVars = runtimeConfigToLaunchFields(hydrateRuntimeConfig(config)).envVars ?? {};
  return { ...baseEnv, ...envVars };
}

function envValue(env: CredentialEnv, name: string): string | null {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function homeOf(ctx: CredentialLocationContext): string {
  return envValue(ctx.env, "HOME") ?? (ctx.platform === "win32" ? envValue(ctx.env, "USERPROFILE") : null) ?? ctx.homeDir;
}

function resolvedEnvDir(ctx: CredentialLocationContext, name: string): string | null {
  const value = envValue(ctx.env, name);
  return value ? path.resolve(ctx.cwd, value) : null;
}

/**
 * The Keychain service Claude Code stores its sign-in under on macOS: the
 * plain name, or with a config dir set, the name suffixed with the first 8
 * hex chars of the sha256 of that dir (NFC-normalized).
 */
export function claudeKeychainService(env: CredentialEnv): string {
  const dir = envValue(env, "CLAUDE_SECURESTORAGE_CONFIG_DIR") ?? envValue(env, "CLAUDE_CONFIG_DIR");
  if (!dir) return "Claude Code-credentials";
  const suffix = createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

/**
 * Per runtime: where its credential lives for an agent with env `ctx.env`
 * (the agent's own homes honoured, B8), or null when it is not covered: a key
 * passed in the env (nothing on disk changes), a keyring store Raft cannot
 * see (Codex in keyring mode reads as an absent file), or a runtime not in
 * this table.
 */
const CREDENTIAL_SOURCE_RESOLVERS: Readonly<Record<string, (ctx: CredentialLocationContext) => CredentialSourcePart[] | null>> = {
  claude: (ctx) => {
    if (envValue(ctx.env, "ANTHROPIC_AUTH_TOKEN")) return null;
    const configDir = resolvedEnvDir(ctx, "CLAUDE_CONFIG_DIR") ?? path.join(homeOf(ctx), ".claude");
    const file: CredentialSourcePart = { kind: "file", path: path.join(configDir, ".credentials.json") };
    // macOS keeps the sign-in in the Keychain; Claude Code falls back to the
    // plaintext file when the Keychain is unavailable, so both are watched.
    return ctx.platform === "darwin" ? [{ kind: "keychain", service: claudeKeychainService(ctx.env) }, file] : [file];
  },
  codex: (ctx) => {
    if (envValue(ctx.env, "OPENAI_API_KEY")) return null;
    const codexHome = resolvedEnvDir(ctx, "CODEX_HOME") ?? path.join(homeOf(ctx), ".codex");
    return [{ kind: "file", path: path.join(codexHome, "auth.json") }];
  },
  "kimi-sdk": (ctx) => {
    const kimiHome = resolvedEnvDir(ctx, "KIMI_CODE_HOME") ?? path.join(homeOf(ctx), ".kimi-code");
    // `credentials/<storage>.json`: the storage name depends on the OAuth host pair.
    return [{ kind: "dir", path: path.join(kimiHome, "credentials"), entries: "json_files" }];
  },
  qoder: (ctx) => {
    if (envValue(ctx.env, "QODER_PERSONAL_ACCESS_TOKEN")) return null;
    const dirName = envValue(ctx.env, "QODER_CONFIG_DIR_NAME") ?? envValue(ctx.env, "QODERCN_CONFIG_DIR_NAME") ?? ".qoder";
    // Qoder's credential file name is not known: the config dir itself.
    return [{ kind: "dir", path: path.join(homeOf(ctx), dirName), entries: "all" }];
  },
  qwen: (ctx) => {
    const qwenHome = resolvedEnvDir(ctx, "QWEN_HOME") ?? path.join(homeOf(ctx), ".qwen");
    // Where OAR's Qwen auth status looks (presence only): settings, .env, legacy OAuth.
    return ["settings.json", ".env", "oauth_creds.json"].map((name) => ({ kind: "file" as const, path: path.join(qwenHome, name) }));
  },
  grok: (ctx) => {
    const grokHome = resolvedEnvDir(ctx, "GROK_HOME") ?? path.join(homeOf(ctx), ".grok");
    return [{ kind: "file", path: path.join(grokHome, "auth.json") }];
  },
};

export function credentialSourceFor(runtime: string, ctx: CredentialLocationContext): CredentialSource | null {
  const resolve = CREDENTIAL_SOURCE_RESOLVERS[runtime];
  const parts = resolve ? resolve(ctx) : null;
  return parts && parts.length > 0 ? { runtime, parts } : null;
}

/** The source kinds of `source`, for a trace (`file`, `dir`, `keychain`; comma-joined). Never a path. */
export function credentialSourceKinds(source: CredentialSource): string {
  return [...new Set(source.parts.map((part) => part.kind))].join(",");
}

// ----- Fingerprints ----------------------------------------------------------

/** A source part as it is now: `present` with an in-memory digest, `absent`, or `unreadable` (neither: compares as nothing). */
export type CredentialPartState =
  | { kind: "present"; digest: string }
  | { kind: "absent" }
  | { kind: "unreadable" };

/** The file system reads a fingerprint makes (sync: a few `stat` calls a tick). */
export interface CredentialFs {
  statSync(target: string): Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "isFile" | "isDirectory">;
  readFileSync(target: string): Buffer;
  readdirSync(target: string): Dirent[];
}

export const NODE_CREDENTIAL_FS: CredentialFs = {
  statSync: (target) => statSync(target),
  readFileSync: (target) => readFileSync(target),
  readdirSync: (target) => readdirSync(target, { withFileTypes: true }),
};

/**
 * Runs `/usr/bin/security` with `args` (attributes only: the caller never
 * passes `-w` or `-g`). Resolves with its exit code and stdout.
 */
export type SecurityCommandRunner = (args: readonly string[]) => Promise<{ code: number | null; stdout: string }>;

/**
 * The names `security` gets from the daemon's own environment: enough to find
 * the user's login keychain (HOME, USER, LOGNAME; the Keychain session itself
 * is the per-user securityd, reached without any variable) and to run
 * (PATH, TMPDIR). Nothing else: no runtime keys, no Raft tokens.
 */
export const SECURITY_COMMAND_ENV_NAMES = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR"] as const;

export function securityCommandEnv(source: NodeJS.ProcessEnv = ambientProcessEnv()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of SECURITY_COMMAND_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** The production runner: `/usr/bin/security`, bounded, its stdout only. It refuses the flags that print the secret. */
export const runSecurityCommand: SecurityCommandRunner = (args) => new Promise((resolve, reject) => {
  if (args.some((arg) => FORBIDDEN_SECURITY_FLAGS.has(arg))) {
    reject(new Error("refusing to read a Keychain secret"));
    return;
  }
  execFile("/usr/bin/security", [...args], { env: securityCommandEnv(), timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
    resolve({ code, stdout: String(stdout ?? "") });
  });
});

/** Read caps: a credential file is a few KiB; anything past the cap is not hashed. */
const CREDENTIAL_FILE_READ_CAP_BYTES = 64 * 1024;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The stat facts that change when a file is rewritten (atomic renames change `ino`). */
export function fileStatKey(target: string, fs: CredentialFs): string | "absent" | "unreadable" {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return "absent";
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    return isMissing(error) ? "absent" : "unreadable";
  }
}

/** The file's content digest (read only now: the caller saw its stat change). */
export function fileDigest(target: string, fs: CredentialFs): CredentialPartState {
  try {
    const content = fs.readFileSync(target);
    return { kind: "present", digest: sha256(content.length > CREDENTIAL_FILE_READ_CAP_BYTES ? content.subarray(0, CREDENTIAL_FILE_READ_CAP_BYTES) : content) };
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : { kind: "unreadable" };
  }
}

/** A directory's entries: names, and for files their size and mtime. Contents are never read. */
export function dirState(target: string, entries: "all" | "json_files", fs: CredentialFs): CredentialPartState {
  let listed: Dirent[];
  try {
    listed = fs.readdirSync(target);
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : { kind: "unreadable" };
  }
  const lines: string[] = [];
  for (const entry of listed) {
    if (entries === "json_files" && !entry.name.endsWith(".json")) continue;
    if (entry.isDirectory()) {
      // A subdirectory's mtime moves with every log or session file in it: its name only.
      lines.push(`d:${entry.name}`);
      continue;
    }
    try {
      const stat = fs.statSync(path.join(target, entry.name));
      lines.push(`f:${entry.name}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      // Gone between the listing and the stat: not there.
    }
  }
  return { kind: "present", digest: sha256(lines.sort().join("\n")) };
}

/** `security` exit code for "no such item". */
const SECURITY_ITEM_NOT_FOUND = 44;
const FORBIDDEN_SECURITY_FLAGS = new Set(["-w", "-g"]);

/** The argv for a Keychain item's attributes: never `-w` (the secret) or `-g` (the secret on stderr). */
export function keychainAttributesArgs(service: string): string[] {
  const args = ["find-generic-password", "-s", service];
  if (args.some((arg) => FORBIDDEN_SECURITY_FLAGS.has(arg))) throw new Error("refusing to read a Keychain secret");
  return args;
}

/** The Keychain item's modification date (`"mdat"<timedate>=...`): its fingerprint. */
export async function keychainState(service: string, run: SecurityCommandRunner): Promise<CredentialPartState> {
  let result: { code: number | null; stdout: string };
  try {
    result = await run(keychainAttributesArgs(service));
  } catch {
    return { kind: "unreadable" };
  }
  if (result.code === SECURITY_ITEM_NOT_FOUND) return { kind: "absent" };
  if (result.code !== 0) return { kind: "unreadable" };
  const mdat = /"mdat"<timedate>=(\S+)/u.exec(result.stdout)?.[1];
  return mdat ? { kind: "present", digest: sha256(mdat) } : { kind: "unreadable" };
}

// ----- Own writes ------------------------------------------------------------

type OwnCredentialWriteListener = (target: string) => void;
const ownCredentialWriteListeners = new Set<OwnCredentialWriteListener>();

/**
 * The daemon itself just rewrote the credential file `target` (the Kimi
 * token refresh): not a sign-in by the user, so a disk watch takes the new
 * content as what it compares against.
 */
export function noteOwnCredentialWrite(target: string): void {
  for (const listener of [...ownCredentialWriteListeners]) {
    try {
      listener(target);
    } catch {
      // A watch failing never fails the write.
    }
  }
}

export function onOwnCredentialWrite(listener: OwnCredentialWriteListener): () => void {
  ownCredentialWriteListeners.add(listener);
  return () => { ownCredentialWriteListeners.delete(listener); };
}

// ----- Accounts --------------------------------------------------------------

/**
 * The provider account a credential signs in as: `known` with a digest of
 * the account id (the id itself is never kept), or `unknown` (no file, no
 * id, unreadable).
 */
export type CredentialAccount = { kind: "known"; digest: string } | { kind: "unknown" };

const ACCOUNT_FILE_READ_CAP_BYTES = 8 * 1024 * 1024;

function readJsonObject(target: string, fs: CredentialFs): Record<string, unknown> | null {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > ACCOUNT_FILE_READ_CAP_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(target).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  const child = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof child === "object" && child !== null && !Array.isArray(child) ? child as Record<string, unknown> : null;
}

function knownAccount(id: unknown): CredentialAccount {
  return typeof id === "string" && id.trim().length > 0 ? { kind: "known", digest: sha256(id.trim()) } : { kind: "unknown" };
}

/**
 * Per runtime: where the account of the sign-in is, read locally:
 * - Codex: `tokens.account_id` in `<CODEX_HOME or ~/.codex>/auth.json`;
 * - Claude: `oauthAccount.accountUuid` in `$CLAUDE_CONFIG_DIR/.claude.json`,
 *   else `~/.claude.json` (on every platform: on macOS the token is in the
 *   Keychain, the account still in this file).
 * Other runtimes: not read (null).
 */
const CREDENTIAL_ACCOUNT_READERS: Readonly<Record<string, (ctx: CredentialLocationContext, fs: CredentialFs) => CredentialAccount | null>> = {
  codex: (ctx, fs) => {
    if (envValue(ctx.env, "OPENAI_API_KEY")) return null;
    const codexHome = resolvedEnvDir(ctx, "CODEX_HOME") ?? path.join(homeOf(ctx), ".codex");
    return knownAccount(recordAt(readJsonObject(path.join(codexHome, "auth.json"), fs), "tokens")?.account_id);
  },
  claude: (ctx, fs) => {
    if (envValue(ctx.env, "ANTHROPIC_AUTH_TOKEN")) return null;
    const configDir = resolvedEnvDir(ctx, "CLAUDE_CONFIG_DIR");
    const file = configDir ? path.join(configDir, ".claude.json") : path.join(homeOf(ctx), ".claude.json");
    return knownAccount(recordAt(readJsonObject(file, fs), "oauthAccount")?.accountUuid);
  },
};

export function readCredentialAccount(runtime: string, ctx: CredentialLocationContext, fs: CredentialFs = NODE_CREDENTIAL_FS): CredentialAccount | null {
  const read = CREDENTIAL_ACCOUNT_READERS[runtime];
  return read ? read(ctx, fs) : null;
}

/** Reads the account an agent's runtime signs in as (null: the runtime's account is not read). */
export type CredentialAccountReader = (config: AgentConfig) => CredentialAccount | null;

/** The production reader: the daemon's env under the agent's, the user's home. */
export function createCredentialAccountReader(
  baseEnv: () => CredentialEnv,
  opts: { homeDir?: string; platform?: NodeJS.Platform; cwd?: string; fs?: CredentialFs } = {},
): CredentialAccountReader {
  return (config) => readCredentialAccount(config.runtime || "claude", {
    env: agentCredentialEnv(config, baseEnv()),
    homeDir: opts.homeDir ?? os.homedir(),
    platform: opts.platform ?? process.platform,
    cwd: opts.cwd ?? process.cwd(),
  }, opts.fs);
}

/**
 * Reconciler step 15 (task #48, Tenny): a credential released because it
 * changed (web login or on disk) may now sign in as another account. A live
 * process keeps the account it started with (verified for Claude by a live
 * test, task #48, Otter bfe2d441: it takes the new token but keeps the old
 * account uuid), so it is restarted when:
 * - the account changed (`account_changed`), or
 * - it was known at the start and cannot be read now (`account_unknown`).
 * Same account, or unknown at the start (`started_unknown`), or a runtime
 * whose account is not read (`not_read`): release only.
 */
export type CredentialAccountCheck = "account_changed" | "account_unknown" | "same_account" | "started_unknown" | "not_read";

export function credentialAccountCheck(started: CredentialAccount | null | undefined, now: CredentialAccount | null): { check: CredentialAccountCheck; restart: boolean } {
  if (!started || !now) return { check: "not_read", restart: false };
  if (started.kind === "unknown") return { check: "started_unknown", restart: false };
  if (now.kind === "unknown") return { check: "account_unknown", restart: true };
  return now.digest === started.digest ? { check: "same_account", restart: false } : { check: "account_changed", restart: true };
}
