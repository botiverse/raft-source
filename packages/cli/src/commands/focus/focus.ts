// `raft focus <target>` focuses a thread, a DM or a task conversation;
// `raft focus` lists what is focused; `raft unfocus <target>` lets one go.
// Only on a Server with Focus on (flag `agent_focus_v0`); elsewhere the
// Server refuses AGENT_FOCUS_DISABLED.
// → POST /internal/agent-api/focus | POST /unfocus | GET /focus

import type { Command } from "commander";
import { formatHint, RAFT_HINTS } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { adoptCliReplyText, writeText } from "../../core/renderer";
import { apiFailureError } from "../_apiFailure";
import { applyDmPeerKind, PEER_KIND_OPTION } from "../_target";
import { formatFocusList, formatFocusResult, formatUnfocusResult } from "./_format";

interface FocusOpts {
  peerKind?: string;
}

const TARGET_ARGUMENT_HELP =
  "A thread ('#engineering:abcd1234', 'dm:@alice:abcd1234'), a DM ('dm:@alice') or a task conversation ('#engineering:#7'), as raft inbox check names it";

const FOCUS_HELP_AFTER =
  "\nWith a target: focus it. Without one: list what you have focused.\n" +
  "You keep at most 3 conversations in focus. Focusing one more unfocuses the least recently active: those Raft focused for you first, then those you focused yourself. The output names what was unfocused and the command that brings it back.\n" +
  "A plain channel ('#engineering') cannot be focused yet. Works only where the Server has Focus on.\n";

const UNFOCUS_HELP_AFTER =
  "\nIts updates then reach your inbox like any other conversation's. Unfocusing something that is not focused changes nothing.\n" +
  "To see what is focused: raft focus\n";

/** The listing's command as the next step of every refusal that has none of its own. */
const LIST_NEXT_ACTION = `See what is focused: ${formatHint(RAFT_HINTS.focusList())}`;

/** A refusal (4xx) the Server sent without a next step ends with the listing; a 5xx keeps its own retry advice. */
function nextActionFor(res: { status: number; suggestedNextAction?: string | null }): { suggestedNextAction?: string } {
  return res.suggestedNextAction || res.status >= 500 ? {} : { suggestedNextAction: LIST_NEXT_ACTION };
}

export const focusCommand = defineCommand(
  {
    name: "focus",
    description: "Focus a thread, DM or task conversation, or list what you have focused",
    arguments: ["[target]"],
    usage: '["<target>"]',
    options: [PEER_KIND_OPTION],
    helpAfter: `\nArguments:\n  target  ${TARGET_ARGUMENT_HELP}\n${FOCUS_HELP_AFTER}`,
  },
  async (ctx, targetArg: string | undefined, opts: FocusOpts = {}) => {
    const rawTarget = targetArg?.trim() ?? "";
    const agentContext = ctx.loadAgentContext();
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));

    if (!rawTarget) {
      if (opts.peerKind !== undefined) {
        throw new CliError({
          code: "INVALID_ARG",
          message: "--peer-kind needs a DM target to focus; without a target this command lists what is focused.",
          suggestedNextAction: `${formatHint(RAFT_HINTS.focus("dm:@name"))} --peer-kind ${opts.peerKind}`,
        });
      }
      const listed = await agentApi.focus.list();
      if (!listed.ok) throw apiFailureError(listed, "FOCUS_FAILED", listed.status >= 500 || listed.suggestedNextAction ? {} : { suggestedNextAction: `Run it again: ${formatHint(RAFT_HINTS.focusList())}` });
      if (!listed.data) {
        throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Agent API focusList returned an empty response body", suggestedNextAction: `Run it again: ${formatHint(RAFT_HINTS.focusList())}` });
      }
      writeText(ctx.io, adoptCliReplyText(`${formatFocusList(listed.data)}\n`));
      return;
    }

    const target = applyDmPeerKind(rawTarget, opts.peerKind);
    const res = await agentApi.focus.add({ target });
    if (!res.ok) throw apiFailureError(res, res.status === 404 ? "NOT_FOUND" : "FOCUS_FAILED", nextActionFor(res));
    if (!res.data) {
      throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Agent API focus returned an empty response body", suggestedNextAction: LIST_NEXT_ACTION });
    }
    writeText(ctx.io, adoptCliReplyText(`${formatFocusResult(res.data)}\n`));
  },
);

export const unfocusCommand = defineCommand(
  {
    name: "unfocus",
    description: "Stop focusing a conversation",
    arguments: ["[target]"],
    usage: '"<target>"',
    options: [PEER_KIND_OPTION],
    helpAfter: `\nArguments:\n  target  ${TARGET_ARGUMENT_HELP}\n${UNFOCUS_HELP_AFTER}`,
  },
  async (ctx, targetArg: string | undefined, opts: FocusOpts = {}) => {
    const rawTarget = targetArg?.trim() ?? "";
    if (!rawTarget) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Name the conversation to unfocus, as the focus list names it.",
        suggestedNextAction: LIST_NEXT_ACTION,
      });
    }
    const target = applyDmPeerKind(rawTarget, opts.peerKind);
    const agentContext = ctx.loadAgentContext();
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await agentApi.focus.remove({ target });
    if (!res.ok) throw apiFailureError(res, res.status === 404 ? "NOT_FOUND" : "UNFOCUS_FAILED", nextActionFor(res));
    if (!res.data) {
      throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Agent API unfocus returned an empty response body", suggestedNextAction: LIST_NEXT_ACTION });
    }
    writeText(ctx.io, adoptCliReplyText(`${formatUnfocusResult(res.data)}\n`));
  },
);

export function registerFocusCommands(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, focusCommand, runtimeOptions);
  registerCliCommand(parent, unfocusCommand, runtimeOptions);
}
