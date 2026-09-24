/**
 * RAP §3 syscall surface — task #141, first slice.
 *
 * Contract attachment `2168f101` §2 Q1/Q3, §3, §4d-3. Criteria #138 v16 item 3.
 * Signature draft published as `rap-syscall-signatures-draft.md`.
 *
 * ⚠️ NO APP NAMES here — the manifest is #137's sole exemption.
 *
 * This module owns authorization and resolution for `notify`. An app names a
 * SUBJECT; the registry resolves it to a granted conversation, or refuses.
 * Raising and waking stay behind `DeliverySeam`; production hook owners provide
 * the concrete carrier, while tests can still isolate authorization.
 */
import { randomUUID } from "node:crypto";
import {
  manifestPermitsSyscall,
  type AppId,
} from "./rapRegistry.js";
import {
  getInstalledApp,
  // The STORE primitive. Deliberately aliased: it resolves a grant but never
  // checks whether the manifest declared the syscall, so it is not an app-facing
  // surface and must not be mistaken for one (@XX's correction on task #141 --
  // "callable from TypeScript" is not "callable under the contract"). The
  // subject-addressed public syscall of the same name is defined below.
  resolveConversation as resolveConversationInStore,
  type RapRegistryReader,
} from "./rapRegistryStore.js";
import { currentRapEventId } from "./rapInvocationContext.js";
import { productionRapTimerSeam } from "./rapTimerRuntime.js";

/** An app addresses a SUBJECT. Never a channel, thread, or raw target (§2 Q1). */
export interface Subject {
  readonly agentId: string;
}

export interface NotificationPayload {
  readonly notificationClass: string;
  readonly body: string;
}

/** OS-owned invocation identity; an app cannot select a different source event. */
export interface NotificationInvocation {
  readonly eventId: string;
}

export type SuppressionReason = "debounced" | "muted";
export type UndeterminedReason = "timeout" | "cross_replica_unconfirmed" | "state_not_returned";
export type RefusalReason =
  | "not_installed"
  | "syscall_not_declared"
  | "no_grant_for_subject"
  | "notification_class_not_declared";

/**
 * How far a notification actually got. Deliberately not a boolean.
 *
 * The `l1_`/`l2_` prefixes are load-bearing (@Huaihuai): the LAYER each result
 * evidences is carried by the type, not by prose elsewhere. There is NO `l3_*`
 * variant: layer 3 is the message target's existing per-agent read cursor, not
 * a `notify` return value. Promoting a result to "the agent acknowledged" would
 * therefore require an explicit type change someone must write and review,
 * rather than a new conclusion drawn by re-reading the same sentence.
 *
 * ⚠️ This value does NOT satisfy agent-side visibility of suppression. It tells
 * the APP its notification was held; the agent is told nothing by it, so on the
 * agent's side "I received nothing" and "there was nothing to receive" remain
 * indistinguishable. That belongs to #143. A count here would be additive, never
 * the place that criterion is discharged.
 */
export type NotifyOutcome =
  | { kind: "l1_raised"; conversationId: string; eventId: string }
  | { kind: "l2_woke"; conversationId: string; eventId: string }
  | { kind: "l1_suppressed"; conversationId: string; eventId: string; reason: SuppressionReason }
  | { kind: "refused"; reason: RefusalReason }
  /**
   * The outcome is genuinely UNDETERMINED. A known unknown gets its own literal
   * and may not borrow a legal value: returning a refusal or a success here
   * would disguise it as known, and a borrowed legal value looks like normal
   * operation forever.
   */
  | { kind: "not_established"; reason: UndeterminedReason };

/** Opaque OS-owned identity for one logical timer. */
export type RapTimerId = string & { readonly __brand: "RapTimerId" };

/**
 * App-owned, bounded JSON projected into a later registry-owned due envelope.
 * The OS stores and replays it; it never interprets it or reads an app table to
 * reconstruct it.
 */
export type RapTimerData =
  | null
  | boolean
  | number
  | string
  | readonly RapTimerData[]
  | { readonly [key: string]: RapTimerData };

export interface ScheduleSpec {
  readonly fireAtMs: number;
  readonly sourceId: string;
  readonly data: RapTimerData;
}

export interface RapTimerScheduleInput extends ScheduleSpec {
  readonly serverId: string;
  readonly appId: AppId;
  readonly subjectAgentId: string;
}

export interface RapTimerCancelInput {
  readonly serverId: string;
  readonly appId: AppId;
  readonly subjectAgentId: string;
  readonly sourceId: string;
}

export interface RapTimerScheduleReceipt {
  readonly timerId: RapTimerId;
  readonly nextFireAt: number;
}

export interface RapTimerSeam {
  schedule(input: RapTimerScheduleInput): Promise<RapTimerScheduleReceipt>;
  cancel(input: RapTimerCancelInput): Promise<"cancelled" | "not_found">;
}

export type ScheduleOutcome =
  | ({ kind: "scheduled" } & RapTimerScheduleReceipt)
  | { kind: "refused"; reason: RefusalReason };

export type CancelOutcome =
  | { kind: "cancelled" }
  | { kind: "not_found" }
  | { kind: "refused"; reason: RefusalReason };

/**
 * The delivery seam. Raising and waking live behind this so that authorization
 * can be implemented and tested independently of its carrier -- and so that a
 * missing production implementation is a visible absence rather than a silent
 * success.
 */
export interface DeliverySeam {
  raise(
    conversationId: string,
    payload: NotificationPayload,
    invocation: NotificationInvocation,
  ): Promise<NotifyOutcome>;
}

/**
 * §3 `notify`. Subject-addressed only: an app cannot name a channel or thread,
 * so there is no ambient authority to post anywhere (§2 Q1).
 *
 * Refusal is a RESULT, not an exception -- criteria item 3's positive control
 * requires notifying an ungranted subject to be refused, and an exception would
 * make that indistinguishable from a crash.
 */
async function notifyWithRegistry(
  registry: Pick<RapRegistryReader, "getInstalledApp" | "resolveConversation">,
  serverId: string,
  appId: AppId,
  subject: Subject,
  payload: NotificationPayload,
  seam: DeliverySeam,
): Promise<NotifyOutcome> {
  const installed = await registry.getInstalledApp(serverId, appId);
  if (!installed) return { kind: "refused", reason: "not_installed" };

  // §2 Q3: the manifest is the whole answer. Being first-party is not an input
  // -- there is no argument for it, so a built-in cannot be granted a syscall
  // its manifest does not declare.
  if (!manifestPermitsSyscall(installed.manifest, "notify")) {
    return { kind: "refused", reason: "syscall_not_declared" };
  }
  if (!installed.manifest.notificationClasses.includes(payload.notificationClass)) {
    // Declaring `notify` does not grant every kind of notification. The manifest
    // declares classes, and an undeclared class fails closed like anything else
    // outside the manifest.
    return { kind: "refused", reason: "notification_class_not_declared" };
  }

  const conversation = await registry.resolveConversation(serverId, appId, subject.agentId);
  if (conversation.kind === "refused") {
    return { kind: "refused", reason: "no_grant_for_subject" };
  }

  // Hook-bound notifications inherit the OS-minted source event identity.
  // A notification raised outside a hook gets a fresh OS identity here. The
  // app has no event-id argument on this syscall and therefore cannot replace
  // either value with one derived from payload content.
  const invocation = { eventId: currentRapEventId() ?? randomUUID() };
  const outcome = await seam.raise(conversation.conversationId, payload, invocation);
  if (
    (outcome.kind === "l1_raised"
      || outcome.kind === "l2_woke"
      || outcome.kind === "l1_suppressed")
    && outcome.eventId !== invocation.eventId
  ) {
    return { kind: "not_established", reason: "state_not_returned" };
  }
  return outcome;
}

const productionRegistry = { getInstalledApp, resolveConversation: resolveConversationInStore };

/**
 * How far a subject resolution got. `resolved` carries ONLY the conversation
 * UUID: the app never learns the server, app, or owner components it was built
 * from, so it cannot reconstruct a target it was not granted.
 *
 * The refusal set is derived by EXCLUSION from `RefusalReason` rather than
 * re-listed, so a new refusal reason cannot silently fail to appear here.
 * `notification_class_not_declared` is excluded because this syscall carries no
 * notification class -- it is unreachable, not merely unused.
 */
export type ResolveConversationOutcome =
  | { kind: "resolved"; conversationId: string }
  | { kind: "refused"; reason: Exclude<RefusalReason, "notification_class_not_declared"> };

async function resolveConversationWithRegistry(
  registry: Pick<RapRegistryReader, "getInstalledApp" | "resolveConversation">,
  serverId: string,
  appId: AppId,
  subject: Subject,
): Promise<ResolveConversationOutcome> {
  const installed = await registry.getInstalledApp(serverId, appId);
  if (!installed) return { kind: "refused", reason: "not_installed" };

  // The check the store primitive does NOT do, and the whole reason this
  // wrapper exists. §2 Q3: the manifest is the whole answer, so an app that
  // never declared `resolveConversation` cannot resolve a subject even when a
  // grant for that subject exists.
  if (!manifestPermitsSyscall(installed.manifest, "resolveConversation")) {
    return { kind: "refused", reason: "syscall_not_declared" };
  }

  const resolution = await registry.resolveConversation(serverId, appId, subject.agentId);
  if (resolution.kind === "refused") {
    // The store separates `not_installed` from `no_grant_for_subject`, but
    // installation was already established above; anything left is a grant
    // failure. Collapsing it here keeps the app from distinguishing "no such
    // agent" from "agent exists but not granted" -- that difference is an
    // existence oracle over subjects the app was never granted.
    return { kind: "refused", reason: "no_grant_for_subject" };
  }
  return { kind: "resolved", conversationId: resolution.conversationId };
}

/**
 * §3 `resolveConversation`. Subject-addressed only: the parameter is a
 * `Subject`, so there is no channel, thread, or raw target an app could name
 * (§2 Q1). Refusal is a RESULT, never an exception.
 */
export async function resolveConversation(
  serverId: string,
  appId: AppId,
  subject: Subject,
): Promise<ResolveConversationOutcome> {
  return resolveConversationWithRegistry(productionRegistry, serverId, appId, subject);
}

/** Test-only `resolveConversation` against an explicit-grant catalog. */
export function createResolveConversationForTests(
  registry: Pick<RapRegistryReader, "getInstalledApp" | "resolveConversation">,
): typeof resolveConversation {
  return (serverId, appId, subject) =>
    resolveConversationWithRegistry(registry, serverId, appId, subject);
}

export async function notify(
  serverId: string,
  appId: AppId,
  subject: Subject,
  payload: NotificationPayload,
  seam: DeliverySeam,
): Promise<NotifyOutcome> {
  return notifyWithRegistry(productionRegistry, serverId, appId, subject, payload, seam);
}

async function authorizeTimerSyscall(
  registry: Pick<RapRegistryReader, "getInstalledApp" | "resolveConversation">,
  serverId: string,
  appId: AppId,
  subject: Subject,
  syscall: "schedule" | "cancel",
): Promise<RefusalReason | null> {
  const installed = await registry.getInstalledApp(serverId, appId);
  if (!installed) return "not_installed";
  if (!manifestPermitsSyscall(installed.manifest, syscall)) return "syscall_not_declared";
  const conversation = await registry.resolveConversation(serverId, appId, subject.agentId);
  return conversation.kind === "refused" ? "no_grant_for_subject" : null;
}

async function scheduleWithRegistry(
  registry: Pick<RapRegistryReader, "getInstalledApp" | "resolveConversation">,
  serverId: string,
  appId: AppId,
  subject: Subject,
  spec: ScheduleSpec,
  seam: RapTimerSeam,
): Promise<ScheduleOutcome> {
  const refusal = await authorizeTimerSyscall(registry, serverId, appId, subject, "schedule");
  if (refusal) return { kind: "refused", reason: refusal };
  const receipt = await seam.schedule({
    serverId,
    appId,
    subjectAgentId: subject.agentId,
    ...spec,
  });
  return { kind: "scheduled", ...receipt };
}

async function cancelWithRegistry(
  registry: Pick<RapRegistryReader, "getInstalledApp" | "resolveConversation">,
  serverId: string,
  appId: AppId,
  subject: Subject,
  sourceId: string,
  seam: RapTimerSeam,
): Promise<CancelOutcome> {
  const refusal = await authorizeTimerSyscall(registry, serverId, appId, subject, "cancel");
  if (refusal) return { kind: "refused", reason: refusal };
  const result = await seam.cancel({
    serverId,
    appId,
    subjectAgentId: subject.agentId,
    sourceId,
  });
  return { kind: result };
}

export async function schedule(
  serverId: string,
  appId: AppId,
  subject: Subject,
  spec: ScheduleSpec,
  seam: RapTimerSeam = productionRapTimerSeam,
): Promise<ScheduleOutcome> {
  return scheduleWithRegistry(productionRegistry, serverId, appId, subject, spec, seam);
}

export async function cancel(
  serverId: string,
  appId: AppId,
  subject: Subject,
  sourceId: string,
  seam: RapTimerSeam = productionRapTimerSeam,
): Promise<CancelOutcome> {
  return cancelWithRegistry(productionRegistry, serverId, appId, subject, sourceId, seam);
}

/**
 * Test-only seam for the explicit-grant catalog. The production syscall keeps
 * its §3 signature and is permanently bound to the built-in registry above.
 */
export function createNotifyForTests(
  registry: Pick<RapRegistryReader, "getInstalledApp" | "resolveConversation">,
): typeof notify {
  return (serverId, appId, subject, payload, seam) =>
    notifyWithRegistry(registry, serverId, appId, subject, payload, seam);
}

/** Test-only timer syscalls against an explicit-grant catalog. */
export function createRapTimersForTests(
  registry: Pick<RapRegistryReader, "getInstalledApp" | "resolveConversation">,
): {
  schedule: typeof schedule;
  cancel: typeof cancel;
} {
  return {
    schedule: (serverId, appId, subject, spec, seam = productionRapTimerSeam) =>
      scheduleWithRegistry(registry, serverId, appId, subject, spec, seam),
    cancel: (serverId, appId, subject, sourceId, seam = productionRapTimerSeam) =>
      cancelWithRegistry(registry, serverId, appId, subject, sourceId, seam),
  };
}
