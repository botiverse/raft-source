import type {
  AgentAppInboxRegistry,
  AgentAppInboxStore,
} from "./agentAppInbox.js";
import type {
  AgentInboxAppItem,
  MachineToServerMessage,
  ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { CLEANER_CONFIG_BOUNDS } from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";
import { REMINDER_FIRE_REQUEST_CAPABILITY } from "@botiverse/raft-shared/src/apps/reminder/protocol.js";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition.js";
import { createReminderRuntime } from "./apps/reminder/runtime.js";
import { receiveCleanerConfigMessage } from "./apps/cleaner/configReceiver.js";
import { createSystemCleanerAppRegistry } from "./apps/cleaner/definition.js";
import {
  SystemCleanerRuntime,
  type CleanerClock,
  type CleanerMeasurement,
  type CleanerTrace,
} from "./apps/cleaner/runtime.js";
import type { Clock } from "./connection.js";
import type { ScopedAppStorageFactory } from "./scopedAppStorage.js";

export const BUILT_IN_READY_CAPABILITIES = [
  REMINDER_FIRE_REQUEST_CAPABILITY,
] as const;

export interface BuiltInLocalAppRuntimeOptions {
  agentsDataDir: string;
  clock?: Clock;
  cleanerClock?: CleanerClock;
  cleanerMeasurementTimeoutMs?: number;
  cleanerMeasureMemoryFile?: (input: {
    ownerAgentId: string;
    literalFileName: "MEMORY.md";
    absolutePath: string;
  }) => Promise<CleanerMeasurement>;
  getInbox(agentId: string): AgentAppInboxStore;
  notifyInbox(agentId: string, item: AgentInboxAppItem): Promise<boolean>;
  send(message: MachineToServerMessage): void;
  trace?: CleanerTrace;
}

// Generic daemon core consumes the built-in local scheduling adapter without
// naming or branching on a particular App. App identity stays in this exempt
// registry manifest and the App-owned implementation directory.
export function createBuiltInLocalScheduleRuntime(options: BuiltInLocalAppRuntimeOptions) {
  const reminder = createReminderRuntime({
    clock: options.clock,
    getInbox: options.getInbox,
    notifyInbox: options.notifyInbox,
    send: options.send,
    trace: options.trace,
  });
  const cleaner = new SystemCleanerRuntime({
    agentsDataDir: options.agentsDataDir,
    clock: options.cleanerClock,
    measurementTimeoutMs: options.cleanerMeasurementTimeoutMs,
    measureMemoryFile: options.cleanerMeasureMemoryFile,
    getInbox: options.getInbox,
    wake: async (agentId: string, item: AgentInboxAppItem) => {
      await options.notifyInbox(agentId, item);
    },
    trace: options.trace,
  });
  const inboxRegistry: AgentAppInboxRegistry = {
    ...REMINDER_AGENT_INBOX_REGISTRY,
    ...createSystemCleanerAppRegistry((ownerAgentId) => {
      const config = cleaner.getAppliedConfig(ownerAgentId);
      return config
        ? {
            thresholdBytes: config.thresholdBytes,
            maximumThresholdBytes: CLEANER_CONFIG_BOUNDS.thresholdBytes.max,
          }
        : null;
    }),
  };

  return {
    inboxRegistry,
    bindScopedStorage(storageFactory: ScopedAppStorageFactory) {
      // This pre-scoped global carrier has no provable Server owner. Keep App
      // identity and migration policy inside the exempt registry boundary.
      storageFactory.quarantineLegacyFile(
        "reminders/mirror.json",
        "system.reminder",
      );
      reminder.bindStorageProvider((agentId) =>
        storageFactory.open({ appId: "system.reminder", agentId })
      );
    },
    start: () => reminder.start(),
    stop() {
      reminder.stop();
      cleaner.clear();
    },
    handleServerMessage(message: ServerToMachineMessage): boolean {
      if (message.type === "app_config.upsert" || message.type === "app_config.snapshot") {
        const result = receiveCleanerConfigMessage(cleaner, message);
        for (const terminal of result.terminals) {
          options.trace?.(
            "daemon.app_config.receive",
            {
              ...terminal.attrs,
              message_type: message.type,
              outcome: terminal.outcome,
              ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
            },
            terminal.status,
          );
        }
        return result.kind !== "ignored";
      }
      return reminder.handleServerMessage(message);
    },
    beforeAck: (agentId: string, item: AgentInboxAppItem) => reminder.beforeAck(agentId, item),
    beforeServerAuthorizedAck: (agentId: string, item: AgentInboxAppItem) =>
      reminder.beforeServerAuthorizedAck(agentId, item),
    replayPendingReceipts: () => reminder.replayPendingReceipts(),
    onConnect: () => reminder.onConnect(),
    requestSnapshot(agentId: string) {
      reminder.requestSnapshot(agentId);
      options.send({ type: "app_config.snapshot.request", agentId });
    },
    requestReminderSnapshotIfUnsynchronized(agentId: string): boolean {
      return reminder.requestSnapshotIfUnsynchronized(agentId);
    },
  };
}
