/**
 * Server domain events + reducer — RFC 037 T5-server.
 *
 * This reducer owns only push-shaped server domain state:
 * server list/entity facts, current server, sidebar order, and serverEpoch.
 * Request-shaped data such as members, billing, and usage remains outside
 * this event-store slice.
 */

import type { Server, SidebarOrderPreferences } from "../serverStore";

export const DEFAULT_SIDEBAR_ORDER: SidebarOrderPreferences = {
  channelOrder: [],
  agentOrder: [],
  dmOrder: [],
  channelSortMode: "manual",
  jointChannelSortMode: "manual",
  dmSortMode: "manual",
  pinnedSortMode: "manual",
  pinned: [],
  pinnedChannelIds: [],
  pinnedAgentIds: [],
  pinnedOrder: [],
  hiddenDmIds: [],
  channelPanelTabOrder: [],
  agentPanelTabOrder: [],
  customSections: [],
  sectionOrder: ["system:pinned", "system:joint", "system:channels", "system:dms"],
  sectionPlacements: [],
  sectionsVersion: 0,
  pinnedVersion: 0,
};

export interface ServerDomainState {
  servers: Server[];
  current: Server | null;
  sidebarOrder: SidebarOrderPreferences;
  serverEpoch: number;
}

export type ServerPatchEvent =
  | {
      kind: "patch";
      patch: "current-set";
      server: Server;
    }
  | {
      kind: "patch";
      patch: "current-clear";
    }
  | {
      kind: "patch";
      patch: "server-upsert";
      server: Pick<Server, "id"> & Partial<Server>;
    }
  | {
      kind: "patch";
      patch: "membership-removed";
      serverId: string;
    }
  | {
      kind: "patch";
      patch: "sidebar-order-set";
      sidebarOrder: SidebarOrderPreferences;
    };

export type ServerHydrateEvent =
  | {
      kind: "hydrate";
      source: "servers";
      servers: Server[];
    }
  | {
      kind: "hydrate";
      source: "sidebar-order";
      serverId: string;
      epoch: number;
      sidebarOrder: SidebarOrderPreferences;
    };

export interface ServerReconcileEvent {
  kind: "reconcile";
  servers: Server[];
}

export type ServerEvent = ServerHydrateEvent | ServerPatchEvent | ServerReconcileEvent;

export interface ServerTransition {
  event:
    | `hydrate:${ServerHydrateEvent["source"]}`
    | `patch:${ServerPatchEvent["patch"]}`
    | "reconcile";
  touched: number;
  serverEpochDelta: number;
  reconcileSuggested: boolean;
}

export interface ServerApplyResult {
  state: ServerDomainState;
  transition: ServerTransition;
}

export function applyServerEvent(
  state: ServerDomainState,
  event: ServerEvent,
): ServerApplyResult {
  switch (event.kind) {
    case "hydrate":
      return applyHydrate(state, event);
    case "patch":
      return applyPatch(state, event);
    case "reconcile":
      return applyReconcile(state, event);
  }
}

function applyHydrate(state: ServerDomainState, event: ServerHydrateEvent): ServerApplyResult {
  switch (event.source) {
    case "servers": {
      const current = reconcileCurrentReference(state.current, event.servers, { clearMissing: false });
      const next: ServerDomainState = { ...state, servers: event.servers, current };
      return changed(state, next, "hydrate:servers", 0);
    }
    case "sidebar-order": {
      if (state.current?.id !== event.serverId || state.serverEpoch !== event.epoch) {
        return noop(state, "hydrate:sidebar-order");
      }
      const next: ServerDomainState = { ...state, sidebarOrder: event.sidebarOrder };
      return changed(state, next, "hydrate:sidebar-order", 0);
    }
  }
}

function applyPatch(state: ServerDomainState, event: ServerPatchEvent): ServerApplyResult {
  switch (event.patch) {
    case "current-set": {
      const servers = upsertFullServer(state.servers, event.server);
      const next: ServerDomainState = {
        ...state,
        servers,
        current: event.server,
        sidebarOrder: DEFAULT_SIDEBAR_ORDER,
        serverEpoch: state.serverEpoch + 1,
      };
      return changed(state, next, "patch:current-set", 1);
    }
    case "current-clear": {
      if (!state.current) return noop(state, "patch:current-clear");
      const next: ServerDomainState = {
        ...state,
        current: null,
        sidebarOrder: DEFAULT_SIDEBAR_ORDER,
        serverEpoch: state.serverEpoch + 1,
      };
      return changed(state, next, "patch:current-clear", 1);
    }
    case "server-upsert": {
      const servers = patchKnownServerList(state.servers, event.server);
      const current = state.current?.id === event.server.id
        ? patchServer(state.current, event.server)
        : state.current;
      const next: ServerDomainState = { ...state, servers, current };
      return changed(state, next, "patch:server-upsert", 0);
    }
    case "membership-removed": {
      const servers = state.servers.filter((server) => server.id !== event.serverId);
      const removedFromList = servers.length !== state.servers.length;
      const wasCurrent = state.current?.id === event.serverId;
      if (!removedFromList && !wasCurrent) return noop(state, "patch:membership-removed");
      const next: ServerDomainState = {
        ...state,
        servers,
        current: wasCurrent ? null : state.current,
        sidebarOrder: wasCurrent ? DEFAULT_SIDEBAR_ORDER : state.sidebarOrder,
        serverEpoch: wasCurrent ? state.serverEpoch + 1 : state.serverEpoch,
      };
      return changed(state, next, "patch:membership-removed", wasCurrent ? 1 : 0);
    }
    case "sidebar-order-set": {
      const next: ServerDomainState = { ...state, sidebarOrder: event.sidebarOrder };
      return changed(state, next, "patch:sidebar-order-set", 0);
    }
  }
}

function applyReconcile(state: ServerDomainState, event: ServerReconcileEvent): ServerApplyResult {
  const current = reconcileCurrentReference(state.current, event.servers, { clearMissing: true });
  const next: ServerDomainState = { ...state, servers: event.servers, current };
  return changed(state, next, "reconcile", 0);
}

function upsertFullServer(servers: Server[], server: Server): Server[] {
  const index = servers.findIndex((item) => item.id === server.id);
  if (index === -1) return [...servers, server];
  if (servers[index] === server) return servers;
  const next = [...servers];
  next[index] = server;
  return next;
}

function patchKnownServerList(
  servers: Server[],
  patch: Pick<Server, "id"> & Partial<Server>,
): Server[] {
  const index = servers.findIndex((item) => item.id === patch.id);
  if (index === -1) return servers;
  const patched = patchServer(servers[index], patch);
  if (patched === servers[index]) return servers;
  const next = [...servers];
  next[index] = patched;
  return next;
}

function patchServer<T extends Server>(
  server: T,
  patch: Pick<Server, "id"> & Partial<Server>,
): T {
  let changed = false;
  const next = { ...server } as T;
  for (const [key, value] of Object.entries(patch) as Array<[keyof Server, Server[keyof Server]]>) {
    if (key === "id") continue;
    if (!Object.is(next[key], value)) {
      next[key] = value as never;
      changed = true;
    }
  }
  return changed ? next : server;
}

function reconcileCurrentReference(
  current: Server | null,
  servers: Server[],
  options: { clearMissing: boolean },
): Server | null {
  if (!current) return null;
  return servers.find((server) => server.id === current.id) ?? (options.clearMissing ? null : current);
}

function changed(
  previous: ServerDomainState,
  next: ServerDomainState,
  event: ServerTransition["event"],
  epochDeltaHint: number,
): ServerApplyResult {
  if (
    previous.servers === next.servers
    && previous.current === next.current
    && previous.sidebarOrder === next.sidebarOrder
    && previous.serverEpoch === next.serverEpoch
  ) {
    return noop(previous, event);
  }
  const serverEpochDelta = next.serverEpoch - previous.serverEpoch;
  return {
    state: next,
    transition: {
      event,
      touched: 1,
      serverEpochDelta: serverEpochDelta || epochDeltaHint,
      reconcileSuggested: false,
    },
  };
}

function noop(state: ServerDomainState, event: ServerTransition["event"]): ServerApplyResult {
  return {
    state,
    transition: {
      event,
      touched: 0,
      serverEpochDelta: 0,
      reconcileSuggested: false,
    },
  };
}
