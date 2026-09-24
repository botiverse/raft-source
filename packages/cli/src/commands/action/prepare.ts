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
//     "draftHint": "..." }
// or
//   { "type": "channel:add_member",
//     "channel": "#existing-channel",
//     "humans": ["@alice", ...],
//     "agents": ["@scout", ...],
//     "draftHint": "..." }
//
// Why stdin (not flags)?  The action shape is a discriminated union with
// type-specific fields and arrays of UUIDs — flag-based design ends up
// being either rigid (subcommand per type) or awkward (repeatable opts
// for `--initial-human`). stdin JSON mirrors the existing `raft message
// send` pattern (content on stdin) and keeps the API symmetric with the
// old MCP tool's `action` argument.

import type { Readable } from "node:stream";
import type { Command } from "commander";

import { actionCardActionSchema, validateActionCardAction } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";

interface PrepareOpts {
  target: string;
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
    "Pipe a JSON ActionCardAction object (for example channel:create / agent:create / channel:add_member) into raft action prepare:",
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

export const actionPrepareCommand = defineCommand(
  {
    name: "prepare",
    description: "Prepare an action card for a human to commit (B-mode quick-commit shortcut)",
    options: [
      {
        flags: "--target <target>",
        description: "Channel/DM/thread target to post the card. Same format as raft message send: '#channel', 'dm:@peer', '#channel:shortid', 'dm:@peer:shortid'",
      },
    ],
  },
  async (ctx, opts: PrepareOpts) => {
      if (!opts.target?.trim()) {
        throw cliError("INVALID_ARG", "--target is required");
      }

      const agentContext = ctx.loadAgentContext();
      let raw: unknown;
      try {
        raw = await resolveActionInput(ctx.io.stdin ?? process.stdin);
      } catch (err) {
        if (err instanceof PrepareActionInputError) throw cliError(err.code, err.message, { cause: err });
        throw err;
      }

      const parsed = actionCardActionSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw cliError("INVALID_ACTION", `Action failed validation: ${issues}`);
      }
      const crossFieldError = validateActionCardAction(parsed.data);
      if (crossFieldError) {
        throw cliError("INVALID_ACTION", `Action failed validation: ${crossFieldError}`);
      }

      const client = ctx.createApiClient(agentContext);
      const agentApi = createAgentApiSurfaceClient(client);
      const res = await agentApi.actions.prepare({ target: opts.target, action: parsed.data });
      if (!res.ok) {
        const code = res.status >= 500 ? "SERVER_5XX" : "PREPARE_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      const data = res.data;
      if (!data) {
        throw cliError("INVALID_JSON_RESPONSE", "Prepare action response did not include a message id");
      }
      const shortId = data.messageId ? data.messageId.slice(0, 8) : null;
      writeText(ctx.io, adoptCliReplyText(
        shortId
          ? `Action card posted to ${opts.target} as message ${data.messageId} (short ${shortId}). The human can click the action verb to commit.\n`
          : `Action card posted to ${opts.target}.\n`,
      ));
  },
);

export function registerActionPrepareCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, actionPrepareCommand, runtimeOptions);
}
