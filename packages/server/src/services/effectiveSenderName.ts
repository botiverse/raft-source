export interface EffectiveSenderNameSource {
  displayName: string | null;
  name: string;
}

export function effectiveUserSenderName(
  user: EffectiveSenderNameSource | null | undefined,
): string {
  return user?.displayName || user?.name || "User";
}

export function effectiveAgentSenderName(
  agent: EffectiveSenderNameSource | null | undefined,
): string {
  return agent?.displayName || agent?.name || "Agent";
}
