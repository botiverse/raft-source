import type { Command } from "commander";

import type { AgentInboxAppItem, AgentInboxSourceRef, AgentInboxSourceSeal } from "@botiverse/raft-shared";

import { createDaemonApiSurfaceClient } from "../../daemonApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { isReminderDueItem, matchesReminderId, readLocalReminderState } from "./sealGuard";

interface AckOpts {
  id: string;
  revision: string;
}

type AcknowledgedAppSource = {
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
  itemId: string;
  acknowledgedAtMs: number;
  ownerAgentId?: string;
};

const REMINDER_INBOX_APP_ID = "system.reminder";
const REMINDER_DUE_NOTIFICATION_CLASS = "due";

function matchesReminderItem(itemId: string, query: string): boolean {
  return itemId === query || itemId.startsWith(query);
}

function isExactAcknowledgement(
  ack: AcknowledgedAppSource,
  item: AgentInboxAppItem,
): boolean {
  return ack.appId === item.appId
    && ack.notificationClass === item.notificationClass
    && ack.itemId === item.itemId
    && ack.sourceRef.kind === "reminder"
    && item.sourceRef.kind === "reminder"
    && ack.sourceRef.id === item.sourceRef.id
    && ack.sourceRef.revision === item.sourceRef.revision;
}

const FULL_REMINDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A failed daemon ack as the agent reads it. The daemon says whether the
 * reminder is still not acked and whether the same ack is safe to run again
 * (its `suggested_next_action`); ACK_UNREACHABLE: it could not reach the Server.
 */
function ackFailure(ack: { status: number; error?: string | null; errorCode?: string | null; suggestedNextAction?: string | null }): Error {
  return cliError(
    ack.errorCode === "app_source_ack_unavailable"
      ? "ACK_UNREACHABLE"
      : ack.status >= 500 ? "SERVER_5XX" : "ACK_FAILED",
    ack.error ?? `HTTP ${ack.status}`,
    ack.suggestedNextAction ? { suggestedNextAction: ack.suggestedNextAction } : {},
  );
}

function parseAckOptions(opts: AckOpts): { id: string; revision: string } {
  const id = opts.id?.trim();
  if (!id) {
    throw cliError("INVALID_ARG", "--id is required");
  }
  const revision = opts.revision?.trim();
  if (!/^[1-9][0-9]*$/.test(revision ?? "")) {
    throw cliError("INVALID_ARG", "--revision must be a positive integer");
  }
  return { id, revision };
}

function findReminderSeal(
  seals: readonly AgentInboxSourceSeal[],
  reminderId: string,
): AgentInboxSourceSeal | undefined {
  return seals.find((seal) =>
    seal.appId === REMINDER_INBOX_APP_ID
    && seal.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS
    && seal.sourceRef.kind === "reminder"
    && seal.sourceRef.id === reminderId,
  );
}

function sealedReminderError(seal: AgentInboxSourceSeal): Error {
  const identity = seal.sourceRef.revision === undefined
    ? "id-only"
    : `registered revision ${seal.sourceRef.revision}`;
  return cliError(
    "ACK_FAILED",
    `Reminder ${seal.sourceRef.id} is sealed (${identity}) by ${seal.owner} until ${seal.until}; run raft reminder unseal explicitly first`,
  );
}

async function runReminderAck(ctx: CommandContext, opts: AckOpts): Promise<void> {
    const { id, revision } = parseAckOptions(opts);
    const agentContext = ctx.loadAgentContext();
    if (agentContext.clientMode !== "managed-runner") {
      throw cliError("ACK_FAILED", "Reminder Inbox acknowledgements are only available in managed runners");
    }

    const client = ctx.createApiClient(agentContext);
    const daemonApi = createDaemonApiSurfaceClient(client);
    const snapshot = await daemonApi.inbox.check();
    if (!snapshot.ok) {
      throw cliError(
        snapshot.status >= 500 ? "SERVER_5XX" : "ACK_FAILED",
        snapshot.error ?? `HTTP ${snapshot.status}`,
      );
    }

    const items = (snapshot.data?.items ?? []) as Array<
      AgentInboxAppItem | { source: "message_target"; row: unknown }
    >;
    const acknowledgedSources = (snapshot.data?.acknowledged_app_sources ?? []) as AcknowledgedAppSource[];
    const seals = (snapshot.data?.seals ?? []) as AgentInboxSourceSeal[];
    const reminderItems = items.filter((item): item is AgentInboxAppItem =>
      item.source === "app"
      && isReminderDueItem(item)
      && (matchesReminderId(item.sourceRef.id, id) || matchesReminderItem(item.itemId, id)),
    );
    const reminderAcknowledgements = acknowledgedSources.filter((ack) =>
      ack.appId === REMINDER_INBOX_APP_ID
      && ack.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS
      && ack.sourceRef.kind === "reminder"
      && ack.sourceRef.revision !== undefined
      && (matchesReminderId(ack.sourceRef.id, id) || matchesReminderItem(ack.itemId, id)),
    );
    const distinctReminderIds = new Set([
      ...reminderItems.map((item) => item.sourceRef.id),
      ...reminderAcknowledgements.map((ack) => ack.sourceRef.id),
    ]);
    if (distinctReminderIds.size > 1) {
      throw cliError("ACK_FAILED", `Reminder prefix ${id} is ambiguous across active or acknowledged Reminder Inbox items`);
    }

    const exact = reminderItems.find((item) => item.sourceRef.revision === revision);
    if (!exact) {
      const acknowledged = reminderAcknowledgements.find((ack) => ack.sourceRef.revision === revision);
      if (acknowledged) {
        // Acked here, perhaps only here (a daemon before reminder-server-ack@1):
        // the daemon sends the Server the ack; its answer is the answer, and
        // "already acknowledged" there is a success.
        const forwarded = await daemonApi.inbox.ack({ itemId: acknowledged.itemId });
        if (!forwarded.ok && !(forwarded.status === 404 && forwarded.errorCode === "item_not_found")) {
          throw ackFailure(forwarded);
        }
        writeText(ctx.io, adoptCliReplyText(`Reminder ${acknowledged.sourceRef.id} revision ${revision} was already acknowledged for this fired item.\n`));
        return;
      }
      if (distinctReminderIds.size === 0 && !FULL_REMINDER_ID.test(id)) {
        throw cliError(
          "ACK_FAILED",
          `No reminder Inbox item on this Computer matches ${id} revision ${revision}, so the short id cannot be resolved`,
          { suggestedNextAction: "Run the ack with the full reminder id from its ack: line in raft inbox check." },
        );
      }
      // Not held here (a lost store, another machine): ack the exact source on
      // the Server, by the full id.
      const reminderId = distinctReminderIds.size === 1 ? [...distinctReminderIds][0]! : id;
      const sourceRef = { kind: "reminder", id: reminderId, revision };
      const forwarded = await daemonApi.inbox.ack({
        itemId: `reminder:${reminderId}:${revision}`,
        source: { appId: REMINDER_INBOX_APP_ID, notificationClass: REMINDER_DUE_NOTIFICATION_CLASS, sourceRef },
      });
      if (!forwarded.ok) {
        if (forwarded.status === 404 && forwarded.errorCode === "item_not_found") {
          throw cliError("ACK_FAILED", `No active or acknowledged reminder Inbox item matches ${id} revision ${revision}`);
        }
        throw ackFailure(forwarded);
      }
      writeText(ctx.io, adoptCliReplyText(`Reminder ${reminderId} revision ${revision} fired item acknowledged.\n`));
      return;
    }
    const protectingSeal = findReminderSeal(seals, exact.sourceRef.id);
    if (protectingSeal) throw sealedReminderError(protectingSeal);

    const ack = await daemonApi.inbox.ack({ itemId: exact.itemId });
    if (!ack.ok && ack.status === 404 && ack.errorCode === "item_not_found") {
      const refreshed = await daemonApi.inbox.check();
      if (!refreshed.ok) {
        throw cliError(
          refreshed.status >= 500 ? "SERVER_5XX" : "ACK_FAILED",
          refreshed.error ?? `HTTP ${refreshed.status}`,
        );
      }
      const refreshedAcknowledgements = (refreshed.data?.acknowledged_app_sources ?? []) as AcknowledgedAppSource[];
      if (!refreshedAcknowledgements.some((acknowledged) => isExactAcknowledgement(acknowledged, exact))) {
        throw cliError("ACK_FAILED", `No durable acknowledgement was recorded for reminder ${exact.sourceRef.id} revision ${revision}`);
      }
    } else if (!ack.ok) {
      throw ackFailure(ack);
    }

    writeText(ctx.io, adoptCliReplyText(`Reminder ${exact.sourceRef.id} revision ${revision} fired item acknowledged.\n`));
}

const reminderAckOptions = [
  { flags: "--id <id>", description: "Reminder id (full uuid or short prefix)" },
  { flags: "--revision <revision>", description: "Exact reminder source revision to acknowledge" },
];

export const reminderAckCommand = defineCommand(
  {
    name: "ack",
    description: "Acknowledge one exact fired reminder Inbox item",
    options: reminderAckOptions,
  },
  runReminderAck,
);

export const reminderDismissCommand = defineCommand(
  {
    name: "dismiss",
    description: "Dismiss one exact fired reminder Inbox item",
    options: reminderAckOptions,
  },
  runReminderAck,
);

export function registerReminderAckCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderAckCommand, runtimeOptions);
  registerCliCommand(parent, reminderDismissCommand, runtimeOptions);
  registerCliCommand(parent, reminderSealCommand, runtimeOptions);
  registerCliCommand(parent, reminderUnsealCommand, runtimeOptions);
}

interface SealOpts {
  id: string;
  revision?: string;
  allPending?: boolean;
  owner?: string;
  until?: string;
}

function validateSealSelector(opts: SealOpts): { id: string; revision?: string; allPending: boolean } {
  const id = opts.id?.trim();
  if (!id) throw cliError("INVALID_ARG", "--id is required");
  const allPending = opts.allPending === true;
  const revision = opts.revision?.trim();
  if (allPending && revision) {
    throw cliError("INVALID_ARG", "Pass at most one of --revision or --all-pending");
  }
  if (revision && !/^[1-9][0-9]*$/.test(revision)) {
    throw cliError("INVALID_ARG", "--revision must be a positive integer");
  }
  return { id, ...(revision ? { revision } : {}), allPending };
}

function selectReminderItems(items: AgentInboxAppItem[], opts: SealOpts): AgentInboxAppItem[] {
  const { id, revision, allPending } = validateSealSelector(opts);
  const matching = items.filter((item) =>
    matchesReminderId(item.sourceRef.id, id)
    && (allPending || revision === undefined || item.sourceRef.revision === revision),
  );
  const distinctIds = new Set(matching.map((item) => item.sourceRef.id));
  if (distinctIds.size > 1) throw cliError("INVALID_ARG", `Reminder prefix ${id} is ambiguous`);
  if (matching.length === 0) throw cliError("NOT_FOUND", `No pending reminder Inbox item matches ${id}${revision ? ` revision ${revision}` : ""}`);
  return matching;
}

function reminderSource(item: AgentInboxAppItem) {
  return {
    appId: item.appId,
    notificationClass: item.notificationClass,
    sourceRef: item.sourceRef,
  };
}

export const reminderSealCommand = defineCommand(
  {
    name: "seal",
    description: "Seal a local reminder id against destructive actions",
    options: [
      { flags: "--id <id>", description: "Reminder id (full uuid or short prefix)" },
      { flags: "--revision <revision>", description: "Exact evidence revision (optional)" },
      { flags: "--all-pending", description: "Seal every pending revision for this reminder" },
      { flags: "--owner <owner>", description: "Accountable seal owner, e.g. @Stone" },
      { flags: "--until <condition>", description: "Explicit unseal condition" },
    ],
  },
  async (ctx, opts: SealOpts) => {
    const owner = opts.owner?.trim();
    const until = opts.until?.trim();
    if (!owner || owner.length > 120 || /[\u0000-\u001f\u007f]/.test(owner)) {
      throw cliError("INVALID_ARG", "--owner must be a single-line value of at most 120 characters");
    }
    if (!until || until.length > 500 || /[\u0000-\u001f\u007f]/.test(until)) {
      throw cliError("INVALID_ARG", "--until must be a single-line value of at most 500 characters");
    }
    const state = await readLocalReminderState(ctx);
    const selector = validateSealSelector(opts);
    let sources: ReturnType<typeof reminderSource>[];
    const fullId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selector.id);
    if (!selector.allPending && selector.revision === undefined) {
      const matchingIds = new Set([
        ...state.items.filter((item) => matchesReminderId(item.sourceRef.id, selector.id)).map((item) => item.sourceRef.id),
        ...state.seals.filter((seal) => matchesReminderId(seal.sourceRef.id, selector.id)).map((seal) => seal.sourceRef.id),
      ]);
      if (matchingIds.size > 1) throw cliError("INVALID_ARG", `Reminder prefix ${selector.id} is ambiguous`);
      const resolvedId = [...matchingIds][0] ?? (fullId ? selector.id : null);
      if (!resolvedId) throw cliError("NOT_FOUND", `No local reminder identity matches ${selector.id}; use the full reminder UUID for a detached id-only seal`);
      sources = [{
        appId: REMINDER_INBOX_APP_ID,
        notificationClass: REMINDER_DUE_NOTIFICATION_CLASS,
        sourceRef: { kind: "reminder", id: resolvedId },
      }];
    } else {
      try {
        sources = selectReminderItems(state.items, opts).map(reminderSource);
      } catch (error) {
        const exactFullId = !selector.allPending && selector.revision !== undefined && fullId;
        if (!exactFullId) throw error;
        sources = [{
          appId: REMINDER_INBOX_APP_ID,
          notificationClass: REMINDER_DUE_NOTIFICATION_CLASS,
          sourceRef: { kind: "reminder", id: selector.id, revision: selector.revision },
        }];
      }
    }
    const agentContext = ctx.loadAgentContext();
    const response = await createDaemonApiSurfaceClient(ctx.createApiClient(agentContext)).inbox.seal({
      sources,
      owner,
      until,
    });
    if (!response.ok) throw cliError("UPDATE_FAILED", response.error ?? `HTTP ${response.status}`);
    writeText(ctx.io, adoptCliReplyText(`Sealed ${response.data?.affected ?? sources.length} reminder source identity(ies) for ${sources[0]!.sourceRef.id}.\n`));
  },
);

export const reminderUnsealCommand = defineCommand(
  {
    name: "unseal",
    description: "Remove a local reminder Inbox seal",
    options: [
      { flags: "--id <id>", description: "Reminder id (full uuid or short prefix)" },
      { flags: "--revision <revision>", description: "Exact evidence revision (optional)" },
      { flags: "--all-pending", description: "Unseal every pending revision for this reminder" },
    ],
  },
  async (ctx, opts: SealOpts) => {
    const state = await readLocalReminderState(ctx);
    const selector = validateSealSelector(opts);
    const matchingSeals = state.seals.filter((seal) =>
      matchesReminderId(seal.sourceRef.id, selector.id)
      && (selector.allPending || seal.sourceRef.revision === selector.revision),
    );
    if (matchingSeals.length === 0) throw cliError("NOT_FOUND", "No matching local reminder seal exists");
    const distinctIds = new Set(matchingSeals.map((seal) => seal.sourceRef.id));
    if (distinctIds.size > 1) throw cliError("INVALID_ARG", `Reminder prefix ${selector.id} is ambiguous`);
    const sources = matchingSeals.map(({ appId, notificationClass, sourceRef }) => ({ appId, notificationClass, sourceRef }));
    const agentContext = ctx.loadAgentContext();
    const response = await createDaemonApiSurfaceClient(ctx.createApiClient(agentContext)).inbox.unseal({
      sources,
    });
    if (!response.ok) throw cliError("UPDATE_FAILED", response.error ?? `HTTP ${response.status}`);
    writeText(ctx.io, adoptCliReplyText(`Unsealed ${response.data?.affected ?? sources.length} reminder source identity(ies) for ${sources[0]!.sourceRef.id}.\n`));
  },
);
