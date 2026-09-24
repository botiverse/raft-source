// `raft-computer runners list|stop` — CLI presenters over the ComputerApi.
// Control-plane runner ops, scoped to one attached server (§12 whitelist
// enforced SERVER-SIDE; this renders exactly what the server returned; the
// per-server sk_computer_* is used ONLY as a bearer, never printed).
//
// Server selection (the v4 ambient rule: 1 attached → slug optional; ≥2 →
// required, fail-loud) is resolved presenter-side via the slug-aware target
// resolver; the api takes a concrete serverId / attachment. The api throws the
// RUNNERS_*/RUNNER_* closed-set errors; `present()` maps them to the shared
// stderr error contract.
import { resolveTargetServerId, resolveTargetAttachment } from "./targetServer.js";
import { resolveRaftHome } from "./paths.js";
import { fail, info, present } from "./output.js";
import { formatServerSlugDisplay, listServerAttachments } from "./serverState.js";
import { createComputerApi } from "./lib/api.js";
import type { RunnerListItem } from "./apiClient.js";

export async function runRunnersList(opts: {
  server?: string | null;
  all?: boolean;
}): Promise<void> {
  const all = opts.all === true;
  const home = resolveRaftHome();
  const serverIds = all
    ? [await resolveTargetServerId({ server: opts.server })]
    : opts.server
      ? [await resolveTargetServerId({ server: opts.server })]
      : (await listServerAttachments(home)).map((a) => a.serverId);
  if (serverIds.length === 0) {
    fail("NO_ATTACHMENT", "No server attachments yet. Run `raft-computer attach /<serverSlug>` (e.g. `/myserver`) first.");
  }
  const api = createComputerApi(resolveRaftHome());
  await present(async () => {
    const blocks = [];
    for (const serverId of serverIds) {
      blocks.push(await api.runnersList(serverId, { all }));
    }
    const total = blocks.reduce((sum, block) => sum + block.runners.length, 0);

    if (total === 0) {
      info(all ? "No runners on the selected server." : "No runners on this Computer.");
      return;
    }
    for (const block of blocks) {
      if (block.runners.length === 0) continue;
      const label = block.serverSlug ? formatServerSlugDisplay(block.serverSlug) : block.serverId;
      printRunnersBlock(label, block.runners);
    }
  });
}

function printRunnersBlock(label: string, runners: RunnerListItem[]): void {
  info("");
  info(`Server ${label}:`);
  info("  AGENT                                 STATUS     RUNTIME   MODEL          NAME");
  for (const r of runners) {
    info(
      `  ${r.agentId.padEnd(38)}${(r.status ?? "").padEnd(11)}${(r.runtime ?? "").padEnd(10)}${(r.model ?? "").padEnd(15)}${r.name ?? ""}`,
    );
  }
  info("");
}

export async function runRunnersStop(
  agentId: string,
  opts: { server?: string | null } = {},
): Promise<void> {
  // Arg validation is CLI-layer ergonomics — stays presenter-side.
  if (!agentId || agentId.trim().length === 0) {
    fail("AGENT_ID_REQUIRED", "Usage: raft-computer runners stop <agentId> [serverSlug]");
  }
  const a = await resolveTargetAttachment({ server: opts.server });
  const api = createComputerApi(resolveRaftHome());
  await present(async () => {
    const { serverSlug, serverId } = await api.runnersStop(agentId, {
      serverUrl: a.serverUrl,
      apiKey: a.apiKey,
      serverSlug: a.serverSlug ?? null,
      serverId: a.serverId,
    });
    const label = serverSlug ? formatServerSlugDisplay(serverSlug) : serverId;
    info(`Stop signalled for runner ${agentId} on server ${label}.`);
  });
}
