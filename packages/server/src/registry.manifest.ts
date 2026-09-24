import type { MachineToServerMessage } from "@botiverse/raft-shared";
import type { AgentApiRequestBodyByRoute, AgentApiResponseByRoute } from "@botiverse/raft-shared/src/agentApiContract.js";
import type { AgentOrchestrator } from "./services/agentOrchestrator.js";
import { REMINDER_DUE_NOTIFICATION_CLASS, REMINDER_INBOX_APP_ID } from "./apps/reminder/sourceAck.js";
import { handleLegacyReminderFireAttempt } from "./apps/reminder/legacyFireAttempt.js";
import { handleReminderFireRequest } from "./apps/reminder/fireRequest.js";
import { handleReminderSourceAck } from "./apps/reminder/sourceAck.js";
import {
  createTaskResourceExpiryFollowup,
  getTaskResourceExpiryFollowup,
  publishTaskResourceExpiryFollowup,
} from "./apps/reminder/taskResourceExpiry.js";

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
  trace(
    name: string,
    attrs: Record<string, unknown>,
    status?: "ok" | "error",
  ): void;
  emit(event: string, payload: unknown): void;
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
