export function isAuthErrorStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

export class MissingRefreshTokenError extends Error {
  constructor() {
    super("Missing refresh token");
    this.name = "MissingRefreshTokenError";
  }
}

export function setAuthRefreshAttemptIdOnError(error: unknown, authRefreshAttemptId: string): void {
  if (!error || typeof error !== "object") return;
  Object.defineProperty(error, "authRefreshAttemptId", {
    configurable: true,
    enumerable: false,
    value: authRefreshAttemptId,
  });
}

export function authRefreshAttemptIdFromError(err: unknown): string | undefined {
  const value = (err as { authRefreshAttemptId?: unknown } | null)?.authRefreshAttemptId;
  return typeof value === "string" && /^arf_[0-9a-f]{16}$/.test(value) ? value : undefined;
}

export function isMissingRefreshTokenError(err: unknown): boolean {
  return err instanceof MissingRefreshTokenError || (err as any)?.name === "MissingRefreshTokenError";
}
