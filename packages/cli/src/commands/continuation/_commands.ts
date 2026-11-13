// Every command `cont` can resume. A command that pauses (runContinuable)
// must be listed here too, or its continuations are refused as
// UNKNOWN_COMMAND. Phase 1 has one: `raft message send` held for unseen
// messages, behind its pilot flag (message/send.ts).
import { messageSendContinuation } from "../message/send";
import type { CliContinuationCommandSource } from "./_runtime";

export const CLI_CONTINUATION_COMMANDS: readonly CliContinuationCommandSource[] = [messageSendContinuation];
