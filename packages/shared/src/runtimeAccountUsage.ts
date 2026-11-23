import { z } from "zod";
import { lazySchema } from "./lazySchema";

export const RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION = 2 as const;

/**
 * Server-side relay budget for a manual refresh round-trip: the server waits
 * for the computer's correlated snapshot before answering the refresh POST.
 * Collection usually completes in seconds, but a single daemon-side usage read
 * can run to its own 20s collector timeout, so the budget covers that worst
 * case plus transport slack — a slow Computer should surface as an answer,
 * not as a relay timeout.
 */
export const RUNTIME_ACCOUNT_USAGE_RELAY_BUDGET_MS = 25_000;

export const RUNTIME_ACCOUNT_USAGE_PROVIDERS = ["claude", "codex", "kimi", "grok", "antigravity"] as const;
export type RuntimeAccountUsageProvider = (typeof RUNTIME_ACCOUNT_USAGE_PROVIDERS)[number];
export function isRuntimeAccountUsageProvider(value: unknown): value is RuntimeAccountUsageProvider {
  return (RUNTIME_ACCOUNT_USAGE_PROVIDERS as readonly unknown[]).includes(value);
}

/**
 * The daemon reads Antigravity's account usage: its OAR (0.103+) has
 * `antigravityRuntime.accountUsage`. The server asks a Computer for provider
 * `antigravity` only when it advertises this, and answers the web's read
 * `unsupported` otherwise, so an older Computer keeps no usage for it (it would
 * answer `unsupported`, or `error` before Antigravity ran on its OAR host).
 */
export const DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY = "machine:runtime-account-usage:antigravity";

/** The daemon capability a provider's usage read needs; none for the providers every current Computer reads. */
const RUNTIME_ACCOUNT_USAGE_PROVIDER_CAPABILITIES: Partial<Record<RuntimeAccountUsageProvider, string>> = {
  antigravity: DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY,
};

/** Whether a Computer with these daemon capabilities reads this provider's usage. */
export function runtimeAccountUsageReadableWith(provider: RuntimeAccountUsageProvider, daemonCapabilities: Iterable<string>): boolean {
  const needed = RUNTIME_ACCOUNT_USAGE_PROVIDER_CAPABILITIES[provider];
  if (!needed) return true;
  for (const capability of daemonCapabilities) if (capability === needed) return true;
  return false;
}

/**
 * The providers whose usage a Computer also reads per agent account folder
 * (`accountHomes` on a refresh), and the env var that names that folder. An
 * agent's `HOME` moves the folder too (`~/.codex`, `~/.claude`).
 */
export const RUNTIME_ACCOUNT_USAGE_FOLDER_ENV = {
  codex: "CODEX_HOME",
  claude: "CLAUDE_CONFIG_DIR",
} as const satisfies Partial<Record<RuntimeAccountUsageProvider, string>>;
export type RuntimeAccountUsageFolderProvider = keyof typeof RUNTIME_ACCOUNT_USAGE_FOLDER_ENV;
export function isRuntimeAccountUsageFolderProvider(value: unknown): value is RuntimeAccountUsageFolderProvider {
  return value === "codex" || value === "claude";
}

/** The env var that gives such an agent a key instead of a signed-in account: it has no account folder to read. */
export const RUNTIME_ACCOUNT_USAGE_API_KEY_ENV = {
  codex: "OPENAI_API_KEY",
  claude: "ANTHROPIC_AUTH_TOKEN",
} as const satisfies Record<RuntimeAccountUsageFolderProvider, string>;

/** The env var names an `accountHomes` entry may carry for a provider: `HOME` and its folder key, nothing else. */
export function runtimeAccountUsageFolderEnvNames(provider: RuntimeAccountUsageFolderProvider): readonly [string, string] {
  return ["HOME", RUNTIME_ACCOUNT_USAGE_FOLDER_ENV[provider]];
}

/** The most `accountHomes` entries one refresh carries (agents with the same folder env share one). */
export const RUNTIME_ACCOUNT_USAGE_ACCOUNT_HOMES_MAX = 64;
const ACCOUNT_HOME_ENV_VALUE_MAX = 4096;

/**
 * One account folder the server asks a Computer to read on a refresh: the
 * agents (on that Computer, on this provider, on its default provider and
 * without an API key) whose env vars set `HOME` or the folder key, and those
 * env vars as the agents set them (only those two names).
 */
export type RuntimeAccountUsageAccountHome = {
  agentIds: string[];
  env: Record<string, string>;
};

/**
 * A refresh's `accountHomes` as the Computer may use it: only for a folder
 * provider, entries with valid agent ids and at least one allowed env var
 * (anything else dropped), at most RUNTIME_ACCOUNT_USAGE_ACCOUNT_HOMES_MAX.
 * Undefined when the message carries none (an older server), so the read
 * stays exactly as before.
 */
export function parseRuntimeAccountUsageAccountHomes(provider: RuntimeAccountUsageProvider, value: unknown): RuntimeAccountUsageAccountHome[] | undefined {
  if (!isRuntimeAccountUsageFolderProvider(provider) || !Array.isArray(value)) return undefined;
  const names = runtimeAccountUsageFolderEnvNames(provider);
  const homes: RuntimeAccountUsageAccountHome[] = [];
  for (const entry of value.slice(0, RUNTIME_ACCOUNT_USAGE_ACCOUNT_HOMES_MAX)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { agentIds, env } = entry as { agentIds?: unknown; env?: unknown };
    if (!Array.isArray(agentIds) || typeof env !== "object" || env === null) continue;
    const ids = [...new Set(agentIds.filter((id): id is string => runtimeAccountUsageAgentIdSchema.safeParse(id).success))].slice(0, RUNTIME_ACCOUNT_USAGE_AGENT_IDS_MAX);
    if (ids.length === 0) continue;
    const kept: Record<string, string> = {};
    for (const name of names) {
      const raw = (env as Record<string, unknown>)[name];
      if (typeof raw === "string" && raw.trim().length > 0 && raw.length <= ACCOUNT_HOME_ENV_VALUE_MAX && !raw.includes("\u0000")) kept[name] = raw;
    }
    if (Object.keys(kept).length === 0) continue;
    homes.push({ agentIds: ids, env: kept });
  }
  return homes;
}

export const RUNTIME_ACCOUNT_USAGE_HEALTHS = [
  "ok",
  "rate_limited",
  "reauth_required",
  "unsupported",
  "error",
] as const;
export type RuntimeAccountUsageHealth = (typeof RUNTIME_ACCOUNT_USAGE_HEALTHS)[number];

/**
 * Why an `unsupported` account has no usage reading: OAR's
 * `AccountUsageUnsupportedReason` (its docs/spec/account-usage.md), the codes
 * Raft knows. `quota_unavailable`: the account reports no usage limits (a
 * Claude API key, a Kimi account with no quota data); `version_unsupported`:
 * the CLI is too old to report it; the rest say why this installation or
 * sign-in cannot be read. A code Raft does not know is left out, which reads
 * as a plain `unsupported`.
 */
export const RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS = [
  "version_unsupported",
  "capability_unavailable",
  "unsupported_installation",
  "unsupported_auth_mode",
  "unsupported_auth_storage",
  "auth_configuration_unavailable",
  "endpoint_unavailable",
  "quota_unavailable",
] as const;
export type RuntimeAccountUsageUnsupportedReason = (typeof RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS)[number];

export function isRuntimeAccountUsageUnsupportedReason(value: unknown): value is RuntimeAccountUsageUnsupportedReason {
  return typeof value === "string" && (RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS as readonly string[]).includes(value);
}

/**
 * `parseErrorCode` of an account whose usage could not be read this time but
 * will be on a later read (OAR `{ kind: "unavailable" }`: Kimi's access token
 * expired and waits for Kimi Code to refresh it). Carried as one
 * `parse_unavailable` window under `ok` health, a shape every server already
 * accepts; the web says "temporarily unavailable" instead of an error.
 */
export const RUNTIME_ACCOUNT_USAGE_TEMPORARILY_UNAVAILABLE_CODE = "usage_temporarily_unavailable";

export const RUNTIME_ACCOUNT_USAGE_WINDOW_STATUSES = [
  "ok",
  "limit_reached",
  "parse_unavailable",
] as const;
export type RuntimeAccountUsageWindowStatus = (typeof RUNTIME_ACCOUNT_USAGE_WINDOW_STATUSES)[number];

const isoInstantSchema = lazySchema("isoInstantSchema", () => z.string().datetime({ offset: true }));
const safeLabelSchema = lazySchema("safeLabelSchema", () => z.string().trim().min(1).max(80).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "Label contains control characters",
));
const maskedLabelSchema = lazySchema("maskedLabelSchema", () => safeLabelSchema.refine(
  (value) => /[*•…]/u.test(value),
  "Account labels must contain an explicit mask marker",
));

/**
 * Converts a provider account email into the only identity form allowed in a
 * runtime-usage snapshot. Invalid or unusually long values stay absent rather
 * than being truncated into something that could be mistaken for an account.
 */
export function maskRuntimeAccountEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  if (email.length === 0 || email.length > 254 || /[\u0000-\u0020\u007f]/.test(email)) {
    return undefined;
  }

  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return undefined;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (
    local.length > 64
    || domain.length > 63
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) {
    return undefined;
  }
  const domainLabels = domain.split(".");
  if (
    domainLabels.length < 2
    || domainLabels.some((label) =>
      label.length === 0
      || label.length > 63
      || label.startsWith("-")
      || label.endsWith("-")
      || !/^[a-z0-9-]+$/.test(label),
    )
  ) {
    return undefined;
  }

  const prefixLength = local.length >= 8 ? 3 : 1;
  const remaining = local.length - prefixLength;
  const suffixLength = remaining > 4 ? Math.min(5, remaining - 4) : 0;
  const masked = `${local.slice(0, prefixLength)}****${
    suffixLength > 0 ? local.slice(-suffixLength) : ""
  }@${domain}`;
  return masked.length <= 80 ? masked : undefined;
}

/** The most limit resets a snapshot reports for one account; a larger count is not a reading Raft trusts. */
export const RUNTIME_LIMIT_RESETS_AVAILABLE_MAX = 999;

/**
 * What the runtime ties a usage window to (OAR's `AccountUsageWindow.scope`,
 * forwarded as given). `account`: the whole account's. `model`: one model's,
 * by the runtime's own name for it ("Opus", "Fable", Codex's limit name); not
 * promised to match a model id. `models`: a group of models sharing one
 * quota, by the runtime's name for the group (Antigravity's "Gemini Models",
 * "Claude and GPT models"; sent only to a server advertising
 * SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2). Absent: the
 * runtime says neither, or the Computer predates the field. Display only:
 * whether an agent is blocked is the account's health (`rate_limited`), never
 * a window's scope.
 */
export const runtimeAccountUsageWindowScopeSchema = lazySchema("runtimeAccountUsageWindowScopeSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account") }),
  z.strictObject({ kind: z.literal("model"), name: safeLabelSchema }),
  z.strictObject({ kind: z.literal("models"), name: safeLabelSchema }),
]));
export type RuntimeAccountUsageWindowScope = z.infer<typeof runtimeAccountUsageWindowScopeSchema>;

export const runtimeAccountUsageWindowSchema = lazySchema("runtimeAccountUsageWindowSchema", () => z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  label: safeLabelSchema,
  status: z.enum(RUNTIME_ACCOUNT_USAGE_WINDOW_STATUSES),
  usedRatio: z.number().finite().min(0).max(1).optional(),
  resetsAt: isoInstantSchema.optional(),
  /**
   * Sent only to a server advertising
   * SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1 (the daemon strips
   * it otherwise, `withoutWindowScopes`): an older server's strict parse
   * would refuse the whole snapshot.
   */
  scope: runtimeAccountUsageWindowScopeSchema.optional(),
}).superRefine((window, ctx) => {
  const hasUsage = window.usedRatio !== undefined;
  const hasReset = window.resetsAt !== undefined;
  if (window.status === "parse_unavailable") {
    if (hasUsage || hasReset) {
      ctx.addIssue({
        code: "custom",
        message: "parse_unavailable windows must omit both usedRatio and resetsAt",
      });
    }
    return;
  }
  if (!hasUsage) {
    ctx.addIssue({
      code: "custom",
      message: "usable windows require usedRatio",
    });
  }
}));

/** The most agent ids one account of a snapshot lists (`agentIds`). */
export const RUNTIME_ACCOUNT_USAGE_AGENT_IDS_MAX = 500;
/** The most accounts one snapshot carries: the default account and up to seven agents' own folders. */
export const RUNTIME_ACCOUNT_USAGE_ACCOUNTS_MAX = 8;
const runtimeAccountUsageAgentIdSchema = lazySchema("runtimeAccountUsageAgentIdSchema", () => z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/));

/** A credits balance as the runtime prints it: digits with `.` or `,`, an optional leading `-`. */
export const RUNTIME_ACCOUNT_USAGE_CREDITS_BALANCE_PATTERN = /^-?[0-9][0-9.,]{0,31}$/;
export const runtimeAccountUsageCreditsSchema = lazySchema("runtimeAccountUsageCreditsSchema", () => z.strictObject({
  available: z.boolean(),
  unlimited: z.boolean().optional(),
  balance: z.string().regex(RUNTIME_ACCOUNT_USAGE_CREDITS_BALANCE_PATTERN).optional(),
}));

export const runtimeAccountUsageAccountSchema = lazySchema("runtimeAccountUsageAccountSchema", () => z.strictObject({
  accountKey: z.string().regex(/^[a-f0-9]{64}$/),
  maskedLabel: maskedLabelSchema.optional(),
  planLabel: safeLabelSchema.optional(),
  // Provider-reported display name (Kimi's profile nickname). Unlike maskedLabel
  // it is not an email, so it carries no mask marker; accounts signed in by
  // phone have no email and this is their only readable identity.
  displayName: safeLabelSchema.optional(),
  health: z.enum(RUNTIME_ACCOUNT_USAGE_HEALTHS),
  /**
   * Why an `unsupported` account has no reading
   * (RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS); only with that health. Absent:
   * the runtime gave no reason, or the Computer predates it. A Computer sends
   * it only to a server that advertises
   * SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASON_V1; the server
   * serves it only to a web request declaring
   * RUNTIME_USAGE_UNSUPPORTED_REASON_CLIENT_CAPABILITY.
   */
  unsupportedReason: z.enum(RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS).optional(),
  /**
   * How many limit resets the account holds (Codex: OAR's
   * `limitResets.available`); absent when the runtime reports none or the
   * Computer predates it. A Computer sends it only to a server that
   * advertises SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1: an
   * older server's strict parse would refuse the whole snapshot.
   */
  limitResetsAvailable: z.number().int().min(0).max(RUNTIME_LIMIT_RESETS_AVAILABLE_MAX).optional(),
  /**
   * Extra usage credits (Codex: OAR's `credits`), which keep the account
   * running after a window is used up. `balance` is the runtime's own string,
   * with no unit or currency. Absent: unknown (the runtime did not say, or
   * the Computer predates it). A Computer sends it only to a server that
   * advertises SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_CREDITS_V1; the
   * server serves it only to a web request declaring
   * RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY.
   */
  credits: runtimeAccountUsageCreditsSchema.optional(),
  parseErrorCode: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/).optional(),
  windows: z.array(runtimeAccountUsageWindowSchema).max(12),
  /**
   * The agents whose own account folder (an agent env var setting `HOME` or
   * the runtime's folder key: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`) this account
   * was read from. Absent: the Computer's default account, read in the
   * daemon's own environment. A Computer sends it only in answer to a refresh
   * that carried `accountHomes` (a server that knows the field); the server
   * serves it only to a web request declaring
   * RUNTIME_USAGE_ACCOUNT_FOLDERS_CLIENT_CAPABILITY.
   */
  agentIds: z.array(runtimeAccountUsageAgentIdSchema).min(1).max(RUNTIME_ACCOUNT_USAGE_AGENT_IDS_MAX).optional(),
}).superRefine((account, ctx) => {
  if (account.health === "unsupported" && account.windows.length > 0) {
    ctx.addIssue({ code: "custom", message: "unsupported accounts cannot include usage windows" });
  }
  if (account.unsupportedReason !== undefined && account.health !== "unsupported") {
    ctx.addIssue({ code: "custom", message: "unsupportedReason requires unsupported health" });
  }
  if (account.parseErrorCode && !account.windows.some((window) => window.status === "parse_unavailable")) {
    ctx.addIssue({ code: "custom", message: "parseErrorCode requires a parse_unavailable window" });
  }
}));

export const runtimeAccountUsageSnapshotSchema = lazySchema("runtimeAccountUsageSnapshotSchema", () => z.strictObject({
  protocolVersion: z.literal(RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION),
  provider: z.enum(RUNTIME_ACCOUNT_USAGE_PROVIDERS),
  collectedAt: isoInstantSchema,
  staleAfter: isoInstantSchema,
  collectorVersion: z.string().trim().min(1).max(40),
  sourceVersion: z.string().trim().min(1).max(80).optional(),
  accounts: z.array(runtimeAccountUsageAccountSchema).min(1).max(RUNTIME_ACCOUNT_USAGE_ACCOUNTS_MAX),
}).superRefine((snapshot, ctx) => {
  const collectedAtMs = Date.parse(snapshot.collectedAt);
  const staleAfterMs = Date.parse(snapshot.staleAfter);
  if (staleAfterMs <= collectedAtMs) {
    ctx.addIssue({ code: "custom", path: ["staleAfter"], message: "staleAfter must be after collectedAt" });
  }
  const accountKeys = new Set<string>();
  for (let accountIndex = 0; accountIndex < snapshot.accounts.length; accountIndex += 1) {
    const account = snapshot.accounts[accountIndex]!;
    if (accountKeys.has(account.accountKey)) {
      ctx.addIssue({ code: "custom", path: ["accounts", accountIndex, "accountKey"], message: "accountKey must be unique" });
    }
    accountKeys.add(account.accountKey);
    const windowIds = new Set<string>();
    for (let windowIndex = 0; windowIndex < account.windows.length; windowIndex += 1) {
      const window = account.windows[windowIndex]!;
      if (windowIds.has(window.id)) {
        ctx.addIssue({ code: "custom", path: ["accounts", accountIndex, "windows", windowIndex, "id"], message: "window id must be unique per account" });
      }
      windowIds.add(window.id);
    }
  }
}));

export type RuntimeAccountUsageWindow = z.infer<typeof runtimeAccountUsageWindowSchema>;
export type RuntimeAccountUsageAccount = z.infer<typeof runtimeAccountUsageAccountSchema>;
export type RuntimeAccountUsageSnapshot = z.infer<typeof runtimeAccountUsageSnapshotSchema>;

export function parseRuntimeAccountUsageSnapshot(value: unknown): RuntimeAccountUsageSnapshot {
  return runtimeAccountUsageSnapshotSchema.parse(value);
}

export function safeParseRuntimeAccountUsageSnapshot(value: unknown) {
  return runtimeAccountUsageSnapshotSchema.safeParse(value);
}

/**
 * Drops what an older server's strict snapshot schema does not know, for a
 * Computer talking to a server without
 * SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1.
 */
export function withoutLimitResets(snapshot: RuntimeAccountUsageSnapshot): RuntimeAccountUsageSnapshot {
  if (!snapshot.accounts.some((account) => account.limitResetsAvailable !== undefined)) return snapshot;
  return {
    ...snapshot,
    accounts: snapshot.accounts.map(({ limitResetsAvailable: _dropped, ...account }) => account),
  };
}

/**
 * Drops every account's `credits`, for a reader that predates them (a server
 * without SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_CREDITS_V1, a web client
 * without RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY).
 */
export function withoutCredits(snapshot: RuntimeAccountUsageSnapshot): RuntimeAccountUsageSnapshot {
  if (!snapshot.accounts.some((account) => account.credits !== undefined)) return snapshot;
  return {
    ...snapshot,
    accounts: snapshot.accounts.map(({ credits: _dropped, ...account }) => account),
  };
}

/**
 * Drops every account's `unsupportedReason`, for a reader that predates it (a
 * server without SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASON_V1,
 * a web client without RUNTIME_USAGE_UNSUPPORTED_REASON_CLIENT_CAPABILITY).
 * The account then reads as a plain `unsupported`, as before.
 */
export function withoutUnsupportedReasons(snapshot: RuntimeAccountUsageSnapshot): RuntimeAccountUsageSnapshot {
  if (!snapshot.accounts.some((account) => account.unsupportedReason !== undefined)) return snapshot;
  return {
    ...snapshot,
    accounts: snapshot.accounts.map(({ unsupportedReason: _dropped, ...account }) => account),
  };
}

/**
 * Drops window scopes, for a Computer talking to a server without
 * SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1.
 */
export function withoutWindowScopes(snapshot: RuntimeAccountUsageSnapshot): RuntimeAccountUsageSnapshot {
  if (!snapshot.accounts.some((account) => account.windows.some((window) => window.scope !== undefined))) return snapshot;
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) => ({
      ...account,
      windows: account.windows.map(({ scope: _dropped, ...window }) => window),
    })),
  };
}

/**
 * Drops the scope of a window tied to a group of models (`models`), keeping
 * the rest: for a reader that knows `account` and `model` only (a server with
 * just SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, a web client
 * declaring `runtime-usage-window-scope@1`). Such a window then reads as one
 * the runtime gave no scope.
 */
export function withoutModelsScopes(snapshot: RuntimeAccountUsageSnapshot): RuntimeAccountUsageSnapshot {
  if (!snapshot.accounts.some((account) => account.windows.some((window) => window.scope?.kind === "models"))) return snapshot;
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) => ({
      ...account,
      windows: account.windows.map(({ scope, ...window }) => (scope && scope.kind !== "models" ? { ...window, scope } : window)),
    })),
  };
}

/**
 * A web client's declaration, in its `X-Raft-Client-Capabilities` request
 * header (RAFT_CLIENT_CAPABILITIES_HEADER), that its snapshot parser reads a
 * window's `scope`. Older web bundles parse snapshots strictly and refuse a
 * key they do not know, so the server sends `scope` only to a request that
 * declares this (`runtimeAccountUsageSnapshotForClient`). Versioned like the
 * other client tokens: `@1` reads `account` and `model`, `@2` also `models`.
 */
const RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY_VERSION = 2;
export const RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY = `runtime-usage-window-scope@${RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY_VERSION}`;

/** The highest `runtime-usage-window-scope@<n>` a request's `X-Raft-Client-Capabilities` value declares; 0 for none. */
export function runtimeUsageWindowScopeClientVersion(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  let version = 0;
  for (const value of raw.split(",")) {
    const match = /^runtime-usage-window-scope@([1-9][0-9]*)$/u.exec(value.trim());
    if (match) version = Math.max(version, Number(match[1]));
  }
  return version;
}

/**
 * A web client's declaration, in its `X-Raft-Client-Capabilities` request
 * header, that its snapshot parser reads an account's `agentIds` (an agent's
 * own account folder). Older bundles parse snapshots strictly, so the server
 * drops `agentIds` for a request without it (`runtimeAccountUsageSnapshotForClient`);
 * such a bundle then shows every account as before.
 */
export const RUNTIME_USAGE_ACCOUNT_FOLDERS_CLIENT_CAPABILITY = "runtime-usage-account-folders@1";

/**
 * A web client's declaration, in its `X-Raft-Client-Capabilities` request
 * header, that its snapshot parser reads an account's `credits`. Older
 * bundles parse snapshots strictly, so the server drops `credits` for a
 * request without it (`runtimeAccountUsageSnapshotForClient`).
 */
export const RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY = "runtime-usage-credits@1";

/**
 * A web client's declaration, in its `X-Raft-Client-Capabilities` request
 * header, that its snapshot parser reads an account's `unsupportedReason`.
 * Older bundles parse snapshots strictly, so the server drops it for a
 * request without it (`runtimeAccountUsageSnapshotForClient`).
 */
export const RUNTIME_USAGE_UNSUPPORTED_REASON_CLIENT_CAPABILITY = "runtime-usage-unsupported-reason@1";

function declaresClientCapability(raw: unknown, token: string): boolean {
  return typeof raw === "string" && raw.split(",").some((value) => value.trim() === token);
}

/** Drops every account's `agentIds`, for a reader that predates them. */
export function withoutAccountAgentIds(snapshot: RuntimeAccountUsageSnapshot): RuntimeAccountUsageSnapshot {
  if (!snapshot.accounts.some((account) => account.agentIds !== undefined)) return snapshot;
  return {
    ...snapshot,
    accounts: snapshot.accounts.map(({ agentIds: _dropped, ...account }) => account),
  };
}

/**
 * A snapshot without the agents a viewer may not find (a personal assistant
 * is found only by its owner): their ids leave every account's `agentIds`,
 * and an account left with none is dropped rather than kept without
 * `agentIds`, which would read as the Computer's default account. The
 * default account (no `agentIds`) always stays, so a snapshot keeps at least
 * one account.
 */
export function withoutHiddenAccountAgentIds(snapshot: RuntimeAccountUsageSnapshot, hidden: ReadonlySet<string>): RuntimeAccountUsageSnapshot {
  if (hidden.size === 0 || !snapshot.accounts.some((account) => account.agentIds?.some((id) => hidden.has(id)))) return snapshot;
  const accounts = snapshot.accounts.flatMap((account): RuntimeAccountUsageAccount[] => {
    if (!account.agentIds) return [account];
    const agentIds = account.agentIds.filter((id) => !hidden.has(id));
    return agentIds.length > 0 ? [{ ...account, agentIds }] : [];
  });
  return { ...snapshot, accounts };
}

/**
 * A snapshot in the shape this client reads: no window scopes unless its
 * request declared it reads them, and no `models` scope for a client that
 * declared only `@1`; no account `agentIds` unless it declared
 * RUNTIME_USAGE_ACCOUNT_FOLDERS_CLIENT_CAPABILITY; no `credits` unless it
 * declared RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY; no `unsupportedReason`
 * unless it declared RUNTIME_USAGE_UNSUPPORTED_REASON_CLIENT_CAPABILITY.
 */
export function runtimeAccountUsageSnapshotForClient(snapshot: RuntimeAccountUsageSnapshot, capabilitiesHeader: unknown): RuntimeAccountUsageSnapshot {
  const withReasons = declaresClientCapability(capabilitiesHeader, RUNTIME_USAGE_UNSUPPORTED_REASON_CLIENT_CAPABILITY) ? snapshot : withoutUnsupportedReasons(snapshot);
  const withCredits = declaresClientCapability(capabilitiesHeader, RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY) ? withReasons : withoutCredits(withReasons);
  const withFolders = declaresClientCapability(capabilitiesHeader, RUNTIME_USAGE_ACCOUNT_FOLDERS_CLIENT_CAPABILITY) ? withCredits : withoutAccountAgentIds(withCredits);
  const version = runtimeUsageWindowScopeClientVersion(capabilitiesHeader);
  if (version >= 2) return withFolders;
  return version === 1 ? withoutModelsScopes(withFolders) : withoutWindowScopes(withFolders);
}

/**
 * The Computer's default account in a snapshot: the one read in the daemon's
 * own environment (the first account without `agentIds`), else the first
 * account. What every Computer-level single-account reading uses (plan line,
 * limit resets, the 5-hour limit).
 */
export function defaultRuntimeUsageAccount(snapshot: RuntimeAccountUsageSnapshot | null | undefined): RuntimeAccountUsageAccount | null {
  if (!snapshot) return null;
  return snapshot.accounts.find((account) => account.agentIds === undefined) ?? snapshot.accounts[0] ?? null;
}

/**
 * The accounts an agent's usage reads from a snapshot of its Computer: the
 * account read from the agent's own folder (its id in `agentIds`), else the
 * default accounts (those without `agentIds`). An agent with its own folder
 * never sees the default account's numbers, nor another folder's. A snapshot
 * where no account lists agents (an older Computer, or no agent with its own
 * folder) reads as before: every account.
 */
export function runtimeUsageAccountsForAgent(snapshot: RuntimeAccountUsageSnapshot | null | undefined, agentId: string | null | undefined): RuntimeAccountUsageAccount[] {
  if (!snapshot) return [];
  if (!snapshot.accounts.some((account) => account.agentIds !== undefined)) return snapshot.accounts;
  const own = agentId ? snapshot.accounts.find((account) => account.agentIds?.includes(agentId)) : undefined;
  if (own) return [own];
  return snapshot.accounts.filter((account) => account.agentIds === undefined);
}

/**
 * The window OAR reports as Claude's third-party OAuth apps' weekly use
 * ("Current week (OAuth apps)", OAR id `seven_day_oauth_apps`). It is neither
 * the account's nor a model's, so usage summaries leave it out. The window ids
 * on the wire are hashes of the label, so the label names it.
 */
export const CLAUDE_OAUTH_APPS_WINDOW_LABEL = "Current week (OAuth apps)";

/** Claude's third-party OAuth apps' window: left out wherever the web lists or sums windows. */
export function isClaudeOAuthAppsWindow(window: Pick<RuntimeAccountUsageWindow, "label">): boolean {
  return window.label === CLAUDE_OAUTH_APPS_WINDOW_LABEL;
}

/**
 * Antigravity's model groups, by agy's names for them (the `name` of a
 * window's `models` scope, OAR 0.103): each group's models share one weekly
 * and one 5-hour quota.
 */
export const ANTIGRAVITY_USAGE_MODEL_GROUPS = {
  gemini: "Gemini Models",
  claudeAndGpt: "Claude and GPT models",
} as const;

/**
 * The model group (a `models` scope's name) an agent's model counts against,
 * from Raft's own reading of the runtime's model ids: Antigravity's `gemini*`
 * models are "Gemini Models", its Claude and GPT models "Claude and GPT
 * models". Null when it cannot tell: another runtime, Antigravity's
 * `default` (agy chooses), or an id of neither family. Display only (which
 * window to show for an agent); whether an agent can run follows the
 * account's health, never a group's window.
 */
export function runtimeUsageModelGroupOf(runtimeId: string, model: string | null | undefined): string | null {
  if (runtimeId !== "antigravity" || !model) return null;
  const id = model.trim().toLowerCase();
  if (id.startsWith("gemini")) return ANTIGRAVITY_USAGE_MODEL_GROUPS.gemini;
  if (/(?:^|\/)(?:claude|gpt)(?![a-z])/u.test(id)) return ANTIGRAVITY_USAGE_MODEL_GROUPS.claudeAndGpt;
  return null;
}

/** Whether a window counts against this model group (its `models` scope names it; agy's casing is not relied on). */
export function isRuntimeUsageModelGroupWindow(window: Pick<RuntimeAccountUsageWindow, "scope">, group: string): boolean {
  return window.scope?.kind === "models" && window.scope.name.toLowerCase() === group.toLowerCase();
}

/** Claude's label for a window tied to one model: "Current week (Fable)", "Current session (Opus)". */
const CLAUDE_MODEL_WINDOW_LABEL = /^Current (?:week|session) \((.+)\)$/u;

/** The model a scope-less Claude window's label names; null for "all models", the OAuth apps' window and any other label. */
function claudeModelOfLabel(window: Pick<RuntimeAccountUsageWindow, "label">): string | null {
  if (isClaudeOAuthAppsWindow(window)) return null;
  const name = CLAUDE_MODEL_WINDOW_LABEL.exec(window.label)?.[1]?.trim();
  return name && name.toLowerCase() !== "all models" ? name : null;
}

/**
 * Compatibility shim for Computers before window scope (Computer 1.22.0 and
 * earlier; `scope` arrives with Computer 1.25.0 / OAR 0.102): their Claude
 * windows carry no `scope`, so a model's own window ("Current week (Fable)")
 * would count as an all-models one, and an account with only Fable used up
 * would read as used up. A Claude window without `scope` whose label names a
 * model is read as that model's (`{ kind: "model", name }`); a window with a
 * scope, and every other provider, stay as given. Applied where a snapshot
 * is summarized (the web's usage read, the server's usage-limit notice), never
 * to what the cache stores or serves. Remove once the oldest supported
 * Computer reports scope (docs/contracts/runtime-account-usage.md).
 */
export function inferClaudeUsageWindowScopes(snapshot: RuntimeAccountUsageSnapshot): RuntimeAccountUsageSnapshot {
  if (snapshot.provider !== "claude") return snapshot;
  if (!snapshot.accounts.some((account) => account.windows.some((window) => !window.scope && claudeModelOfLabel(window)))) return snapshot;
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) => ({
      ...account,
      windows: account.windows.map((window) => {
        const name = window.scope ? null : claudeModelOfLabel(window);
        return name ? { ...window, scope: { kind: "model" as const, name } } : window;
      }),
    })),
  };
}

/** A window the runtime ties to one model or a group of models (OAR's `scope`), not the whole account. */
export function isModelScopedUsageWindow(window: Pick<RuntimeAccountUsageWindow, "scope">): boolean {
  return window.scope?.kind === "model" || window.scope?.kind === "models";
}

/** How used a window is, to compare windows: a reached limit above any share; null when unreadable. */
function windowTightness(window: RuntimeAccountUsageWindow): number | null {
  if (window.status === "limit_reached") return 2;
  return window.status === "ok" && typeof window.usedRatio === "number" ? window.usedRatio : null;
}

/**
 * An account whose every window is a group of models' (Antigravity: "Gemini
 * Models", "Claude and GPT models", OAR 0.103), with two groups or more: it
 * runs while any group has quota left (OAR reports it rate limited only once
 * every group is used up), so it counts as its group with the most left. Null
 * for any other account.
 */
function roomiestModelGroup(windows: readonly RuntimeAccountUsageWindow[]): RuntimeAccountUsageWindow[] | null {
  const groups = new Map<string, RuntimeAccountUsageWindow[]>();
  for (const window of windows) {
    if (window.scope?.kind !== "models") return null;
    const key = window.scope.name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), window]);
  }
  if (groups.size < 2) return null;
  let roomiest: { windows: RuntimeAccountUsageWindow[]; tightness: number } | null = null;
  for (const group of groups.values()) {
    const readings = group.map(windowTightness).filter((value): value is number => value !== null);
    if (readings.length === 0) continue;
    const tightness = Math.max(...readings);
    if (roomiest === null || tightness < roomiest.tightness) roomiest = { windows: group, tightness };
  }
  return roomiest?.windows ?? null;
}

/**
 * The account as every usage summary counts it (the web's rack cell and its
 * first line, the rack's sort, the bulk dialog, the usage card's badge; the
 * server's usage-limit notice): never Claude's OAuth apps' window
 * (third-party apps' use), and a model's or a group of models' own window
 * (OAR's `scope`) only when the account reports nothing else; then
 * `modelLine` is false, so the same model is never shown twice. An account
 * of model groups only (Antigravity) counts as its group with the most left,
 * and its model line shows the others. A limit reached only on a window left
 * out leaves the account its percentage (health `ok`): OAR marks the whole
 * account rate limited when any window is at its limit, a model's too. Display
 * and notices only; agent blocking follows the account's own health.
 */
export function allModelsUsageAccount(account: RuntimeAccountUsageAccount): { account: RuntimeAccountUsageAccount; modelLine: boolean } {
  const counted = account.windows.filter((window) => !isClaudeOAuthAppsWindow(window));
  const allModels = counted.filter((window) => !isModelScopedUsageWindow(window));
  const roomiestGroup = allModels.length === 0 ? roomiestModelGroup(counted) : null;
  const modelLine = roomiestGroup !== null || (allModels.length > 0 && counted.some(isModelScopedUsageWindow));
  const kept = roomiestGroup ?? (allModels.length > 0 ? allModels : counted);
  if (kept.length === account.windows.length) return { account, modelLine };
  const limitOnlyLeftOut = account.health === "rate_limited"
    && !kept.some((window) => window.status === "limit_reached")
    && account.windows.some((window) => !kept.includes(window) && window.status === "limit_reached");
  return { account: { ...account, ...(limitOnlyLeftOut ? { health: "ok" as const } : {}), windows: kept }, modelLine };
}

/**
 * Spending one of an account's limit resets from the web (Codex; OAR's
 * `Runtime.redeemLimitReset`). The idempotency key names one attempt: the web
 * mints it once per confirmed click and sends the same key again when it
 * retries an attempt whose outcome it never learned, so a retry never spends
 * a second reset. The server and the Computer pass it through unchanged.
 */
const limitResetIdempotencyKeySchema = lazySchema("limitResetIdempotencyKeySchema", () => z.string().regex(/^[A-Za-z0-9_-]{16,128}$/));

export type RuntimeLimitResetIdempotencyKey = string & { readonly __runtimeLimitResetIdempotencyKey: unique symbol };

export function isRuntimeLimitResetIdempotencyKey(value: unknown): value is RuntimeLimitResetIdempotencyKey {
  return limitResetIdempotencyKeySchema.safeParse(value).success;
}

export function asRuntimeLimitResetIdempotencyKey(value: string): RuntimeLimitResetIdempotencyKey | null {
  return isRuntimeLimitResetIdempotencyKey(value) ? value : null;
}

/** How long the Computer lets OAR's redeem run (OAR's own default for Codex). */
export const RUNTIME_LIMIT_RESET_REDEEM_TIMEOUT_MS = 20_000;
/**
 * Server-side relay budget for a redeem: the Computer's redeem, the usage
 * read it runs right after (its own 20s collector timeout), and transport
 * slack.
 */
export const RUNTIME_LIMIT_RESET_RELAY_BUDGET_MS = 50_000;

/**
 * Which of a Claude account's limit resets a person chose to use. Claude Code
 * holds them by kind and has no way to spend "one of them"; OAR drives Claude
 * Code's own `/limit-reset <kind>` command (`resetId`), always with the kind.
 */
export const RUNTIME_LIMIT_RESET_KINDS = ["five_hour", "weekly", "fable", "full"] as const;
export const runtimeLimitResetKindSchema = lazySchema("runtimeLimitResetKindSchema", () => z.enum(RUNTIME_LIMIT_RESET_KINDS));
export type RuntimeLimitResetKind = (typeof RUNTIME_LIMIT_RESET_KINDS)[number];
export function isRuntimeLimitResetKind(value: unknown): value is RuntimeLimitResetKind {
  return (RUNTIME_LIMIT_RESET_KINDS as readonly unknown[]).includes(value);
}

/**
 * How long the Computer gives a Claude limit-reset redeem or read, counted
 * from when the request arrives: a slow start of the terminal UI (30 s, then
 * 3 s for it to settle), the command, and the 30 s Claude Code may take over
 * the claim itself. Codex keeps RUNTIME_LIMIT_RESET_REDEEM_TIMEOUT_MS.
 */
export const RUNTIME_LIMIT_RESET_CLAUDE_TIMEOUT_MS = 75_000;
/**
 * Server-side relay budget for a Claude redeem or read. The Computer's
 * timeout above runs from the moment the request arrives, so it already
 * covers waiting behind another request; this adds ending the session (a few
 * seconds), the usage read after a redeem (its own 20s collector timeout) and
 * transport slack. It must stay above the sum of those.
 */
export const RUNTIME_LIMIT_RESET_CLAUDE_RELAY_BUDGET_MS = 120_000;

/** OAR's `AccountUsageReauthReason`. */
export const RUNTIME_LIMIT_RESET_REAUTH_REASONS = ["not_authenticated", "credentials_missing", "scope_missing", "credentials_rejected"] as const;
/**
 * OAR's `AccountUsageUnsupportedReason`, and `not_installed` when the runtime
 * is not on the Computer. The last three are the Claude driver's: a Claude
 * Code version it was not tested against, a platform it cannot drive, and
 * `not_attempted`: nothing was spent and nothing learned, because the Computer
 * was busy with other requests or ran out of time before confirming; the same
 * click may be tried again. A Computer sends those only in answer to a request
 * that named a `kind` (or a read), which an older server never sends.
 * `onboarding_required`: Claude Code stopped at a first-run page OAR does not
 * complete on its own (OAR 0.114 completes Claude Code 2.1.322's theme and
 * Security notes pages; any other is this), so nothing was spent; opening
 * Claude Code once on that Computer finishes it. A Computer sends it only to
 * a request that carries `onboardingRequiredReason`, which the server sets
 * only for a web page that said it reads this (an older server or page reads
 * only `not_attempted` there).
 */
export const RUNTIME_LIMIT_RESET_UNSUPPORTED_REASONS = [
  "capability_unavailable",
  "unsupported_installation",
  "unsupported_auth_mode",
  "unsupported_auth_storage",
  "auth_configuration_unavailable",
  "endpoint_unavailable",
  "quota_unavailable",
  "not_installed",
  "unsupported_version",
  "unsupported_platform",
  "not_attempted",
  "onboarding_required",
] as const;

/**
 * How a redeem ended. The first six are OAR's `LimitResetResult`. `unknown`:
 * the redeem threw (timeout, network, an answer OAR could not read), so it is
 * not known whether a reset was spent; retry with the same idempotency key.
 * None of them says what the limits are now: read usage again.
 */
export const runtimeLimitResetResultSchema = lazySchema("runtimeLimitResetResultSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reset") }),
  z.strictObject({ kind: z.literal("nothing_to_reset") }),
  z.strictObject({ kind: z.literal("no_reset") }),
  z.strictObject({ kind: z.literal("already_redeemed") }),
  z.strictObject({ kind: z.literal("reauth_required"), reason: z.enum(RUNTIME_LIMIT_RESET_REAUTH_REASONS) }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.enum(RUNTIME_LIMIT_RESET_UNSUPPORTED_REASONS) }),
  // `fiveHourSpent`: Claude's older program spent its 5-hour reset with no
  // confirmation while a different kind was being asked for (Claude only).
  z.strictObject({ kind: z.literal("unknown"), fiveHourSpent: z.literal(true).optional() }),
]));
export type RuntimeLimitResetResult = z.infer<typeof runtimeLimitResetResultSchema>;

/**
 * Why a read of the resets an account holds was refused. `consent_required`:
 * the account is at its 5-hour limit and the person has not accepted that
 * opening Claude Code's command there can spend a 5-hour reset unasked (see
 * the read message in index.ts).
 */
export const RUNTIME_LIMIT_RESETS_READ_UNSUPPORTED_REASONS = [...RUNTIME_LIMIT_RESET_UNSUPPORTED_REASONS, "consent_required"] as const;

/**
 * What Claude Code showed for one kind when asked. `available` carries only
 * what the screen positively said: `expiresText` is Claude Code's own wording
 * ("Nov 19, 4:58pm", no year or zone), `expiresAt` only when an exact instant
 * is known. `none`: it said there is no such reset. `unknown`: the screen was
 * not recognised. `not_checked`: the kind was left out on purpose.
 * `not_offered`: the account is on Claude's older program, which has no such
 * kind.
 */
export const runtimeLimitResetKindStatusSchema = lazySchema("runtimeLimitResetKindStatusSchema", () => z.discriminatedUnion("state", [
  z.strictObject({
    kind: runtimeLimitResetKindSchema,
    state: z.literal("available"),
    resetsLeft: z.number().int().min(0).max(RUNTIME_LIMIT_RESETS_AVAILABLE_MAX).optional(),
    resetsTotal: z.number().int().min(0).max(RUNTIME_LIMIT_RESETS_AVAILABLE_MAX).optional(),
    expiresAt: isoInstantSchema.optional(),
    expiresText: safeLabelSchema.optional(),
  }),
  z.strictObject({ kind: runtimeLimitResetKindSchema, state: z.literal("none") }),
  z.strictObject({ kind: runtimeLimitResetKindSchema, state: z.literal("unknown") }),
  z.strictObject({ kind: runtimeLimitResetKindSchema, state: z.literal("not_checked") }),
  z.strictObject({ kind: runtimeLimitResetKindSchema, state: z.literal("not_offered") }),
]));
export type RuntimeLimitResetKindStatus = z.infer<typeof runtimeLimitResetKindStatusSchema>;

/**
 * How a read of the resets an account holds ended. `read` has one entry per
 * kind, in RUNTIME_LIMIT_RESET_KINDS order. `program: "legacy"`: Claude Code
 * answered as its older program does (one 5-hour reset a week, no kinds, and
 * no confirmation when it is used), so only `five_hour` can be anything but
 * `not_offered`. `fiveHourSpent`: opening the command spent the older
 * program's 5-hour reset (the hazard a read at the 5-hour limit needs consent
 * for). `unknown`: nothing could be read (Claude Code did not start, or timed
 * out before the first kind).
 */
export const runtimeLimitResetsReadResultSchema = lazySchema("runtimeLimitResetsReadResultSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("read"),
    program: z.literal("legacy").optional(),
    fiveHourSpent: z.literal(true).optional(),
    resets: z.array(runtimeLimitResetKindStatusSchema).max(RUNTIME_LIMIT_RESET_KINDS.length),
  }),
  z.strictObject({ kind: z.literal("reauth_required"), reason: z.enum(RUNTIME_LIMIT_RESET_REAUTH_REASONS) }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.enum(RUNTIME_LIMIT_RESETS_READ_UNSUPPORTED_REASONS) }),
  z.strictObject({ kind: z.literal("unknown") }),
]));
export type RuntimeLimitResetsReadResult = z.infer<typeof runtimeLimitResetsReadResultSchema>;

/** Whether usage shows a Claude account at its 5-hour limit; `unknown` when it does not say. */
export type ClaudeFiveHourLimit = "at_limit" | "not_at_limit" | "unknown";

/** Claude's 5-hour window, as OAR labels it (the window ids on the wire are hashes of the label). */
export const CLAUDE_FIVE_HOUR_WINDOW_LABEL = "Current session";

/**
 * The 5-hour limit from a Claude usage snapshot. Only one default account (no
 * `agentIds`) with
 * measured windows (health `ok`, or `rate_limited`, which is how OAR reports
 * an account at one of its limits) and one readable "Current session" window
 * counts as an answer; anything else is `unknown`. Read by
 * the server from its cache to tell the Computer, and the web to ask the
 * person's consent first; only OAR's own usage read on the Computer, right
 * before a Claude limit-reset command, decides what is typed.
 */
export function claudeFiveHourLimitOf(snapshot: RuntimeAccountUsageSnapshot | null | undefined): ClaudeFiveHourLimit {
  if (snapshot?.provider !== "claude") return "unknown";
  // Limit resets act on the default account only: agents' own folders (`agentIds`) are not it.
  const defaults = snapshot.accounts.filter((candidate) => candidate.agentIds === undefined);
  if (defaults.length !== 1) return "unknown";
  const account = defaults[0]!;
  if (account.health !== "ok" && account.health !== "rate_limited") return "unknown";
  const windows = account.windows.filter((window) => window.label === CLAUDE_FIVE_HOUR_WINDOW_LABEL);
  if (windows.length !== 1) return "unknown";
  const window = windows[0]!;
  if (window.status === "limit_reached") return "at_limit";
  if (window.status === "ok" && window.usedRatio !== undefined && window.usedRatio < 1) return "not_at_limit";
  return "unknown";
}
