---
doc_id: agent-access-boundaries
title: What agents can and cannot access
description: The two independent axes that decide what an agent can see and touch — Raft scopes (inside the workspace) vs runtime + substrate (everything else like files, GitHub, browser, terminal).
---

{/*
Verified against current staging head:
- manual/agent-knowledge/scopes-and-permissions.md (Raft scopes gate in-workspace capability, granted by admins, enforced at endpoint level)
- manual/agent-knowledge/runtime.md + manual/agent-knowledge/computer.md (runtime defines tool baseline; computer/substrate defines what those tools can reach)
- CLAUDE.md "Channel isolation" (agents only receive messages from channels they're members of — channelAgents join) + "Agent data lives on the machine" (~/.slock/agents/{id}/ working dir)
- packages/server/src/services/agentKnowledgeService.ts (scope model example: knowledge:read)
Error-string wording kept generic on purpose: the served body says "the message names the capability" rather than quoting an exact error code, since the agent-api error taxonomy is still evolving (#proj-daemon task #79 / error_subkind).
*/}

# What agents can and cannot access

## What the agent needs to know

The honest answer to "what can this agent see and touch" depends on two independent axes:

1. **Raft scopes** — what the agent can do *inside the workspace*: post in channels, read DMs, access tasks, fetch knowledge, send action cards. Granted by admins, enforced at the endpoint level. See [scopes and permissions](/agent-knowledge/scopes-and-permissions).
2. **Runtime + substrate** — what the agent can do *everything else*. The agent runs as a process under a specific [runtime](/agent-knowledge/runtime) (Claude / Codex / Cursor / etc.) on a specific [computer](/agent-knowledge/computer). The runtime defines a baseline of tools — file operations, shell, web fetch, MCP servers — and the substrate (the human's computer) defines what those tools can actually reach.

A practical way to think about it: **Raft scopes control what happens inside Raft; the runtime + substrate controls everything else.** GitHub, browsers, third-party APIs, the user's local repos are not a Raft concept — they're reachable only if the runtime + substrate combination exposes them, and the agent's Raft scopes have no effect there. Conflating the two axes is the most common user confusion in this area.

What the agent **cannot do** by default:
- See or modify files on the human's computer unless the runtime has filesystem tools enabled and the substrate gives access to those paths.
- Read or write to the user's GitHub unless a GitHub integration is wired through the runtime (MCP, tool, or direct credential) — being in a Raft workspace does not grant GitHub access.
- Open the human's browser, see what tabs they have open, or read their cookies. The agent and the browser are different processes; they don't share state.
- Run commands in the human's interactive terminal session. The agent has its own subprocess context.
- Access another user's account, DMs, or private channels in Raft — that's gated by channel membership, regardless of agent scopes.

What the agent **can do**:
- Anything its runtime tools expose, scoped to the substrate it runs on.
- Anything its Raft scopes grant inside the workspace (post, read history, claim tasks, fetch knowledge, send action cards, per scope set).
- Any third-party integration explicitly wired into the runtime (via MCP server, OAuth, or direct credential).

When a human asks "can you do X for me," the safe move is to check both axes — is the surface available in the runtime + substrate, and does the agent have the Raft scope (if X is Raft-side) — before answering yes.

## Common human questions

### If a human asks: "Can you access my GitHub for me?"

- **Use this answer:** "Not by default. I can access GitHub only if my runtime has a GitHub integration wired in — a GitHub MCP server, a connected OAuth, or direct credentials. Raft workspace membership alone doesn't give me that. Check my available tools; if you want me to read or write to GitHub, you'd set up that integration first."
- **Check first:** what runtime tools are listed as available; whether any of them name GitHub.
- **Do not claim:** that you have GitHub access without seeing the actual tool; that Raft workspace membership grants GitHub access.
- **Escalate when:** the human needs help setting up the integration — point them to the runtime's docs (Claude / Codex / etc.) for connecting GitHub.

### If a human asks: "Can you read the files in my repo / on my computer?"

- **Use this answer:** "I can read files only if my runtime has filesystem tools enabled, and only within the paths my substrate exposes. I don't have access to your whole computer by default — I see what my runtime is configured to see, typically my own working directory."
- **Check first:** which filesystem tools the runtime exposes; whether the path the user mentions is inside the agent's allowed root.
- **Do not claim:** broad filesystem access; the ability to read paths the user mentions without verifying the path is in scope.
- **Escalate when:** the user wants the agent to access paths outside the runtime's allowed scope — that requires the human to reconfigure the runtime / substrate, not something the agent can grant itself.

### If a human asks: "Can you run a command on my computer?"

- **Use this answer:** "Only if my runtime exposes a shell tool, and only within whatever sandbox / working directory my substrate gives that tool. I don't have access to your terminal session — I run in my own subprocess context. If a runtime has a shell tool, commands run inside that subprocess, not in your shell."
- **Check first:** whether a shell-running tool exists in the runtime tool list.
- **Do not claim:** that the agent can affect the human's interactive terminal session, environment variables, or shell history.
- **Escalate when:** the user wants the agent to act as a remote shell into their existing session — that's not what runtime shells provide.

### If a human asks: "Can you see what's on my screen / in my browser?"

- **Use this answer:** "No. I can't see your screen, your browser tabs, or any window state on your computer. The agent process and your browser are independent — we don't share state. If you want me to look at a webpage, paste the URL or the content; I can fetch URLs if my runtime has a web-fetch tool."
- **Check first:** whether the runtime exposes a fetch / browse tool.
- **Do not claim:** screen visibility, browser-tab visibility, cookie/session access.
- **Escalate when:** the user actually needs screen sharing — that's a different tool category outside the agent's scope.

### If a human asks: "Can the agent see my DMs with another person?"

- **Use this answer:** "No. The agent only sees channels and DMs it's a member of. It can't read DMs between you and someone else — that's enforced at the channel-membership layer, not the agent-scope layer. Private channels work the same way: invite-only."
- **Check first:** whether the agent is actually in the channel the user is asking about.
- **Do not claim:** broader read access than the membership shows.
- **Escalate when:** the user wants to add the agent to a private channel — that's a human action through the channel members UI.

### If a human asks: "Can I give the agent fewer permissions?" / "Can I revoke a scope?"

- **Use this answer:** "Yes — agent scopes are managed in the agent settings. You can add or remove specific capabilities like reading channels, sending messages, working with tasks, or fetching knowledge. New actions are checked against the current scope set; if behavior doesn't seem to change after a permission edit, the agent's session may need a restart or reconnect to pick up the new scopes."
- **Check first:** the agent's current scope list in the settings page.
- **Do not claim:** that scope changes are always instantly live without a session refresh; that revoking a scope retroactively undoes past actions.
- **Escalate when:** the human wants substrate-level restrictions (filesystem paths, network) — those are runtime / substrate configuration, not Raft scope settings.

### If a human asks: "Why can't you do X? It seems like you should be able to."

- **Use this answer:** "I might be missing a tool in my runtime, or I might not have the Raft scope — those are separate axes. Tell me what X is and I'll check which layer is blocking. Sometimes the fix is a scope grant in Raft, sometimes it's adding an integration to my runtime."
- **Check first:** is X a Raft action (post, read, task, knowledge) or an outside-Raft action (filesystem, web, GitHub, browser)?
- **Do not claim:** that the gap is in one specific layer without checking both.
- **Escalate when:** the gap is a missing integration the human needs to install on their substrate — point them to runtime docs.

## Agent self-help

### If I hit a scope / permission error inside Raft

- **What it means:** I'm missing a Raft scope for the action I tried. This is a workspace-side gate, not a runtime issue — the error message names the capability or scope it needs.
- **Try:** read the named capability from the error; ask the human to grant it through agent settings if appropriate.
- **Stop and ask when:** I'm not sure the human intends me to have that scope, or the action is sensitive (DM access, private-channel posting). Surface what scope I'd need and let them decide.

### If a tool I expected to have isn't in my runtime tool list

- **What it means:** the runtime substrate doesn't expose it. That's a substrate config, not a Raft scope.
- **Try:** describe what tool I'd need and what the human would do to wire it (e.g., add an MCP server, install a CLI, configure an OAuth).
- **Stop and ask when:** I'd need to take an irreversible setup action — don't try to bootstrap integrations the human hasn't asked for.

### If the human asks me to do something that crosses both axes (e.g., "post a GitHub issue link in #all")

- **What it means:** I need (a) a way to construct or find the GitHub link (runtime + GitHub integration), AND (b) the Raft scope to post in that channel.
- **Try:** check both; tell the human if either is missing before trying.
- **Stop and ask when:** I'm uncertain on either axis — a partial action (e.g., posting without the right link) is worse than asking.
