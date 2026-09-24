export const OFFICIAL_ONBOARDING_AGENT_IDENTITY = {
  name: "Cindy",
  displayName: "Cindy",
  description: "Onboarding Assistant",
  avatarUrl: "pixel:mug",
  serverRole: "admin",
} as const;

export function hasOfficialOnboardingAgentIdentity(agent: {
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
}, serverRole: string | null): boolean {
  return agent.name === OFFICIAL_ONBOARDING_AGENT_IDENTITY.name
    && agent.displayName === OFFICIAL_ONBOARDING_AGENT_IDENTITY.displayName
    && agent.description === OFFICIAL_ONBOARDING_AGENT_IDENTITY.description
    && agent.avatarUrl === OFFICIAL_ONBOARDING_AGENT_IDENTITY.avatarUrl
    && serverRole === OFFICIAL_ONBOARDING_AGENT_IDENTITY.serverRole;
}
