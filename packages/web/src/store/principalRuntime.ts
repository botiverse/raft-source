let currentPrincipalId: string | null = null;

export function getCurrentPrincipalId(): string | null {
  return currentPrincipalId;
}

export function setCurrentPrincipalId(principalId: string | null): void {
  currentPrincipalId = principalId;
}
