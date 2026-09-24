/**
 * Server→Computer app-config transport composition (task #204).
 *
 * DAG position: the TOP of the config chain. This is the only module that
 * combines the three lower layers —
 *
 *   shared spec  ←  pure projector / app definition  ←  manifest catalog  ←  HERE
 *
 * It imports the manifest catalog (for the per-app projectors) and the durable
 * config service, and owns snapshot/push composition. Nothing below imports it,
 * so there is no back edge: the catalog stays free of the DB service, and the
 * app definition stays free of both.
 *
 * OS-layer file — it names no app. Which apps publish config is data supplied
 * by `BUILT_IN_APP_CONFIG_PROJECTORS`.
 *
 * Config truth only: no notification, timer, measurement, or audit consumer.
 */

import type { AppConfigWireSnapshot } from "@botiverse/raft-shared/src/appConfigTransport.js";
import {
  appConfigTraceAttrs,
  appSnapshotTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace.js";

import { composeAppSnapshot } from "./appSnapshotComposition.js";
import { BUILT_IN_APP_CONFIG_PROJECTORS } from "./rapBuiltinAppManifests.js";
import { getRapAppConfig } from "./rapAppConfigService.js";

/** Read one app's durable config and project it onto the wire. */
async function snapshotFor(
  projector: (typeof BUILT_IN_APP_CONFIG_PROJECTORS)[number],
  input: { serverId: string; ownerAgentId: string },
): Promise<AppConfigWireSnapshot> {
  const stored = await getRapAppConfig({
    serverId: input.serverId,
    subjectAgentId: input.ownerAgentId,
    appId: projector.appId,
  });
  return projector.project({
    ownerAgentId: input.ownerAgentId,
    revision: stored.revision,
    effective: stored.effective,
  });
}

/** Every built-in app config envelope owned by one agent. */
export async function listBuiltInAppConfigSnapshotsForAgent(input: {
  serverId: string;
  ownerAgentId: string;
}) {
  return composeAppSnapshot<AppConfigWireSnapshot>(
    BUILT_IN_APP_CONFIG_PROJECTORS.map((projector) => ({
      snapshotTraceAttrs: appSnapshotTraceAttrs({
        appId: projector.appId,
        ownerAgentId: input.ownerAgentId,
        snapshotKind: "app_config",
      }),
      build: async () => {
        const envelope = await snapshotFor(projector, input);
        return [{ value: envelope, traceAttrs: appConfigTraceAttrs(envelope) }];
      },
    })),
    appSnapshotTraceAttrs({
      ownerAgentId: input.ownerAgentId,
      snapshotKind: "app_config",
    }),
  );
}

/**
 * Push one app's freshly-read config to its owner's Computer after a durable
 * mutation.
 *
 * Re-reads through the same path the snapshot uses rather than trusting the
 * caller's patch result, so the Computer can never receive an envelope that
 * disagrees with the store. Returns false when the app publishes no config or
 * the machine is offline — the daemon refills via `app_config.snapshot.request`
 * on reconnect, so a false here is a deferral, not a loss.
 */
export async function pushBuiltInAppConfigForOwner(input: {
  appId: string;
  serverId: string;
  ownerAgentId: string;
  orchestrator: {
    pushAppConfigUpsert(agentId: string, config: AppConfigWireSnapshot): Promise<boolean>;
  };
}): Promise<boolean> {
  const projector = BUILT_IN_APP_CONFIG_PROJECTORS.find(
    (candidate) => candidate.appId === input.appId,
  );
  if (!projector) return false;
  const envelope = await snapshotFor(projector, {
    serverId: input.serverId,
    ownerAgentId: input.ownerAgentId,
  });
  return input.orchestrator.pushAppConfigUpsert(input.ownerAgentId, envelope);
}
