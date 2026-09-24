---
doc_id: metric-safe-vocabulary
title: Metric-safe vocabulary
description: Terms agents must not misread when answering Raft questions — distinctions that, if conflated, lead to wrong user-facing answers about behavior or data.
---

# Metric-safe vocabulary

When an agent answers a user question that touches data, behavior, or state, certain terms have look-alike pairs where one is the actual fact and the other is an inference that's frequently wrong. Get these distinctions right or the answer to the user is wrong.

> **In one sentence**: These are the wrong-vs-right pairs an agent has to keep straight when answering Raft questions about state, data, or behavior.

This is a support-safety glossary, not an analytics doc.

## The pairs

| Distinguishable term | What it ACTUALLY means | Common wrong inference |
|---|---|---|
| **OA broadcast marker** | Raft auto-sent the owner-onboarding instruction message | Agent authored a chat message (it didn't — the marker only proves the broadcast went out) |
| **Current agent model config** | What model the agent is configured to use right now | What model the agent invoked historically (configs change; historical runs may have used different model) |
| **Action card prepared** | An agent created a card and posted it | A human clicked the card and completed the action (cards exist long before / without being clicked) |
| **Action card opened** | A human clicked the card's action button | A human submitted the dialog (opening the dialog ≠ committing) |
| **Action card succeeded** | Dialog was submitted + action completed without error | The underlying behavior is now in effect (state propagation may lag) |
| **Joined server** | User accepted invite + has Membership | User created the server (different paths to same state) |
| **Created server** | User is the server's creator (and initial owner) | Joined by invite (creator-vs-joiner distinguish in onboarding metrics) |
| **Active agent status** | Agent's runtime state is `online` | Agent has sent any message recently (state is what daemon reports, not message activity) |
| **Sent agent message** | Agent actually authored + posted a message | Agent has any presence in the channel (presence ≠ activity) |
| **System message** | Raft auto-generated (e.g. "X joined this channel") | Chat message authored by a human or agent |
| **Chat message** | Authored by human or agent | Includes system messages (which are NOT chat messages) |
| **First OA reply** | The owner (a human) responded to the auto-onboarding message | The onboarding wizard's "I'm done" event (different signal) |
| **First agent invocation** | Agent's first runtime turn for this user | Agent's existence (agents exist after create; first invocation is the first runtime activity) |
| **First 24 hours after the event** | The 24-hour window starting at the event timestamp | Day 0 / today / right after (always 24-hour rolling) |
| **Channel created** | Channel exists with `channel:created` event | First message in channel (creation event vs first-message event differ) |
| **Reminder fired** | The scheduled time elapsed AND the daemon delivered to the author | The author woke up and responded (firing ≠ being-acted-on) |
| **Task `in_progress`** | Someone claimed the task | Someone is actively working on it right now (claim is status; activity may pause without unclaiming) |
| **Agent `working` status** | Agent has an active turn running tools / processing | Agent is producing output (working can be silent for long stretches) |

## How to use this in practice

When answering a user question that involves any of these terms, **pick the actually-true side of the pair**:

- User asks "did my agent ever message me?" → check actual chat-message authorship, don't infer from active status or broadcast markers
- User asks "is my action card done?" → check `committed`/`succeeded`, not `prepared`/`opened`
- User asks "is this server new?" → "first member joined recently" ≠ "server created recently" (could be a long-time server that just got its first invite)

## Anti-patterns

- ❌ "Your agent has been active" → ✅ "Your agent's status is `online`" (more precise) OR "Your agent sent X messages this week" (different fact)
- ❌ "The OA messaged you a setup guide" → ✅ "Raft sent you the auto-onboarding broadcast" (the OA didn't author it; the system did)
- ❌ "The action card completed" → check whether it was `prepared / opened / succeeded` — these are different states
- ❌ "Reminder went off" → "Reminder fired" if confirmed delivered; "Reminder is past its scheduled time but didn't fire" otherwise

## Composition

This page is the support-safety glossary. It complements:
- [Voice & Tone](/agent-knowledge/cross-cutting/voice-and-tone) — broader voice rules
- [Terminology Canon](/agent-knowledge/cross-cutting/terminology-canon) — wrong-word → right-word
- Each concept page's "Gotchas" section — concept-specific reading-errors agents should avoid

The pairs above are derived from observable Raft product behavior + agent-facing concepts only.
