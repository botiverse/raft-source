/** Product tiers, not provider license keys. Unknown tiers never grant access. */
export type AppSumoTier = 1 | 2 | 3 | 4;

export interface AppSumoEntitlement {
  tier: AppSumoTier;
  lifetime: true;
}

export interface AppSumoPlanLimits {
  maxHumans: number;
  maxAgents: number;
  maxHostedJointChannels: number;
  monthlyUploadBytes: number;
}

const GIB = 1024 ** 3;
/** Agreed in #proj-Appsumo:18f81485: independent seats, UTC monthly uploads. */
export const APPSUMO_PLAN_LIMITS: Readonly<Record<AppSumoTier, Readonly<AppSumoPlanLimits>>> = {
  1: { maxHumans: 2, maxAgents: 10, maxHostedJointChannels: 2, monthlyUploadBytes: GIB },
  2: { maxHumans: 6, maxAgents: 30, maxHostedJointChannels: 5, monthlyUploadBytes: 5 * GIB },
  3: { maxHumans: 12, maxAgents: 60, maxHostedJointChannels: 10, monthlyUploadBytes: 20 * GIB },
  4: { maxHumans: 25, maxAgents: 100, maxHostedJointChannels: 20, monthlyUploadBytes: 100 * GIB },
};

export function isAppSumoTier(value: unknown): value is AppSumoTier {
  return value === 1 || value === 2 || value === 3 || value === 4;
}
