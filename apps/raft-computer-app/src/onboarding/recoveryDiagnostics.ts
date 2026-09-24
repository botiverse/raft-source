const SECRET_PATTERNS: RegExp[] = [
  /sk_[a-z]+_[A-Za-z0-9._-]+/g,
  /\beyJ[A-Za-z0-9._-]{20,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

const MAX_DETAIL_LENGTH = 260;

export interface RecoveryFailure {
  message: string;
  errorCode?: string;
  actionId: string;
}

export function createOnboardingActionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `onb-${Date.now().toString(36)}`;
}

export function recoveryFailureFromError(
  err: unknown,
  actionId: string,
  fallbackMessage: string,
): RecoveryFailure {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : fallbackMessage;
  const code = typeof (err as { code?: unknown } | null)?.code === "string"
    ? ((err as { code: string }).code)
    : undefined;
  return {
    message,
    errorCode: code,
    actionId,
  };
}

export function scrubRecoveryDetail(message: string): string {
  let out = message.replace(/\s+/g, " ").trim();
  for (const re of SECRET_PATTERNS) out = out.replace(re, "***REDACTED***");
  if (out.length > MAX_DETAIL_LENGTH) {
    out = `${out.slice(0, MAX_DETAIL_LENGTH - 1)}...`;
  }
  return out;
}

export function recoveryErrorCode(code?: string): string {
  const normalized = code?.trim();
  return normalized && normalized.length > 0 ? normalized : "UNKNOWN";
}

export function buildRecoveryDiagnostics(input: {
  failedStep: "sign-in" | "connect" | "bring-online";
  message: string;
  errorCode?: string;
  actionId: string;
}): string {
  return [
    "Raft Computer setup recovery",
    `failed_step=${input.failedStep}`,
    `error_code=${recoveryErrorCode(input.errorCode)}`,
    `action_id=${input.actionId}`,
    `message=${scrubRecoveryDetail(input.message)}`,
  ].join("\n");
}
