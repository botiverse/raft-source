// What an agent reads when a command pauses to ask it something, and when its
// answer (`cont <id> …`) is refused. The words live in shared
// (agentText/continuations.ts) so the SDK prints the same; this file keeps
// the axSurface registrations. An AX contract, not an implementation detail.
import {
  formatContinuationPaused,
  formatContinuationRefusal,
  heldSendContinuationAsk,
  type ContinuationPausedView,
  type ContinuationRefusalView,
} from "@botiverse/raft-shared/src/agentText/continuations";

import { axSurface } from "../../core/renderer";

const FRESH_REPLIES_ASK = {
  question: "New replies arrived in #ops since you started writing.",
  preview: "@alice 13:02  I already fixed it in #11290\n@bob 13:03  confirmed, closing",
  options: {
    a: "Send your original reply",
    b: { label: "Write a new reply", input: "stdin" as const },
    c: "Cancel",
  },
};
const EXPIRES_AT = Date.UTC(2026, 9, 26, 13, 12);

export const formatContinuationPausedOutput = axSurface(
  "A command paused to ask the agent something (exit 10): the question, its preview, and the `cont` command for each answer, with the continuation id and its deadline.",
  (view: ContinuationPausedView): string => formatContinuationPaused(view),
  {
    examples: [
      { title: "options, one taking text on stdin", args: [{ id: "k7q2m3x9ab", ask: FRESH_REPLIES_ASK, expiresAt: EXPIRES_AT }] },
      { title: "text alone", args: [{ id: "k7q2m3x9ab", ask: { question: "Write the reply to send.", input: "stdin" }, expiresAt: EXPIRES_AT }] },
      {
        title: "a held message send, held 3 times (the continuation pilot)",
        args: [{
          id: "k7q2m3x9ab",
          ask: heldSendContinuationAsk("#ops", {
            cardOnlyLead: null,
            preview: "2 unread messages.\n├ Latest 2 ────────────────────────────\n│ alice 13:01  The fix is on the release branch.\n│ bob 13:02  Confirmed, closing.\n└ ────────────────────────────────────────",
            anywayOffered: true,
          }),
          expiresAt: EXPIRES_AT,
        }],
      },
      {
        title: "a message send held for a channel description it has not seen (the continuation pilot)",
        args: [{
          id: "k7q2m3x9ab",
          ask: heldSendContinuationAsk("#ops", {
            cardOnlyLead: "the description of #ops",
            preview: "Channel #ops (public): Release coordination. Post go/no-go here.\nEquivalent: raft channel info \"#ops\"",
            anywayOffered: false,
          }),
          expiresAt: EXPIRES_AT,
        }],
      },
    ],
  },
);

export const formatContinuationRefusalOutput = axSurface(
  "Answering a continuation was refused (stderr): what happened, in one paragraph, and the command to run next; never the command's arguments or an answer's text.",
  (view: ContinuationRefusalView): string => formatContinuationRefusal(view),
  {
    examples: [
      { title: "unknown id", args: [{ code: "UNKNOWN", id: "k7q2m3x9ab" }] },
      { title: "another agent's", args: [{ code: "NOT_YOURS", id: "k7q2m3x9ab" }] },
      {
        title: "expired, with the original command",
        args: [{ code: "EXPIRED", id: "k7q2m3x9ab", createdAt: EXPIRES_AT - 600_000, expiresAt: EXPIRES_AT, mayHaveTakenEffect: false, rerun: "raft message send --target \"#ops\" <<'RAFTMSG'\n<your message>\nRAFTMSG", check: null }],
      },
      {
        title: "expired, a later question in the exchange: what to check, never the original command",
        args: [{ code: "EXPIRED", id: "k7q2m3x9ab", createdAt: EXPIRES_AT - 600_000, expiresAt: EXPIRES_AT, mayHaveTakenEffect: true, rerun: "raft message send --target \"#ops\" <<'RAFTMSG'\n<your message>\nRAFTMSG", check: "raft message read --target \"#ops\"" }],
      },
      {
        title: "result no longer kept",
        args: [{ code: "RESULT_EXPIRED", id: "k7q2m3x9ab", retentionMs: 1_800_000, check: "raft message read --target \"#ops\"" }],
      },
      {
        title: "different CLI version, nothing ran",
        args: [{ code: "PROGRAM_CHANGED", id: "k7q2m3x9ab", mayHaveTakenEffect: false, rerun: "raft message send --target \"#ops\" <<'RAFTMSG'\n<your message>\nRAFTMSG", check: "raft message read --target \"#ops\"" }],
      },
      {
        title: "no longer resumable by this CLI, a later question in the exchange",
        args: [{ code: "UNKNOWN_COMMAND", id: "k7q2m3x9ab", mayHaveTakenEffect: true, rerun: null, check: "raft message read --target \"#ops\"" }],
      },
      {
        title: "the command changed after it was answered",
        args: [{ code: "REPLAY_DIVERGED", id: "k7q2m3x9ab", mayHaveTakenEffect: true, rerun: null, check: "raft message read --target \"#ops\"" }],
      },
      { title: "no such option", args: [{ code: "INVALID_ANSWER", id: "k7q2m3x9ab", category: "no_such_option", ask: FRESH_REPLIES_ASK, choice: "d" }] },
      { title: "option needs text", args: [{ code: "INVALID_ANSWER", id: "k7q2m3x9ab", category: "missing_input", ask: FRESH_REPLIES_ASK, choice: "b" }] },
      { title: "option takes no text", args: [{ code: "INVALID_ANSWER", id: "k7q2m3x9ab", category: "unexpected_input", ask: FRESH_REPLIES_ASK, choice: "a" }] },
      { title: "already answered", args: [{ code: "ALREADY_ANSWERED", id: "k7q2m3x9ab", previous: { choice: "a", withInput: false }, answeredAt: EXPIRES_AT - 300_000 }] },
      { title: "being answered", args: [{ code: "IN_PROGRESS", id: "k7q2m3x9ab" }] },
      {
        title: "could not save after a step ran",
        args: [{ code: "STORE_FAILED", id: "k7q2m3x9ab", operation: "write", mayHaveTakenEffect: true, rerun: null, check: "raft message read --target \"#ops\"" }],
      },
      { title: "could not read before anything ran", args: [{ code: "STORE_FAILED", id: "k7q2m3x9ab", operation: "read", mayHaveTakenEffect: false, rerun: null, check: null }] },
      {
        title: "a command's first question could not be saved, after steps",
        args: [{ code: "STORE_FAILED", id: null, operation: "write", mayHaveTakenEffect: true, rerun: null, check: "raft message read --target \"#ops\"" }],
      },
      {
        title: "a command's first question could not be saved, before any step",
        args: [{ code: "STORE_FAILED", id: null, operation: "write", mayHaveTakenEffect: false, rerun: "raft message send --target \"#ops\" <<'RAFTMSG'\n<your message>\nRAFTMSG", check: null }],
      },
    ],
  },
);
