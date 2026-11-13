/**
 * Server feature flags for the web, per tab and per server.
 *
 * - Every registered key is evaluated in one batch per server
 *   (POST /feature-flags/evaluate) the first time something asks; all
 *   consumers share the answer. Until it lands every flag reads off
 *   ("loading"); a first evaluation that fails twice resolves "undetermined"
 *   (still off).
 * - Re-read on return: when the page becomes visible again or the window gets
 *   focus, each joined server whose last evaluation (answer or final failure)
 *   is more than SERVER_FEATURE_FLAG_STALE_MS old is evaluated again
 *   (startServerFeatureFlagRefreshOnFocus, started by App while signed in).
 *   A server with an evaluation in flight is skipped, so focus and
 *   visibilitychange firing together send one request.
 * - A failed re-evaluation keeps the previous values: once a server has a
 *   resolved answer, no refresh (this one, Settings, RaftBench) replaces it
 *   with the fail-closed "undetermined" one. The next re-read on return waits
 *   another SERVER_FEATURE_FLAG_STALE_MS.
 * - Off -> on applies at once. On -> off from the re-read on return never
 *   tears down UI in use: a mounted useServerFeatureFlag consumer that already
 *   rendered the flag on keeps reading it on until it unmounts or its server
 *   changes; new mounts and plain reads (readServerFeatureFlag) see off.
 *   Paths someone asked for apply both ways at once and release those holds:
 *   refreshServerFeatureFlags (Settings after a Labs change, RaftBench's
 *   rollout check), a Labs readback, logout.
 * - An answer is published only while it is current: a logout (session
 *   generation) or a newer refresh of the same server (server generation)
 *   discards one still in flight, and so does leaving the server for the
 *   re-read on return.
 * - Re-read on change: `server:features-changed` (a flag affecting that server
 *   may have changed) and every socket reconnect (the notice isn't replayed)
 *   re-read the servers this tab already evaluated, after a random wait of up
 *   to SERVER_FEATURES_CHANGED_JITTER_MS so the tabs a global change reaches
 *   don't all ask at once (store/featureFlagRealtimeSync.ts). Same rules as the
 *   re-read on return, whatever the age of the last answer.
 */
import {
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
  AGENT_USAGE_FEATURE_FLAG_KEY,
  PRO_SEAT_ADD_FEATURE_FLAG_KEY,
  PRO_PREPAID_FEATURE_FLAG_KEY,
  AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY,
  APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY,
  INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY,
  ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY,
  CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
  CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY,
  CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY,
  EXTERNAL_CHANNELS_FEATURE_FLAG_KEY,
  HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
  SERVER_LABS_UI_FEATURE_FLAG_KEY,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  SERVER_GUEST_FEATURE_FLAG_KEY,
  WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
  clearClockTimeout,
  currentRandomUnit,
  currentTimeMs,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { useCallback, useRef, useSyncExternalStore } from "react";

import api from "../api/client";
import { isServerLabEffectivelyEnabled } from "../utils/serverLabsSettings";
import type { ServerLabSettingsReadback } from "../utils/serverLabsSettings";
import { useServerStore } from "./serverStore";

/** RaftBench pilot: default off; enroll only the approved server ID via rollout controls. */
export const RAFTBENCH_OVERVIEW_FLAG_KEY = "raftbench_overview_v0";

/**
 * Personal assistant v0 (RFC 075): the Assistant rail entry and its page.
 * Per server, on only in /botiverse and /raft at first. Default off: no rail
 * entry, no Home row, and /assistant redirects to the server's home.
 */
export const PERSONAL_ASSISTANT_FLAG_KEY = "personal_assistant";

/**
 * Task v2 (#wg-task-v2): tasks own their conversation, hang under a source
 * message (many per message), and open as cards beside the messages from the
 * channel header. Per server, on in /botiverse and /raft first. Default off:
 * the Chat | Tasks | Files tabs and the single task chip stay as they are.
 * Same key as the server's TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY.
 */
export const TASK_V2_CONVERSATIONS_FLAG_KEY = "task_v2_conversations_v0";

/**
 * Deep links v1 (#proj-mobile): the in-app browser guide, the desktop-browser
 * "Open in Raft Desktop" banner, Settings › General › How links open, and the
 * shared "Message not found" landing for a message link. Default off: none of
 * it shows. Also answerable before login (the guide on a signed-out page in
 * WeChat reads it through useDeepLinksFlag's public read).
 */
export const DEEP_LINKS_FLAG_KEY = "deep_links_v1";

/**
 * Drafts (artin, #triage:#127): the sidebar row beside Saved, and its page,
 * listing every unsent composer draft. Default off; seeded on for the
 * botiverse and raft servers only. Off, the row and /drafts are gone; drafts
 * themselves are still kept by the composer.
 */
export const DRAFTS_SECTION_FLAG_KEY = "drafts_section_v0";

/**
 * Web preview (stdrc, #proj-workspace:a351cd82): a card message's Button with
 * `open: "beside"` opens its page in a sandboxed frame in the channel's side
 * area (features/webPreview) instead of a new tab. Web only: the server
 * stores and evaluates it and reads it nowhere (the card's `open` is stored
 * whatever it says). Server-scoped, default off, no rules (migration
 * web_preview_flag). Off: every card button opens a new tab, as before.
 */
export const WEB_PREVIEW_FLAG_KEY = "web_preview_v0";
/**
 * Desktop web preview view: in Raft Desktop (a shell with
 * raftDesktop.webPreview), the web preview panel shows its page in a real
 * browser view the shell lays over the panel (an Electron WebContentsView in
 * its own session partition, apps/desktop main/webPreviewView.ts) instead of
 * the sandboxed frame most sites refuse. Web (desktop renderer) only: the
 * server stores and evaluates it and reads it nowhere. Server-scoped, default
 * off, no rules (migration desktop_web_preview_view_flag). Off, or in a
 * browser: the frame, as before.
 */
export const DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY = "desktop_web_preview_view_v0";

/**
 * Agent Lounge v0 (#proj-chat:30a58e4d): an agent's Lounge (zh 会客厅), the
 * one public conversation where the server's members talk with that agent.
 * Per server. Default off: no Lounge row under an agent's DM, no Lounge
 * button on the DM page or the profile, and the server answers 404 for it.
 */
export const AGENT_LOUNGE_FLAG_KEY = "agent_lounge_v0";

/**
 * Activity inbox refresh, step 3a (#triage:#244, Tenny): a persisted read of a
 * row Activity already lists leaves that row as the read made it, without the
 * GET /api/channels/inbox re-read (inboxInPlaceUnread readPersistedSkipsReread).
 * Only `read_persisted`; live messages and thread replies still re-read, and
 * so does a read of a row the list does not show. Web only: the server stores
 * and evaluates it and reads it nowhere. Server-scoped, default off, no rules
 * (migration inbox_read_inplace_flag); turning it on needs a human's approval.
 * Off: every persisted read re-reads, as before.
 */
export const INBOX_READ_INPLACE_FLAG_KEY = "inbox_read_inplace_v1";

export { HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY, AGENT_READ_PROGRESS_FEATURE_FLAG_KEY, PRO_SEAT_ADD_FEATURE_FLAG_KEY, PRO_PREPAID_FEATURE_FLAG_KEY, APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY };

const SERVER_FEATURE_FLAG_REGISTRY = {
  // View Context (shared agentContextView.ts). The web reads it for
  // Administration's View Context access section (owners and admins grant an
  // agent other agents' context); its routes answer 404 while it is off.
  agentContextView: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  agentLounge: AGENT_LOUNGE_FLAG_KEY,
  agentMigrationHosted: AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY,
  // Agent read progress (shared agentReadProgress.ts): each agent's face on
  // the last message it read in the open conversation, moved live, and the
  // agent read line under your latest message (its starting positions are the
  // read receipts hydrate). Off: no watch, no column.
  agentReadProgress: AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
  // Agent token usage (#proj-o11y:#36): the agent panel's Usage tab, for
  // whoever sees Activity. Off: no tab, and GET /agent-usage answers 404.
  agentUsage: AGENT_USAGE_FEATURE_FLAG_KEY,
  antiprotonHostedRuntime: ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY,
  appPromptTextConsent: APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY,
  // Forum-style channels (#proj-chat:#24): the channel settings switch and the
  // activity-ordered timeline of a channel set to `threadSort: "activity"`.
  // Off: every channel shows in post order and the switch is hidden.
  channelThreadSort: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
  // Channel announcements (#proj-chat:#29): the strip under the channel header
  // and the Announcement row in channel details (components/channel/
  // ChannelAnnouncement*). Off: neither, and no announcement is read.
  channelAnnouncement: CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY,
  // Claude limit resets on the Computer usage card (RuntimeAccountUsageChip,
  // features/computer/ClaudeLimitResetsDialog): View available resets and Use
  // per kind, where the Computer also advertises the Claude driver. Off:
  // nothing new on the card; the server refuses Claude resets too.
  claudeLimitReset: CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY,
  deepLinks: DEEP_LINKS_FLAG_KEY,
  // External channel invites (#wg-rbac:#16), read for the channel's host
  // Server: Add External Member, the Invited group, the External sidebar label.
  // Also the one gate of a member connecting their own server (Connected
  // servers' ⋯) and of the host disconnecting another server (#wg-rbac:#55).
  externalChannels: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY,
  draftsSection: DRAFTS_SECTION_FLAG_KEY,
  // Built pixel avatars for people: "Build an avatar" in the avatar edit menu
  // (HumanAvatarEditMenu), read for the current server. Off: Upload a photo
  // only. A stored built avatar draws whatever this reads.
  humanAvatarBuilder: HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY,
  inboxReadInPlace: INBOX_READ_INPLACE_FLAG_KEY,
  // Interactive link cards (RFC 076): App links read in one batched v2 read
  // per message (components/message/useAppLinkPreviews.ts). Off: the GET.
  interactiveLinkCards: INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY,
  providerConnections: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  raftbenchOverview: RAFTBENCH_OVERVIEW_FLAG_KEY,
  personalAssistant: PERSONAL_ASSISTANT_FLAG_KEY,
  // Adding Pro seats in place from Create Agent, Invite and Guest → member.
  proSeatAdd: PRO_SEAT_ADD_FEATURE_FLAG_KEY,
  // Prepaid Pro paid once with Alipay (task #19): its choice in the upgrade dialog.
  proPrepaid: PRO_PREPAID_FEATURE_FLAG_KEY,
  taskV2Conversations: TASK_V2_CONVERSATIONS_FLAG_KEY,
  publicServer: PUBLIC_SERVER_FEATURE_FLAG_KEY,
  serverLabsUi: SERVER_LABS_UI_FEATURE_FLAG_KEY,
  slackBridge: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
  serverGuest: SERVER_GUEST_FEATURE_FLAG_KEY,
  webPreview: WEB_PREVIEW_FLAG_KEY,
  desktopWebPreviewView: DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY,
  workspaceArtifacts: WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
} as const;

export const REGISTERED_SERVER_FEATURE_FLAG_KEYS = Object.freeze(
  Object.values(SERVER_FEATURE_FLAG_REGISTRY).sort(),
);

export type RegisteredServerFeatureFlagKey =
  (typeof REGISTERED_SERVER_FEATURE_FLAG_KEYS)[number];

export type ServerFeatureFlagResolution = "loading" | "resolved" | "undetermined";
export type ServerFeatureFlagState =
  | "loading"
  | "enabled"
  | "disabled"
  | "undetermined";

type FeatureFlagEvaluateResponse = {
  evaluations: Array<{ key: string; enabled: boolean }>;
};

export type ServerFeatureFlagSnapshot = Readonly<{
  serverId: string | null;
  resolved: boolean;
  resolution: ServerFeatureFlagResolution;
  values: Readonly<Record<string, boolean>>;
}>;

const noServerSnapshot: ServerFeatureFlagSnapshot = Object.freeze({
  serverId: null,
  resolved: false,
  resolution: "loading",
  values: Object.freeze({}),
});

/** How old a server's last evaluation may get before the page coming back re-reads it. */
export const SERVER_FEATURE_FLAG_STALE_MS = 5 * 60_000;

const snapshots = new Map<string, ServerFeatureFlagSnapshot>();
const pending = new Map<string, Promise<ServerFeatureFlagSnapshot>>();
const serverGenerations = new Map<string, number>();
const labDerivedValues = new Map<string, Readonly<Record<string, boolean>>>();
/** When each server's last evaluation answered or finally failed (ms). */
const evaluatedAt = new Map<string, number>();
/** Per server: keys the re-read on return turned off; consumers that showed them on keep them. */
const heldOnKeys = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let generation = 0;
let retryBackoffMs = 250;

function disabledValues(): Readonly<Record<string, boolean>> {
  return Object.freeze(Object.fromEntries(
    REGISTERED_SERVER_FEATURE_FLAG_KEYS.map((key) => [key, false]),
  ));
}

function unresolvedSnapshot(serverId: string): ServerFeatureFlagSnapshot {
  const existing = snapshots.get(serverId);
  if (existing) return existing;
  const created = Object.freeze({
    serverId,
    resolved: false,
    resolution: "loading",
    values: disabledValues(),
  });
  snapshots.set(serverId, created);
  return created;
}

function publish(snapshot: ServerFeatureFlagSnapshot): void {
  if (!snapshot.serverId) return;
  heldOnKeys.delete(snapshot.serverId);
  snapshots.set(snapshot.serverId, applyLabDerivedValues(snapshot));
  for (const listener of listeners) listener();
}

/**
 * The re-read on return: off -> on applies; on -> off is held for consumers
 * that already showed the flag on (header). An unchanged answer publishes
 * nothing, so every flag consumer (each message row) does not re-render.
 */
function publishReRead(snapshot: ServerFeatureFlagSnapshot): void {
  if (!snapshot.serverId) return;
  const previous = snapshots.get(snapshot.serverId);
  const next = applyLabDerivedValues(snapshot);
  const held = new Set(heldOnKeys.get(snapshot.serverId));
  let changed = previous?.resolution !== next.resolution;
  for (const key of REGISTERED_SERVER_FEATURE_FLAG_KEYS) {
    const on = next.values[key] === true;
    if ((previous?.values[key] === true) === on) continue;
    changed = true;
    if (on) held.delete(key);
    else held.add(key);
  }
  if (!changed) return;
  if (held.size > 0) heldOnKeys.set(snapshot.serverId, held);
  else heldOnKeys.delete(snapshot.serverId);
  snapshots.set(snapshot.serverId, next);
  for (const listener of listeners) listener();
}

function applyLabDerivedValues(snapshot: ServerFeatureFlagSnapshot): ServerFeatureFlagSnapshot {
  if (!snapshot.serverId) return snapshot;
  const derived = labDerivedValues.get(snapshot.serverId);
  if (!derived) return snapshot;
  return Object.freeze({
    serverId: snapshot.serverId,
    resolved: snapshot.resolved,
    resolution: snapshot.resolution,
    values: Object.freeze({
      ...snapshot.values,
      ...derived,
    }),
  });
}

function getServerGeneration(serverId: string): number {
  return serverGenerations.get(serverId) ?? 0;
}

function isJoinedServer(serverId: string): boolean {
  const { current, servers } = useServerStore.getState();
  return current?.id === serverId || servers.some((server) => server.id === serverId);
}

function bumpServerGeneration(serverId: string): number {
  const next = getServerGeneration(serverId) + 1;
  serverGenerations.set(serverId, next);
  return next;
}

function waitForRetryBackoff(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setClockTimeout(resolve, ms);
  });
}

async function evaluateRegisteredServerFeatureFlags(
  serverId: string,
): Promise<ServerFeatureFlagSnapshot> {
  const response = await api.post<FeatureFlagEvaluateResponse>("/feature-flags/evaluate", {
    serverId,
    platform: "web",
    keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
  });
  const values = Object.fromEntries(
    REGISTERED_SERVER_FEATURE_FLAG_KEYS.map((key) => [key, false]),
  );
  for (const evaluation of response.data.evaluations) {
    if (Object.hasOwn(values, evaluation.key)) {
      values[evaluation.key] = evaluation.enabled === true;
    }
  }
  return Object.freeze({
    serverId,
    resolved: true,
    resolution: "resolved",
    values: Object.freeze(values),
  });
}

function undeterminedSnapshot(serverId: string): ServerFeatureFlagSnapshot {
  return Object.freeze({
    serverId,
    resolved: true,
    resolution: "undetermined",
    values: disabledValues(),
  });
}

export function subscribeServerFeatureFlags(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getServerFeatureFlagSnapshot(
  serverId: string | null | undefined,
): ServerFeatureFlagSnapshot {
  return serverId ? unresolvedSnapshot(serverId) : noServerSnapshot;
}

export function prefetchServerFeatureFlags(
  serverId: string | null | undefined,
): Promise<ServerFeatureFlagSnapshot> {
  return prefetchServerFeatureFlagsInternal(serverId, false);
}

function prefetchServerFeatureFlagsInternal(
  serverId: string | null | undefined,
  forceRefresh: boolean,
  reReadOnReturn = false,
): Promise<ServerFeatureFlagSnapshot> {
  if (!serverId) return Promise.resolve(noServerSnapshot);

  const cached = snapshots.get(serverId);
  if (!forceRefresh && cached?.resolved) return Promise.resolve(cached);

  const inFlight = pending.get(serverId);
  if (!forceRefresh && inFlight) return inFlight;

  const requestGeneration = generation;
  const requestServerGeneration = getServerGeneration(serverId);
  const requestRetryBackoffMs = retryBackoffMs;
  const isCurrent = () =>
    generation === requestGeneration && getServerGeneration(serverId) === requestServerGeneration;
  const request = evaluateRegisteredServerFeatureFlags(serverId).catch(async () => {
    await waitForRetryBackoff(requestRetryBackoffMs);
    if (!isCurrent()) return undeterminedSnapshot(serverId);
    return evaluateRegisteredServerFeatureFlags(serverId);
  }).catch(() => {
    const previous = snapshots.get(serverId);
    if (previous?.resolution === "resolved") {
      console.warn("[serverFeatureFlags] re-evaluation failed; keeping the previous values", {
        serverId,
      });
      return previous;
    }
    console.warn("[serverFeatureFlags] evaluation failed; keeping registered flags fail-closed", {
      serverId,
    });
    return undeterminedSnapshot(serverId);
  }).then((snapshot) => {
    if (isCurrent() && (!reReadOnReturn || isJoinedServer(serverId))) {
      evaluatedAt.set(serverId, currentTimeMs());
      if (snapshot !== snapshots.get(serverId)) {
        if (reReadOnReturn) publishReRead(snapshot);
        else publish(snapshot);
      }
    }
    return snapshot;
  }).finally(() => {
    if (pending.get(serverId) === request) pending.delete(serverId);
  });

  pending.set(serverId, request);
  return request;
}

export function refreshServerFeatureFlags(
  serverId: string | null | undefined,
): Promise<ServerFeatureFlagSnapshot> {
  if (!serverId) return Promise.resolve(noServerSnapshot);
  bumpServerGeneration(serverId);
  pending.delete(serverId);
  return prefetchServerFeatureFlagsInternal(serverId, true);
}

/** Re-evaluate every joined server whose last evaluation is stale (header). */
function reReadStaleServerFeatureFlags(): void {
  if (document.visibilityState !== "visible") return;
  const now = currentTimeMs();
  for (const [serverId, at] of evaluatedAt) {
    if (now - at <= SERVER_FEATURE_FLAG_STALE_MS) continue;
    if (pending.has(serverId) || !isJoinedServer(serverId)) continue;
    void prefetchServerFeatureFlagsInternal(serverId, true, true);
  }
}

/**
 * The longest random wait before a re-read on change. A change to a kill
 * switch, a default or a plan/lab rule reaches every connection at nearly the
 * same moment; spreading the re-reads keeps the evaluator from taking them all
 * in one burst (Tenny's review of #11281). The wait is the point, so it is a
 * timer.
 */
export const SERVER_FEATURES_CHANGED_JITTER_MS = 10_000;
/** Per server: the re-read on change already waiting; more notices meanwhile join it. */
const changeReReadTimers = new Map<string, unknown>();

function reReadChangedServerFeatureFlags(serverId: string): void {
  changeReReadTimers.delete(serverId);
  // Never evaluated in this tab: the first ask reads the current flags anyway.
  if (!evaluatedAt.has(serverId) || !isJoinedServer(serverId)) return;
  // An answer still in flight may predate the change, but it may also be a
  // refresh someone asked for (Settings after a Labs change) that must land:
  // let it, then read again.
  const inFlight = pending.get(serverId);
  if (inFlight) {
    void inFlight.finally(() => reReadChangedServerFeatureFlags(serverId));
    return;
  }
  void prefetchServerFeatureFlagsInternal(serverId, true, true);
}

/** `server:features-changed` for one server: re-read it after the random wait. */
export function scheduleServerFeatureFlagsReReadOnChange(
  serverId: string,
  random: () => number = currentRandomUnit,
): void {
  if (changeReReadTimers.has(serverId) || !evaluatedAt.has(serverId) || !isJoinedServer(serverId)) return;
  const wait = Math.floor(random() * SERVER_FEATURES_CHANGED_JITTER_MS);
  changeReReadTimers.set(serverId, setClockTimeout(() => reReadChangedServerFeatureFlags(serverId), wait));
}

/** A socket reconnect: notices sent while it was down are lost, so re-read every evaluated server. */
export function scheduleAllServerFeatureFlagsReReadOnReconnect(random: () => number = currentRandomUnit): void {
  for (const serverId of evaluatedAt.keys()) scheduleServerFeatureFlagsReReadOnChange(serverId, random);
}

function clearChangeReReadTimers(): void {
  for (const timer of changeReReadTimers.values()) clearClockTimeout(timer);
  changeReReadTimers.clear();
}

/** Re-read stale server flags when the page comes back (App, once signed in). Returns its stop. */
export function startServerFeatureFlagRefreshOnFocus(): () => void {
  document.addEventListener("visibilitychange", reReadStaleServerFeatureFlags);
  window.addEventListener("focus", reReadStaleServerFeatureFlags);
  return () => {
    document.removeEventListener("visibilitychange", reReadStaleServerFeatureFlags);
    window.removeEventListener("focus", reReadStaleServerFeatureFlags);
  };
}

export function publishServerFeatureFlagValuesFromLabsReadback(
  readback: ServerLabSettingsReadback,
): void {
  const snapshot = getServerFeatureFlagSnapshot(readback.serverId);
  const values: Record<string, boolean> = { ...snapshot.values };
  const previous = labDerivedValues.get(readback.serverId);
  const derived: Record<string, boolean> = {};
  if (previous) {
    for (const key of Object.keys(previous)) {
      values[key] = false;
      derived[key] = false;
    }
  }
  for (const lab of readback.labs) {
    if (Object.hasOwn(values, lab.key)) {
      const enabled = isServerLabEffectivelyEnabled(readback.masterEnabled, lab);
      values[lab.key] = enabled;
      derived[lab.key] = enabled;
    }
  }
  const touched = Object.keys(derived).length > 0;
  if (touched) {
    labDerivedValues.set(readback.serverId, Object.freeze(derived));
  } else {
    labDerivedValues.delete(readback.serverId);
  }
  if (!touched && !previous) return;
  publish(Object.freeze({
    serverId: readback.serverId,
    resolved: snapshot.resolved,
    resolution: snapshot.resolution,
    values: Object.freeze(values),
  }));
}

export function readServerFeatureFlagState(
  serverId: string | null | undefined,
  key: RegisteredServerFeatureFlagKey,
): ServerFeatureFlagState {
  const snapshot = getServerFeatureFlagSnapshot(serverId);
  const derived = serverId ? labDerivedValues.get(serverId) : undefined;
  if (derived && Object.hasOwn(derived, key)) {
    return derived[key] === true ? "enabled" : "disabled";
  }
  if (!snapshot.resolved) return "loading";
  if (snapshot.resolution === "undetermined") return "undetermined";
  return snapshot.values[key] === true ? "enabled" : "disabled";
}

export function readServerFeatureFlag(
  serverId: string | null | undefined,
  key: RegisteredServerFeatureFlagKey,
): boolean {
  const snapshot = getServerFeatureFlagSnapshot(serverId);
  return snapshot.values[key] === true;
}

export function useServerFeatureFlag(
  key: RegisteredServerFeatureFlagKey,
  options: { prefetch?: boolean; serverId?: string | null } = {},
): { resolved: boolean; enabled: boolean; state: ServerFeatureFlagState } {
  const currentServerId = useServerStore((state) => state.current?.id ?? null);
  // A page that acts on a Server other than the current one (an install
  // target picked on the page) reads that Server's flags.
  const serverId = options.serverId !== undefined ? options.serverId : currentServerId;
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = subscribeServerFeatureFlags(listener);
    if (options.prefetch !== false) void prefetchServerFeatureFlags(serverId);
    return unsubscribe;
  }, [options.prefetch, serverId]);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => getServerFeatureFlagSnapshot(serverId),
    () => noServerSnapshot,
  );
  // The server and key this consumer last rendered on: an on -> off from the
  // re-read on return stays on for it until it unmounts (header).
  const shownOn = useRef<string | null>(null);
  const consumer = serverId ? `${serverId}\n${key}` : null;
  const live = snapshot.values[key] === true;
  const held = !live && !!serverId && shownOn.current === consumer
    && heldOnKeys.get(serverId)?.has(key) === true;
  shownOn.current = live || held ? consumer : null;

  return {
    resolved: snapshot.resolved,
    enabled: live || held,
    state: held ? "enabled" : readServerFeatureFlagState(serverId, key),
  };
}

export function resetServerFeatureFlagsForSession(): void {
  generation += 1;
  clearChangeReReadTimers();
  pending.clear();
  snapshots.clear();
  serverGenerations.clear();
  labDerivedValues.clear();
  evaluatedAt.clear();
  heldOnKeys.clear();
  for (const listener of listeners) listener();
}

export function resetServerFeatureFlagsForTests(): void {
  retryBackoffMs = 250;
  resetServerFeatureFlagsForSession();
}

/** Seed one resolved flag for component tests without going through HTTP. */
export function setServerFeatureFlagForTests(
  serverId: string,
  key: RegisteredServerFeatureFlagKey,
  enabled: boolean,
): void {
  const snapshot = getServerFeatureFlagSnapshot(serverId);
  const values = Object.freeze({ ...snapshot.values, [key]: enabled });
  publish(Object.freeze({
    serverId,
    resolved: true,
    resolution: "resolved",
    values,
  }));
}

/** Marks a server's flags as already answered (none on), so no evaluate request is made. */
export function resolveServerFeatureFlagsForTests(serverId: string): void {
  publish(Object.freeze({
    serverId,
    resolved: true,
    resolution: "resolved",
    values: getServerFeatureFlagSnapshot(serverId).values,
  }));
}

export function setServerFeatureFlagRetryBackoffForTests(ms: number): void {
  retryBackoffMs = ms;
}
