---
doc_id: terminology-canon
title: Terminology Canon
description: Wrong-word → right-word table for Raft concepts. Synonyms, forbidden words, brand vs technical naming. Grep your draft for the left column.
---

# Terminology Canon

The right word matters. Raft has product nouns; many things have common synonyms or near-synonyms that mislead. This page is the canonical wrong-word → right-word table. Grep your draft for the left column before sending; if you find any, switch to the right column.

> **In one sentence**: When in doubt, use the Raft product name (right column), not the synonym (left column).

## The table

| ❌ Wrong / sloppy | ✅ Right |
|---|---|
| `bot` | `agent` |
| `chatbot` | `agent` |
| `AI assistant` | `agent` |
| `AI agent` | `agent` (drop the "AI" prefix) |
| `agentic` | (don't use; describe the actual thing) |
| `AI-native` | `agent-native` if needed (avoid otherwise) |
| `personal agent` | (avoid; that's a different positioning Raft doesn't claim) |
| `workspace` (in product surfaces) | `server` (the actual product noun) |
| `workspace` (in casual reference) | OK in passing — "Raft is a workspace where..." — but switch to `server` when naming the actual object |
| `daemon` (in user-facing content) | "the Raft app on your computer" / "the local Raft process" — keep `daemon` for technical context only; below-the-line for most users |
| `machine` (when describing the host) | `computer` (the UI button + concept is "Computer") |
| `prompt` (the thing humans say to agents) | `message` (Raft uses messages, not prompts; agents aren't called via prompts) |
| `conversation` | `channel` / `thread` / `DM` (clarify which) |
| `room` | `channel` / `DM` (clarify which) |
| `chat history` | `messages` / `message history` |
| `notifications panel` | `Notifications` (the Settings tab) OR `Inbox / Activity` (the in-app aggregation) — clarify which |
| `inbox` (generic) | `Inbox` (Raft's specific surface) |
| `mute notifications` | `mute this server` (the actual scope of the toggle today) |
| `pin a message` | (doesn't exist — say "save a message" if user means bookmark, or "convert to task" if tracking) |
| `direct message` (lowercase generic) | `DM` (Raft's UI uses "DM" in surface text) |
| `group chat` | `DM` (Raft's DM supports 1:1 and group; both are "DM" in product) |
| `archive a channel` (verbose) | "Archive Channel" (verbatim button text) |
| `delete account` | (doesn't exist in UI — say "Log out" or "contact Raft to delete") |
| `change @handle` | (doesn't exist — handle is immutable; display name is editable) |
| `dark mode toggle` | (doesn't exist; no theme picker today) |
| `leverage` / `unlock` / `supercharge` | (don't use — banned per Raft voice; describe the actual action) |
| `seamless` / `seamlessly` | (drop entirely) |
| `synergy` / `synergistic` | (drop entirely) |
| `revolutionary` / `groundbreaking` / `next-gen` | (drop entirely) |
| `intuitive` / `delightful` / `magical` | (drop entirely) |
| `ecosystem` | (avoid unless specifically referring to the runtime ecosystem) |

## Sub-section: voice/positioning vs. product nouns

**Product nouns** (right column above) are immutable — that's what the UI calls them.

**Voice/positioning words** (the bottom rows — leverage, seamless, etc.) are about tone. They're not factually wrong; they're cliché or import positioning Raft doesn't make. See [Voice & Tone](/agent-knowledge/cross-cutting/voice-and-tone) for the broader rules.

## Sub-section: terms commonly invented by agents (and the corrections)

These are things agents tend to make up. Don't.

- ❌ "Raft workspace" (as a noun) → ✅ "Raft server" / "your server"
- ❌ "Raft bot" → ✅ "Raft agent" / "your agent"
- ❌ "Slack-like" framings → ✅ "Raft supports channels / DMs / threads; here's how"
- ❌ "AI-powered chat" → ✅ "agent-driven chat" or just describe the agent's behavior
- ❌ "Smart inbox" → ✅ "Inbox"
- ❌ "Cloud server" (referring to compute) → ✅ "Computer" (in Raft terminology) — keep cloud-server for actual cloud-providers, not Raft concepts

## Composition

This page complements:
- [Voice & Tone](/agent-knowledge/cross-cutting/voice-and-tone) — broader rules on register, sentence shape, anti-patterns
- [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have) — explicit list of features that don't exist (so agents don't invent them)
- Each concept page's "What it CAN'T do" section — local-to-concept limits
