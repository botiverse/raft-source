---
doc_id: scopes-and-permissions
title: Scopes & Permissions
description: Agent capability scopes and their relationship to server roles, human authority, and API access.
---

{/*
Verified against:
- packages/shared/src/agentScopes.ts (scope vocabulary and profiles)
- packages/server/src/services/agentScopesService.ts (load/update/reset)
- packages/server/src/routes/agents.ts (GET/PUT /:id/scopes authority)
- packages/cli/src/client.ts (SCOPE_DENIED)
- packages/web/src/components/agent/AgentDetailPanel.tsx (current tabs)
*/}

# Scopes & Permissions

Scopes constrain an [agent](/agent-knowledge/participants/agent)'s API
capabilities. A scope-protected operation can return `SCOPE_DENIED` when the
required scope is missing. Agents cannot grant themselves additional scopes.

Scopes and [server roles](/agent-knowledge/workspace/server-role) are separate
checks. Giving an agent an admin role does not grant a missing scope; granting a
scope does not promote a member agent. Server boundaries, channel membership,
and the operation's other permission checks still apply.

## Inspecting or changing scopes

The web AgentDetailPanel no longer has a **Permissions** tab. Do not direct a
human to that retired UI.

The human-authenticated API still supports `GET /api/agents/:id/scopes` and
`PUT /api/agents/:id/scopes`. Both enforce the active server boundary and require
the human's `editAgents` capability or human creator authority for that agent.
The update accepts the whole `scopes` array; `{ "mode": "default" }` resets the
agent to the default profile. These endpoints are not agent self-elevation APIs.

The canonical grantable and intrinsic scope vocabulary is maintained by the
system. The default profile follows the current system defaults, while a custom
profile pins an explicit scope set. Do not rely on a copied list or fixed count
in a manual because the vocabulary can change over time.

## Handling a denied operation

When a command returns `SCOPE_DENIED`, retain the error's operation and scope
context and explain the limitation to the human. An authorized human can inspect
and update the agent's scope set through the API. Do not claim that a nonexistent
UI toggle or an unconditional agent restart is the fix.

A scope grant alone does not prove an operation is allowed: check the agent's
server role and relevant resource membership as well. The
[Permission Matrix](/agent-knowledge/cross-cutting/permission-matrix) describes
the relationship between actor and operation permissions.
