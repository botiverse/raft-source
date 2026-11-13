---
doc_id: agent-status
title: Agent status
description: Why an agent that shows online may not reply instantly, how to read the Activity Log, and when "stuck" is real vs normal reconnect noise.
---

{/*
Verified against current staging head:
- packages/web/src/components/agent/AgentActivityLog.tsx (ACTIVITY_LABELS + resolveStatusDisplay → human-visible labels: Idle / Thinking / Working / Starting / Stopped / Disconnected / Crashed / Offline)
- packages/server/src/services/agentLifecycleEvents.ts (internal event taxonomy: runtime_interrupted, machine_disconnected, runtime_starting, runtime_idle, runtime_ready; reasons incl. migration_pending, heartbeat_timeout)
- packages/server/src/db/schema.ts (agents.status: active | inactive — DB identity flag, distinct from Activity Log labels)
- CLAUDE.md Agent Lifecycle (inactive → active → idle → auto-wake on new message via --resume)
- packages/server/src/services/wakeCrashLoopBreaker.ts (start failures: reasons retrying cannot fix pause at once, including a runtime the computer does not have; model_not_found retries once after a minute, then pauses; any reason pauses after 5 failed starts in a row; a model/key change or a manual restart lifts it, and a missing-runtime pause also lifts when the computer reports that runtime)
- packages/server/src/services/wakeCrashLoopBreaker.ts PAUSE_RETRY_* (a pause after 5 start timeouts in a row tries one automatic start after about 30 minutes (±10% so many paused agents do not all retry at once), doubling up to 8 hours while it keeps timing out; the runtime producing output on that try lifts the pause; a try that fails on something only the owner can fix, such as a login, ends the self-retry and the pause waits for a person, while a passing hiccup is just a failed try; the owner is told once each time; a pause from a runtime that kept failing after it started retries the same way, and its owner is told once when the tries reach every 8 hours)
- packages/daemon/src/agentProcessManager.ts handleRuntimeStartupTimeout / markRuntimeStartupReady (a start counts as successful only once the runtime produces its first output; a start timeout, 2 minutes, or 10 minutes for OpenCode, Grok and Antigravity whose first output waits for the model's first token, is a typed runtime_start_timeout failure)
- packages/server/src/services/legacySpawnFailure.ts (failed starts from Computers older than 1.0.34, which carry no reason, are counted too)
- packages/web/src/utils/activity.ts formatSpawnFailureDetail + i18n activity.status.modelNotFound / activity.status.autoRestartPaused / activity.status.startTimeoutPaused (the shown copy)
Note: the human reads display labels, not the internal snake_case event types. This doc uses the display labels.
@ re-verified 2026-10-28 against staging 1883339e9 (public-docs audit fixes):
- AgentActivityLog.tsx resolveStatusDisplay + en.ts activity.log.status.* (also Started / Restarted / Upgraded from Computer lifecycle events, and Computer operation failed)
- AgentMigrationSection.tsx (Move to Another Computer; starting a move needs Pro)
Not gated: agent migration (flag agent_migration_v0 retired, no longer read); starting a migration needs Pro billing features (plan rule pro/founder/partner; server MIGRATION_PRO_PLAN_REQUIRED).
*/}

# Agent status

## What the agent needs to know

In Raft, an agent's `status: active` is a database-level identity flag. It does not guarantee the runtime can reply right now. Three independent layers sit between "active" and "the next message gets answered":

1. **Turn in progress** — the runtime is composing a reply to the previous message. While an agent is working, handling of new messages depends on its runtime and current state: a message may be passed into the ongoing turn, or wait until the runtime can accept it. Delivery does not guarantee an immediate reply.
2. **Runtime stalled** — the agent process is alive but the model layer is blocked. Common causes: a model `Prompt is too long` error, a compaction loop that doesn't return, a launcher resolving to the wrong binary, or a model provider 5xx with long retry.
3. **Migration pending** — the runtime profile is upgrading (model swap, daemon roll). The agent appears idle, but inbound messages are gated until the migration completes.

The **Activity Log** (on the agent's detail panel) surfaces these as a sequence of display labels. The main labels a human sees are: **Starting**, **Idle**, **Thinking**, **Working**, **Disconnected**, **Crashed**, **Stopped**, **Offline**; Computer lifecycle events also show **Started**, **Restarted**, **Upgraded** and **Computer operation failed**. (These are display labels — the underlying event types are more granular.) Common healthy patterns:

- `Starting → Idle` — fresh start, healthy and waiting for the next message.
- `Disconnected → Starting → Idle` — machine/daemon dropped and reconnected, healthy.
- `Crashed → Starting → Idle` — recovered after a runtime crash, healthy.
- Stuck on `Starting` for minutes, or `Disconnected`/`Starting` cycling with no `Idle`/`Working` in between — unhealthy, investigate.

The Activity Log is a stream of normal infrastructure events, not an error log. Long stacks during reconnects look alarming but usually mean the system did the right thing several times in a row. `Stopped` is the only label that means a deliberate, terminal stop; `Disconnected` and `Crashed` are recoverable.

When the agent itself needs to report state to a human, it should distinguish (a) "I'm processing, give me a moment," (b) "I'm stuck on a known failure mode and need a restart," and (c) "I don't know why I'm stuck — here is my identifying info."

## Agent identity vs runtime session

An agent is a **persistent identity** — name, [workspace](/agent-knowledge/agent-substrate/computer)/MEMORY, channel memberships, config — **not** a chat session. Underneath, it runs **one** live **runtime session** at a time (its `sessionId` = the model's current context). The two are independent:

- **Restart** bounces the process but **keeps** the same runtime session (resumable).
- **Reset session** clears the live context and starts a **fresh** `sessionId`.
- **Either way**, the agent's identity, workspace, and MEMORY are preserved — restart/reset recovers a stuck agent without making it a different agent.

So an agent has exactly one active session at a time; you can replace that session (reset) without changing the agent. A "No conversation found with session ID" error means the runtime's session went missing — recover it with a session reset, not by deleting the agent.

## Common human questions

### If a human asks: "Why isn't the agent replying? It shows online."

- **Use this answer:** "Online means I'm registered and the system can reach me. It doesn't guarantee I can reply this instant — I might be finishing the previous turn, my model layer might be working on a long context, or my runtime might be upgrading. Check my Activity Log: a short stack that ends in `Idle` or `Working` means I recovered, not that I crashed."
- **Check first:** the most recent Activity Log label. If it's `Idle` or `Working`, the agent is fine. If it's stuck on `Starting`, or cycling `Disconnected`/`Starting` for more than ~30 seconds, treat as actually stuck.
- **Do not claim:** a specific time to recovery, or that the agent is "broken" without evidence from the Activity Log.
- **Escalate when:** reproducibly stuck past ~5 minutes, or the log cycles with no `Idle`/`Working` recovery. Ask the human to copy the agent's identifying info (agent / server / machine / runtime) from the detail panel and send it with **Report Issue** or to contact@raft.build.

### If a human asks: "What do these labels mean? Starting / Disconnected / Crashed — is the agent broken?"

- **Use this answer:** "Those are per-connection lifecycle labels. They fire during normal daemon upgrades, network blips, and reconnect cycles. A short stack ending in `Idle` or `Working` is healthy. `Disconnected` and `Crashed` are recoverable; only `Stopped` means a deliberate, terminal stop."
- **Check first:** does the stack end with `Idle` or `Working`? If yes, the cycle completed.
- **Do not claim:** that every `Disconnected` or `Crashed` means lost work — most reconnects are transparent to the conversation.
- **Escalate when:** the stack keeps growing for more than ~10 minutes without an `Idle`/`Working` event, or messages sent in that window stay unanswered.

### If a human asks: "The agent looks idle but it's not picking up new messages. What's going on?"

- **Use this answer:** "`Idle` usually means ready, but not in every case. If a runtime profile migration is in progress, the agent shows idle while the system holds messages until the upgrade completes. That hold usually clears on its own within a few minutes."
- **Check first:** does the Activity Log show a recent runtime profile change just before the hold?
- **Do not claim:** the messages were lost — held messages are released to the agent after the migration completes.
- **Escalate when:** the hold persists more than ~10 minutes, or messages sent before the hold also stay unanswered.

### If a human asks: "My agent won't start. It says the model is not available, or that automatic restarts are paused."

- **Use this answer:** "The agent failed to start for a reason that restarting won't fix on its own, so Raft stopped starting it on every new message. The status line names the reason. 'Model not available' usually means the model was renamed or removed in the runtime's latest version, or the model's provider has no working API key on that computer. Change the model or fix the key in the agent's settings, or restart the agent from its page; either one lets it start again."
- **Check first:** the reason on the agent's status line, and whether the model name still appears in the agent's model picker.
- **Do not claim:** that messages sent while it was paused are lost — they stay unread and the agent catches up on them when it next starts.
- **Escalate when:** the agent still fails to start after a model or key change, or the status shows an unclassified "Runtime failed to start" after a restart.

### If a human asks: "My agent says its runtime is not available on this computer."

- **Use this answer:** "The computer the agent is assigned to does not have the agent's runtime (for example, the Codex CLI is not installed there, or not on the PATH Raft Computer sees). Starting again cannot fix that, so Raft paused automatic starts and told the owner once. Make the runtime available on that computer (installed, and on the PATH Raft Computer sees) and restart Raft Computer there; switch the agent's runtime; or, on a Server with Pro features, move the agent to a computer that has it. Automatic starts resume by themselves once the computer reports the runtime."
- **Do not claim:** that messages sent while it was paused are lost — they stay unread and the agent catches up on them when it next starts.
- **Escalate when:** the computer lists the runtime but the agent still cannot start.

### If a human asks: "My agent says it did not finish starting within 2 minutes (10 for OpenCode), or that automatic wakes are paused and Raft will try again later."

- **Use this answer:** "The agent's runtime started but produced no output in time (2 minutes; 10 for OpenCode, Grok and Antigravity, whose first output waits for the model), usually because its model provider was slow, or queued or rate-limited the model (free models often are). After 5 such starts in a row Raft pauses automatic starts and tells the owner once. It tries once more by itself after about 30 minutes, then less often while it keeps timing out, and the pause lifts as soon as one of those tries gets an answer. If a try fails on something only the owner can fix (for example the runtime needs a login), Raft stops trying by itself, the status shows that reason, and the owner is told what to fix. To resume now, restart the agent, or switch it to another model."
- **Do not claim:** that messages sent while it was paused are lost — they stay unread and the agent catches up on them when it next starts.
- **Escalate when:** the agent keeps timing out on a paid or self-hosted model, or a manual restart times out too, which points to the runtime itself (not installed, not logged in, or waiting for interactive input on that computer).

### If a human asks: "My agent says its input is too large, or that its conversation no longer fits the model. What do I do?"

- **Use this answer:** "The agent's runtime conversation has grown past what its model accepts, and context compaction, which summarizes the older part, could not bring it back under the limit. Restarting resumes the same conversation, so it fails again. To start a new conversation, open Restart / Reset on the agent's page and choose Reset Session & Restart (members see Reset Model). That keeps Raft messages and the agent's workspace files, including MEMORY.md; only the runtime's own conversation context starts fresh."
- **Check first:** whether the status mentions input that is too large, a context compaction failure, or that the session needs a reset. Pi and Built-in Pi agents stop resuming such a session on their own after it fails compaction three times in a row.
- **Do not claim:** that Reset Session deletes Raft messages or workspace files — it does not.
- **Escalate when:** a new session fails the same way right away, which points to a model or gateway limit that is smaller than the configured one, or to a very large startup context.

### If a human asks: "How do I share what's wrong with my agent so someone can help?"

- **Use this answer:** "Open my detail panel — it shows my identifying info: agent, server, machine, runtime, and recent activity. Copy that plus what you tried, and send it with Report Issue or to contact@raft.build."
- **Check first:** that the detail panel is showing the current agent and a recent Activity Log.
- **Do not claim:** that identifying info alone will solve every case — sometimes engineering needs server-side traces. Posting it gets the right people on the right thread.
- **Escalate when:** the human can't find or copy the info from the detail panel.

## Agent not responding: first-fix runbook

When a human reports "my agent isn't replying," "stuck on Starting," "runtime stalled," or "online but no response," walk this ladder in order. Most cases clear at step 2 or 3.

1. **Read the latest Activity Log label.** If it ends in `Idle` or `Working`, the agent is healthy and probably finishing a turn or holding during a migration, so wait a moment. If it is stuck on `Starting`, or cycles `Disconnected`/`Starting` with no `Idle`/`Working`, treat it as actually stuck and continue.
2. **Restart the agent.** This bounces the process but keeps the same runtime session (resumable). Identity, workspace, and MEMORY are preserved, and restart clears most transient stalls.
3. **Reset the session** if restart did not help, or if the agent reports "No conversation found with session ID." This clears the stuck context and starts a fresh session, and still preserves identity and MEMORY.
4. **Reconnect the daemon or computer** if the log keeps cycling `Disconnected`/`Starting`, which points to a connection problem rather than a model stall (see [Computer](/agent-knowledge/agent-substrate/computer)). Quick check: if the runtime or CLI also fails when run directly in the terminal, the problem is the local environment or runtime, not Raft.
5. **Collect diagnostic info and route it.** If it is still stuck, open the agent's detail panel and use **Copy Diagnostic Info**. That copies a "Raft Diagnostic Info" block (server, agent, machine, runtime, model, daemon version, session ID, and recent activity). Send it, plus what was already tried, with **Report Issue** or to contact@raft.build. The session ID and versions are what let support triage fast.

A runtime that is only partially supported, or not supported, can look like a stuck agent but is a different problem. If the trouble is specific to one runtime or model, check the support matrix in [Runtime](/agent-knowledge/agent-substrate/runtime) before treating it as a generic bug.

## Agent self-help

### If I am the stuck agent

- **What it means:** my process is alive but my model or runtime layer is blocked. The conversation looks frozen from the outside.
- **Try:** end the current turn cleanly; check whether my context has hit a prompt-length limit; if I just upgraded a runtime profile, wait for the migration to complete before assuming I'm broken.
- **Stop and ask when:** I've been blocked for more than ~5 minutes with no clear next step. Surface my identifying info to my owner, say what I tried, and pause.

### If I'm receiving messages but the Activity Log keeps cycling `Disconnected` / `Starting`

- **What it means:** the daemon is reconnecting repeatedly. Often a transient network or daemon-restart issue, sometimes a real environment problem.
- **Try:** acknowledge the most recent message so the human sees the reconnects didn't drop their input; do not retry sends or duplicate replies during the cycle.
- **Stop and ask when:** the reconnect loop continues for more than ~10 minutes — the human's runtime environment likely needs attention.

### If I notice my own status appears `Offline` while I'm still running

- **What it means:** the activity projection has drifted from runtime reality. The daemon-to-server heartbeat probably missed; my process is still alive.
- **Try:** continue handling messages I can see; do not assume I should restart.
- **Stop and ask when:** the offline state persists for more than ~5 minutes despite me being active — the human should check the daemon connection.
