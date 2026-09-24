/**
 * RAP v1 registry — immutable built-ins plus rule-constant authorization.
 *
 * There is no install/grant table in v1. The production catalog is the three
 * built-in manifests, and its grant rule is evaluated against the server's
 * current agents at resolution time. The test-only factory retains an explicit
 * grant rule so "agent exists but is ungranted" remains a reachable refusal and
 * a reverse tooth for the later third-party registry.
 *
 * ⚠️ NO APP NAMES here. The manifest module is the sole named-app exemption.
 */
import { createHash } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, channelAgents, channelHumans, channels } from "../db/schema.js";
import { BUILT_IN_RAP_APPS } from "./rapBuiltinAppManifests.js";
import {
  manifestDeclaresHook,
  mintAppPrincipal,
  parseManifest,
  type AppId,
  type AppManifest,
  type AppPrincipal,
  type HookName,
} from "./rapRegistry.js";
import { runWithMintedRapEvent } from "./rapInvocationContext.js";

/**
 * THE canonical statement of which hooks the handler ABI can register, and the
 * ONLY one. Both the compile-time slot list (`AppHookHandlers`) and the runtime
 * classification in `dispatchHook` are derived from this array, so they cannot
 * disagree and there is no second list to keep in step.
 *
 * ⚠️ A name in `HookName` but absent here is DECLARABLE BUT NOT REGISTERABLE:
 * an app may declare it in its manifest and the OS will never be able to call
 * it, because the ABI offers no slot. That is reported as `not_registerable`,
 * never as `no_handler` -- the app did not fail to implement it, the platform
 * does not let it. `onThresholdCrossed` is in exactly that state today: its
 * event envelope does not exist yet (task #142), and §4d-8b forbids minting a
 * slot for an event hook that cannot be told which occurrence fired.
 *
 * ⇒ When #142 lands that envelope, adding the name HERE is the single edit that
 * both opens the slot and retires `not_registerable` for it. If retiring it ever
 * requires editing a second list, this mechanism has failed and task #151 with it.
 */
export const REGISTERABLE_HOOKS = ["onInstall", "onEnable", "onDisable", "onUninstall", "onDue"] as const;

export type RegisterableHookName = (typeof REGISTERABLE_HOOKS)[number];

/** A registerable name must be a declarable name; this fails the build if one drifts. */
const _registerableAreDeclarable: readonly HookName[] = REGISTERABLE_HOOKS;
void _registerableAreDeclarable;

/** Per-hook handler signature. An event hook is given its envelope; a lifecycle hook needs nothing. */
type HookSignature<K extends RegisterableHookName> = K extends "onDue"
  ? (event: DueHookEvent) => Promise<unknown> | unknown
  : () => Promise<void> | void;

/**
 * The OS calls back into an app through this. An app registers its handlers at
 * runtime; the registry decides WHETHER to call them, from the manifest alone.
 *
 * Derived from `REGISTERABLE_HOOKS` on purpose: a slot exists if and only if the
 * runtime will classify that hook as registerable.
 *
 * `onDue` carries a registry-owned due-event envelope. `eventId` is minted by the
 * OS-side source and is the identity a later syscall/result must carry; `data` is
 * the app-owned projection of the due resource, never an ambient channel or
 * target handle.
 */
export type AppHookHandlers = { [K in RegisterableHookName]?: HookSignature<K> };

/** Runtime half of the same fact. Not a second list -- it reads the canonical array. */
export function isRegisterableHook(hook: HookName): hook is RegisterableHookName {
  return (REGISTERABLE_HOOKS as readonly string[]).includes(hook);
}

export interface DueHookEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly subjectAgentId: string;
  readonly data: unknown;
}

export interface RaiseDueEventInput {
  readonly subjectAgentId: string;
  readonly data: unknown;
}

const hookHandlers = new Map<string, AppHookHandlers>();

const handlerKey = (serverId: string, appId: AppId) => `${serverId}\u0000${appId}`;

/** Register an app's hook handlers. Called by the app's own runtime, not by the OS. */
export function registerHookHandlers(serverId: string, appId: AppId, handlers: AppHookHandlers): void {
  hookHandlers.set(handlerKey(serverId, appId), handlers);
}

export function clearHookHandlers(serverId: string, appId: AppId): void {
  hookHandlers.delete(handlerKey(serverId, appId));
}

export type HookDispatch =
  | { kind: "called"; eventId?: string; result?: unknown }
  /** Declared, registered, and it threw. Reported, never swallowed. */
  | { kind: "threw"; error: string }
  /** The manifest does not declare it, so the OS does not call it (§2 Q3). */
  | { kind: "not_declared" }
  /**
   * Declared, but the handler ABI has no registration slot for it, so no app
   * could ever have implemented it. The responsible party is the platform, not
   * the app -- reporting this as `no_handler` blamed the app for a door it was
   * never given (task #151).
   */
  | { kind: "not_registerable" }
  /** Declared and registerable, but this app registered no handler for it. */
  | { kind: "no_handler" };

/**
 * Call a hook, and REPORT which of the four things happened.
 *
 * A boolean would collapse "not declared", "not implemented" and "threw" into
 * one, and #138 item 1 turns on telling "the OS never called it" apart from
 * "the app never implemented it". Those are different findings about different
 * parties, so they get different values.
 */
export function dispatchHook(
  serverId: string,
  appId: AppId,
  hook: "onDue",
  manifest: AppManifest,
  event: DueHookEvent,
): Promise<HookDispatch>;
export function dispatchHook(
  serverId: string,
  appId: AppId,
  hook: Exclude<HookName, "onDue">,
  manifest: AppManifest,
): Promise<HookDispatch>;
export async function dispatchHook(
  serverId: string,
  appId: AppId,
  hook: HookName,
  manifest: AppManifest,
  event?: DueHookEvent,
): Promise<HookDispatch> {
  if (!manifestDeclaresHook(manifest, hook)) return { kind: "not_declared" };
  // Before any handler lookup on purpose: a handler cast past the type system into
  // a slot the ABI does not offer must NOT be able to buy a `called`. The ABI
  // decides registerability; the handler map only decides implementation.
  if (!isRegisterableHook(hook)) return { kind: "not_registerable" };
  const handlers = hookHandlers.get(handlerKey(serverId, appId));
  const fn = handlers?.[hook as keyof AppHookHandlers];
  if (typeof fn !== "function") return { kind: "no_handler" };
  try {
    if (hook === "onDue") {
      if (!event) throw new Error("onDue requires a registry-owned due-event envelope");
      const result = await handlers?.onDue?.call(handlers, event);
      return { kind: "called", eventId: event.eventId, result };
    }
    await (fn as () => Promise<void> | void).call(handlers);
    return { kind: "called" };
  } catch (err) {
    // An app's hook throwing must not abort the OS-side operation, and must not
    // vanish either: install/uninstall still complete, and the receipt carries
    // the failure.
    return { kind: "threw", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Raise an app-owned due event.
 *
 * The source identity is minted here, at the OS boundary, and is deliberately
 * unrelated to the payload. Two equal payloads are two events. An app can
 * receive this identity but cannot provide or derive the value used by the
 * registry receipt and any syscall invoked from this event.
 */
export async function raiseDueEvent(
  serverId: string,
  appId: AppId,
  manifest: AppManifest,
  input: RaiseDueEventInput,
): Promise<HookDispatch> {
  return runWithMintedRapEvent((eventId) => {
    const event: DueHookEvent = {
      eventId,
      occurredAt: currentDate().toISOString(),
      subjectAgentId: input.subjectAgentId,
      data: input.data,
    };
    return dispatchHook(serverId, appId, "onDue", manifest, event);
  });
}
export interface InstalledApp {
  readonly appId: AppId;
  readonly principal: AppPrincipal;
  readonly manifest: AppManifest;
  /** Built-ins have no installation event in v1. */
  readonly installedAt: null;
}

export interface RegistryListing {
  readonly apps: InstalledApp[];
  /**
   * app_ids whose stored manifest could not be re-parsed. NOT silently dropped:
   * "this server has no such app" and "the app is there but unreadable" are
   * different facts, and collapsing them is the same defect this whole card
   * exists to remove -- an absence that could be either nothing-to-report or
   * something-withheld.
   */
  readonly unreadable: string[];
}

export type ConversationResolution =
  | { kind: "resolved"; conversationId: string }
  | { kind: "refused"; reason: "not_installed" | "no_grant_for_subject" };

export type RapCatalogGrant =
  | { readonly kind: "all_server_agents" }
  | { readonly kind: "explicit_agent_ids"; readonly agentIds: readonly string[] };

export interface RapCatalogEntry {
  readonly appId: AppId;
  readonly rawManifest: unknown;
  readonly grant: RapCatalogGrant;
}

/** The narrow registry surface consumed by RAP syscalls. */
export interface RapRegistryReader {
  listRegistry(serverId: string): Promise<RegistryListing>;
  listInstalledApps(serverId: string): Promise<InstalledApp[]>;
  getInstalledApp(serverId: string, appId: AppId): Promise<InstalledApp | null>;
  resolveConversation(serverId: string, appId: AppId, agentId: string): Promise<ConversationResolution>;
}

/**
 * Physical v1 conversation identity.
 *
 * Exact derivation: SHA-256 over the domain-separated UTF-8 tuple
 * `(serverId, appId, ownerAgentId)`, truncated to 128 bits, with RFC 4122
 * version/variant bits set before UUID formatting. The resulting UUID is used
 * directly as `channels.id`; its primary-key conflict is the sole v1
 * concurrency/deduplication mechanism for this no-identity-row DM shape.
 */
export function deriveRapConversationChannelId(serverId: string, appId: AppId, agentId: string): string {
  const bytes = createHash("sha256")
    .update("rap-conversation-v1\0")
    .update(serverId)
    .update("\0")
    .update(appId)
    .update("\0")
    .update(agentId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function ensureConversationChannel(
  serverId: string,
  appId: AppId,
  agentId: string,
): Promise<string> {
  const channelId = deriveRapConversationChannelId(serverId, appId, agentId);
  return getDb().transaction(async (tx) => {
    await tx
      .insert(channels)
      .values({
        id: channelId,
        serverId,
        name: appId,
        type: "dm",
      })
      .onConflictDoNothing({ target: channels.id });

    const [channel] = await tx
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (
      !channel
      || channel.serverId !== serverId
      || channel.name !== appId
      || channel.type !== "dm"
      || channel.parentMessageId !== null
    ) {
      throw new Error("RAP_CONVERSATION_CHANNEL_INTEGRITY_MISMATCH");
    }

    // A soft-deleted/archived derived row is the same registry-owned identity,
    // not a free slot for a different conversation. Resolution restores it.
    if (channel.deletedAt !== null || channel.archivedAt !== null) {
      await tx
        .update(channels)
        .set({ deletedAt: null, archivedAt: null })
        .where(eq(channels.id, channelId));
    }

    await tx
      .insert(channelAgents)
      .values({ channelId, agentId })
      .onConflictDoNothing({ target: [channelAgents.channelId, channelAgents.agentId] });

    const [agentMembers, humanMembers] = await Promise.all([
      tx.select({ agentId: channelAgents.agentId }).from(channelAgents).where(eq(channelAgents.channelId, channelId)),
      tx.select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, channelId)),
    ]);
    if (
      humanMembers.length !== 0
      || agentMembers.length !== 1
      || agentMembers[0]?.agentId !== agentId
    ) {
      throw new Error("RAP_CONVERSATION_MEMBERSHIP_INTEGRITY_MISMATCH");
    }
    return channelId;
  });
}

/**
 * Resolve an already-created production built-in conversation for agent-facing
 * enumeration/open. This intentionally consults the closed production catalog;
 * test catalogs and arbitrary syntactically valid app ids never become writable
 * `dm:@...` targets.
 */
export async function getBuiltInConversationChannel(
  serverId: string,
  appId: AppId,
  ownerAgentId: string,
): Promise<typeof channels.$inferSelect | null> {
  const installed = await getInstalledApp(serverId, appId);
  if (!installed) return null;
  const channelId = deriveRapConversationChannelId(serverId, appId, ownerAgentId);
  const db = getDb();
  const [channel, agentMembers, humanMembers] = await Promise.all([
    db.select().from(channels).where(and(
      eq(channels.id, channelId),
      eq(channels.serverId, serverId),
      eq(channels.name, appId),
      eq(channels.type, "dm"),
      isNull(channels.parentMessageId),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    )).limit(1).then((rows) => rows[0] ?? null),
    db.select({ agentId: channelAgents.agentId }).from(channelAgents).where(eq(channelAgents.channelId, channelId)),
    db.select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, channelId)),
  ]);
  if (
    !channel
    || humanMembers.length !== 0
    || agentMembers.length !== 1
    || agentMembers[0]?.agentId !== ownerAgentId
  ) {
    return null;
  }
  return channel;
}

function copyCatalog(entries: readonly RapCatalogEntry[]): readonly RapCatalogEntry[] {
  return entries.map((entry) => ({
    appId: entry.appId,
    // Snapshot the catalog at construction. Later mutation of a caller-owned
    // object must not become a runtime capability change without rebuilding the
    // registry through a reviewable code path.
    rawManifest: structuredClone(entry.rawManifest),
    grant: entry.grant.kind === "all_server_agents"
      ? { kind: "all_server_agents" }
      : { kind: "explicit_agent_ids", agentIds: [...entry.grant.agentIds] },
  }));
}

function createRegistry(entries: readonly RapCatalogEntry[]): RapRegistryReader {
  const catalog = copyCatalog(entries);

  async function listRegistry(_serverId: string): Promise<RegistryListing> {
    const apps: InstalledApp[] = [];
    const unreadable: string[] = [];
    for (const entry of catalog) {
      const parsed = parseManifest(entry.rawManifest);
      if (parsed.kind !== "parsed" || parsed.manifest.appId !== entry.appId) {
        unreadable.push(entry.appId);
        continue;
      }
      apps.push({
        appId: entry.appId,
        principal: mintAppPrincipal(entry.appId),
        manifest: parsed.manifest,
        installedAt: null,
      });
    }
    apps.sort((a, b) => a.appId.localeCompare(b.appId));
    unreadable.sort();
    return { apps, unreadable };
  }

  async function listInstalledApps(serverId: string): Promise<InstalledApp[]> {
    return (await listRegistry(serverId)).apps;
  }

  async function getInstalledApp(serverId: string, appId: AppId): Promise<InstalledApp | null> {
    const all = await listInstalledApps(serverId);
    return all.find((app) => app.appId === appId) ?? null;
  }

  async function resolveConversation(
    serverId: string,
    appId: AppId,
    agentId: string,
  ): Promise<ConversationResolution> {
    const entry = catalog.find((candidate) => candidate.appId === appId);
    if (!entry) return { kind: "refused", reason: "not_installed" };

    // A corrupt/mismatched declaration is not an installed app. Never grant
    // from the key alone while the manifest that defines its boundary is unreadable.
    const parsed = parseManifest(entry.rawManifest);
    if (parsed.kind !== "parsed" || parsed.manifest.appId !== entry.appId) {
      return { kind: "refused", reason: "not_installed" };
    }

    const [agent] = await getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.serverId, serverId), eq(agents.id, agentId)))
      .limit(1);
    if (!agent) return { kind: "refused", reason: "no_grant_for_subject" };

    const granted = entry.grant.kind === "all_server_agents"
      || entry.grant.agentIds.includes(agentId);
    if (!granted) return { kind: "refused", reason: "no_grant_for_subject" };

    // v1 maps the registry-owned conversation onto an existing owner-only DM
    // channel. The app receives only the resolved UUID; it cannot choose the
    // server, app, or owner components through the public syscall surface.
    return { kind: "resolved", conversationId: await ensureConversationChannel(serverId, appId, agentId) };
  }

  return { listRegistry, listInstalledApps, getInstalledApp, resolveConversation };
}

const productionRegistry = createRegistry(BUILT_IN_RAP_APPS.map((definition) => ({
  appId: definition.appId,
  rawManifest: definition.manifest,
  grant: { kind: definition.grant },
})));

/**
 * Test-only catalog seam. Production never passes entries at runtime; this
 * remains solely so an existing-but-ungranted agent can exercise the refusal
 * that becomes production-load-bearing again when third-party apps return.
 *
 * Two separate third-party debts must survive deletion of the row mechanism:
 * (1) a DB writer could fabricate its row-is-a-grant authority with one INSERT;
 * constants make that moot only until the table returns; and (2) the built-ins'
 * intentional all-server-agent scope makes existing-but-ungranted unreachable
 * in production v1. A future third-party registry must introduce an explicit
 * grant authority and a production-reachable refusal; it must not inherit the
 * built-ins' broad rule merely because that predicate is easy to reuse here.
 */
export function createRapRegistryForTests(entries: readonly RapCatalogEntry[]): RapRegistryReader {
  return createRegistry(entries);
}

export async function listRegistry(serverId: string): Promise<RegistryListing> {
  return productionRegistry.listRegistry(serverId);
}

export async function listInstalledApps(serverId: string): Promise<InstalledApp[]> {
  return productionRegistry.listInstalledApps(serverId);
}

export async function getInstalledApp(serverId: string, appId: AppId): Promise<InstalledApp | null> {
  return productionRegistry.getInstalledApp(serverId, appId);
}

export async function resolveConversation(
  serverId: string,
  appId: AppId,
  agentId: string,
): Promise<ConversationResolution> {
  return productionRegistry.resolveConversation(serverId, appId, agentId);
}
