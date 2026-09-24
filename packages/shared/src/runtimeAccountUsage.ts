import { z } from "zod";

export const RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION = 2 as const;

export const RUNTIME_ACCOUNT_USAGE_PROVIDERS = ["claude", "codex", "kimi", "grok"] as const;
export type RuntimeAccountUsageProvider = (typeof RUNTIME_ACCOUNT_USAGE_PROVIDERS)[number];

export const RUNTIME_ACCOUNT_USAGE_HEALTHS = [
  "ok",
  "rate_limited",
  "reauth_required",
  "unsupported",
  "error",
] as const;
export type RuntimeAccountUsageHealth = (typeof RUNTIME_ACCOUNT_USAGE_HEALTHS)[number];

export const RUNTIME_ACCOUNT_USAGE_WINDOW_STATUSES = [
  "ok",
  "limit_reached",
  "parse_unavailable",
] as const;
export type RuntimeAccountUsageWindowStatus = (typeof RUNTIME_ACCOUNT_USAGE_WINDOW_STATUSES)[number];

const isoInstantSchema = z.string().datetime({ offset: true });
const safeLabelSchema = z.string().trim().min(1).max(80).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "Label contains control characters",
);
const maskedLabelSchema = safeLabelSchema.refine(
  (value) => /[*•…]/u.test(value),
  "Account labels must contain an explicit mask marker",
);

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

export const runtimeAccountUsageWindowSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  label: safeLabelSchema,
  status: z.enum(RUNTIME_ACCOUNT_USAGE_WINDOW_STATUSES),
  usedRatio: z.number().finite().min(0).max(1).optional(),
  resetsAt: isoInstantSchema.optional(),
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
});

export const runtimeAccountUsageAccountSchema = z.strictObject({
  accountKey: z.string().regex(/^[a-f0-9]{64}$/),
  maskedLabel: maskedLabelSchema.optional(),
  planLabel: safeLabelSchema.optional(),
  health: z.enum(RUNTIME_ACCOUNT_USAGE_HEALTHS),
  parseErrorCode: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/).optional(),
  windows: z.array(runtimeAccountUsageWindowSchema).max(12),
}).superRefine((account, ctx) => {
  if (account.health === "unsupported" && account.windows.length > 0) {
    ctx.addIssue({ code: "custom", message: "unsupported accounts cannot include usage windows" });
  }
  if (account.parseErrorCode && !account.windows.some((window) => window.status === "parse_unavailable")) {
    ctx.addIssue({ code: "custom", message: "parseErrorCode requires a parse_unavailable window" });
  }
});

export const runtimeAccountUsageSnapshotSchema = z.strictObject({
  protocolVersion: z.literal(RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION),
  provider: z.enum(RUNTIME_ACCOUNT_USAGE_PROVIDERS),
  collectedAt: isoInstantSchema,
  staleAfter: isoInstantSchema,
  collectorVersion: z.string().trim().min(1).max(40),
  sourceVersion: z.string().trim().min(1).max(80).optional(),
  accounts: z.array(runtimeAccountUsageAccountSchema).min(1).max(8),
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
});

export type RuntimeAccountUsageWindow = z.infer<typeof runtimeAccountUsageWindowSchema>;
export type RuntimeAccountUsageAccount = z.infer<typeof runtimeAccountUsageAccountSchema>;
export type RuntimeAccountUsageSnapshot = z.infer<typeof runtimeAccountUsageSnapshotSchema>;

export function parseRuntimeAccountUsageSnapshot(value: unknown): RuntimeAccountUsageSnapshot {
  return runtimeAccountUsageSnapshotSchema.parse(value);
}

export function safeParseRuntimeAccountUsageSnapshot(value: unknown) {
  return runtimeAccountUsageSnapshotSchema.safeParse(value);
}
