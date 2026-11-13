// Task operations. `claimTasks` is the claim-before-work step: it returns per
// task whether the agent may work on it, never throws for a refusal (a failed
// claim is a concurrency lock, not a tool error), and surfaces a freshness
// hold as an `interrupted` outcome (interrupt.ts): the resume is the identical
// command, and there is nothing to cancel.

import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient } from "../agentApiClient";
import type {
  AgentApiTaskAmendSuccessResponse,
  AgentApiTaskClaimResult,
  AgentApiTaskAssignSuccessResponse,
  AgentApiTaskCreateSuccessResponse,
  AgentApiTaskUnclaimSuccessResponse,
  AgentApiTaskWriteUnseen,
  AgentApiTaskEnvelope,
  AgentApiTaskHistoryResponse,
  AgentApiTaskListResponse,
} from "../agentApiContract";
import {
  agentTaskThreadTarget,
  formatAgentClaimResults,
  formatAgentMyTaskList,
  formatAgentTaskAmended,
  formatAgentTaskAssigned,
  formatAgentTaskConverted,
  formatAgentTaskDeleted,
  formatAgentTaskHistory,
  formatAgentTaskList,
  formatAgentTaskShow,
  formatAgentTasksCreated,
  formatAgentTaskStatusUpdated,
  formatAgentTaskUnclaimed,
  type AgentClaimResult,
} from "../agentText/tasks";
import type { AgentApiHeldFreshnessResponse } from "../agentApiMessageContract";
import { formatAgentTaskWriteUnseen, renderAgentHold } from "../agentText/hold";
import { formatAgentTaskRef } from "../agentText/taskRef";
import { heldNextStep, taskClaimArgv, taskUpdateArgv, unreadMessagesInterrupt, type RaftInterrupt, type RaftInterrupted } from "./interrupt";
import { formatHint, hintStep, RAFT_HINTS, type RaftHintOptions, type RaftHintStyle } from "./hint";
import { isHeldResponse } from "./messages";
import { AGENT_GATED_WRITES, agentWriteLandingTarget, type AgentGatedTaskWriteAction, type AgentWriteLanding } from "../agentWriteLanding";
import type { SeenFrontier } from "./frontier";
import { failureFromClientResult, failureOutcome, keyedWriteFailure, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";
import { TASK_CREATE_STATUSES, type TaskCreateStatus } from "../taskCreateStatus";

const taskChannelSchema = lazySchema("taskChannelSchema", () => z.string().describe("The channel the task board belongs to, for example `#proj-sdk`."));
const taskNumberSchema = lazySchema("taskNumberSchema", () => z.number().int().positive().describe("The task number on that channel's board."));
const raftTaskStatusSchema = lazySchema("raftTaskStatusSchema", () => z.enum(["backlog", "todo", "in_progress", "in_review", "done", "closed"]));
// Mirrors `TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU` from the shared root index;
// declared here so this module does not pull the whole shared package into
// SDK bundles. `agentOps.test.ts` pins the two literals to each other.
const TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU = "already claimed by you";


export interface ClaimTasksRequest {
  /** Channel target the tasks live in, for example `#proj-sdk`. */
  target: string;
  taskNumbers?: number[];
  /** Full or short message ids of top-level messages to claim as tasks. */
  messageIds?: string[];
}

export const claimTasksRequestSchema = lazySchema("claimTasksRequestSchema", () => requestSchema<ClaimTasksRequest>()(z.object({
  target: taskChannelSchema,
  taskNumbers: z.array(z.number().int().positive()).optional().describe("Task numbers to claim."),
  messageIds: z.array(z.string()).optional().describe("Full or short ids of top-level messages to claim as tasks."),
})));

export type RaftClaimRowState = "claimed" | "already_yours" | "conflict" | "refused";

export interface RaftClaimRow {
  ref: string;
  taskNumber: number | null;
  messageId: string | null;
  state: RaftClaimRowState;
  /** May the agent work on this task now? True for `claimed` and `already_yours`. */
  mayWork: boolean;
  reason: string | null;
  holder: { type: "user" | "agent"; name: string | null } | null;
  conflict: AgentApiTaskClaimResult["conflict"] | null;
  /** The Server's row, as the CLI formatter reads it. */
  raw: AgentClaimResult;
}

export interface RaftClaimResult {
  target: string;
  rows: RaftClaimRow[];
  /** At least one row authorises work. */
  anyAuthorised: boolean;
}

export type ClaimTasksOutcome =
  | RaftOutcome<RaftClaimResult, "claimed" | "partial" | "refused">
  | RaftInterrupted;

/**
 * What a task write tells the Server its model context has seen of the
 * conversation the write's result lands in (agentWriteLanding.ts), as a send
 * does: the Server holds the write when that conversation has newer messages.
 * Nothing seen yet in this context attests nothing, and an unattested write is
 * not held.
 */
function taskAttestation(
  action: AgentGatedTaskWriteAction,
  body: Record<string, unknown>,
  frontier: SeenFrontier | undefined,
): { seenFor?: AgentWriteLanding; seenUpToSeq?: number; seenExactSeqs?: number[] } {
  const landing = frontier ? agentWriteLandingTarget(action, body) : undefined;
  if (!frontier || !landing) return {};
  const seen = frontier.attestation(landing);
  if (seen.seenUpToSeq === undefined && seen.seenExactSeqs.length === 0) return {};
  return {
    seenFor: AGENT_GATED_WRITES[action].landing,
    ...(seen.seenUpToSeq === undefined ? {} : { seenUpToSeq: seen.seenUpToSeq }),
    ...(seen.seenExactSeqs.length > 0 ? { seenExactSeqs: seen.seenExactSeqs.slice(0, 2_500) } : {}),
  };
}

/** A task write's result text, then any unseen messages attached to it (agentWriteLanding.ts `attach`). */
function withAttachedUnseen(text: string, unseen: AgentApiTaskWriteUnseen | undefined, style: RaftHintStyle = "cli"): string {
  const attached = formatAgentTaskWriteUnseen(unseen, style);
  return attached ? `${text.trimEnd()}\n\n${attached}` : text;
}

/** Where a held task write's context comes from: its landing, else the board. */
function heldTaskTarget(action: AgentGatedTaskWriteAction, body: Record<string, unknown>): string {
  return agentWriteLandingTarget(action, body) ?? String(body.channel);
}

/**
 * A held task call: the interrupt whose resume is the identical command, with
 * no cancel (a held task call saved nothing). `context` is the held text the
 * CLI prints (`formatAgentHold`). It carries the call's context, so
 * `frontier.recordHeld(interrupt)` books under it on any view.
 */
function heldTaskInterrupt(target: string, data: AgentApiHeldFreshnessResponse, action: string, after: string, argv: string[], style: RaftHintStyle, frontier: SeenFrontier | undefined): { interrupt: RaftInterrupt; pointsToRead: boolean } {
  const interrupt = unreadMessagesInterrupt({ target, hold: data, context: "", resume: { argv }, hints: style });
  const held = renderAgentHold(target, data, { heldAction: action, draftInstructions: `${after}\n`, isolationInstructions: `${action} ${after}\n` }, style);
  return {
    interrupt: {
      ...interrupt,
      context: held.text.trimEnd(),
      ...(frontier?.contextId ? { contextId: frontier.contextId } : {}),
    },
    pointsToRead: held.pointsToRead,
  };
}

/** A held task call's next step: read only when the held text leaves something out, then resume. */
function heldTaskNext(kind: string, interrupt: RaftInterrupt, pointsToRead: boolean, resume: string, style: RaftHintStyle): RaftNextStep {
  return heldNextStep(kind, interrupt, pointsToRead, {
    read: `Unread messages in this channel may change the task and interrupt.context does not show all of them in full; read them (frontier.recordHeld(interrupt) once the model saw them), then ${resume} if it is still right.`,
    shown: `Unread messages in this channel may change the task; interrupt.context shows them. Show it to the model, call frontier.recordHeld(interrupt), then ${resume} if it is still right.`,
  }, style);
}

function rowState(result: AgentApiTaskClaimResult): RaftClaimRowState {
  if (result.success) return "claimed";
  if (result.reason === TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU) return "already_yours";
  if (result.conflict?.kind === "claim_conflict") return "conflict";
  return "refused";
}

function claimNext(claim: RaftClaimResult, style: RaftHintStyle): RaftNextStep | null {
  const first = claim.rows.find((row) => row.mayWork);
  if (first) {
    // Task v2: the task is discussed in its own conversation, by its ref.
    const taskRef = typeof first.raw.taskRef === "string" ? first.raw.taskRef : null;
    if (taskRef) {
      return hintStep("start_work", RAFT_HINTS.taskReply(taskRef), "The claim is yours; post progress in the task's conversation.", style);
    }
    const thread = first.messageId ? agentTaskThreadTarget(claim.target, first.messageId) : null;
    const why = "The claim is yours; post progress in the task's thread.";
    return thread
      ? hintStep("start_work", RAFT_HINTS.messageSend({ target: thread }), why, style, { target: thread })
      : { kind: "start_work", why };
  }
  return {
    kind: "do_not_start",
    why: "No claim authorised work. Do not retry the identical claim and do not start conflicting execution; if you own this lane, correct the routing in the original thread.",
  };
}

function claimText(claim: RaftClaimResult, style: RaftHintStyle): string {
  return formatAgentClaimResults(claim.target, { results: claim.rows.map((row) => row.raw) }, style);
}

export async function claimTasks(
  client: Pick<AgentApiClient, "tasks">,
  request: ClaimTasksRequest,
  frontier?: SeenFrontier,
  options: RaftHintOptions = {},
): Promise<ClaimTasksOutcome> {
  const style = options.hints ?? "cli";
  const numbers = (request.taskNumbers ?? []).filter((n) => Number.isInteger(n) && n > 0);
  const ids = (request.messageIds ?? []).map((id) => id.trim()).filter(Boolean);
  const invalid = validateOpRequest(claimTasksRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A channel target is required to claim tasks." }));
  if (numbers.length === 0 && ids.length === 0) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Pass at least one task number or message id to claim." }));
  }
  const body = {
    channel: request.target,
    ...(numbers.length ? { task_numbers: numbers } : {}),
    ...(ids.length ? { message_ids: ids } : {}),
  };
  const result = await client.tasks.claim({ ...body, ...taskAttestation("task_claim", body, frontier) });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  if (isHeldResponse(data)) {
    // A claim saves nothing: resuming is the identical claim, and there is nothing to cancel.
    const { interrupt, pointsToRead } = heldTaskInterrupt(
      heldTaskTarget("task_claim", body),
      data,
      "Your task claim was not applied.",
      "After reviewing, rerun the claim if it is still correct.",
      taskClaimArgv(request.target, numbers, ids),
      style,
      frontier,
    );
    return {
      ok: true,
      state: "interrupted",
      interrupt,
      next: heldTaskNext("retry_claim", interrupt, pointsToRead, "resume the claim (interrupt.resume)", style),
      text: interrupt.context,
    };
  }
  const rows: RaftClaimRow[] = (data.results ?? []).map((row) => {
    const state = rowState(row);
    return {
      ref: row.taskNumber ? String(row.taskNumber) : row.messageId ?? "?",
      taskNumber: row.taskNumber ?? null,
      messageId: row.messageId ?? null,
      state,
      mayWork: state === "claimed" || state === "already_yours",
      reason: row.reason ?? null,
      holder: row.conflict?.currentAssignee ?? null,
      conflict: row.conflict ?? null,
      raw: row as AgentClaimResult,
    };
  });
  const claim: RaftClaimResult = { target: request.target, rows, anyAuthorised: rows.some((row) => row.mayWork) };
  const state = !claim.anyAuthorised ? "refused" : rows.every((row) => row.mayWork) ? "claimed" : "partial";
  return { ok: true, state, data: claim, next: claimNext(claim, style), text: claimText(claim, style) };
}

// ── the rest of the task family ──────────────────────────────────────────

export type RaftTaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed";

export interface ListTasksRequest {
  /** Channel board, for example `#proj-sdk`; omit with `mine: true` for your own tasks across channels. */
  target?: string;
  mine?: boolean;
  status?: RaftTaskStatus | "all";
}

export const listTasksRequestSchema = lazySchema("listTasksRequestSchema", () => requestSchema<ListTasksRequest>()(z.object({
  target: z.string().optional().describe("A channel's board, for example `#proj-sdk`. Pass exactly one of target or mine."),
  mine: z.boolean().optional().describe("true: your own tasks across channels instead of one board."),
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "closed", "all"]).optional().describe("Filter by status; all includes backlog, done and closed."),
})));

export interface RaftTaskBoard {
  scope: "channel" | "mine";
  target: string | null;
  tasks: AgentApiTaskListResponse["tasks"];
  coverage: AgentApiTaskListResponse["coverage"] | null;
  /** The server's assertion about this response; absent on servers that make none. */
  pagination?: AgentApiTaskListResponse["pagination"];
}

export async function listTasks(
  client: Pick<AgentApiClient, "tasks">,
  request: ListTasksRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftTaskBoard, "board" | "empty">> {
  const invalid = validateOpRequest(listTasksRequestSchema, request); if (invalid) return invalid;
  const mine = request.mine === true;
  if (mine === Boolean(request.target?.trim())) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Pass exactly one of a channel target or mine: true." }));
  }
  const result = await client.tasks.list({
    ...(mine ? { mine: "true" as const } : { channel: request.target! }),
    ...(request.status ? { status: request.status } : {}),
  });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  const scope = mine ? "mine" : "channel";
  const board: RaftTaskBoard = {
    scope,
    target: mine ? null : request.target!,
    tasks: data.tasks,
    coverage: data.coverage ?? null,
    ...(data.scope === scope && data.pagination ? { pagination: data.pagination } : {}),
  };
  const text = mine ? formatAgentMyTaskList(data, request.status) : formatAgentTaskList(request.target!, data, request.status);
  const open = board.tasks.find((t) => t.status === "todo" && !t.claimedByName);
  const next: RaftNextStep | null = open?.taskNumber && board.target
    ? hintStep(
      "claim_task",
      RAFT_HINTS.taskClaim({ target: board.target, taskNumber: open.taskNumber }),
      "An unassigned todo task is open; claim it before working on it.",
      options.hints,
      { target: board.target, taskNumbers: [open.taskNumber] },
    )
    : null;
  return { ok: true, state: board.tasks.length > 0 ? "board" : "empty", data: board, next, text };
}

export interface CreateTasksRequest {
  target: string;
  /**
   * The task's source: the id (full or 8-char short) of the channel message
   * that asked for this work. Every task in the request hangs under it; sent
   * only when given. Servers with task conversations require it (a create
   * without one is refused, `task_source_required`); servers without them
   * refuse it (`task_v2_not_enabled`). A reply in one of the channel's threads
   * resolves to that thread's root message (`data.tasks[].sourceThreadReplyId`
   * then names the reply given). For work you thought of yourself, first post
   * a message in the channel saying what and why, then create from it.
   */
  sourceMessageId?: string;
  tasks: Array<{ title: string; createsResource?: boolean }>;
  /** `@handle`; yourself to start in_progress, or (owner/admin) someone else to reserve a todo. */
  assignee?: string;
  /**
   * The status every task starts in: `todo` or `in_progress`. Omitted:
   * assigning yourself starts the work, anything else is todo. `in_progress`
   * with an `assignee` starts it for them (without one it is unassigned);
   * `todo` with yourself reserves it for later.
   */
  status?: TaskCreateStatus;
  /**
   * One key per logical create. Generated with `crypto.randomUUID()` when
   * omitted and returned as `data.idempotencyKey` (and, on a retryable
   * failure, as `next.args.idempotencyKey`). Repeating the same request with
   * the same key returns the first result (same task numbers) and creates
   * nothing; the same key with a different request fails with
   * `IDEMPOTENCY_KEY_REUSED`. A key is valid for 24 hours: retry within that
   * window; after it the Server forgets the key and the same request creates
   * again. The SDK never retries on its own: Servers
   * without keyed task create ignore the key, and a repeat there creates the
   * tasks again.
   */
  idempotencyKey?: string;
}

export const createTasksRequestSchema = lazySchema("createTasksRequestSchema", () => requestSchema<CreateTasksRequest>()(z.object({
  target: taskChannelSchema,
  sourceMessageId: z.string().optional().describe("The task's source: the id (full or 8-char short) of the channel message that asked for this work. Required by servers with task conversations; refused by servers without them. A reply in one of the channel's threads resolves to that thread's root message. For work you thought of yourself, first post a message in the channel saying what and why, then create from it."),
  tasks: z.array(z.object({
    title: z.string().describe("Task title."),
    createsResource: z.boolean().optional().describe("The task produces a resource (for example a document) that needs a receipt."),
  })).describe("One entry per task to create."),
  assignee: z.string().optional().describe("`@handle`: yourself to start in_progress, or (owner/admin) someone else to reserve a todo."),
  status: z.enum(TASK_CREATE_STATUSES).optional().describe("The status every task starts in. Omitted: assigning yourself starts the work, anything else is todo. in_progress with an assignee starts it for them; todo with yourself as assignee reserves it without starting; backlog parks it (needs task conversations on the server)."),
  idempotencyKey: z.string().optional().describe("One key per logical create; generated when omitted and returned. Repeat the same request with the same key within 24 hours to retry without creating the tasks twice."),
})));

export type RaftTasksCreated = AgentApiTaskCreateSuccessResponse & {
  target: string;
  /** The key this create was sent with (the caller's, or the generated one). */
  idempotencyKey: string;
};

export async function createTasks(
  client: Pick<AgentApiClient, "tasks">,
  request: CreateTasksRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftTasksCreated, "created">> {
  const invalid = validateOpRequest(createTasksRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.trim() || !request.tasks?.length) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A channel target and at least one task title are required." }));
  }
  // The Server decides whether a source is required (task conversations on)
  // or refused (off); an empty one is no source.
  const sourceMessageId = request.sourceMessageId?.trim() || undefined;
  const idempotencyKey = request.idempotencyKey?.trim() || globalThis.crypto.randomUUID();
  const result = await client.tasks.create({
    channel: request.target,
    tasks: request.tasks.map((t) => ({
      title: t.title,
      ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
      ...(t.createsResource ? { creates_resource: true } : {}),
    })),
    ...(request.assignee ? { assignee: request.assignee } : {}),
    ...(request.status ? { status: request.status } : {}),
    idempotencyKey,
  });
  if (!result.ok) return keyedWriteFailure(failureFromClientResult(result), idempotencyKey);
  // Never held: this create attests nothing seen, and only an attested create is checked.
  const data = result.data as AgentApiTaskCreateSuccessResponse;
  const first = data.tasks[0];
  return {
    ok: true,
    state: "created",
    data: { ...data, target: request.target, idempotencyKey },
    next: first
      ? first.conversationAnchored
        ? taskConversationStep(request.target, first.taskNumber, options.hints)
        : taskThreadStep(request.target, first.messageId, "Follow up in each task's thread.", options.hints)
      : null,
    text: formatAgentTasksCreated(request.target, data, options.hints),
  };
}

/** Task v2: reply in the task's own conversation, by its ref (CLI only: no operation yet). */
function taskConversationStep(target: string, taskNumber: number, style: RaftHintStyle = "cli"): RaftNextStep | null {
  const ref = formatAgentTaskRef(target, taskNumber);
  return ref ? hintStep("post_in_task_conversation", RAFT_HINTS.taskReply(ref), "Follow up in each task's own conversation.", style) : null;
}

/** Post in a task's thread (a send: `content` is the caller's). */
function taskThreadStep(target: string, messageId: string, why: string, style: RaftHintStyle = "cli"): RaftNextStep {
  const thread = agentTaskThreadTarget(target, messageId);
  return hintStep("post_in_task_thread", RAFT_HINTS.messageSend({ target: thread }), why, style, { target: thread });
}

export interface TaskRef {
  target: string;
  taskNumber: number;
}

const taskRefFields = { target: taskChannelSchema, taskNumber: taskNumberSchema };

export const taskRefSchema = lazySchema("taskRefSchema", () => requestSchema<TaskRef>()(z.object(taskRefFields)));

function requireTaskRef(request: TaskRef, schema: z.ZodType = taskRefSchema) {
  const invalid = validateOpRequest(schema, request); if (invalid) return invalid;
  if (!request.target?.trim() || !Number.isInteger(request.taskNumber) || request.taskNumber <= 0) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A channel target and a positive task number are required." }));
  }
  return null;
}

export async function unclaimTask(client: Pick<AgentApiClient, "tasks">, request: TaskRef): Promise<RaftOutcome<TaskRef, "unclaimed">> {
  const invalid = requireTaskRef(request); if (invalid) return invalid;
  const result = await client.tasks.unclaim({ channel: request.target, task_number: request.taskNumber });
  if (!result.ok) return failureFromClientResult(result);
  // Never held: this release attests nothing seen, and only an attested write is checked.
  const data = result.data as AgentApiTaskUnclaimSuccessResponse;
  return { ok: true, state: "unclaimed", data: request, next: null, text: withAttachedUnseen(formatAgentTaskUnclaimed(request.taskNumber, data.taskRef), data.unseen) };
}

export interface AssignTaskRequest extends TaskRef {
  /** `@handle` to assign. Required: clearing is the explicit `tasks.unassign`, never an omitted argument. */
  assignee: string;
  /** Optimistic-concurrency token from a task you just read; lose rather than clobber. */
  expectedRevision?: number;
  /**
   * Handing it to someone else: one line on what it waits on them for. They
   * see it in their notification and in the task (`checkTaskAssignReason`).
   * Required when the assignee is someone other than you.
   */
  reason?: string;
}

export const assignTaskRequestSchema = lazySchema("assignTaskRequestSchema", () => requestSchema<AssignTaskRequest>()(z.object({
  ...taskRefFields,
  // Required: an omitted argument is an error, never a silent clear (Tenny, 2026-10-04). Clear with tasks.unassign.
  assignee: z.string().trim().min(1).describe("`@handle` to assign (yourself, or someone else if you are an owner/admin). To clear an assignment use tasks.unassign."),
  expectedRevision: z.number().int().nonnegative().optional().describe("Revision of the task you just read; the change is refused if it moved."),
  reason: z.string().optional().describe("Handing it to someone else (required then): one line on what it waits on them for. They see it in their notification and in the task, so no separate message is needed."),
})));

export async function assignTask(
  client: Pick<AgentApiClient, "tasks">,
  request: AssignTaskRequest,
): Promise<RaftOutcome<{ target: string; taskNumber: number; assignee: string | null; revision: number }, "assigned" | "unassigned">> {
  const invalid = requireTaskRef(request, assignTaskRequestSchema); if (invalid) return invalid;
  const result = await client.tasks.assign({
    channel: request.target,
    task_number: request.taskNumber,
    assignee: request.assignee,
    ...(request.expectedRevision === undefined ? {} : { expected_revision: request.expectedRevision }),
    // Always sent (empty when none was given): the server then holds an agent
    // handing the task to someone else to give one, as it does the CLI.
    reason: request.reason ?? "",
  });
  if (!result.ok) return failureFromClientResult(result);
  // Never held: this assignment attests nothing seen, and only an attested write is checked.
  const data = result.data as AgentApiTaskAssignSuccessResponse;
  const assignee = data.assignee;
  return {
    ok: true,
    state: assignee ? "assigned" : "unassigned",
    data: { target: request.target, taskNumber: request.taskNumber, assignee, revision: data.revision },
    next: null,
    text: formatAgentTaskAssigned(request.taskNumber, assignee, data.taskRef),
  };
}

export interface UnassignTaskRequest extends TaskRef {
  /** Optimistic-concurrency token from a task you just read; lose rather than clobber. */
  expectedRevision?: number;
}

export const unassignTaskRequestSchema = lazySchema("unassignTaskRequestSchema", () => requestSchema<UnassignTaskRequest>()(z.object({
  ...taskRefFields,
  expectedRevision: z.number().int().nonnegative().optional().describe("Revision of the task you just read; the change is refused if it moved."),
})));

/** Clear a task's assignee (the CLI's `raft task unassign`): the explicit way to clear, never an omitted `assignee`. */
export async function unassignTask(
  client: Pick<AgentApiClient, "tasks">,
  request: UnassignTaskRequest,
): Promise<RaftOutcome<{ target: string; taskNumber: number; assignee: null; revision: number }, "unassigned">> {
  const invalid = requireTaskRef(request, unassignTaskRequestSchema); if (invalid) return invalid;
  const result = await client.tasks.assign({
    channel: request.target,
    task_number: request.taskNumber,
    assignee: null,
    ...(request.expectedRevision === undefined ? {} : { expected_revision: request.expectedRevision }),
  });
  if (!result.ok) return failureFromClientResult(result);
  // Never held: this assignment attests nothing seen, and only an attested write is checked.
  const data = result.data as AgentApiTaskAssignSuccessResponse;
  return {
    ok: true,
    state: "unassigned",
    data: { target: request.target, taskNumber: request.taskNumber, assignee: null, revision: data.revision },
    next: null,
    text: formatAgentTaskAssigned(request.taskNumber, null, data.taskRef),
  };
}

export interface UpdateTaskStatusRequest extends TaskRef {
  status: RaftTaskStatus;
  /** Moving into `backlog`: what would bring it back (optional). Refused with any other status. */
  reason?: string;
}

export const updateTaskStatusRequestSchema = lazySchema("updateTaskStatusRequestSchema", () => requestSchema<UpdateTaskStatusRequest>()(z.object({
  ...taskRefFields,
  status: raftTaskStatusSchema.describe("todo → in_progress → done; backlog = not now; closed = won't do. Any status can be set from any other."),
  reason: z.string().optional().describe("With status backlog: what would bring the task back. Optional; refused with any other status."),
})));

export type UpdateTaskStatusOutcome =
  | RaftOutcome<UpdateTaskStatusRequest, "updated">
  | RaftInterrupted;

/** A held task write: the interrupt whose resume is the identical command; nothing to cancel. */
function heldTaskWrite(
  target: string,
  data: AgentApiHeldFreshnessResponse,
  action: string,
  kind: string,
  argv: string[],
  style: RaftHintStyle,
  frontier: SeenFrontier | undefined,
): RaftInterrupted {
  const { interrupt, pointsToRead } = heldTaskInterrupt(target, data, action, "After reviewing, repeat the operation if it is still correct.", argv, style, frontier);
  return {
    ok: true,
    state: "interrupted",
    interrupt,
    next: heldTaskNext(kind, interrupt, pointsToRead, "resume (interrupt.resume)", style),
    text: interrupt.context,
  };
}

export async function updateTaskStatus(
  client: Pick<AgentApiClient, "tasks">,
  request: UpdateTaskStatusRequest,
  frontier?: SeenFrontier,
  options: RaftHintOptions = {},
): Promise<UpdateTaskStatusOutcome> {
  const invalid = requireTaskRef(request, updateTaskStatusRequestSchema); if (invalid) return invalid;
  const body = {
    channel: request.target,
    task_number: request.taskNumber,
    status: request.status,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
  const result = await client.tasks.updateStatus({ ...body, ...taskAttestation("task_update", body, frontier) });
  if (!result.ok) return failureFromClientResult(result);
  if (isHeldResponse(result.data)) {
    return heldTaskWrite(heldTaskTarget("task_update", body), result.data, "The status change was not applied.", "retry_update_status", taskUpdateArgv(request.target, request.taskNumber, request.status, request.reason === undefined ? [] : ["--reason", request.reason]), options.hints ?? "cli", frontier);
  }
  // What the server stored (older servers omit it: the request). A task v2
  // task asked for in_review stores in_progress.
  const stored = result.data.status ?? request.status;
  const done = stored === "in_review";
  return {
    ok: true,
    state: "updated",
    data: request,
    next: done
      ? { kind: "await_review", why: result.data.taskRef ? "in_review is no longer used with task conversations: set done when the work is finished and send the result to the person who asked; if it waits on someone's decision or input, set in_progress and assign it to them." : "A human validates the work; set done after approval." }
      : null,
    text: withAttachedUnseen(formatAgentTaskStatusUpdated(request.taskNumber, stored, result.data.taskRef, options.hints ?? "cli", request.status), result.data.unseen, options.hints ?? "cli"),
  };
}

export interface AmendTaskRequest extends TaskRef {
  title?: string;
  /** New description; `null` clears it. */
  description?: string | null;
}

export const amendTaskRequestSchema = lazySchema("amendTaskRequestSchema", () => requestSchema<AmendTaskRequest>()(z.object({
  ...taskRefFields,
  title: z.string().optional().describe("New title."),
  description: z.string().nullable().optional().describe("New description; null clears it."),
})));

export type AmendTaskOutcome =
  | RaftOutcome<AgentApiTaskAmendSuccessResponse & { target: string }, "amended">
  | RaftInterrupted;

function taskAmendArgv(request: AmendTaskRequest): string[] {
  return [
    "task", "amend", "--target", request.target, "--number", String(request.taskNumber),
    ...(request.title === undefined ? [] : ["--title", request.title]),
    ...(request.description === undefined ? [] : request.description === null ? ["--clear-description"] : ["--description", request.description]),
  ];
}

export async function amendTask(
  client: Pick<AgentApiClient, "tasks">,
  request: AmendTaskRequest,
  frontier?: SeenFrontier,
  options: RaftHintOptions = {},
): Promise<AmendTaskOutcome> {
  const invalid = requireTaskRef(request, amendTaskRequestSchema); if (invalid) return invalid;
  if (request.title === undefined && request.description === undefined) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Pass a new title, a new description, or description: null to clear it." }));
  }
  const body = {
    channel: request.target,
    task_number: request.taskNumber,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.description === undefined ? {} : { description: request.description }),
  };
  const result = await client.tasks.amend({ ...body, ...taskAttestation("task_amend", body, frontier) });
  if (!result.ok) return failureFromClientResult(result);
  if (isHeldResponse(result.data)) {
    return heldTaskWrite(heldTaskTarget("task_amend", body), result.data, "The amendment was not applied.", "retry_amend", taskAmendArgv(request), options.hints ?? "cli", frontier);
  }
  return { ok: true, state: "amended", data: { ...result.data, target: request.target }, next: null, text: withAttachedUnseen(formatAgentTaskAmended(result.data), result.data.unseen) };
}

export async function taskHistory(
  client: Pick<AgentApiClient, "tasks">,
  request: TaskRef,
): Promise<RaftOutcome<AgentApiTaskHistoryResponse & { target: string }, "history">> {
  const invalid = requireTaskRef(request); if (invalid) return invalid;
  const result = await client.tasks.history({ channel: request.target, task_number: request.taskNumber });
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "history", data: { ...result.data, target: request.target }, next: null, text: formatAgentTaskHistory(result.data) };
}

/**
 * `raft task show`: one task's current title and description. Reads the
 * channel's whole board (`status: "all"`, so done and closed tasks are found)
 * and picks the task; a miss says whether the Server asserted the list is
 * complete, exactly as the CLI does.
 */
export async function showTask(
  client: Pick<AgentApiClient, "tasks">,
  request: TaskRef,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<{ target: string; task: AgentApiTaskEnvelope }, "task">> {
  const invalid = requireTaskRef(request); if (invalid) return invalid;
  const { target, taskNumber } = request;
  const result = await client.tasks.list({ channel: target, status: "all" });
  if (!result.ok) return failureFromClientResult(result);
  const tasks = result.data.tasks ?? [];
  const task = tasks.find((candidate) => candidate.taskNumber === taskNumber);
  if (!task) {
    const asserted = result.data.scope === "channel" && result.data.coverage?.status !== "incomplete"
      && result.data.pagination?.mode === "complete" && result.data.pagination.truncated === false;
    const message = asserted
      ? `task #${taskNumber} not found in ${target} (searched ${tasks.length} task(s), status=all; server asserts this list is complete)`
      : tasks.length === 0
        ? `task #${taskNumber} not found in ${target}: the server returned 0 tasks and did not assert the list is complete. That can mean the channel has no tasks, or that the server failed to read them (it currently reports some read errors as an empty list), and this command cannot tell which — so this is not evidence that task #${taskNumber} does not exist`
        : `task #${taskNumber} not found in ${target} (searched ${tasks.length} task(s), status=all; this surface does NOT assert completeness — so this is "absent from what was returned", not "does not exist")`;
    return failureOutcome(opError("NOT_FOUND", {
      message,
      nextAction: `Check the number with \`${formatHint(RAFT_HINTS.taskListAll(target), options.hints)}\`.`,
    }));
  }
  return { ok: true, state: "task", data: { target, task }, next: null, text: formatAgentTaskShow(target, task) };
}

export interface ConvertMessageToTaskRequest {
  target: string;
  messageId: string;
}

export const convertMessageToTaskRequestSchema = lazySchema("convertMessageToTaskRequestSchema", () => requestSchema<ConvertMessageToTaskRequest>()(z.object({
  target: taskChannelSchema,
  messageId: z.string().describe("Full or short id of a top-level message in that channel."),
})));

export async function convertMessageToTask(
  client: Pick<AgentApiClient, "tasks">,
  request: ConvertMessageToTaskRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<{ target: string; task: AgentApiTaskCreateSuccessResponse["tasks"][number] }, "converted">> {
  const invalid = validateOpRequest(convertMessageToTaskRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.trim() || !request.messageId?.trim()) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A channel target and a message id are required." }));
  }
  const result = await client.tasks.convert({ channel: request.target, message_id: request.messageId });
  if (!result.ok) return failureFromClientResult(result);
  const task = result.data.task;
  return {
    ok: true,
    state: "converted",
    data: { target: request.target, task },
    next: taskThreadStep(request.target, task.messageId, "Follow up in the task's thread; it is unassigned until someone claims it.", options.hints),
    text: formatAgentTaskConverted(request.target, task, options.hints),
  };
}

export async function deleteTask(client: Pick<AgentApiClient, "tasks">, request: TaskRef): Promise<RaftOutcome<TaskRef, "deleted">> {
  const invalid = requireTaskRef(request); if (invalid) return invalid;
  const result = await client.tasks.delete({ channel: request.target, task_number: request.taskNumber });
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "deleted", data: request, next: null, text: formatAgentTaskDeleted(request.taskNumber, result.data.taskRef) };
}
