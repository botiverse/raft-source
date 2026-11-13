// `raft task read <ref> [--unread | --before <id|seq> | --after <id|seq> | --around <id|seq>] [--limit N]`
// (task v2) — read a task's own conversation, with `raft message read`'s
// window flags and output.
// → GET /internal/agent-api/tasks/read

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { executeHistoryRead, historyWindowQuery, validateReadOpts } from "../message/read";
import { resolveTaskAddress, TASK_ADDRESS_OPTIONS, TASK_REF_ARGUMENT, type TaskAddressOpts } from "./_taskAddress";

interface TaskReadOpts extends TaskAddressOpts {
  before?: string;
  after?: string;
  around?: string;
  limit?: string;
  unread?: boolean;
}

export const taskReadCommand = defineCommand(
  {
    name: "read",
    description: "Read a task's discussion (its own conversation)",
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7" [--unread | --before <idOrSeq> | --after <idOrSeq> | --around <idOrSeq>] [--limit <n>]',
    options: [
      ...TASK_ADDRESS_OPTIONS,
      { flags: "--before <idOrSeq>", description: "Return messages strictly before this anchor (pure-decimal values are seqs)" },
      { flags: "--after <idOrSeq>", description: "Return messages strictly after this anchor (pure-decimal values are seqs)" },
      { flags: "--around <idOrSeq>", description: "Center the window on this anchor: a message id, its 8-character short id, or a seq (an 8-digit value that is no short id here is a seq)" },
      { flags: "--unread", description: "Read the task's unread messages from others: start right after your read position and move it forward" },
      { flags: "--limit <n>", description: "Max messages to return (server default applies if omitted)" },
    ],
    helpAfter:
      '\nA task is named by its ref: "#channel:#7", or "dm:@peer:#7" for a task in a DM. Quote it: an unquoted # starts a shell comment.\n'
      + "Reply to the task with `raft task reply <ref>` (body on stdin); `raft message send/read` do not take task refs.\n",
  },
  async (ctx, refArg: string | undefined, opts: TaskReadOpts = {}) => {
    const address = resolveTaskAddress(refArg, opts);
    const readOpts = validateReadOpts(opts, address.ref);
    await executeHistoryRead(ctx, readOpts, (agentApi) => agentApi.tasks.read({
      channel: address.channel,
      task_number: address.taskNumber,
      ...historyWindowQuery(readOpts),
    }));
  },
);

export function registerTaskReadCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskReadCommand, runtimeOptions);
}
