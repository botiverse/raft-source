// Which first-party apps (apps/firstPartyApps.ts) are on for a server: each
// app's server-scoped flag (FirstPartyApp.flag). What agents are told about
// the apps (first-party app mechanism §七): agent start sends it as
// AgentConfig.enabledApps (services/agentOrchestrator.ts) and the agent
// context as features.enabledApps (routes/internalAgentApi.ts), and the shared
// CLI guide renders each known app's entry from it.
//
// Only registry apps: the Reminder and Vault apps are installed integrations
// (the app platform's), and their own flags keep reaching agents as
// reminderApp / vaultApp.
import type { FirstPartyApp } from "../platform/apps";
import { firstPartyApps } from "../apps/firstPartyApps";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { evaluateFeatureFlags } from "./featureFlagService";

/**
 * The ids of the apps whose flag is on for `serverId`, in registry order, in
 * one batched evaluation. An evaluation failure reads as all off (`[]`), as
 * the other start flags do; `site` names the caller in that warning. `apps`
 * defaults to the registry (tests pass their own).
 */
export async function enabledFirstPartyAppIds(
  serverId: string,
  site: string,
  apps: readonly FirstPartyApp[] = firstPartyApps(),
): Promise<string[]> {
  try {
    return await enabledFirstPartyAppIdsStrict(serverId, apps);
  } catch (error) {
    console.warn(`[${site}] first-party app flag evaluation failed; reporting none on`, serializeErrorForLog(error));
    return [];
  }
}

/**
 * enabledFirstPartyAppIds without its fallback: an evaluation failure throws,
 * for a caller that must not report "none on" when it could not tell (the
 * daemon's `server:features`).
 */
export async function enabledFirstPartyAppIdsStrict(
  serverId: string,
  apps: readonly FirstPartyApp[] = firstPartyApps(),
): Promise<string[]> {
  if (apps.length === 0) return [];
  const answers = await evaluateFeatureFlags(apps.map((app) => ({ key: app.flag, serverId })));
  return apps.filter((_, index) => answers[index]?.enabled === true).map((app) => app.id);
}
