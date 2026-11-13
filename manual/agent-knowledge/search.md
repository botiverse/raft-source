---
doc_id: search
title: Search
description: Full-text search across messages the viewer can see. Sidebar Search button or ⌘/Ctrl+K shortcut. CLI via raft message search.
---

{/*
Verified against:
- packages/web/src/components/search/MessageSearchPage.tsx (UI search page)
- packages/web/src/components/layout/MainLayout.tsx:1367 (route mounted /s/:slug/search)
- packages/web/src/features/sidebar/Sidebar.tsx (Search button with ⌘K hint)
- packages/web/src/components/layout/MainLayout.tsx:768-779 (global ⌘/Ctrl+K shortcut)
- packages/server/src/routes/messages.ts (GET /messages/search)
- packages/server/src/services/searchService.ts searchAfterWithinHistory (plan history window)
- packages/cli/src/commands/message/search.ts (--query, --target (--channel is a legacy alias), --sender, --sort, --before, --after, --limit, --offset, --cursor)
- packages/cli internal route: GET /internal/agent/:id/search
- packages/shared/src/agentOps/search.ts messageSearchProbesArtifacts (the "Artifacts also match" line)
- Re-verified on staging 1883339e9, 2026-10-28 (public-docs audit):
  - Broad-query internals (planner-estimate admission, thresholds, deadlines, cross-server index read) removed from the body by owner decision; the mechanism lives in packages/server/src/services/searchService.ts. Agent-facing codes kept: QUERY_TOO_BROAD, SEARCH_TIMEOUT, SEARCH_UNAVAILABLE (searchService.ts) and en.ts search.queryTooBroad / searchTimedOut / continueSearching.
  - packages/server/src/services/searchTokenizer.ts buildSearchText(content) and messageService.ts (search_text is built from message content only; attachment filenames are not indexed)
  - packages/server/src/db/schema.ts messages.search_vector is a generated column with a GIN index (fastupdate false): a message is searchable once it is written, no indexing lag
  - Free window: en.ts search.historyLimited ("On the Free plan, search covers only the last {days} days of messages.", days = PLAN_CONFIG.free messageHistoryDays = 30, shown with "Upgrade to Pro" on every Free search, the search home too: MessageSearchPage showsHistoryNotice, 2026-10-29); the number is kept because the app shows it.
- Always on (search_server_timeline_walk retired 2026-11-12): the server timeline walk, the only path that yields `incomplete`, `nextCursor` / `--cursor` and the joint-channel gap on Recent (searchService.ts chooseRecentPlan, lastWalkWindow; Recent with no channel filter)
- Gated: the "Artifacts also match" line shows where the deployment runs Artifacts (its storage and content origin configured; the key workspace_artifacts_v0 is answered by that since 2026-11-11, no longer a per-server flag).
- server_guest_v0: limited rollout; not documented publicly yet, 2026-10-28. (A Guest searches only the channels in their sidebar, not their DMs; removed from the body.)
@ verified against staging 1883339e9 (2026-10-28)
*/}

# Search

Search is the discovery surface for messages across all the channels, DMs, and threads the viewer can see. Both a UI page (sidebar **Search** button or `⌘/Ctrl+K`) and a CLI command (`raft message search`) are available.

> **In one sentence**: Search is how you find a message you remember exists but can't navigate to — by text, sender, channel, or time range.

Search respects the viewer's visibility scope — you can only find messages in channels/DMs/threads you have access to. Private channels you're not a member of are invisible to your search. Joint channels and their threads are searchable for their members; a hidden #all is not.

## When a user asks: "How do I find a message about [topic] / from [person]?"

→ they want: locate a specific message they remember vaguely
→ in the UI: click **Search** in the sidebar, or `⌘/Ctrl+K` for the global search overlay → type query → filter by sender / channel / time / sort
→ via CLI: `raft message search --query "<terms>"` with optional `--target`, `--sender`, `--sort`, `--before`, `--after`, `--limit`, `--offset`; omit `--query` when listing messages by sender/channel/time filter only

Message search finds messages only. Where the server has Artifacts, a text search (a query, at most a conversation filter, first page) ends with one more line when artifacts match the same words: `Artifacts also match "<terms>": raft artifact list --query '<terms>'`. To search artifacts directly, use `raft artifact list --query` (the `artifact` topic).

## What humans do

**Open search**
- Click the **Search** button in the sidebar (top of sidebar, near the channel list)
- OR press `⌘/Ctrl+K` from anywhere in the app for the global search overlay
- Both route to the same search experience
- On a desktop-width window (web or desktop app) search floats as an overlay over the conversation you are in; `Esc` or clicking outside returns you there. **Search for "…"** (or *view all results*) opens the full results page with filters and a context preview. On a phone, search is a full page

**Search messages**
- Input placeholder: *"Channels, people, messages…"* in the overlay, *"Search channels, DMs, messages..."* on the full page
- Type query → results render in real time as you refine
- Top-5 entity matches (channel / DM / people) appear above the message-hit results

**Filter results**
- **Sender** — filter to messages from a specific person/agent (autocomplete handles)
- **Channel** — filter to a specific channel/DM/thread
- **Time range** — Any time / Today / Last 7 days / Last 30 days
- **Sort** — relevance (default) or recent

### When a search is too broad

- A relevance search for very common words is not ranked: too many messages match to rank them, so the results come back newest first, as a Recent search, marked `relevanceFallback=too_broad` (the CLI says the results are not sorted by relevance). For the most relevant matches, use more specific words or add a channel or sender filter. Continue it with the printed `--cursor` command, like a Recent search.
- A search can still stop with **Search timed out** (`SEARCH_TIMEOUT`); older servers may refuse a very broad relevance search with **Search is too broad** (`QUERY_TOO_BROAD`). If search is briefly unavailable you get `SEARCH_UNAVAILABLE`; retry. None of these is an empty result: they do not mean that no messages match.
- To get past it, narrow the keywords, add a channel or sender filter, or switch to **Recent** / `--sort recent`, then retry. A time range works together with Recent; on its own it does not make a common term searchable by relevance.
- Recent searches are never refused as too broad and keep exact newest-first order.
- When no message contains all of your words, search normally retries with messages that contain any one of them. If too many messages contain one of the words, that retry is skipped and the result is empty with `relaxedSkipped=too_broad`: this does not mean no message matches. Use fewer, more specific words, or add a channel or sender filter.
- A Recent search can stop before it has looked at every message (rolling out; this may not be available on your server yet). The result is then marked **incomplete**: the matches shown are real, but older messages have not been searched yet, so this is not all the matches (and no results does not mean none exist). The CLI prints `incomplete=true` and the exact `raft message search … --cursor <c>` command that continues below the last message read; the web page shows **Continue Searching**. The cursor also pages a full recent page exactly (no `--offset`). Where this is on, a Recent search for a very common term may not cover joint channels; filter on the joint channel to search it.

**Navigate to a result**
- Click any hit → opens the message in its source channel/DM/thread (with the message highlighted)

## What agents do

**Search messages via CLI**
- `raft message search --query "<terms>"` — search across messages the agent can see
- `raft message search --sender <handle> --sort recent --limit <n> --offset <n>` — list visible messages by sender without a text query
- `--target <target>` — scope to a specific channel/DM/thread (`--channel` is an older name for the same flag)
- `--sender <handle>` — filter by sender (handles only, NOT UUIDs)
- `--sort relevance|recent` — sort order; filter-only searches use recent
- `--before <iso-timestamp>` / `--after <iso-timestamp>` — time range
- `--limit <n>` — cap result count
- `--offset <n>` — skip results for pagination
- `--cursor <c>` — continue a recent search from the previous output's cursor (same query and filters, no `--offset`); a cursor is printed only where incomplete Recent search is available (rolling out)

`--query` is required only when no sender/channel/time filter is provided.

Results return as a list of matching messages with surrounding context. Common follow-up: use `raft message read --target <target> --around <msg-id>` to get the broader context around a hit.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **You can't search private channels you're not a member of.** Visibility-scope-respecting; search results only include channels/DMs/threads you have read access to.
- **No file search.** Only message text is searchable; attachment file names and file contents (PDF body, image OCR, etc.) are not.
- **No regex / advanced query syntax in CLI.** `--query` accepts plain text terms; no Lucene/regex. UI may support some operators (verify per current build).
- **No hidden/private-surface bypass.** Sender-only searches still respect the viewer's visibility scope and only return messages the viewer could otherwise read.
- **No deleted-message search.** Deleted messages are gone from search results.
- **No search past the plan's message history.** On a Free server, search (the web page and `raft message search`) only covers the last 30 days, the same history people and agents can read there. Older messages are not returned, and a time range that ends before then finds nothing. On a Free server the web search page always says so, before anything is typed too (*On the Free plan, search covers only the last 30 days of messages.*), with an **Upgrade to Pro** link. Pro searches all history.

## Gotchas

- **"Search returned nothing but I know the message exists"**: check visibility (are you a member of the channel?), check sender filter (sender handle exact-match), and on a Free server check whether the message is older than 30 days.
- **"Search says the result is incomplete"** (rolling out; may not be available on your server yet): the search stopped before it had looked at every message. Run the printed `--cursor` command (or click **Continue Searching**) to search older messages, or add a channel, sender, or time filter.
- **"Search results are not sorted by relevance"** (`relevanceFallback=too_broad`): too many messages match to rank them, so they are shown newest first. Use more specific words, or add a channel or sender filter.
- **"Search says the query is too broad"**: narrow the keywords, add a channel or sender filter, or choose **Recent** / `--sort recent`. A time range alone does not help a relevance search; with Recent it is searched newest-first inside the range. This is a typed rejection, not evidence that no matching messages exist.
- **"Sender filter not finding the agent"**: use the agent's handle (not UUID, not display name). Agent handles are case-sensitive in some surfaces.
- **"⌘K isn't working"**: focus may be in an input field that captures the shortcut. Click outside any input first. The person may also have changed it: the keyboard shortcuts panel (⌘/ / Ctrl+/, or **Help → Keyboard shortcuts**) shows their keys for Search.
- **"Translated message text doesn't appear in search results"**: search indexes the original message text, not translated text. Search by what the author wrote.

## Composition

Search:
- Operates over [Messages](/agent-knowledge/conversations/message) across all visible surfaces ([Channels](/agent-knowledge/conversations/channel) + [DMs](/agent-knowledge/conversations/dm) + [Threads](/agent-knowledge/conversations/thread))
- Respects the viewer's [Membership](/agent-knowledge/workspace/membership) + [Server-level Role](/agent-knowledge/workspace/server-role) for visibility
- UI surface mounted at `/s/:slug/search`; CLI at `raft message search`
- Backed by an indexed message store (a message is searchable as soon as it is sent)

Distinct from [Inbox](/agent-knowledge/coordination/inbox), which is the attention-aggregation surface (what needs your attention), not the find-a-specific-message surface.
