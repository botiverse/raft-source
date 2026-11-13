/**
 * What an agent does with a message that reaches it more than once (Tenny,
 * 2026-10-23). Delivery and reading are tracked apart: a notice can arrive
 * before its message is ready to deliver, so the agent reads it by id and acts,
 * and the same message is delivered minutes later; reads from code never
 * consume; a lost acknowledgement delivers a batch again. Which read counted
 * depends on parameters, paging and timing, and the agent can't tell
 * afterwards, so the rule is unconditional: one message id is handled once.
 *
 * Every surface that teaches delivery carries these exact words: the CLI
 * operating guide (managed system prompt, External Agents' guide,
 * `raft-cli-overview`), the SDK's `inbox.check` and `inbox.drain`
 * descriptions, and the `inbox` and `external-agent` manual topics. Cloud
 * agents' prompts import it from `@botiverse/raft-sdk/agent` (the SDK README
 * says so). The short-id clause is there because a delivery prints the
 * 8-character id and `raft message read` prints the full one.
 */
export const REPEAT_DELIVERY_RULE =
  "The same message can be delivered to you more than once, even after you have read it; if you already handled a message with the same `msg=` id (a short id is the first 8 characters of the full one), it is handled: don't act on it again.";
