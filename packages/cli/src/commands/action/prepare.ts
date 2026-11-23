// `raft action prepare --target <ch>` reads an ActionCardAction JSON from
// stdin and posts an action card to <target>.
//
// Action cards are B-mode shortcuts: an agent prepares the form, the human
// admin clicks the action verb to commit it under their own identity. The
// scope `action:prepare` gates this CLI command (added in the agent
// permission system; until that lands the command is open to all agents).
//
// Replaces the legacy `prepare_action` MCP tool — same payload shape, sent
// through the id-less Agent API action-prepare route. The MCP tool is demoted
// to a deprecated shim that points here.
//
// Input shape (read from stdin, JSON):
//   { "type": "channel:create",
//     "name": "demo",
//     "visibility": "public",
//     "description": "...",
//     "initialHumans": ["uuid", ...],
//     "initialAgents": ["uuid", ...],
//     "draftHint": "..." }
// or
//   { "type": "agent:create",
//     "name": "scout",
//     "description": "...",
//     "requiredComputer": "tygg-ec2",
//     "suggestedRuntime": "codex",
//     "draftHint": "..." }
// ("suggestedRuntime" only starts the dialog on that runtime, marked as the
// agent's suggestion; the person picks. The Server refuses an id it does not
// offer for new agents and lists the ones it does.)
// or
//   { "type": "channel:add_member",
//     "channel": "#existing-channel",
//     "humans": ["@alice", ...],
//     "agents": ["@scout", ...],
//     "draftHint": "..." }
// or (moving an agent to another computer: the agent that prepares it
// ("move me"), or, with "agent", another agent named by its handle; the
// person picks the target computer in the migration dialog)
//   { "type": "agent:migrate",
//     "agent": "@scout",
//     "suggestedComputer": "mac-mini",
//     "draftHint": "..." }
// or (wherever the deployment has product feedback configured; whoever
// sends it may edit it first and sends it as their own product feedback)
//   { "type": "feedback:submit",
//     "feedbackType": "idea" | "problem",
//     "message": "...",
//     "draftHint": "..." }
// or (only on a Free server of a deployment with billing set up, and not in a
// shared channel; one plain sentence
// of reason, up to 200 characters, never the hint's `<…>` placeholder, and the
// Free limit hit if there is one; no other field; a repeat for the same
// conversation and gate within a day answers with the card already there, and
// any other upgrade card in a conversation that had one lately is refused with
// UPGRADE_CARD_COOLDOWN, and one for a gate already offered elsewhere on the
// server lately with UPGRADE_CARD_ALREADY_OFFERED)
//   { "type": "plan:upgrade",
//     "reason": "...",
//     "gate": "history_30d" }
// or (the answers come back as a reply in the card's thread, the card
// expires, and `raft action withdraw --message <id>` takes it back)
//   { "type": "question:ask",
//     "to": "@tenny" | "anyone",
//     "questions": [{ "id": "window", "kind": "single", "text": "...",
//                     "options": [{ "value": "tue_am", "label": "..." }, ...] }] }
//
// The CLI checks only that the JSON is an object with a `type`. The Server
// checks the card (its type and fields), so a card type this CLI doesn't
// know yet (a Computer's CLI does not update itself) still reaches it, and a
// refusal prints the Server's sentence and next step.
//
// Why stdin (not flags)?  The action shape is a discriminated union with
// type-specific fields and arrays of UUIDs — flag-based design ends up
// being either rigid (subcommand per type) or awkward (repeatable opts
// for `--initial-human`). stdin JSON mirrors the existing `raft message
// send` pattern (content on stdin) and keeps the API symmetric with the
// old MCP tool's `action` argument.

import type { Readable } from "node:stream";
import type { Command } from "commander";

import type { AgentApiActionCardWire, RaftFailure } from "@botiverse/raft-shared";
import { agentApiActionCardWireSchema, formatHint, listPreparableOperations, prepareActionCard, RAFT_HINTS } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient, createCliOperationFailures } from "../../agentApiPath";
import type { ApiResponse } from "../../client";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import { rateLimitedCliError } from "../../core/apiFailure";
import { CliError, cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { applyDmPeerKind, PEER_KIND_OPTION } from "../_target";
import { formatPreparableOperationsList } from "./_format";

interface PrepareOpts {
  target: string;
  peerKind?: string;
  list?: boolean;
}

const ACTION_HEREDOC_DELIMITER = "RAFTACTION";

export class PrepareActionInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PrepareActionInputError";
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let content = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream as Readable) {
    content += String(chunk);
  }
  return content;
}

function missingActionMessage(): string {
  return [
    "No action JSON received on stdin.",
    "Pipe a JSON ActionCardAction object (for example question:ask / channel:create / agent:create / channel:add_member / feedback:submit / plan:upgrade; `raft action prepare --help` shows a question card) into raft action prepare:",
    `  raft action prepare --target "#channel" <<'${ACTION_HEREDOC_DELIMITER}'`,
    "  {\"type\":\"channel:create\",\"name\":\"demo\",\"visibility\":\"public\"}",
    `  ${ACTION_HEREDOC_DELIMITER}`,
  ].join("\n");
}

export async function resolveActionInput(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<unknown> {
  if ((input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY) {
    throw new PrepareActionInputError("MISSING_ACTION", missingActionMessage());
  }
  const raw = (await readStream(input)).replace(/^\uFEFF/, "");
  if (raw.trim().length === 0) {
    throw new PrepareActionInputError("MISSING_ACTION", missingActionMessage());
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new PrepareActionInputError(
      "INVALID_JSON",
      `Action JSON failed to parse: ${(err as Error).message}`,
    );
  }
}

/** The card the Server checks: any JSON object with a non-empty string `type`. */
function actionWithType(raw: unknown): AgentApiActionCardWire {
  const parsed = agentApiActionCardWireSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new CliError({
    code: "INVALID_ACTION",
    message: 'The action JSON must be an object with a "type" (the card type, for example "channel:create").',
    suggestedNextAction: 'The card types and their fields are in the manual: raft manual get action-cards --intent "Prepare an action card" --reason "Need the card types and fields"',
  });
}

/**
 * A refused prepare: the Server's code as it sent it (PREPARE_FAILED when it
 * sent none), its sentence, its next step, and whether the same request may
 * go again (a 4xx: no). A 5xx is as before: SERVER_5XX with the Server's
 * error. `response` is the refusal as the CLI received it.
 */
function prepareCliError(failure: RaftFailure, response: ApiResponse<unknown> | null): CliError {
  const { error } = failure;
  if (error.code === "INVALID_REQUEST") return new CliError({ code: "INVALID_ARG", message: error.message });
  if (response && response.status >= 500) {
    return new CliError({ code: "SERVER_5XX", message: response.error ?? `HTTP ${response.status}` });
  }
  // Over the write budget (429 RATE_LIMITED): the wait, retryable, the same command again.
  if (error.serverCode === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return rateLimitedCliError({ message: error.message, retryAfterSeconds: error.retryAfterSeconds }, null);
  }
  // The Server's code (the op keeps only a well-formed one), so a code added on
  // the Server needs no CLI release: an agent tells a paid server, a disabled
  // feature or a wrong field (and an upgrade card's cooldown, once the Server
  // refuses with one) apart by it.
  const code = error.serverCode ?? "PREPARE_FAILED";
  // Without a step from the Server, the SDK's generic one ("read the Server's
  // error code") adds nothing to the Code line above it: left out.
  const nextAction = error.code === "HTTP_ERROR" && !response?.suggestedNextAction ? undefined : error.nextAction;
  return cliError(code, error.message, { suggestedNextAction: nextAction, retryable: error.retryable });
}

/**
 * The card agents need most often, in `--help` (#triage:#262): a question card
 * a person answers on a form, with when to use one; every card type and field
 * is in the `action-cards` Manual topic.
 */
const QUESTION_CARD_HELP = `
Ask a person to choose (question:ask): they answer on the card, and the
answer comes back as a reply that @mentions you (don't poll for it):
  raft action prepare --target "#ops" <<'RAFTACTION'
  {"type":"question:ask","to":"@alice","questions":[{"id":"window","kind":"single","text":"Which window do we deploy in?","options":[{"value":"tue_am","label":"Tue 10:00"},{"value":"wed_pm","label":"Wed 15:00"}]}]}
  RAFTACTION
Up to 4 questions in one card. "single" and "multiple" take 1-4 options;
with 2 or more Raft adds Other… itself (don't add one). "text" takes a
short answer. Every question must be answered unless you set
"required": false on it (e.g. an optional comment).
One option makes a confirm card: the person sees one button with your label
and presses it to confirm (no Other…). The answer is that option's value:
  raft action prepare --target "#ops" <<'RAFTACTION'
  {"type":"question:ask","to":"@alice","questions":[{"id":"ack","kind":"single","text":"The deploy is done. Seen it?","options":[{"value":"ok","label":"Got it"}]}]}
  RAFTACTION
In a DM leave out "to"; in a channel it is a person's handle (not an
agent's), or "anyone".
Use a card when the answer decides what you do next: a choice between
options, whether you should go ahead, or a short answer you will act on; in a
running conversation too. Ask in a message only what a card can't take (an
open question, a step they must take elsewhere), and don't ask what you can
decide yourself: decide it and say what you chose.
Ask a person to run an operation you can't (request:prepare): they confirm
it on the card and it runs as them. List what you can prepare here, with each
operation's args and whom to ask:
  raft action prepare --list
Every card type and its fields: the \`action-cards\` Manual topic.`;

/**
 * `--list`: the operations this agent may prepare as a request card on its
 * server (RFC 085 §4.2 discovery), as the Server lists them. A Server too old
 * to list them answers 404 without a code: said so, with what to do instead.
 */
async function listOperations(ctx: CommandContext): Promise<void> {
  const agentContext = ctx.loadAgentContext();
  const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
  const failures = createCliOperationFailures();
  const outcome = await listPreparableOperations({ actions: { ...api.actions, operations: () => failures.observe(api.actions.operations()) } });
  if (outcome.ok) {
    writeText(ctx.io, formatPreparableOperationsList(outcome.data));
    return;
  }
  const response = failures.last();
  if (response && response.status >= 500) throw new CliError({ code: "SERVER_5XX", message: response.error ?? `HTTP ${response.status}` });
  if (outcome.error.status === 404 && !outcome.error.serverCode) {
    throw cliError("LIST_UNAVAILABLE", "This Raft Server can't list the operations you can prepare as a request card (it is older than this command).", {
      suggestedNextAction: `Ask the person in a message to do it themselves in Raft: ${formatHint(RAFT_HINTS.messageReply({ target: "dm:@<person>" }))}`,
      retryable: false,
    });
  }
  throw cliError(outcome.error.serverCode ?? "LIST_FAILED", outcome.error.message, { suggestedNextAction: outcome.error.nextAction, retryable: outcome.error.retryable });
}

export const actionPrepareCommand = defineCommand(
  {
    name: "prepare",
    description: "Prepare an action card for a human to commit (B-mode quick-commit shortcut)",
    options: [
      {
        flags: "--target <target>",
        description: "Channel/DM/thread target to post the card. Same format as raft message send: '#channel', 'dm:@peer', '#channel:shortid', 'dm:@peer:shortid'",
      },
      PEER_KIND_OPTION,
      {
        flags: "--list",
        description: "List the operations you can prepare as a request card (request:prepare) on this server, with their args and whom to ask; posts nothing",
      },
    ],
    helpAfter: QUESTION_CARD_HELP,
  },
  async (ctx, opts: PrepareOpts) => {
      if (opts.list) {
        await listOperations(ctx);
        return;
      }
      if (!opts.target?.trim()) {
        throw cliError("INVALID_ARG", "--target is required");
      }
      const target = opts.peerKind === undefined ? opts.target : applyDmPeerKind(opts.target.trim(), opts.peerKind);

      const agentContext = ctx.loadAgentContext();
      let raw: unknown;
      try {
        raw = await resolveActionInput(ctx.io.stdin ?? process.stdin);
      } catch (err) {
        if (err instanceof PrepareActionInputError) throw cliError(err.code, err.message, { cause: err });
        throw err;
      }
      const action = actionWithType(raw);

      // The SDK's actions.prepare: same request, same words. A transport
      // failure or a daemon-proxy 5xx throws as other commands' requests do.
      const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
      const failures = createCliOperationFailures();
      const outcome = await prepareActionCard({
        actions: { ...api.actions, prepare: (body) => failures.observe(api.actions.prepare(body)) },
      }, { target, action });
      if (!outcome.ok) throw prepareCliError(outcome, failures.last());
      writeText(ctx.io, adoptCliReplyText(outcome.text));
  },
);

export function registerActionPrepareCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, actionPrepareCommand, runtimeOptions);
}
