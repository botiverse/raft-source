import type { OnboardingStep, WorkspaceEntry } from "./types.js";

/**
 * Minimal shape of a `getStatus().servers` row needed to resolve a reused
 * attachment for the success/bring-online step. Kept narrow so this module
 * (and its test) does not depend on the full Computer status report type.
 *
 * `serverConnected` distinguishes a *live* reused attachment from a *stopped*
 * one (e.g. after sign-out stopped the service per rule 1 → must be brought
 * back online before claiming connected).
 */
export interface AttachedServerRow {
  serverId: string;
  machineId: string | null;
  serverConnected: boolean;
}

export function hasAvailableWorkspace(
  workspaces: WorkspaceEntry[],
  attachedServers: AttachedServerRow[],
  excludeServerId?: string,
): boolean {
  const attachedServerIds = new Set(attachedServers.map((s) => s.serverId));
  return workspaces.some(
    (w) =>
      w.id !== excludeServerId &&
      w.attachable &&
      (!w.alreadyAttached || !attachedServerIds.has(w.id)),
  );
}

/**
 * Decide the onboarding step to land on after `listWorkspaces` succeeds.
 *
 * Three outcomes, in priority order:
 *
 * 1. **Something new to connect** — at least one *eligible* workspace
 *    (attachable AND not yet attached) → the picker, auto-selecting when there
 *    is exactly one.
 * 2. **Already attached but stopped** — no eligible workspace BUT this Computer
 *    has a stopped valid attachment → reuse it via `bringing-online`. Without
 *    this branch, re-login lands here: `logout` clears only the user session, so
 *    the per-server attachment under `computer/servers/<serverId>/runner.state.json`
 *    survives and the server comes back `alreadyAttached` → zero eligible → the
 *    user is pushed back through "connect", creating a *duplicate* Computer.
 *    (task #132 / #134)
 * 3. **Everything is already connected** — no eligible workspace and every
 *    attachable server is already attached/connected → show the all-connected
 *    screen instead of falsely implying there is one workspace left to open.
 * 4. **Genuinely nothing** — no eligible AND no existing attachment (e.g. only
 *    member-role servers, none attached) → the empty screen.
 */
export function decideWorkspaceStep(
  workspaces: WorkspaceEntry[],
  attachedServers: AttachedServerRow[],
): OnboardingStep {
  const attachedServerIds = new Set(attachedServers.map((s) => s.serverId));
  const eligible = workspaces.filter((w) =>
    hasAvailableWorkspace([w], attachedServers),
  );
  if (eligible.length > 0) {
    return {
      step: "workspaces",
      workspaces,
      selected: eligible.length === 1 ? eligible[0].slug : null,
    };
  }

  const attached = workspaces.find((w) => w.alreadyAttached && attachedServerIds.has(w.id));
  if (attached) {
    const stoppedAttached = workspaces.find((w) => {
      if (!w.alreadyAttached) return false;
      const row = attachedServers.find((s) => s.serverId === w.id);
      return row && !row.serverConnected;
    });
    // A reused attachment whose runner is stopped (sign-out stopped the service)
    // must be brought back online before we claim all servers are connected.
    if (stoppedAttached) {
      const row = attachedServers.find((s) => s.serverId === stoppedAttached.id);
      return {
        step: "bringing-online",
        workspaceName: stoppedAttached.name,
        workspaceSlug: stoppedAttached.slug,
        serverId: stoppedAttached.id,
        machineId: row?.machineId ?? null,
      };
    }

    return {
      step: "workspaces-empty",
      reason: "all-connected",
    };
  }

  const attachedWithoutLocalStatus = workspaces.find((w) => w.alreadyAttached);
  if (attachedWithoutLocalStatus) {
    return {
      step: "workspaces",
      workspaces,
      selected: attachedWithoutLocalStatus.slug,
    };
  }

  return {
    step: "workspaces-empty",
    reason: workspaces.length === 0 ? "no-servers" : "all-connected",
  };
}
