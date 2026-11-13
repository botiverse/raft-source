import { PROVIDER_PROBE_CAPABILITY } from "@botiverse/raft-shared";
import type {
  AgentAppInboxNoticeOptions,
  AgentAppInboxRegistry,
  AgentAppInboxStore,
} from "./agentAppInbox";
import type {
  AgentInboxAppItem,
  MachineToServerMessage,
  ServerToMachineMessage,
  Tracer,
} from "@botiverse/raft-shared";
import { CLEANER_CONFIG_BOUNDS } from "@botiverse/raft-shared/src/apps/cleaner/configProtocol";
import { REMINDER_FIRE_REQUEST_CAPABILITY } from "@botiverse/raft-shared/src/apps/reminder/protocol";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";
import { createReminderRuntime } from "./apps/reminder/runtime";
import { receiveCleanerConfigMessage } from "./apps/cleaner/configReceiver";
import { createSystemCleanerAppRegistry } from "./apps/cleaner/definition";
import {
  SystemCleanerRuntime,
  type CleanerClock,
  type CleanerMeasurement,
  type CleanerProviderQuota,
  type CleanerReminderStateStore,
  type CleanerTrace,
} from "./apps/cleaner/runtime";
import {
  IdleTaskReminderRuntime,
  createIdleTaskReminderAsk,
  type IdleTaskReminderAsk,
} from "./apps/idleTaskReminder/runtime";
import { fetchAgentApiAsAgent } from "./agentCredentialProxy";
import type { AgentIdleNoticeDelivery, AgentIdleNoticeFacts } from "./agentHost/agentLifecycleHost";
import type { Clock } from "./connection";
import type { ScopedAppStorageFactory } from "./scopedAppStorage";

export const BUILT_IN_READY_CAPABILITIES = [
  REMINDER_FIRE_REQUEST_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
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
  /** The agent's provider quota reading (AgentProcessManager.providerQuota.quotaFor). */
  cleanerProviderQuota?: (agentId: string) => CleanerProviderQuota | undefined;
  /** Tests: the Cleaner's reminder state store in place of the per-agent file. */
  cleanerReminderStateStore?: CleanerReminderStateStore;
  /** Raft Computer's own disk use, attached to the cleaner's low-disk decision. */
  cleanerMeasureRaftDiskFootprint?: () => Promise<Readonly<Record<string, unknown>>>;
  getInbox(agentId: string): AgentAppInboxStore;
  notifyInbox(agentId: string, item: AgentInboxAppItem, notice?: AgentAppInboxNoticeOptions): Promise<boolean>;
  send(message: MachineToServerMessage): void;
  /**
   * Idle task reminder: the agent's live session and the idle-only write
   * (AgentLifecycleHost). Without both the reminder is not run.
   */
  idleNoticeFacts?(agentId: string): AgentIdleNoticeFacts | null;
  deliverIdleNotice?(agentId: string, text: string): Promise<AgentIdleNoticeDelivery>;
  /** Tests: the ask in place of the agent-credential request. */
  idleTaskReminderAsk?: IdleTaskReminderAsk;
  trace?: CleanerTrace;
  tracer: Tracer;
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
    tracer: options.tracer,
  });
  // Owners asked once per connection for app config on agent:start.
  const appConfigRequested = new Set<string>();
  const cleaner = new SystemCleanerRuntime({
    agentsDataDir: options.agentsDataDir,
    clock: options.cleanerClock,
    measurementTimeoutMs: options.cleanerMeasurementTimeoutMs,
    measureMemoryFile: options.cleanerMeasureMemoryFile,
    measureRaftDiskFootprint: options.cleanerMeasureRaftDiskFootprint,
    reminderStateStore: options.cleanerReminderStateStore,
    providerQuota: options.cleanerProviderQuota,
    getInbox: options.getInbox,
    // Cleaner hints are advisory: never start a stopped agent for one, and
    // never interrupt a turn that started after the Working → Idle edge.
    // Only the urgent .raftbackupignore reminder interrupts: it is written
    // into a running turn as the busy app Inbox notice.
    wake: async (agentId: string, item: AgentInboxAppItem, wakeOptions?: { interrupt?: boolean }) => {
      await options.notifyInbox(agentId, item, { startStoppedAgent: false, requireIdle: wakeOptions?.interrupt !== true });
    },
    // The idle task reminder goes first at a transition; the Cleaner presents after it.
    beforeIdlePresent: (agentId: string) => idleTaskReminder?.settled(agentId) ?? Promise.resolve(),
    deliveryPending: (agentId: string) => options.idleNoticeFacts?.(agentId)?.deliveriesPending,
    trace: options.trace,
  });
  const { idleNoticeFacts, deliverIdleNotice } = options;
  // Read lazily by the Cleaner's beforeIdlePresent (declared after it).
  const idleTaskReminder: IdleTaskReminderRuntime | null = idleNoticeFacts && deliverIdleNotice
    ? new IdleTaskReminderRuntime({
        ask: options.idleTaskReminderAsk ?? createIdleTaskReminderAsk({ fetchAsAgent: fetchAgentApiAsAgent }),
        agentFacts: (agentId) => idleNoticeFacts(agentId),
        deliver: (agentId, text) => deliverIdleNotice(agentId, text),
        trace: options.trace,
      })
    : null;
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
      idleTaskReminder?.clear();
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
    // Each app on its own: one app's failure never keeps the edge from the
    // other. The idle task reminder starts first; the Cleaner waits for it.
    onAgentWorkingToIdle(agentId: string) {
      try {
        idleTaskReminder?.onAgentWorkingToIdle(agentId);
      } finally {
        cleaner.onAgentWorkingToIdle(agentId);
      }
    },
    /** AgentConfig.migrationReadiness from agent:start or agent:config. */
    noteMigrationReadiness(agentId: string, readiness: unknown) {
      cleaner.noteMigrationReadiness(agentId, readiness);
    },
    /** machine:workspace:delete succeeded: the Cleaner drops the agent's reminder state. */
    onAgentWorkspaceDeleted(agentId: string) {
      cleaner.onAgentWorkspaceDeleted(agentId);
    },
    /** The agent's own provider credential hit a usage limit (ProviderLimitLedger). */
    noteProviderLimitHit(agentId: string) {
      cleaner.noteProviderLimitHit(agentId);
    },
    /** The connected Server advertises SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1. */
    setServerIdleTaskReminderCapable(capable: boolean) {
      idleTaskReminder?.setServerCapable(capable);
    },
    beforeAck: (agentId: string, item: AgentInboxAppItem) => reminder.beforeAck(agentId, item),
    beforeServerAuthorizedAck: (agentId: string, item: AgentInboxAppItem) =>
      reminder.beforeServerAuthorizedAck(agentId, item),
    replayPendingReceipts: () => reminder.replayPendingReceipts(),
    onConnect() {
      appConfigRequested.clear();
      reminder.onConnect();
    },
    requestSnapshot(agentId: string) {
      reminder.requestSnapshot(agentId);
      options.send({ type: "app_config.snapshot.request", agentId });
    },
    requestReminderSnapshotIfUnsynchronized(agentId: string): boolean {
      return reminder.requestSnapshotIfUnsynchronized(agentId);
    },
    /**
     * agent:start fallback for app config, mirroring reminders: an owner that
     * arrived after connect (e.g. by migration) has no applied Cleaner config,
     * so its schedule never arms. Ask once per connection.
     */
    requestAppConfigSnapshotIfMissing(agentId: string): boolean {
      if (cleaner.getAppliedConfig(agentId) !== null || appConfigRequested.has(agentId)) return false;
      appConfigRequested.add(agentId);
      options.send({ type: "app_config.snapshot.request", agentId });
      return true;
    },
  };
}
