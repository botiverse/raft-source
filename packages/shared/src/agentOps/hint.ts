// Hints: the "run this next" pointers in agent-facing text and in an
// outcome's `next`, in one structured form.
//
// A hint is the CLI words after `raft` (exactly as the CLI prints them, quotes
// included) plus, when an operation does the same thing, that operation's
// manifest name and arguments in manifest shape. `formatHint` renders it: the
// CLI form by default (byte-identical to the hand-written strings it
// replaced, so the CLI's pinned output does not move), or, for runtimes that
// call operations as model tools (`createRaft({ hints: "tool" })`), the tool
// call: `messages_read({ target: "#ops" })`.
//
// Every hint in packages/shared/src/agentOps, agentText and agentMessageText
// comes from a builder in `RAFT_HINTS`; hint.test.ts forbids hand-written
// `raft <group> <command>` strings there and pins every builder's CLI form,
// and the SDK checks every builder's arguments against the operation's schema.

import { parseRaftRefTarget } from "../raftRefs";

/** How hints are rendered: `cli` (default) as `raft …` commands, `tool` as operation tool calls. */
export type RaftHintStyle = "cli" | "tool";

/** Options every hint-rendering operation accepts. */
export interface RaftHintOptions {
  hints?: RaftHintStyle;
}

/** The operation a next step maps to: manifest name and arguments in manifest shape. */
export interface RaftNextOperation {
  /** Manifest name (`RAFT_OPERATIONS`), for example `messages.read`. */
  name: string;
  args: Record<string, unknown>;
  /** Some required arguments are left for the caller (for example a message's `content`). */
  partial?: true;
}

export interface RaftHint {
  /** The CLI words after `raft`, as printed (quoted values keep their quotes). */
  cli: readonly string[];
  /** The operation that does the same; absent when no operation does (admin writes left to humans). */
  op?: RaftNextOperation;
  /** Required arguments the caller fills in; the tool form shows them as `name: …`. Present exactly when `op.partial`. */
  fill?: readonly string[];
  /** The operation is a typed method only (binary result, not a model tool); the tool form is a code call. */
  codeOnly?: true;
}

/** `tasks.updateStatus` → `tasks_update_status`: the manifest's tool name for an operation name. */
export function raftToolNameFor(name: string): string {
  return name.replace(/\./g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Tool-form wording for a CLI command that has no operation. */
export const RAFT_NO_TOOL_WORDING = "ask a human via an action card (`actions_prepare`)";

const ELLIPSIS = "…";

function q(value: string): string {
  return `"${value}"`;
}

function hint(cli: readonly string[], op?: { name: string; args: Record<string, unknown> }, fill?: readonly string[]): RaftHint {
  if (!op) return { cli };
  const args = Object.fromEntries(Object.entries(op.args).filter(([, value]) => value !== undefined));
  return fill && fill.length > 0
    ? { cli, op: { name: op.name, args, partial: true }, fill }
    : { cli, op: { name: op.name, args } };
}

function toolArgs(hint: RaftHint): string {
  const parts = Object.entries(hint.op?.args ?? {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  for (const key of hint.fill ?? []) parts.push(`${key}: ${ELLIPSIS}`);
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
}

/** Render a hint: `raft message read --target "#ops"` (cli) or `messages_read({ target: "#ops" })` (tool). */
export function formatHint(hint: RaftHint, style: RaftHintStyle = "cli"): string {
  if (style === "cli") return ["raft", ...hint.cli].join(" ");
  if (!hint.op) return RAFT_NO_TOOL_WORDING;
  if (hint.codeOnly) return `raft.${hint.op.name}(${toolArgs(hint)})`;
  return `${raftToolNameFor(hint.op.name)}(${toolArgs(hint)})`;
}

/** Just the command's name, for prose that lists commands: `raft channel join` (cli) or `channels_join` (tool). */
export function formatHintName(hint: RaftHint, style: RaftHintStyle = "cli"): string {
  if (style === "cli") return ["raft", ...hint.cli].join(" ");
  if (!hint.op) return RAFT_NO_TOOL_WORDING;
  return hint.codeOnly ? `raft.${hint.op.name}` : raftToolNameFor(hint.op.name);
}

/** A flag named in prose: `--limit` (cli) or `limit` (tool, the argument name). */
export function formatHintFlag(flag: string, arg: string, style: RaftHintStyle = "cli"): string {
  return style === "cli" ? `--${flag}` : arg;
}

/**
 * The hint as a next step: `command` is the rendered hint, `operation` the
 * structured call (when there is one). `args` keeps the step's own arguments.
 */
export function hintStep(
  kind: string,
  hint: RaftHint,
  why: string,
  style: RaftHintStyle = "cli",
  args?: Record<string, unknown>,
): { kind: string; command: string; args?: Record<string, unknown>; operation?: RaftNextOperation; why: string } {
  return {
    kind,
    command: formatHint(hint, style),
    ...(args ? { args } : {}),
    ...(hint.op ? { operation: hint.op } : {}),
    why,
  };
}

/** A conversation read window; `around` shows the short id the CLI prints and sends the full id. */
interface MessageReadHint {
  target: string;
  after?: number;
  before?: number;
  around?: { shown: string; id: string };
  /** Read the target's unread (`--unread`); never combined with after/before/around. */
  unread?: true;
  /** The window size the read that printed this hint asked for (`--limit`). */
  limit?: number;
}

/** One shell word: single quotes, as the CLI's search commands print values. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** What every Manual fetch sends: what the user wants to accomplish, and why the Manual is needed now. */
export interface RaftManualContext {
  intent: string;
  reason: string;
}

/** A Manual fetch's intent or reason: double-quoted as the CLI's help prints them, single-quoted when it holds anything a shell reads inside double quotes. */
function manualContextWord(value: string): string {
  return /^[^"\\$`!]*$/.test(value) ? q(value) : shellWord(value);
}

/** An Artifact as a CLI argument: an id, an old name or a `<…>` placeholder bare; anything else (a title) quoted. */
function artifactWord(artifact: string): string {
  return /^(?:<[^<>]*>|[A-Za-z0-9_-]+)$/.test(artifact) ? artifact : shellWord(artifact);
}

/** A local file name as a CLI argument: bare when it is plain (`comment-c_812-1.png`, a `<…>` placeholder), else quoted. */
function fileWord(file: string): string {
  return /^(?:<[^<>]*>|[A-Za-z0-9_][A-Za-z0-9_.-]*)$/.test(file) ? file : shellWord(file);
}

/** A recent text search continued from the server's cursor, with the caller's own query and filters. */
export interface MessageSearchContinueHint {
  query: string;
  target?: string;
  sender?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor: string;
}

/** `#channel:#7` / `dm:@peer:#7` (raftRefs.ts parses; the separator lives there). */
function isTaskRefTarget(target: string): boolean {
  const parsed = parseRaftRefTarget(target);
  return parsed?.kind === "task" && (parsed.channelName !== undefined || parsed.peerName !== undefined);
}

const RAFT_TASK_HINTS = {
  /**
   * Task v2: a task's own conversation, addressed by its ref (`#channel:#7`,
   * `dm:@peer:#7`). CLI only: no SDK operation replies to, reads or follows a
   * task conversation yet.
   */
  taskReply: (ref: string, attachmentId?: string): RaftHint => hint([
    "task", "reply", q(ref),
    ...(attachmentId === undefined ? [] : ["--attachment-id", attachmentId]),
  ]),
  taskRead: ({ ref, after, before, around, unread, limit }: { ref: string; after?: number; before?: number; around?: { shown: string; id: string }; unread?: true; limit?: number }): RaftHint => hint([
    "task", "read", q(ref),
    ...(unread ? ["--unread"] : []),
    ...(after === undefined ? [] : ["--after", String(after)]),
    ...(before === undefined ? [] : ["--before", String(before)]),
    ...(around === undefined ? [] : ["--around", around.shown]),
    ...(limit === undefined ? [] : ["--limit", String(limit)]),
  ]),
  taskView: (ref: string): RaftHint => hint(["task", "view", q(ref)]),
  taskFollow: (ref: string): RaftHint => hint(["task", "follow", q(ref)]),
  taskUnfollow: (ref: string): RaftHint => hint(["task", "unfollow", q(ref)]),
  /** The task reply / read commands by name (prose). */
  taskReplyName: (): RaftHint => hint(["task", "reply"]),
  taskReadName: (): RaftHint => hint(["task", "read"]),
  /** The task status / assign / claim commands by name (prose, e.g. the idle task reminder). */
  taskUpdateName: (): RaftHint => hint(["task", "update"], { name: "tasks.updateStatus", args: {} }, ["target", "taskNumber", "status"]),
  taskAssignName: (): RaftHint => hint(["task", "assign"], { name: "tasks.assign", args: {} }, ["target", "taskNumber", "assignee"]),
  /** The hand-off a refusal asks for (task_assign_reason_required): the same task and assignee, with the reason left to fill. */
  taskAssignWithReason: ({ ref, target, taskNumber, assignee }: { ref: string; target: string; taskNumber: number; assignee: string }): RaftHint => hint(
    ["task", "assign", q(ref), assignee, "--reason", q(ELLIPSIS)],
    { name: "tasks.assign", args: { target, taskNumber, assignee } },
    ["reason"],
  ),
  /** Handing a task to someone with what it waits on them for (the idle task reminder's rule): the reason travels with the assignment. */
  taskHandoff: (): RaftHint => hint(
    ["task", "assign", q("#channel:#N"), "@who", "--reason", q("what you need from them")],
    { name: "tasks.assign", args: {} },
    ["target", "taskNumber", "assignee", "reason"],
  ),
  taskClaimName: (): RaftHint => hint(["task", "claim"], { name: "tasks.claim", args: {} }, ["target", "taskNumbers"]),
  /** A board's tasks (the idle task reminder, naming the boards in prose). */
  taskListName: (): RaftHint => hint(["task", "list", "--target", "<board>"], { name: "tasks.list", args: {} }, ["target"]),
} satisfies Record<string, (...args: never[]) => RaftHint>;

/**
 * Every hint the shared formatters and operations produce. Placeholder
 * arguments (`<name>`, `"…"`) are `fill` keys: the CLI form prints the
 * placeholder, the tool form `name: …`.
 */
export const RAFT_HINTS = {
  // A task ref (`#channel:#7`) is never a message target: the read / send
  // hints for one are the task commands (`raft task read|reply <ref>`).
  messageRead: ({ target, after, before, around, unread, limit }: MessageReadHint): RaftHint => isTaskRefTarget(target)
    ? RAFT_TASK_HINTS.taskRead({ ref: target, after, before, around, unread, limit })
    : hint(
    [
      "message", "read", "--target", q(target),
      ...(unread ? ["--unread"] : []),
      ...(after === undefined ? [] : ["--after", String(after)]),
      ...(before === undefined ? [] : ["--before", String(before)]),
      ...(around === undefined ? [] : ["--around", around.shown]),
      ...(limit === undefined ? [] : ["--limit", String(limit)]),
    ],
    { name: "messages.read", args: { target, after, before, around: around?.id, ...(unread ? { unread } : {}), limit } },
  ),
  /** Continue a recent text search below what the previous page covered. */
  messageSearch: ({ query, target, sender, after, before, limit, cursor }: MessageSearchContinueHint): RaftHint => hint(
    [
      "message", "search", "--query", shellWord(query),
      ...(target === undefined ? [] : ["--target", shellWord(target)]),
      ...(sender === undefined ? [] : ["--sender", shellWord(sender)]),
      ...(after === undefined ? [] : ["--after", shellWord(after)]),
      ...(before === undefined ? [] : ["--before", shellWord(before)]),
      ...(limit === undefined ? [] : ["--limit", String(limit)]),
      "--sort", "recent", "--cursor", shellWord(cursor),
    ],
    { name: "messages.search", args: { query, target, sender, after, before, limit, sort: "recent", cursor } },
  ),
  /** A new text search of messages (first page, relevance), e.g. from an Artifact search that found nothing. */
  messageSearchQuery: ({ query, target }: { query: string; target?: string }): RaftHint => hint(
    ["message", "search", "--query", shellWord(query), ...(target === undefined ? [] : ["--target", shellWord(target)])],
    { name: "messages.search", args: { query, target } },
  ),
  /** Send into a conversation; `content` is always the caller's. Without a target the target is left too. */
  messageSend: ({ target, attachmentId, targetConfirmed }: { target?: string; attachmentId?: string; targetConfirmed?: true }): RaftHint => target !== undefined && isTaskRefTarget(target)
    ? RAFT_TASK_HINTS.taskReply(target, attachmentId)
    : hint(
    [
      "message", "send",
      ...(target === undefined ? [] : ["--target", target.startsWith("<") ? target : q(target)]),
      ...(attachmentId === undefined ? [] : ["--attachment-id", attachmentId]),
      ...(targetConfirmed ? ["--target-confirmed"] : []),
    ],
    { name: "messages.send", args: { target, attachmentIds: attachmentId === undefined ? undefined : [attachmentId], ...(targetConfirmed ? { targetConfirmed } : {}) } },
    target === undefined ? ["target", "content"] : ["content"],
  ),
  /**
   * Send a message whose text is known (an Artifact's link after a push): the CLI form runs as
   * printed, the text given on stdin as a here-string; the tool form carries it as `content`.
   */
  messageSendContent: ({ target, content }: { target: string; content: string }): RaftHint => hint(
    ["message", "send", "--target", q(target), `<<<${shellWord(content)}`],
    { name: "messages.send", args: { target, content } },
  ),
  /**
   * Reply in a conversation, the reply left to the caller: the CLI form gives
   * it on stdin as a here-string placeholder (`<<<'<your reply>'`), the tool
   * form leaves `content` to fill. A task ref is replied to with `task reply`.
   */
  messageReply: ({ target }: { target: string }): RaftHint => isTaskRefTarget(target)
    ? RAFT_TASK_HINTS.taskReply(target)
    : hint(
      ["message", "send", "--target", q(target), `<<<${shellWord("<your reply>")}`],
      { name: "messages.send", args: { target } },
      ["content"],
    ),
  /** The send command's name alone (prose, never a call). */
  messageSendName: (): RaftHint => hint(["message", "send"], { name: "messages.send", args: {} }, ["target", "content"]),
  messageCheck: (): RaftHint => hint(["message", "check"], { name: "inbox.check", args: {} }),
  inboxList: ({ view, before }: { view?: "mentions"; before?: number } = {}): RaftHint => hint(
    [
      "inbox", "check",
      ...(view === undefined ? [] : ["--view", view]),
      ...(before === undefined ? [] : ["--before", String(before)]),
    ],
    { name: "inbox.list", args: { view, before } },
  ),
  /** RFC 081: read one page of one inbox item (SDK `inbox.read`). `cursor` is a reminder's next page. */
  inboxRead: ({ target, cursor }: { target: string; cursor?: string }): RaftHint => hint(
    [
      "inbox", "read", "--target", q(target),
      ...(cursor === undefined ? [] : ["--cursor", cursor]),
    ],
    { name: "inbox.read", args: { target, cursor } },
  ),
  /** RFC 081: dismiss one item, or every item with no activity since `before`, without reading. CLI only. */
  inboxDismiss: ({ target, before }: { target?: string; before?: string } = {}): RaftHint => hint([
    "inbox", "dismiss",
    ...(target === undefined ? [] : ["--target", q(target)]),
    ...(before === undefined ? [] : ["--before", before]),
  ]),
  /** Ack one fired revision of a reminder (RFC 081 reminder items). CLI only. */
  reminderAck: ({ id, revision }: { id: string; revision: string }): RaftHint => hint([
    "reminder", "ack", "--id", id, "--revision", revision,
  ]),
  /** `query: true` is the `<name>` placeholder. */
  serverInfo: ({ view, offset, limit, query, joined, archived }: {
    view?: "full" | "channels" | "agents" | "humans";
    offset?: number;
    limit?: number;
    query?: string | true;
    joined?: boolean;
    /** channels view: list only archived channels. */
    archived?: boolean;
  } = {}): RaftHint => hint(
    [
      "server", "info",
      ...(view === undefined ? [] : [`--${view}`]),
      ...(archived ? ["--archived"] : []),
      ...(offset === undefined ? [] : ["--offset", String(offset)]),
      ...(limit === undefined ? [] : ["--limit", String(limit)]),
      ...(query === undefined ? [] : ["--query", query === true ? "<name>" : JSON.stringify(query)]),
      ...(joined ? ["--joined"] : []),
    ],
    { name: "server.info", args: { view, offset, limit, query: typeof query === "string" ? query : undefined, joined: joined ? true : undefined, archived: archived ? true : undefined } },
    query === true ? ["query"] : undefined,
  ),
  /** `name` undefined is the `<name>` placeholder. */
  userInfo: ({ name, offset, limit }: { name?: string; offset?: number; limit?: number } = {}): RaftHint => hint(
    [
      "user", "info", name === undefined ? "<name>" : `@${name}`,
      ...(offset === undefined ? [] : ["--offset", String(offset)]),
      ...(limit === undefined ? [] : ["--limit", String(limit)]),
    ],
    { name: "users.info", args: { name: name === undefined ? undefined : `@${name}`, offset, limit } },
    name === undefined ? ["name"] : undefined,
  ),
  /** The `<name>` placeholder form. */
  /** One channel's details; without a target the name is left to fill in. */
  channelInfo: (target?: string): RaftHint => target === undefined
    ? hint(["channel", "info", "<name>"], { name: "channels.info", args: {} }, ["target"])
    : hint(["channel", "info", q(target)], { name: "channels.info", args: { target } }),
  channelMembers: (target: string): RaftHint => hint(["channel", "members", q(target)], { name: "channels.members", args: { target } }),
  /** Channel attention commands by name (prose). */
  channelJoinName: (): RaftHint => hint(["channel", "join"], { name: "channels.join", args: {} }, ["target"]),
  channelLeaveName: (): RaftHint => hint(["channel", "leave"], { name: "channels.leave", args: {} }, ["target"]),
  channelMuteName: (): RaftHint => hint(["channel", "mute"], { name: "channels.mute", args: {} }, ["target"]),
  channelUnmuteName: (): RaftHint => hint(["channel", "unmute"], { name: "channels.unmute", args: {} }, ["target"]),
  threadUnfollowName: (): RaftHint => hint(["thread", "unfollow"], { name: "threads.unfollow", args: {} }, ["target"]),
  /** Channel / server admin writes by name (prose). The Server checks the agent's role on each call. */
  channelCreateName: (): RaftHint => hint(["channel", "create"], { name: "channels.create", args: {} }, ["name"]),
  channelUpdateName: (): RaftHint => hint(["channel", "update"], { name: "channels.update", args: {} }, ["target"]),
  /** Make an Artifact homed in the channel its announcement (`<artifact>` left to fill when none is named). */
  channelAnnouncementSet: ({ target, artifact }: { target: string; artifact?: string }): RaftHint => hint(
    ["channel", "update", "--target", q(target), "--announcement", artifact === undefined ? "<artifact>" : artifactWord(artifact)],
    { name: "channels.update", args: { target, announcement: artifact } },
    artifact === undefined ? ["announcement"] : undefined,
  ),
  /** Remove the channel's announcement (the Artifact stays). */
  channelAnnouncementClear: ({ target }: { target: string }): RaftHint => hint(
    ["channel", "update", "--target", q(target), "--no-announcement"],
    { name: "channels.update", args: { target, announcement: null } },
  ),
  channelArchiveName: (): RaftHint => hint(["channel", "archive"], { name: "channels.archive", args: {} }, ["target"]),
  channelUnarchiveName: (): RaftHint => hint(["channel", "unarchive"], { name: "channels.unarchive", args: {} }, ["target"]),
  channelAddMemberName: (): RaftHint => hint(["channel", "add-member"], { name: "channels.addMember", args: {} }, ["target"]),
  channelRemoveMemberName: (): RaftHint => hint(["channel", "remove-member"], { name: "channels.removeMember", args: {} }, ["target"]),
  /** Leave a private channel as its last member, deleting it and all its messages. */
  channelLeaveDeleting: (target: string): RaftHint => hint(["channel", "leave", "--target", q(target), "--delete-if-last"], { name: "channels.leave", args: { target, deleteIfLast: true } }),
  /** Remove a private channel's last member, deleting it and all its messages. `member` is `{ user: "@alice" }` or `{ agent: "@bot" }`. */
  channelRemoveMemberDeleting: (target: string, member: { user: string } | { agent: string }): RaftHint => hint(
    ["channel", "remove-member", "--target", q(target), ..."user" in member ? ["--user", member.user] : ["--agent", member.agent], "--delete-if-last"],
    { name: "channels.removeMember", args: { target, ...member, deleteIfLast: true } },
  ),
  serverUpdateName: (): RaftHint => hint(["server", "update"], { name: "server.update", args: {} }),
  taskClaim: ({ target, taskNumber }: { target: string; taskNumber: number }): RaftHint => hint(
    ["task", "claim", "--target", q(target), "--number", String(taskNumber)],
    { name: "tasks.claim", args: { target, taskNumbers: [taskNumber] } },
  ),
  /**
   * Task v2: create a task from a chat message (`--message-id`). CLI only:
   * `title` is printed as given (the caller escapes it for a double-quoted
   * shell word), so it is not an operation argument.
   */
  taskCreateFromMessage: ({ target, messageId, title, assignee }: {
    target: string;
    messageId: string;
    title: string;
    assignee?: string;
  }): RaftHint => hint([
    "task", "create", "--target", q(target), "--message-id", messageId, "--title", q(title),
    ...(assignee ? ["--assignee", assignee] : []),
  ]),
  /**
   * A create refused for having no source (`task_source_required`): the same
   * board, with the source message and the title left to fill in.
   */
  taskCreateWithSource: ({ target }: { target: string }): RaftHint => hint(
    ["task", "create", "--target", q(target), "--message-id", "<id>", "--title", q(ELLIPSIS)],
    { name: "tasks.create", args: { target } },
    ["sourceMessageId", "tasks"],
  ),
  ...RAFT_TASK_HINTS,
  taskListAll: (target: string): RaftHint => hint(
    ["task", "list", "--target", q(target), "--status", "all"],
    { name: "tasks.list", args: { target, status: "all" } },
  ),
  mentionAction: (action: "notify" | "add", resolutionId: string): RaftHint => hint(
    ["mention", action, resolutionId],
    { name: action === "notify" ? "mentions.notify" : "mentions.add", args: { resolutionIds: [resolutionId] } },
  ),
  mentionPending: (): RaftHint => hint(["mention", "pending"], { name: "mentions.pending", args: {} }),
  /** Take back a question card you posted: its message id as prepare printed it (the short id, or the full one). */
  actionWithdraw: (messageId: string): RaftHint => hint(["action", "withdraw", "--message", messageId], { name: "actions.withdraw", args: { messageId } }),
  /** Prose naming the prepare command (a question card asked again): the card and where it goes are the caller's. */
  actionPrepareName: (): RaftHint => hint(["action", "prepare"], { name: "actions.prepare", args: {} }, ["target", "action"]),
  /**
   * Fetch a Manual topic. The server refuses a fetch without a real intent and reason (12 to 500
   * characters each), so the hint always carries the text to send: the caller's own (a search's),
   * or a pointer's own words (agentText/artifacts.ts `ARTIFACT_PAGE_MANUAL_CONTEXT`). Never `…`:
   * a hint prints a command that runs as printed.
   */
  manualGet: (topic: string, { intent, reason }: RaftManualContext): RaftHint => hint(
    ["manual", "get", topic, "--intent", manualContextWord(intent), "--reason", manualContextWord(reason)],
    { name: "manual.get", args: { topic, intent, reason } },
  ),
  /** The download pointer on message lines; the tool form mints a URL (one attachment: its id; several: left to fill). */
  attachmentView: (attachmentId?: string): RaftHint => hint(
    ["attachment", "view"],
    { name: "attachments.downloadUrl", args: { attachmentId } },
    attachmentId === undefined ? ["attachmentId"] : undefined,
  ),
  /** The binary download (typed method only): where an attachment whose URL cannot be minted is fetched; `output` a placeholder of the caller's. */
  attachmentDownload: (attachmentId: string, output = "<path>"): RaftHint => ({
    ...hint(["attachment", "view", attachmentId, "--output", output], { name: "attachments.download", args: { attachmentId } }),
    codeOnly: true,
  }),
  /**
   * A file sent as an attachment, file and conversation left to fill. CLI only: binary payloads have no
   * tool form, so tool-style text says to send a message instead and never renders this.
   */
  attachmentUpload: (): RaftHint => hint(["attachment", "upload", "--path", "<file>", "--target", "<conversation>"]),
  /** An Artifact's summary and what's new (`version`: an older one; `files`: every file). No artifact: left to fill. */
  artifactRead: ({ artifact, version, files }: { artifact?: string; version?: number; files?: true }): RaftHint => hint(
    ["artifact", "read", artifact === undefined ? "<artifact>" : artifactWord(artifact), ...(version === undefined ? [] : ["--rev", String(version)]), ...(files ? ["--files"] : [])],
    { name: "artifacts.read", args: { artifact, version, ...(files ? { files } : {}) } },
    artifact === undefined ? ["artifact"] : undefined,
  ),
  /** Artifacts the agent can see, optionally only those whose home is `target`; with `query`, those matching it. */
  artifactList: ({ query, target, cursor, limit }: { query?: string; target?: string; cursor?: string; limit?: number }): RaftHint => hint(
    [
      "artifact", "list",
      ...(query === undefined ? [] : ["--query", shellWord(query)]),
      ...(target === undefined ? [] : ["--target", q(target)]),
      ...(cursor === undefined ? [] : ["--cursor", cursor]),
      ...(limit === undefined ? [] : ["--limit", String(limit)]),
    ],
    { name: "artifacts.list", args: { query, target, cursor, limit } },
  ),
  /** Comments: what's new to the agent by default, every comment with `all`. */
  artifactComments: ({ artifact, path, all, cursor, review }: { artifact: string; path?: string; all?: true; cursor?: string; review?: string }): RaftHint => hint(
    [
      "artifact", "comments", artifactWord(artifact),
      ...(review === undefined ? [] : ["--review", review]),
      ...(path === undefined ? [] : ["--path", shellWord(path)]),
      ...(all ? ["--all"] : []),
      ...(cursor === undefined ? [] : ["--cursor", cursor]),
    ],
    { name: "artifacts.comments", args: { artifact, review, path, ...(all ? { all } : {}), cursor } },
  ),
  /**
   * One file: saved to disk by the CLI, read as text (or a short-lived URL) by the operation. No path: left to fill.
   * `image` (a comment image's id, from a comment's Images line): that image's bytes instead, saved to
   * `output` (default `<file>`) by the CLI; a program downloads it with the typed method artifacts.commentImage.
   */
  artifactDownload: ({ artifact, path, version, image, output }: { artifact: string; path?: string; version?: number; image?: string; output?: string }): RaftHint => image !== undefined
    ? {
      ...hint(
        ["artifact", "download", artifactWord(artifact), "--image", artifactWord(image), "--output", output === undefined ? "<file>" : fileWord(output)],
        { name: "artifacts.commentImage", args: { artifact, fileId: image } },
      ),
      codeOnly: true,
    }
    : hint(
      [
        "artifact", "download", artifactWord(artifact), path === undefined ? "<path>" : shellWord(path),
        ...(version === undefined ? [] : ["--rev", String(version)]),
        "--output", "<file>",
      ],
      { name: "artifacts.fileContent", args: { artifact, path, version } },
      path === undefined ? ["path"] : undefined,
    ),
  /** Download an Artifact's files into a directory and record the base (CLI only: cloud agents read files as content). */
  artifactPull: ({ artifact, dir }: { artifact: string; dir?: string }): RaftHint => hint(
    ["artifact", "pull", artifactWord(artifact), ...(dir === undefined ? [] : ["--dir", dir.startsWith("<") ? dir : q(dir)])],
  ),
  /** Push a directory's changes as a new version (CLI); the operation takes the files themselves, left to fill. `target`: a new one's home (a `<…>` placeholder stays bare). */
  artifactPublish: ({ dir, artifact, base, deletePath, target, note }: { dir?: string; artifact?: string; base?: number; deletePath?: string; target?: string; note?: string }): RaftHint => hint(
    [
      "artifact", "push", dir === undefined ? "<dir>" : q(dir),
      ...(target === undefined ? [] : ["--target", target.startsWith("<") ? target : q(target)]),
      ...(note === undefined ? [] : ["--note", q(note)]),
      ...(deletePath === undefined ? [] : ["--delete", shellWord(deletePath)]),
    ],
    { name: "artifacts.push", args: { artifact, base, target, note, ...(deletePath === undefined ? {} : { delete: [deletePath] }) } },
    ["files"],
  ),
  /** Answer in an Artifact's comments; the body is the caller's (stdin on the CLI). */
  artifactComment: ({ artifact, path, replyTo }: { artifact: string; path?: string; replyTo?: string }): RaftHint => hint(
    ["artifact", "comment", artifactWord(artifact), ...(path === undefined ? [] : ["--path", shellWord(path)]), ...(replyTo === undefined ? [] : ["--reply-to", replyTo])],
    { name: "artifacts.comment", args: { artifact, path, replyTo } },
    ["body"],
  ),
  /** A review: several comments posted together, the JSON on stdin (CLI) or `comments` (tool). */
  artifactReview: ({ artifact, version }: { artifact: string; version?: number }): RaftHint => hint(
    ["artifact", "review", artifactWord(artifact), ...(version === undefined ? [] : ["--rev", String(version)])],
    { name: "artifacts.review", args: { artifact, version } },
    ["comments"],
  ),
  /** Resolve a comment thread by its root comment (#249); `note` (shown quoted, a `<…>` placeholder too) is posted as a reply. */
  artifactResolve: ({ artifact, comment, note }: { artifact: string; comment: string; note?: string }): RaftHint => hint(
    ["artifact", "resolve", artifactWord(artifact), comment, ...(note === undefined ? [] : ["--note", q(note)])],
    { name: "artifacts.resolve", args: { artifact, comment, note } },
  ),
  /** Reopen a resolved comment thread (#249). */
  artifactReopen: ({ artifact, comment }: { artifact: string; comment: string }): RaftHint => hint(
    ["artifact", "reopen", artifactWord(artifact), comment],
    { name: "artifacts.reopen", args: { artifact, comment } },
  ),
  /** Follow an Artifact again after unfollowing it. */
  artifactFollow: ({ artifact }: { artifact: string }): RaftHint => hint(["artifact", "follow", artifactWord(artifact)], { name: "artifacts.follow", args: { artifact } }),
  /** Stop following an Artifact (mentions still arrive). */
  artifactUnfollow: ({ artifact }: { artifact: string }): RaftHint => hint(["artifact", "unfollow", artifactWord(artifact)], { name: "artifacts.unfollow", args: { artifact } }),
  /** Move an Artifact to the whole server: the only larger home an agent moves one to (public is a person's step). */
  artifactMove: ({ artifact }: { artifact: string }): RaftHint => hint(["artifact", "move", artifactWord(artifact), "--to", "server"], { name: "artifacts.move", args: { artifact, to: "server" } }),
  /** Save an attachment (its id from a message) as an Artifact, as the web's "Save as Artifact". */
  artifactSave: ({ attachmentId }: { attachmentId: string }): RaftHint => hint(["artifact", "save", attachmentId], { name: "artifacts.saveAttachment", args: { attachmentId } }),
  /**
   * A version's publish check (`version`: whose check to read; the push and check texts always
   * pass it, so a later push can't change what the command reads; `wait`: while it is pending or
   * running, wait for it, up to 90 s). The CLI's flag is `--rev`, as everywhere
   * (the root program owns `--version`); the CLI also saves the screenshots.
   */
  artifactCheck: ({ artifact, version, wait }: { artifact: string; version?: number; wait?: true }): RaftHint => hint(
    ["artifact", "check", artifactWord(artifact), ...(version === undefined ? [] : ["--rev", String(version)]), ...(wait ? ["--wait"] : [])],
    { name: "artifacts.check", args: { artifact, version, ...(wait ? { wait } : {}) } },
  ),
} satisfies Record<string, (...args: never[]) => RaftHint>;

export type RaftHintBuilderName = keyof typeof RAFT_HINTS;
