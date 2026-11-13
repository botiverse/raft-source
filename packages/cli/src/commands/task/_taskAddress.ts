// Task v2: how the task-conversation commands (`raft task view|reply|read|
// follow|unfollow`) and the task writes (`assign|unassign|claim|unclaim|
// update|amend|delete`) name one task. The task ref `#channel:#7` /
// `dm:@peer:#7` (positional, quoted: an unquoted `#` starts a shell comment),
// or the board + number every other task command takes
// (`--target "#channel" --number 7`).

import { formatAgentTaskRef, parseAgentTaskRef } from "@botiverse/raft-shared/src/agentCliSurface";

import { CliError } from "../../core/errors";
import { applyDmPeerKind, PEER_KIND_OPTION, requireTargetAlias, resolveTargetAlias, type TargetAliasOpts } from "../_target";

export interface TaskAddressOpts extends TargetAliasOpts {
  number?: string;
}

export interface TaskAddress {
  /** The board's conversation target sent to the server: `#channel` / `dm:@peer`. */
  channel: string;
  taskNumber: number;
  /** `#channel:#7` / `dm:@peer:#7`. */
  ref: string;
}

/** The options every task-conversation command shares (after the positional `[ref]`). */
export const TASK_ADDRESS_OPTIONS = [
  { flags: "--target <target>", description: "The task's board: '#channel' or 'dm:@peer' (with --number), instead of a ref" },
  { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
  PEER_KIND_OPTION,
  { flags: "--number <n>", description: "Task number on that board (with --target)" },
] as const;

export const TASK_REF_ARGUMENT = "[ref]";

/**
 * Nothing names the task: no ref, no --target, no --number. The usual cause
 * is an unquoted ref, `raft task assign #proj:#7 @bob`: the shell reads `#`
 * as the start of a comment and drops it and everything after it.
 */
export const NO_TASK_NAMED_MESSAGE =
  'No task named. Give its ref in quotes, e.g. "#channel:#7" (unquoted, # starts a shell comment, which drops the ref and everything after it), or --target "#channel" --number 7.';

/** `--peer-kind` on a task ref: a DM ref takes it (`dm:@peer~agent`); a channel ref says which form it needs. */
function applyPeerKindToRef(refTarget: string, peerKind: string | undefined): string {
  if (peerKind === undefined) return refTarget;
  if (!refTarget.startsWith("dm:")) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--peer-kind only applies to a task in a DM ("dm:@peer:#7", or "dm:@peer~agent:#7" / "dm:@peer~human:#7"); got ${refTarget}`,
    });
  }
  return applyDmPeerKind(refTarget, peerKind);
}

function parseTaskNumber(raw: string): number {
  const number = Number(raw.trim().replace(/^#/, ""));
  if (!Number.isInteger(number) || number <= 0) {
    throw new CliError({ code: "INVALID_ARG", message: `--number must be a positive integer; got ${raw}` });
  }
  return number;
}

/**
 * Resolve the task a command names. Either a ref (`"#proj:#7"`), or
 * `--target "#proj" --number 7`; both together must agree.
 */
export function resolveTaskAddress(refArg: string | undefined, opts: TaskAddressOpts): TaskAddress {
  const rawRef = refArg?.trim() ?? "";
  const number = opts.number?.trim() ? parseTaskNumber(opts.number) : undefined;

  if (rawRef) {
    const parsed = parseAgentTaskRef(rawRef);
    if (!parsed) {
      throw new CliError({
        code: "INVALID_TARGET",
        message: `Not a task ref: ${rawRef}. A task is named "#channel:#7" (a task in a DM: "dm:@peer:#7"), or with --target "#channel" --number 7. Quote the ref: an unquoted # starts a shell comment.`,
      });
    }
    // --peer-kind applies to a DM ref as to a DM --target (same as
    // "dm:@peer~agent:#7"); a channel ref refuses it, naming the DM forms.
    const refTarget = applyPeerKindToRef(parsed.target, opts.peerKind);
    const flagTarget = resolveTargetAlias({ target: opts.target, channel: opts.channel });
    const kindedFlagTarget = flagTarget === undefined ? undefined : applyDmPeerKind(flagTarget, opts.peerKind);
    if ((kindedFlagTarget !== undefined && kindedFlagTarget !== refTarget) || (number !== undefined && number !== parsed.taskNumber)) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `The ref ${parsed.ref} and --target/--number name different tasks; give one of them.`,
      });
    }
    const ref = refTarget === parsed.target ? parsed.ref : formatAgentTaskRef(refTarget, parsed.taskNumber) ?? parsed.ref;
    return { channel: refTarget, taskNumber: parsed.taskNumber, ref };
  }

  const target = resolveTargetAlias(opts);
  if (!target || number === undefined) {
    throw new CliError({
      code: "INVALID_ARG",
      message: target || number !== undefined
        ? 'Name the task by its ref, e.g. "#channel:#7" (quoted), or with --target "#channel" --number 7.'
        : NO_TASK_NAMED_MESSAGE,
    });
  }
  const ref = formatAgentTaskRef(target, number);
  if (!ref) {
    throw new CliError({
      code: "INVALID_TARGET",
      message: `--target must be a channel ('#channel') or a DM ('dm:@peer') holding the task board; got ${target}`,
    });
  }
  return { channel: target, taskNumber: number, ref };
}

/**
 * The task a task WRITE names (`assign`, `unassign`, `claim`, `unclaim`,
 * `update`, `amend`, `delete`): the ref, as `view` takes it (`"#proj:#7"`), or
 * the board + number those commands always took. Without a ref it is exactly
 * the old flags' check (same refusals), so scripts that use them keep working.
 */
export function resolveTaskWriteAddress(
  refArg: string | undefined,
  opts: TargetAliasOpts & { number?: string },
): { channel: string; taskNumber: number } {
  if (refArg?.trim()) {
    const address = resolveTaskAddress(refArg, opts);
    return { channel: address.channel, taskNumber: address.taskNumber };
  }
  if (!opts.target?.trim() && !opts.channel?.trim() && !opts.number?.trim()) {
    throw new CliError({ code: "INVALID_ARG", message: NO_TASK_NAMED_MESSAGE });
  }
  const channel = requireTargetAlias(opts);
  const raw = opts.number;
  const taskNumber = Number(raw);
  if (!Number.isFinite(taskNumber) || !Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new CliError({ code: "INVALID_ARG", message: `--number must be a positive integer; got ${raw}` });
  }
  return { channel, taskNumber };
}

