/**
 * Computer-local typed app Inbox store (Phase 1).
 *
 * - message_target path unchanged (pending messages elsewhere)
 * - app items are OS-minted via an **injected** closed registry (default empty)
 * - real product app names / action builders are NOT hard-coded in this OS file
 * - sourceRef is structured identity/revision via app-owned normalizer
 * - inbox check is pure read; ack is explicit
 * - item identity is stable from closed (appId, notificationClass, normalized sourceRef)
 * - transient items live only in process memory (restart may drop)
 * - durable recovery uses a platform-scoped storage capability, never an App-
 *   supplied path; persisted action/id fields are rematerialized from the
 *   injected registry rather than trusted from storage
 */

import { createHash } from "node:crypto";
import {
  AGENT_INBOX_PREVIEW_MAX_CHARS,
  currentTimeMs,
  sourceRefIdentityKey,
  type AgentInboxAppItem,
  type AgentInboxSourceSeal,
  type AgentInboxPrimaryAction,
  type AgentInboxRetention,
  type AgentInboxSourceRef,
} from "@botiverse/raft-shared";
import { appInboxItemTraceAttrs } from "@botiverse/raft-shared/src/appRuntimeTrace";
import type { ScopedAppStorage } from "./scopedAppStorage";

export type AgentAppInboxMintInput = {
  appId: string;
  notificationClass: string;
  /**
   * Raw source identity for the class normalizer. Must become a structured
   * AgentInboxSourceRef; freeform opaque strings fail closed unless the
   * app-owned normalizer accepts a closed wire form.
   */
  sourceRef: unknown;
  /** Optional display; must not include shell commands */
  title?: string;
  summary?: string;
  /**
   * Forbidden: callers must not pass raw shell. Only registry-mapped fields.
   * If present and not matching registry, mint fails closed.
   */
  requestedPrimaryAction?: AgentInboxPrimaryAction;
};

export type AgentAppInboxMintResult =
  | { ok: true; item: AgentInboxAppItem }
  | {
      ok: false;
      code:
        | "unknown_app"
        | "unknown_class"
        | "invalid_primary_action"
        | "raw_command_forbidden"
        | "invalid_source_ref"
        | "invalid_preview";
      message: string;
    };

export type AgentAppSourceRefNormalizeResult =
  | { ok: true; ref: AgentInboxSourceRef }
  | { ok: false; message: string };

export type AgentAppInboxAcknowledgedSource = {
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
  itemId: string;
  acknowledgedAtMs: number;
  ownerAgentId?: string;
  /**
   * The Server has settled this ack (server-authority classes): "accepted"
   * (it recorded the ack) or "refused" (it holds nothing to ack: no such
   * source or revision fired). Absent: acked only here, as a daemon before
   * reminder-server-ack@1 did; the server-ack backfill sends it.
   */
  serverAck?: "accepted" | "refused";
};

/** An exact source identity a Server-authorized ack names, normalized by its class. */
export type AgentAppInboxServerAckSource = {
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
  itemId: string;
};

export type AgentAppInboxAckIntent = {
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
  itemId: string;
  ackAttemptId: string;
  createdAtMs: number;
  ownerAgentId?: string;
};

export type AgentAppInboxSeal = AgentInboxSourceSeal;

/**
 * One notification class under an app. App-owned packages inject these;
 * OS core never embeds product app identifiers.
 */
export type AgentAppNotificationClassDefinition = {
  retention: AgentInboxRetention;
  primaryAction: AgentInboxPrimaryAction;
  /**
   * Closed source-ref schema/normalizer. Mint input is validated into a
   * structured {kind,id,revision?} before identity or action materialization.
   */
  normalizeSourceRef: (raw: unknown) => AgentAppSourceRefNormalizeResult;
  /**
   * Closed action-builder seam. Must return an exact executable CLI string
   * (or null to fail closed). Receives normalized structured sourceRef.
   */
  materializeActionCli: (input: {
    sourceRef: AgentInboxSourceRef;
    primaryAction: AgentInboxPrimaryAction;
  }) => string | null;
  /**
   * Optional app-owned stable identity. This is still OS-minted because the
   * caller cannot supply it; the closed registry definition owns the builder.
   */
  materializeItemId?: (sourceRef: AgentInboxSourceRef) => string | null;
  /**
   * Who adjudicates an agent's explicit ack (`POST /inbox/ack` through the
   * agent proxy). "server": only the Server's app-source ACK route, so the
   * Server's read state is the one read state (RFC 081 D7); the local item
   * is retired only after the Server accepts. Absent: the daemon acks
   * locally, falling back to the Server when the local source refuses.
   * Daemon-internal retirements (`store.ack`) are unaffected.
   */
  ackAuthority?: "server";
  /**
   * The `Next action` an agent reads when a Server-authorized ack of this
   * source fails: "refused" (the Server answered 4xx; the same ack would be
   * refused again) or "unavailable" (5xx or unreachable; the same ack is safe
   * to run again). Absent: the proxy's generic wording.
   */
  ackFailureNextAction?: (input: { sourceRef: AgentInboxSourceRef; outcome: "refused" | "unavailable" }) => string;
};

/** appId → notificationClass → definition. Production default is empty. */
export type AgentAppInboxRegistry = Readonly<
  Record<string, Readonly<Record<string, AgentAppNotificationClassDefinition>>>
>;

const FORBIDDEN_PRIMARY_ACTION_KEYS = new Set(["command", "shell", "argv", "executable", "cwd"]);

/** Control / line terminators that would let preview forge a second CLI line (NEL and the Unicode separators included). */
const PREVIEW_FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

export const AGENT_APP_INBOX_PERSISTED_REJECTION_CODES = [
  "invalid_json",
  "envelope_invalid",
  "items_invalid",
  "item_invalid",
  "item_shape_invalid",
  "item_registry_binding_invalid",
  "item_source_ref_invalid",
  "item_action_identity_invalid",
  "item_preview_invalid",
  "acknowledged_sources_invalid",
  "acknowledged_source_invalid",
  "acknowledged_source_shape_invalid",
  "acknowledged_source_registry_binding_invalid",
  "acknowledged_source_ref_invalid",
  "acknowledged_source_item_id_invalid",
  "ack_intents_invalid",
  "ack_intent_invalid",
  "ack_intent_shape_invalid",
  "ack_intent_registry_binding_invalid",
  "ack_intent_source_ref_invalid",
  "ack_intent_item_id_invalid",
  "ack_intent_item_binding_invalid",
  "seals_invalid",
  "seal_invalid",
  "seal_shape_invalid",
  "seal_registry_binding_invalid",
  "seal_source_ref_invalid",
] as const;

type AgentAppInboxPersistedRejectionCode =
  typeof AGENT_APP_INBOX_PERSISTED_REJECTION_CODES[number];

class AgentAppInboxPersistedRejection extends Error {
  constructor(readonly code: AgentAppInboxPersistedRejectionCode) {
    super(
      code === "invalid_json"
        ? "Unexpected token in agent app inbox persisted JSON"
        : code === "envelope_invalid"
          ? "agent app inbox persistence envelope invalid"
          : `agent app inbox persisted payload rejected: ${code}`,
    );
  }
}

function rejectPersistedPayload(code: AgentAppInboxPersistedRejectionCode): never {
  throw new AgentAppInboxPersistedRejection(code);
}

/** How an App asks for its Inbox item to be noticed by the owner agent. */
export interface AgentAppInboxNoticeOptions {
  /**
   * false: only a running agent session is notified. A stopped agent is
   * neither restarted locally nor woken through the Server; it sees the item
   * when it next wakes for another reason. Default true.
   */
  startStoppedAgent?: boolean;
  /**
   * true: never write into a running turn. A busy agent is not interrupted;
   * the item waits for the next idle drain. Default false.
   */
  requireIdle?: boolean;
}

export type AgentAppInboxStore = {
  list(): readonly AgentInboxAppItem[];
  listAcknowledgedSources(): readonly AgentAppInboxAcknowledgedSource[];
  listSeals(): readonly AgentAppInboxSeal[];
  findProtectingSeal(input: {
    appId: string;
    notificationClass: string;
    sourceRef: AgentInboxSourceRef;
  }): AgentAppInboxSeal | null;
  sealSources(input: {
    sources: readonly Pick<AgentAppInboxSeal, "appId" | "notificationClass" | "sourceRef">[];
    owner: string;
    until: string;
  }): AgentAppInboxSeal[] | null;
  unsealSources(input: {
    sources: readonly Pick<AgentAppInboxSeal, "appId" | "notificationClass" | "sourceRef">[];
  }): AgentAppInboxSeal[] | null;
  isSourceAcknowledged(input: {
    appId: string;
    notificationClass: string;
    sourceRef: AgentInboxSourceRef;
  }): boolean;
  mint(input: AgentAppInboxMintInput): AgentAppInboxMintResult;
  ack(itemId: string): boolean;
  /**
   * Drops an item whose source no longer asks for an ack (a canceled reminder,
   * a recurring reminder's earlier fire: RFC 081 D21, D22). Nothing is
   * acknowledged: no acknowledged source is recorded, so no ack reaches the
   * Server, and the source isn't asked (`beforeAck`). False when the store
   * holds no such item or a seal protects it.
   */
  retire(itemId: string): boolean;
  /**
   * The agent dismissed the item without acting on it (`raft inbox dismiss`):
   * removed as retire() removes it, traced with outcome `dismissed`. Which
   * items an agent may dismiss is the caller's check
   * (agentInboxAppItemDismissTarget).
   */
  dismiss(itemId: string): boolean;
  /** The item's class sets `ackAuthority: "server"`: an agent's ack goes only through the Server. */
  requiresServerAuthorizedAck(item: Pick<AgentInboxAppItem, "appId" | "notificationClass">): boolean;
  /**
   * A source of a server-authority class, normalized and with its itemId, or
   * null (unknown class, not server-authority, invalid sourceRef): what an
   * ack of a source this store does not hold (a lost store) sends the Server.
   */
  normalizeServerAckSource(input: {
    appId: string;
    notificationClass: string;
    sourceRef: unknown;
  }): AgentAppInboxServerAckSource | null;
  /** Records the Server's settlement of an acknowledged source (no-op when the store holds no such ack). */
  markAcknowledgedSourceServerAck(
    source: Pick<AgentAppInboxAcknowledgedSource, "appId" | "notificationClass" | "sourceRef">,
    outcome: "accepted" | "refused",
  ): void;
  /** Acknowledged server-authority sources the Server has not settled, oldest first, at most `limit`. */
  listServerAckBackfillPending(limit: number): AgentAppInboxAcknowledgedSource[];
  /** The capability whose one-time server-ack backfill completed, or null. */
  serverAckBackfillDone(): string | null;
  markServerAckBackfillDone(capability: string): void;
  /** Content-free trace of one backfill run (counts only). */
  traceServerAckBackfill(attrs: {
    attempted: number;
    accepted: number;
    refused: number;
    failed: number;
    remaining: number;
    done: boolean;
  }): void;
  /** The class's ackFailureNextAction for this item, or null when it has none. */
  ackFailureNextAction(
    item: Pick<AgentInboxAppItem, "appId" | "notificationClass" | "sourceRef">,
    outcome: "refused" | "unavailable",
  ): string | null;
  beginServerAuthorizedAckIntent(input: { itemId: string; ackAttemptId: string }): AgentAppInboxAckIntent | null;
  completeServerAuthorizedAck(input: { itemId: string; ackAttemptId: string }): boolean;
  clearServerAuthorizedAckIntent(input: { itemId: string; ackAttemptId: string }): boolean;
  /** Test/process-boundary: drop transient items (models daemon restart). */
  dropTransient(): number;
  clear(): void;
};

export function createAgentAppInboxStore(options?: {
  nowMs?: () => number;
  /**
   * Optional override for first-mint itemId only. Same (appId,class,sourceRef)
   * always reuses the stored identity (upsert), ignoring later factory values.
   */
  idFactory?: () => string;
  /**
   * Closed app notification registry. Defaults to empty — Phase 1 substrate
   * does not register product apps; successors inject app-owned definitions.
   */
  registry?: AgentAppInboxRegistry;
  /**
   * Platform-scoped durable carrier for durable-retention items and exact ack
   * receipts. The App never receives a filesystem path or root authority.
   */
  storage?: ScopedAppStorage;
  /**
   * Durable producer handoff invoked before removing an item. A throw or an
   * explicit false aborts the acknowledgement so the item remains available
   * for retry.
   */
  beforeAck?: (item: AgentInboxAppItem) => boolean | void;
  /**
   * App-owned proof gate for daemon-mediated Server ACK. This is intentionally
   * separate from beforeAck: the Server has already adjudicated world revision,
   * so a missing or older local source cache must not veto completion.
   */
  beforeServerAuthorizedAck?: (item: AgentInboxAppItem, intent: AgentAppInboxAckIntent) => boolean | void;
  /** Content-free lifecycle telemetry; display/action fields are never passed. */
  trace?: (
    name: string,
    attrs: Record<string, unknown>,
    status?: "ok" | "error",
  ) => void;
  /** Owning Agent identity required to correlate App source and wake stages. */
  ownerAgentId?: string;
}): AgentAppInboxStore {
  // Injected/shared clock seam only — no ambient Date.now in this file.
  const nowMs = options?.nowMs ?? currentTimeMs;
  const idFactory = options?.idFactory;
  const registry: AgentAppInboxRegistry = options?.registry ?? {};
  const items = new Map<string, AgentInboxAppItem>();
  /** Identity key → itemId for upsert / replay idempotency. */
  const identityIndex = new Map<string, string>();
  /** Identity key → durable exact ack receipt for explicit repeat-ack idempotency. */
  const acknowledgedSources = new Map<string, AgentAppInboxAcknowledgedSource>();
  /** itemId → daemon-owned outbound exact ACK intent. */
  const ackIntents = new Map<string, AgentAppInboxAckIntent>();
  /** Exact source identity -> local per-Agent hold, independent of source record lifetime. */
  const seals = new Map<string, AgentAppInboxSeal>();
  /** The capability whose server-ack backfill completed (persisted), or null. */
  let serverAckBackfillDoneFor: string | null = null;
  const assertStorageActive = () => options?.storage?.assertActive();

  const persist = () => {
    if (!options?.storage) return;
    const durable = [...items.values()].filter((item) => isDurableRetention(item.retention));
    options.storage.writeTextAtomic(
      `${JSON.stringify({
        version: 4,
        items: durable,
        acknowledgedSources: [...acknowledgedSources.values()],
        ackIntents: [...ackIntents.values()],
        seals: [...seals.values()],
        ...(serverAckBackfillDoneFor ? { serverAckBackfillDone: serverAckBackfillDoneFor } : {}),
      })}\n`,
    );
  };

  const restore = () => {
    if (!options?.storage) return;
    const raw = options.storage.readText();
    if (raw === null) return;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        rejectPersistedPayload("invalid_json");
      }
      if (!parsed || typeof parsed !== "object" || ![1, 2, 3, 4].includes((parsed as { version?: number }).version ?? 0)) {
        rejectPersistedPayload("envelope_invalid");
      }
      const rawItems = (parsed as { items?: unknown }).items;
      if (!Array.isArray(rawItems)) rejectPersistedPayload("items_invalid");
      const restoredItems: AgentInboxAppItem[] = [];
      for (const rawItem of rawItems) {
        restoredItems.push(restorePersistedItem(rawItem, registry));
      }
      const restoredAcknowledgedSources: AgentAppInboxAcknowledgedSource[] = [];
      if (((parsed as { version?: number }).version ?? 0) >= 2) {
        const rawAcknowledgedSources = (parsed as { acknowledgedSources?: unknown }).acknowledgedSources;
        if (rawAcknowledgedSources !== undefined && !Array.isArray(rawAcknowledgedSources)) {
          rejectPersistedPayload("acknowledged_sources_invalid");
        }
        for (const rawAcknowledgedSource of rawAcknowledgedSources ?? []) {
          restoredAcknowledgedSources.push(
            restoreAcknowledgedSource(rawAcknowledgedSource, registry),
          );
        }
      }
      const restoredAckIntents: AgentAppInboxAckIntent[] = [];
      if (((parsed as { version?: number }).version ?? 0) >= 3) {
        const rawAckIntents = (parsed as { ackIntents?: unknown }).ackIntents;
        if (rawAckIntents !== undefined && !Array.isArray(rawAckIntents)) {
          rejectPersistedPayload("ack_intents_invalid");
        }
        for (const rawAckIntent of rawAckIntents ?? []) {
          const intent = restoreAckIntent(rawAckIntent, registry);
          const item = restoredItems.find((candidate) => candidate.itemId === intent.itemId);
          if (!item || makeIdentityKey(item.appId, item.notificationClass, item.sourceRef) !== makeIdentityKey(intent.appId, intent.notificationClass, intent.sourceRef)) {
            rejectPersistedPayload("ack_intent_item_binding_invalid");
          }
          restoredAckIntents.push(intent);
        }
      }
      const restoredSeals: AgentAppInboxSeal[] = [];
      if ((parsed as { version?: number }).version === 4) {
        const rawSeals = (parsed as { seals?: unknown }).seals;
        if (rawSeals !== undefined && !Array.isArray(rawSeals)) {
          rejectPersistedPayload("seals_invalid");
        }
        for (const rawSeal of rawSeals ?? []) {
          restoredSeals.push(restoreSeal(rawSeal, registry));
        }
      }

      const rawBackfillDone = (parsed as { serverAckBackfillDone?: unknown }).serverAckBackfillDone;
      const restoredBackfillDone = typeof rawBackfillDone === "string" && rawBackfillDone.length > 0
        ? rawBackfillDone
        : null;

      // Install only after the complete payload has passed parse, schema, and
      // semantic binding validation. A valid prefix cannot leak through a
      // later rejection.
      for (const restored of restoredItems) {
        const identityKey = makeIdentityKey(
          restored.appId,
          restored.notificationClass,
          restored.sourceRef,
        );
        items.set(restored.itemId, restored);
        identityIndex.set(identityKey, restored.itemId);
      }
      for (const acknowledged of restoredAcknowledgedSources) {
        acknowledgedSources.set(
          makeIdentityKey(acknowledged.appId, acknowledged.notificationClass, acknowledged.sourceRef),
          acknowledged,
        );
      }
      for (const intent of restoredAckIntents) {
        ackIntents.set(intent.itemId, intent);
      }
      for (const seal of restoredSeals) {
        seals.set(makeIdentityKey(seal.appId, seal.notificationClass, seal.sourceRef), seal);
      }
      serverAckBackfillDoneFor = restoredBackfillDone;
    } catch (error) {
      options.storage.reportDataFailure(
        error instanceof AgentAppInboxPersistedRejection
          ? "invalid_payload"
          : "internal_error",
      );
      throw error;
    }
  };

  restore();

  /** retire() and dismiss(): the item leaves without an ack; `outcome` is what the trace says. */
  const removeWithoutAck = (itemId: string, outcome: "retired" | "dismissed"): boolean => {
    assertStorageActive();
    const item = items.get(itemId);
    if (!item) return false;
    if (findSealForSourceId(seals, item)) return false;
    items.delete(itemId);
    identityIndex.delete(makeIdentityKey(item.appId, item.notificationClass, item.sourceRef));
    ackIntents.delete(itemId);
    persist();
    if (options?.ownerAgentId) {
      options.trace?.("daemon.app_inbox.ack", {
        ...appInboxItemTraceAttrs(options.ownerAgentId, item),
        outcome,
        retention: item.retention,
      });
    }
    return true;
  };

  return {
    list() {
      assertStorageActive();
      return [...items.values()].sort(
        (a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) || a.itemId.localeCompare(b.itemId),
      ).map((item) => {
        const seal = seals.get(makeIdentityKey(item.appId, item.notificationClass, item.sourceRef));
        return seal
          ? { ...item, sourceRef: { ...item.sourceRef }, seal: { owner: seal.owner, until: seal.until, sealedAtMs: seal.sealedAtMs } }
          : item;
      });
    },
    listAcknowledgedSources() {
      assertStorageActive();
      return [...acknowledgedSources.values()].sort(
        (a, b) => b.acknowledgedAtMs - a.acknowledgedAtMs || a.itemId.localeCompare(b.itemId),
      );
    },
    listSeals() {
      assertStorageActive();
      return [...seals.values()]
        .sort((a, b) => makeIdentityKey(a.appId, a.notificationClass, a.sourceRef)
          .localeCompare(makeIdentityKey(b.appId, b.notificationClass, b.sourceRef)))
        .map((seal) => ({ ...seal, sourceRef: { ...seal.sourceRef } }));
    },
    findProtectingSeal(input) {
      assertStorageActive();
      const found = findSealForSourceId(seals, input);
      return found ? { ...found, sourceRef: { ...found.sourceRef } } : null;
    },
    sealSources(input) {
      assertStorageActive();
      if (
        input.sources.length === 0
        || !isValidSealLabel(input.owner, AGENT_INBOX_PREVIEW_MAX_CHARS)
        || !isValidSealLabel(input.until, 500)
      ) return null;
      const normalized = input.sources.map((source) => normalizeSealSource(source, registry));
      if (normalized.some((source) => source === null)) return null;
      const keys = normalized.map((source) => makeIdentityKey(source!.appId, source!.notificationClass, source!.sourceRef));
      if (new Set(keys).size !== keys.length) return null;
      const created = normalized.map((source) => ({
        ...source!,
        owner: input.owner,
        until: input.until,
        sealedAtMs: nowMs(),
      }));
      for (const seal of created) {
        seals.set(makeIdentityKey(seal.appId, seal.notificationClass, seal.sourceRef), seal);
      }
      persist();
      return created;
    },
    unsealSources(input) {
      assertStorageActive();
      if (input.sources.length === 0) return null;
      const normalized = input.sources.map((source) => normalizeSealSource(source, registry));
      if (normalized.some((source) => source === null)) return null;
      const keys = normalized.map((source) => makeIdentityKey(source!.appId, source!.notificationClass, source!.sourceRef));
      if (new Set(keys).size !== keys.length) return null;
      if (keys.some((key) => !seals.has(key))) return null;
      const removed = keys.map((key) => seals.get(key)!);
      for (const key of keys) seals.delete(key);
      persist();
      return removed;
    },
    isSourceAcknowledged(input) {
      assertStorageActive();
      return acknowledgedSources.has(makeIdentityKey(
        input.appId,
        input.notificationClass,
        input.sourceRef,
      ));
    },
    mint(input) {
      assertStorageActive();
      const appId = input.appId.trim();
      const notificationClass = input.notificationClass.trim();
      if (!appId || !registry[appId]) {
        return { ok: false, code: "unknown_app", message: `unknown appId: ${appId || "(empty)"}` };
      }
      const classSpec = registry[appId]![notificationClass];
      if (!classSpec) {
        return {
          ok: false,
          code: "unknown_class",
          message: `unknown notificationClass for ${appId}: ${notificationClass || "(empty)"}`,
        };
      }
      if (input.requestedPrimaryAction) {
        const forbidden = Object.keys(input.requestedPrimaryAction as object).some((k) =>
          FORBIDDEN_PRIMARY_ACTION_KEYS.has(k),
        );
        if (forbidden) {
          return {
            ok: false,
            code: "raw_command_forbidden",
            message: "primaryAction must not carry raw shell/command fields",
          };
        }
        // Callers may only restate the registry action, not invent a new one.
        if (!primaryActionEquals(input.requestedPrimaryAction, classSpec.primaryAction)) {
          return {
            ok: false,
            code: "invalid_primary_action",
            message: "primaryAction must match OS registry mapping for app/class",
          };
        }
      }

      const normalized = classSpec.normalizeSourceRef(input.sourceRef);
      if (!normalized.ok) {
        return { ok: false, code: "invalid_source_ref", message: normalized.message };
      }
      const sourceRef = normalized.ref;
      // Structural sanity on normalizer output (defensive closed shape).
      if (!isClosedSourceRefShape(sourceRef)) {
        return {
          ok: false,
          code: "invalid_source_ref",
          message: "normalized sourceRef must be {kind,id,revision?} without control chars",
        };
      }

      const titleResult = sanitizePreviewField(input.title, "title");
      if (!titleResult.ok) return titleResult;
      const summaryResult = sanitizePreviewField(input.summary, "summary");
      if (!summaryResult.ok) return summaryResult;

      const primaryAction: AgentInboxPrimaryAction = { ...classSpec.primaryAction };
      const actionCli = classSpec.materializeActionCli({ sourceRef, primaryAction });
      if (!actionCli || PREVIEW_FORBIDDEN_CHARS.test(actionCli)) {
        return {
          ok: false,
          code: "invalid_primary_action",
          message: "primaryAction could not be materialized from registry + sourceRef",
        };
      }

      const identityKey = makeIdentityKey(appId, notificationClass, sourceRef);
      const existingItemId = identityIndex.get(identityKey);
      const materializedItemId = classSpec.materializeItemId?.(sourceRef);
      if (classSpec.materializeItemId && (!materializedItemId || PREVIEW_FORBIDDEN_CHARS.test(materializedItemId))) {
        return {
          ok: false,
          code: "invalid_source_ref",
          message: "itemId could not be materialized from registry + sourceRef",
        };
      }
      const itemId =
        existingItemId ??
        materializedItemId ??
        (idFactory ? idFactory() : deriveStableItemId(appId, notificationClass, sourceRef));

      const item: AgentInboxAppItem = {
        source: "app",
        itemId,
        appId,
        notificationClass,
        sourceRef: { ...sourceRef },
        primaryAction,
        actionCli,
        retention: classSpec.retention,
        ...(titleResult.value !== undefined ? { title: titleResult.value } : {}),
        ...(summaryResult.value !== undefined ? { summary: summaryResult.value } : {}),
        // Upsert keeps original createdAt when replaying same identity.
        createdAtMs: existingItemId ? (items.get(existingItemId)?.createdAtMs ?? nowMs()) : nowMs(),
      };

      // Fail closed: app items never carry message identity fields.
      assertNoMessageFields(item);
      items.set(item.itemId, item);
      identityIndex.set(identityKey, item.itemId);
      acknowledgedSources.delete(identityKey);
      ackIntents.delete(item.itemId);
      persist();
      if (options?.ownerAgentId) {
        options.trace?.("daemon.app_inbox.mint", {
          ...appInboxItemTraceAttrs(options.ownerAgentId, item),
          outcome: existingItemId ? "updated" : "created",
          retention: item.retention,
        });
      }
      return { ok: true, item };
    },
    ack(itemId) {
      assertStorageActive();
      const item = items.get(itemId);
      if (!item) return false;
      if (findSealForSourceId(seals, item)) return false;
      const sourceAcked = options?.beforeAck?.(item);
      if (sourceAcked === false) {
        if (options?.ownerAgentId) {
          options.trace?.(
            "daemon.app_inbox.ack",
            {
              ...appInboxItemTraceAttrs(options.ownerAgentId, item),
              outcome: "source_ack_rejected",
              retention: item.retention,
            },
            "error",
          );
        }
        return false;
      }
      if (isDurableRetention(item.retention)) {
        acknowledgedSources.set(makeIdentityKey(item.appId, item.notificationClass, item.sourceRef), {
          appId: item.appId,
          notificationClass: item.notificationClass,
          sourceRef: { ...item.sourceRef },
          itemId: item.itemId,
          acknowledgedAtMs: nowMs(),
          ...(options?.ownerAgentId ? { ownerAgentId: options.ownerAgentId } : {}),
        });
      }
      items.delete(itemId);
      identityIndex.delete(makeIdentityKey(item.appId, item.notificationClass, item.sourceRef));
      persist();
      if (options?.ownerAgentId) {
        options.trace?.("daemon.app_inbox.ack", {
          ...appInboxItemTraceAttrs(options.ownerAgentId, item),
          outcome: "acknowledged",
          retention: item.retention,
        });
      }
      return true;
    },
    retire(itemId) {
      return removeWithoutAck(itemId, "retired");
    },
    dismiss(itemId) {
      return removeWithoutAck(itemId, "dismissed");
    },
    requiresServerAuthorizedAck(item) {
      return registry[item.appId]?.[item.notificationClass]?.ackAuthority === "server";
    },
    normalizeServerAckSource(input) {
      const classSpec = registry[input.appId]?.[input.notificationClass];
      if (!classSpec || classSpec.ackAuthority !== "server") return null;
      const normalized = classSpec.normalizeSourceRef(input.sourceRef);
      if (!normalized.ok || !isClosedSourceRefShape(normalized.ref)) return null;
      const itemId = classSpec.materializeItemId?.(normalized.ref)
        ?? deriveStableItemId(input.appId, input.notificationClass, normalized.ref);
      return {
        appId: input.appId,
        notificationClass: input.notificationClass,
        sourceRef: normalized.ref,
        itemId,
      };
    },
    markAcknowledgedSourceServerAck(source, outcome) {
      assertStorageActive();
      const key = makeIdentityKey(source.appId, source.notificationClass, source.sourceRef);
      const acknowledged = acknowledgedSources.get(key);
      if (!acknowledged || acknowledged.serverAck === outcome) return;
      acknowledgedSources.set(key, { ...acknowledged, serverAck: outcome });
      persist();
    },
    listServerAckBackfillPending(limit) {
      assertStorageActive();
      const pending: AgentAppInboxAcknowledgedSource[] = [];
      for (const acknowledged of acknowledgedSources.values()) {
        if (acknowledged.serverAck !== undefined) continue;
        if (registry[acknowledged.appId]?.[acknowledged.notificationClass]?.ackAuthority !== "server") continue;
        pending.push(acknowledged);
      }
      return pending
        .sort((a, b) => a.acknowledgedAtMs - b.acknowledgedAtMs || a.itemId.localeCompare(b.itemId))
        .slice(0, Math.max(0, limit))
        .map((acknowledged) => ({ ...acknowledged, sourceRef: { ...acknowledged.sourceRef } }));
    },
    serverAckBackfillDone() {
      assertStorageActive();
      return serverAckBackfillDoneFor;
    },
    markServerAckBackfillDone(capability) {
      assertStorageActive();
      if (serverAckBackfillDoneFor === capability) return;
      serverAckBackfillDoneFor = capability;
      persist();
    },
    traceServerAckBackfill(attrs) {
      options?.trace?.(
        "daemon.app_inbox.server_ack_backfill",
        {
          ...(options?.ownerAgentId ? { owner_agent_id: options.ownerAgentId } : {}),
          attempted: attrs.attempted,
          accepted: attrs.accepted,
          refused: attrs.refused,
          failed: attrs.failed,
          remaining: attrs.remaining,
          done: attrs.done,
        },
        attrs.failed > 0 ? "error" : "ok",
      );
    },
    ackFailureNextAction(item, outcome) {
      return registry[item.appId]?.[item.notificationClass]?.ackFailureNextAction?.({ sourceRef: item.sourceRef, outcome }) ?? null;
    },
    beginServerAuthorizedAckIntent(input) {
      assertStorageActive();
      const item = items.get(input.itemId);
      if (!item) return null;
      if (findSealForSourceId(seals, item)) return null;
      const existing = ackIntents.get(input.itemId);
      if (existing) return { ...existing, sourceRef: { ...existing.sourceRef } };
      const intent: AgentAppInboxAckIntent = {
        appId: item.appId,
        notificationClass: item.notificationClass,
        sourceRef: { ...item.sourceRef },
        itemId: item.itemId,
        ackAttemptId: input.ackAttemptId,
        createdAtMs: nowMs(),
        ...(options?.ownerAgentId ? { ownerAgentId: options.ownerAgentId } : {}),
      };
      ackIntents.set(item.itemId, intent);
      persist();
      return { ...intent, sourceRef: { ...intent.sourceRef } };
    },
    completeServerAuthorizedAck(input) {
      assertStorageActive();
      const item = items.get(input.itemId);
      const intent = ackIntents.get(input.itemId);
      if (!item || !intent || intent.ackAttemptId !== input.ackAttemptId) return false;
      if (findSealForSourceId(seals, item)) return false;
      if (makeIdentityKey(item.appId, item.notificationClass, item.sourceRef) !== makeIdentityKey(intent.appId, intent.notificationClass, intent.sourceRef)) {
        return false;
      }
      const sourceAcked = options?.beforeServerAuthorizedAck?.(item, intent);
      if (sourceAcked === false) {
        if (options?.ownerAgentId) {
          options.trace?.(
            "daemon.app_inbox.ack",
            {
              ...appInboxItemTraceAttrs(options.ownerAgentId, item),
              outcome: "server_authorized_source_ack_rejected",
              retention: item.retention,
            },
            "error",
          );
        }
        return false;
      }
      if (isDurableRetention(item.retention)) {
        acknowledgedSources.set(makeIdentityKey(item.appId, item.notificationClass, item.sourceRef), {
          appId: item.appId,
          notificationClass: item.notificationClass,
          sourceRef: { ...item.sourceRef },
          itemId: item.itemId,
          acknowledgedAtMs: nowMs(),
          ...(options?.ownerAgentId ? { ownerAgentId: options.ownerAgentId } : {}),
          serverAck: "accepted",
        });
      }
      items.delete(input.itemId);
      identityIndex.delete(makeIdentityKey(item.appId, item.notificationClass, item.sourceRef));
      ackIntents.delete(input.itemId);
      persist();
      if (options?.ownerAgentId) {
        options.trace?.("daemon.app_inbox.ack", {
          ...appInboxItemTraceAttrs(options.ownerAgentId, item),
          outcome: "server_authorized_acknowledged",
          retention: item.retention,
        });
      }
      return true;
    },
    clearServerAuthorizedAckIntent(input) {
      assertStorageActive();
      const intent = ackIntents.get(input.itemId);
      if (!intent || intent.ackAttemptId !== input.ackAttemptId) return false;
      ackIntents.delete(input.itemId);
      persist();
      return true;
    },
    dropTransient() {
      assertStorageActive();
      let n = 0;
      for (const [id, item] of items) {
        if (item.retention === "transient") {
          items.delete(id);
          identityIndex.delete(makeIdentityKey(item.appId, item.notificationClass, item.sourceRef));
          ackIntents.delete(id);
          n += 1;
        }
      }
      if (n > 0) persist();
      return n;
    },
    clear() {
      assertStorageActive();
      items.clear();
      identityIndex.clear();
      acknowledgedSources.clear();
      ackIntents.clear();
      seals.clear();
      serverAckBackfillDoneFor = null;
      persist();
    },
  };
}

function restoreSeal(raw: unknown, registry: AgentAppInboxRegistry): AgentAppInboxSeal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    rejectPersistedPayload("seal_invalid");
  }
  const saved = raw as Partial<AgentAppInboxSeal>;
  if (
    typeof saved.appId !== "string"
    || typeof saved.notificationClass !== "string"
    || !saved.sourceRef
    || typeof saved.owner !== "string"
    || !saved.owner
    || saved.owner.length > AGENT_INBOX_PREVIEW_MAX_CHARS
    || PREVIEW_FORBIDDEN_CHARS.test(saved.owner)
    || typeof saved.until !== "string"
    || !saved.until
    || saved.until.length > 500
    || PREVIEW_FORBIDDEN_CHARS.test(saved.until)
    || typeof saved.sealedAtMs !== "number"
    || !Number.isFinite(saved.sealedAtMs)
  ) {
    rejectPersistedPayload("seal_shape_invalid");
  }
  const classSpec = registry[saved.appId]?.[saved.notificationClass];
  if (!classSpec || !isDurableRetention(classSpec.retention)) {
    rejectPersistedPayload("seal_registry_binding_invalid");
  }
  if (saved.sourceRef.revision === undefined && isClosedSourceRefShape(saved.sourceRef)) {
    return {
      appId: saved.appId,
      notificationClass: saved.notificationClass,
      sourceRef: { ...saved.sourceRef },
      owner: saved.owner,
      until: saved.until,
      sealedAtMs: saved.sealedAtMs,
    };
  }
  const normalized = classSpec.normalizeSourceRef(saved.sourceRef);
  if (!normalized.ok || !isClosedSourceRefShape(normalized.ref)) {
    rejectPersistedPayload("seal_source_ref_invalid");
  }
  return {
    appId: saved.appId,
    notificationClass: saved.notificationClass,
    sourceRef: normalized.ref,
    owner: saved.owner,
    until: saved.until,
    sealedAtMs: saved.sealedAtMs,
  };
}

function normalizeSealSource(
  source: Pick<AgentAppInboxSeal, "appId" | "notificationClass" | "sourceRef">,
  registry: AgentAppInboxRegistry,
): Pick<AgentAppInboxSeal, "appId" | "notificationClass" | "sourceRef"> | null {
  const classSpec = registry[source.appId]?.[source.notificationClass];
  if (!classSpec || !isDurableRetention(classSpec.retention)) return null;
  if (source.sourceRef.revision === undefined && isClosedSourceRefShape(source.sourceRef)) {
    return {
      appId: source.appId,
      notificationClass: source.notificationClass,
      sourceRef: { ...source.sourceRef },
    };
  }
  const normalized = classSpec.normalizeSourceRef(source.sourceRef);
  if (!normalized.ok || !isClosedSourceRefShape(normalized.ref)) return null;
  return {
    appId: source.appId,
    notificationClass: source.notificationClass,
    sourceRef: normalized.ref,
  };
}

function isValidSealLabel(value: string, maxLength: number): boolean {
  return value === value.trim()
    && value.length > 0
    && value.length <= maxLength
    && !PREVIEW_FORBIDDEN_CHARS.test(value);
}

function findSealForSourceId(
  seals: ReadonlyMap<string, AgentAppInboxSeal>,
  input: Pick<AgentAppInboxSeal, "appId" | "notificationClass" | "sourceRef">,
): AgentAppInboxSeal | undefined {
  return [...seals.values()].find((seal) =>
    seal.appId === input.appId
    && seal.notificationClass === input.notificationClass
    && seal.sourceRef.kind === input.sourceRef.kind
    && seal.sourceRef.id === input.sourceRef.id,
  );
}

function restorePersistedItem(raw: unknown, registry: AgentAppInboxRegistry): AgentInboxAppItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    rejectPersistedPayload("item_invalid");
  }
  const saved = raw as Partial<AgentInboxAppItem>;
  if (
    saved.source !== "app"
    || typeof saved.appId !== "string"
    || typeof saved.notificationClass !== "string"
    || !isDurableRetention(saved.retention)
    || !saved.sourceRef
  ) {
    rejectPersistedPayload("item_shape_invalid");
  }
  const classSpec = registry[saved.appId]?.[saved.notificationClass];
  if (!classSpec || !isDurableRetention(classSpec.retention)) {
    rejectPersistedPayload("item_registry_binding_invalid");
  }
  const normalized = classSpec.normalizeSourceRef(saved.sourceRef);
  if (!normalized.ok || !isClosedSourceRefShape(normalized.ref)) {
    rejectPersistedPayload("item_source_ref_invalid");
  }
  const sourceRef = normalized.ref;
  const primaryAction = { ...classSpec.primaryAction };
  const actionCli = classSpec.materializeActionCli({ sourceRef, primaryAction });
  const itemId = classSpec.materializeItemId?.(sourceRef)
    ?? deriveStableItemId(saved.appId, saved.notificationClass, sourceRef);
  if (!actionCli || PREVIEW_FORBIDDEN_CHARS.test(actionCli) || !itemId || PREVIEW_FORBIDDEN_CHARS.test(itemId)) {
    rejectPersistedPayload("item_action_identity_invalid");
  }
  const title = sanitizePreviewField(saved.title, "title");
  const summary = sanitizePreviewField(saved.summary, "summary");
  if (!title.ok || !summary.ok) rejectPersistedPayload("item_preview_invalid");
  const item: AgentInboxAppItem = {
    source: "app",
    itemId,
    appId: saved.appId,
    notificationClass: saved.notificationClass,
    sourceRef,
    primaryAction,
    actionCli,
    retention: classSpec.retention,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(summary.value !== undefined ? { summary: summary.value } : {}),
    ...(typeof saved.createdAtMs === "number" && Number.isFinite(saved.createdAtMs)
      ? { createdAtMs: saved.createdAtMs }
      : {}),
  };
  assertNoMessageFields(item);
  return item;
}

function restoreAcknowledgedSource(raw: unknown, registry: AgentAppInboxRegistry): AgentAppInboxAcknowledgedSource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    rejectPersistedPayload("acknowledged_source_invalid");
  }
  const saved = raw as Partial<AgentAppInboxAcknowledgedSource>;
  if (
    typeof saved.appId !== "string"
    || typeof saved.notificationClass !== "string"
    || !saved.sourceRef
    || typeof saved.itemId !== "string"
    || typeof saved.acknowledgedAtMs !== "number"
    || !Number.isFinite(saved.acknowledgedAtMs)
    || (saved.ownerAgentId !== undefined && typeof saved.ownerAgentId !== "string")
  ) {
    rejectPersistedPayload("acknowledged_source_shape_invalid");
  }
  const classSpec = registry[saved.appId]?.[saved.notificationClass];
  if (!classSpec || !isDurableRetention(classSpec.retention)) {
    rejectPersistedPayload("acknowledged_source_registry_binding_invalid");
  }
  const normalized = classSpec.normalizeSourceRef(saved.sourceRef);
  if (!normalized.ok || !isClosedSourceRefShape(normalized.ref)) {
    rejectPersistedPayload("acknowledged_source_ref_invalid");
  }
  const materializedItemId = classSpec.materializeItemId?.(normalized.ref)
    ?? deriveStableItemId(saved.appId, saved.notificationClass, normalized.ref);
  if (saved.itemId !== materializedItemId) {
    rejectPersistedPayload("acknowledged_source_item_id_invalid");
  }
  return {
    appId: saved.appId,
    notificationClass: saved.notificationClass,
    sourceRef: normalized.ref,
    itemId: saved.itemId,
    acknowledgedAtMs: saved.acknowledgedAtMs,
    ...(saved.ownerAgentId ? { ownerAgentId: saved.ownerAgentId } : {}),
    ...(saved.serverAck === "accepted" || saved.serverAck === "refused" ? { serverAck: saved.serverAck } : {}),
  };
}

function restoreAckIntent(raw: unknown, registry: AgentAppInboxRegistry): AgentAppInboxAckIntent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    rejectPersistedPayload("ack_intent_invalid");
  }
  const saved = raw as Partial<AgentAppInboxAckIntent>;
  if (
    typeof saved.appId !== "string"
    || typeof saved.notificationClass !== "string"
    || !saved.sourceRef
    || typeof saved.itemId !== "string"
    || typeof saved.ackAttemptId !== "string"
    || typeof saved.createdAtMs !== "number"
    || !Number.isFinite(saved.createdAtMs)
    || (saved.ownerAgentId !== undefined && typeof saved.ownerAgentId !== "string")
  ) {
    rejectPersistedPayload("ack_intent_shape_invalid");
  }
  const classSpec = registry[saved.appId]?.[saved.notificationClass];
  if (!classSpec || !isDurableRetention(classSpec.retention)) {
    rejectPersistedPayload("ack_intent_registry_binding_invalid");
  }
  const normalized = classSpec.normalizeSourceRef(saved.sourceRef);
  if (!normalized.ok || !isClosedSourceRefShape(normalized.ref)) {
    rejectPersistedPayload("ack_intent_source_ref_invalid");
  }
  const materializedItemId = classSpec.materializeItemId?.(normalized.ref)
    ?? deriveStableItemId(saved.appId, saved.notificationClass, normalized.ref);
  if (saved.itemId !== materializedItemId) {
    rejectPersistedPayload("ack_intent_item_id_invalid");
  }
  return {
    appId: saved.appId,
    notificationClass: saved.notificationClass,
    sourceRef: normalized.ref,
    itemId: saved.itemId,
    ackAttemptId: saved.ackAttemptId,
    createdAtMs: saved.createdAtMs,
    ...(saved.ownerAgentId ? { ownerAgentId: saved.ownerAgentId } : {}),
  };
}

/** Exported for tests / Phase 2 callers that need the same identity key. */
export function makeIdentityKey(
  appId: string,
  notificationClass: string,
  sourceRef: AgentInboxSourceRef,
): string {
  return `${appId}\0${notificationClass}\0${sourceRefIdentityKey(sourceRef)}`;
}

function isDurableRetention(retention: AgentInboxRetention | undefined): retention is "until_source_read" | "until_explicit_ack" {
  return retention === "until_source_read" || retention === "until_explicit_ack";
}

/**
 * OS-stable itemId from closed (appId, class, normalized sourceRef).
 * Same triple ⇒ same id (Phase 1 is still process-local storage).
 */
export function deriveStableItemId(
  appId: string,
  notificationClass: string,
  sourceRef: AgentInboxSourceRef,
): string {
  const h = createHash("sha256")
    .update("agent-app-inbox-v1\0")
    .update(appId)
    .update("\0")
    .update(notificationClass)
    .update("\0")
    .update(sourceRefIdentityKey(sourceRef))
    .digest("hex");
  // UUID-shaped, version-ish nibble fixed for readability (not a real UUID v5).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function isClosedSourceRefShape(ref: AgentInboxSourceRef): boolean {
  if (typeof ref.kind !== "string" || !ref.kind || PREVIEW_FORBIDDEN_CHARS.test(ref.kind)) {
    return false;
  }
  if (typeof ref.id !== "string" || !ref.id || PREVIEW_FORBIDDEN_CHARS.test(ref.id)) {
    return false;
  }
  if (ref.revision !== undefined) {
    if (typeof ref.revision !== "string" || !ref.revision || PREVIEW_FORBIDDEN_CHARS.test(ref.revision)) {
      return false;
    }
  }
  return true;
}

function sanitizePreviewField(
  value: string | undefined,
  field: "title" | "summary",
):
  | { ok: true; value?: string }
  | { ok: false; code: "invalid_preview"; message: string } {
  if (value === undefined) return { ok: true };
  // Empty string → omit (not an error).
  if (value.length === 0) return { ok: true };
  if (PREVIEW_FORBIDDEN_CHARS.test(value)) {
    return {
      ok: false,
      code: "invalid_preview",
      message: `${field} must be single-line without control chars`,
    };
  }
  if (value.length > AGENT_INBOX_PREVIEW_MAX_CHARS) {
    return {
      ok: false,
      code: "invalid_preview",
      message: `${field} exceeds ${AGENT_INBOX_PREVIEW_MAX_CHARS} chars`,
    };
  }
  return { ok: true, value };
}

function primaryActionEquals(a: AgentInboxPrimaryAction, b: AgentInboxPrimaryAction): boolean {
  return a.kind === b.kind && a.target === b.target && a.commandId === b.commandId;
}

function assertNoMessageFields(item: AgentInboxAppItem): void {
  const forbidden = [
    "firstPendingMsgId",
    "latestMsgId",
    "firstPendingSeq",
    "latestSeq",
    "latestSenderName",
    "latestSenderType",
    "msgId",
    "seq",
    "sender",
  ];
  for (const key of forbidden) {
    if (key in (item as object)) {
      throw new Error(`app inbox item must not carry message field: ${key}`);
    }
  }
}
