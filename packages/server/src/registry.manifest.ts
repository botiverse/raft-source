import type { MachineToServerMessage } from "@botiverse/raft-shared";
import type { AgentApiRequestBodyByRoute, AgentApiResponseByRoute } from "@botiverse/raft-shared/src/agentApiContract";
import type { AgentOrchestrator } from "./services/agentOrchestrator";
import { REMINDER_DUE_NOTIFICATION_CLASS, REMINDER_INBOX_APP_ID } from "./apps/reminder/sourceAck";
import { handleLegacyReminderFireAttempt } from "./apps/reminder/legacyFireAttempt";
import { handleReminderFireRequest } from "./apps/reminder/fireRequest";
import { handleReminderSourceAck } from "./apps/reminder/sourceAck";
import {
  createTaskResourceExpiryFollowup,
  getTaskResourceExpiryFollowup,
  publishTaskResourceExpiryFollowup,
} from "./apps/reminder/taskResourceExpiry";

export const taskResourceExpiryFollowups = {
  create: createTaskResourceExpiryFollowup,
  get: getTaskResourceExpiryFollowup,
};

export { publishTaskResourceExpiryFollowup };

export interface BuiltInMachineMessageAgent {
  id: string;
  serverId: string;
}

export interface BuiltInMachineMessageContext {
  host: AgentOrchestrator;
  machineId: string;
  agent: BuiltInMachineMessageAgent;
  daemonVersion: string | null;
  computerVersion: string | null;
  capabilities: ReadonlySet<string>;
  nowMs: number;
  send(message: import("@botiverse/raft-shared").ServerToMachineMessage): Promise<boolean>;
  /**
   * Set the outcome of the receipt span that wraps this handler. The last call
   * wins. The span ends when the handler returns.
   */
  setReceiptOutcome(
    attrs: Record<string, unknown>,
    status?: "ok" | "error",
  ): void;
  emit(event: string, payload: unknown): void;
  /** The Socket.IO server, for user-scoped side effects (null before it is attached). */
  io: import("socket.io").Server | null;
}

export interface BuiltInMachineMessageDispatch {
  agentId: string;
  handle(context: BuiltInMachineMessageContext): Promise<void>;
}

/**
 * The generic transport resolves app-owned machine messages here. App identity
 * and protocol vocabulary stay in this exempt manifest and app directories.
 */
export function resolveBuiltInMachineMessageDispatch(
  message: MachineToServerMessage,
): BuiltInMachineMessageDispatch | null {
  if (message.type === "reminder.fire_attempt") {
    return {
      agentId: message.agentId,
      handle: (context) => handleLegacyReminderFireAttempt(message, context),
    };
  }
  if (message.type === "reminder.fire_request") {
    return {
      agentId: message.agentId,
      handle: (context) => handleReminderFireRequest(message, context),
    };
  }
  return null;
}

export type BuiltInAppSourceAckInput = AgentApiRequestBodyByRoute["appSourceAck"] & {
  serverId: string;
  actingAgentId: string;
};

export type BuiltInAppSourceAckResult =
  | { ok: true; response: AgentApiResponseByRoute["appSourceAck"] }
  | {
      ok: false;
      status: number;
      body: {
        error: string;
        code: string;
        latestFiredSourceVersion?: number;
      };
    };

export async function ackBuiltInAppSource(
  input: BuiltInAppSourceAckInput,
): Promise<BuiltInAppSourceAckResult> {
  if (input.appId === REMINDER_INBOX_APP_ID && input.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS) {
    return handleReminderSourceAck(input);
  }
  return {
    ok: false,
    status: 404,
    body: {
      error: "No authority handler is registered for this app source",
      code: "app_source_authority_not_registered",
    },
  };
}
