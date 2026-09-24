export function getRegistrationBlockedReason(): string | null {
  return null;
}

export function isRegistrationEnabled(): boolean {
  return getRegistrationBlockedReason() === null;
}

export function assertRegistrationEnabled(): void {
  const blockedReason = getRegistrationBlockedReason();
  if (blockedReason) {
    throw new Error(blockedReason);
  }
}
