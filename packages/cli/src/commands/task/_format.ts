import { T, UUID_A, UUID_B, sampleTask } from "../_axExampleFixtures";
import { axSurface } from "../../core/renderer";
import type {
  AgentApiTaskFollowingResponse,
  AgentClaimTasksData,
  AgentCreatedTask,
  AgentCreateTasksData,
  AgentTaskAmendData,
  AgentTaskHistoryData,
  AgentTaskListData,
} from "@botiverse/raft-shared";
import {
  formatAgentClaimResults,
  formatAgentFollowedTasks,
  formatAgentMyTaskList,
  formatAgentTaskAmended,
  formatAgentTaskAssigned,
  formatAgentTaskConverted,
  formatAgentTaskDeleted,
  formatAgentTaskHistory,
  formatAgentTaskList,
  formatAgentTaskStatusUpdated,
  formatAgentTaskUnclaimed,
  formatAgentTasksCreated,
} from "@botiverse/raft-shared/src/agentCliSurface";

// Canonical task formatting for agent-facing output. The text lives in
// `@botiverse/raft-shared` (`agentText/tasks.ts`) so the SDK renders the same
// bytes; this file keeps the axSurface registrations and their examples.
// The line format is an AX contract, not an implementation detail.

type TaskListData = AgentTaskListData;
type CreateTasksData = AgentCreateTasksData;
type CreatedTask = AgentCreatedTask;
type ClaimTasksData = AgentClaimTasksData;
type TaskAmendData = AgentTaskAmendData;
type TaskHistoryData = AgentTaskHistoryData;

export const formatTaskList = axSurface(
  "Channel task board listing.",
  (channel: string, data: TaskListData, statusFilter?: string): string => formatAgentTaskList(channel, data, statusFilter),
  {
    examples: [{ title: "channel board", args: ["#general", { tasks: [sampleTask, { ...sampleTask, number: 43, title: "review the other thing", status: "todo", claimedById: null, claimedByName: null, createdByName: "bob", createdByHandle: "bob" }] }] }],
  },
);

export const formatMyTaskList = axSurface(
  "Cross-channel --mine task listing with coverage notes.",
  (data: TaskListData, statusFilter?: string): string => formatAgentMyTaskList(data, statusFilter),
  {
    examples: [{ title: "cross-channel, in_progress filter", args: [{ tasks: [{ ...sampleTask, channelRef: "#general" }, { ...sampleTask, number: 7, title: "review spec", channelRef: "#proj-x", claimedByName: null, claimedById: null }], coverage: { status: "complete", visibleChannelTypes: ["channel", "dm"] } }, "in_progress"] }],
  },
);

export const formatFollowedTasks = axSurface(
  "Task conversations the bound agent follows (raft task list --following), with unread counts and the exact raft task read / unfollow commands.",
  (tasks: AgentApiTaskFollowingResponse["tasks"]): string => formatAgentFollowedTasks(tasks),
  {
    examples: [
      {
        title: "followed task conversations",
        args: [[
          { taskRef: "#proj:#7", taskNumber: 7, title: "hero copy", status: "in_progress", unread: 2, followedAt: T, reason: "assigned" },
          { taskRef: "dm:@alice:#3", taskNumber: 3, title: "pricing table", status: "todo", unread: 0, followedAt: T, reason: "manual" },
        ]],
      },
      { title: "none", args: [[]] },
    ],
  },
);

export const formatTasksCreated = axSurface(
  "Receipt for task create.",
  (channel: string, data: CreateTasksData): string => formatAgentTasksCreated(channel, data),
  {
    examples: [{ args: ["#general", { tasks: [{ taskNumber: 42, messageId: UUID_A, title: "do the thing", status: "todo", claimedByType: null, claimedById: null, claimedAt: null }] }] }],
  },
);

export const formatClaimResults = axSurface(
  "Claim results incl. concurrency-lock guidance on failed claims.",
  (channel: string, data: ClaimTasksData): string => formatAgentClaimResults(channel, data),
  {
    examples: [{ title: "mixed claimed/failed", args: ["#general", { results: [{ taskNumber: 42, success: true, messageId: UUID_A }, { taskNumber: 43, success: false, reason: "already claimed", messageId: UUID_B }] }] }],
  },
);

export const formatTaskUnclaimed = axSurface(
  "Unclaim confirmation.",
  (taskNumber: number, taskRef?: string | null): string => formatAgentTaskUnclaimed(taskNumber, taskRef),
  {
    examples: [{ args: [42] }, { title: "task v2 server (task ref)", args: [42, "#general:#42"] }],
  },
);

export const formatTaskAssigned = axSurface(
  "Assign confirmation.",
  (taskNumber: number, assignee: string | null, taskRef?: string | null): string => formatAgentTaskAssigned(taskNumber, assignee, taskRef),
  {
    examples: [{ title: "assigned", args: [42, "Alice"] }, { title: "unassigned", args: [42, null] }, { title: "task v2 server (task ref)", args: [42, "Alice", "#general:#42"] }],
  },
);

export const formatTaskStatusUpdated = axSurface(
  "Status-change confirmation.",
  (taskNumber: number, status: string, taskRef?: string | null, requestedStatus?: string): string =>
    formatAgentTaskStatusUpdated(taskNumber, status, taskRef, "cli", requestedStatus),
  {
    examples: [
      { args: [42, "in_review"] },
      { title: "task v2 server (task ref)", args: [42, "in_review", "#general:#42"] },
      { title: "task v2 task asked for in_review (stored in_progress)", args: [42, "in_progress", "#general:#42", "in_review"] },
    ],
  },
);

export const formatTaskDeleted = axSurface(
  "Delete confirmation.",
  (taskNumber: number, taskRef?: string | null): string => formatAgentTaskDeleted(taskNumber, taskRef),
  {
    examples: [{ args: [42] }, { title: "task v2 server (task ref)", args: [42, "#general:#42"] }],
  },
);

export const formatTaskConverted = axSurface(
  "Message→task conversion receipt.",
  (channel: string, task: CreatedTask): string => formatAgentTaskConverted(channel, task),
  {
    examples: [{ args: ["#general", { taskNumber: 42, messageId: UUID_A, title: "do the thing", status: "todo", claimedByType: null, claimedById: null, claimedAt: null }] }],
  },
);

export const formatTaskAmended = axSurface(
  "Amend receipt with revision.",
  (data: TaskAmendData): string => formatAgentTaskAmended(data),
  {
    examples: [{ args: [{ task: { taskNumber: 42, title: "do the thing (amended)", description: "narrowed scope", revision: 3 }, event: { seq: 7 } }] }],
  },
);

export const formatTaskHistory = axSurface(
  "Task audit history listing.",
  (data: TaskHistoryData): string => formatAgentTaskHistory(data),
  {
    examples: [{ args: [{ task: { taskNumber: 42, title: "do the thing", description: null, revision: 3 }, events: [{ seq: 1, eventType: "created", actorType: "user", actorName: "richard", payload: {}, createdAt: T }, { seq: 2, eventType: "amended", actorType: "agent", actorName: "Alice", payload: { revision: 2 }, createdAt: T }] }] }],
  },
);
