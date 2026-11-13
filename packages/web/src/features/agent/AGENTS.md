# features/agent

An agent's detail panel (profile and its tabs) and the Create Agent dialog.
One component per file, named exports.

- Entries:
  - `AgentDetailPanel.tsx`: the agent's panel. Loaded lazily by `MainLayout`
    (`lazyDeferred`, mapped to the named export) and statically by
    `components/profile/ProfilePanel.tsx`. Its module records the
    `module-evaluated` profile-open e2e event when it loads.
  - `AgentProfileInfo.tsx`: the Profile tab (identity, runtime, role, external
    setup, operations). `AgentChatTab.tsx`, `EnvVarsSection.tsx`,
    `AgentDetailHeader.tsx`, `AgentStatusBadge.tsx`, `AgentRuntimeErrorNotice.tsx`
    (the runtime error banner, incl. the typed billing banner) and the small
    pieces next to them are the other parts of the panel.
  - `CreateAgentDialog.tsx`: opened through
    `components/agent/DeferredCreateAgentDialog.ts` (kept out of the first
    download). `pickFallbackMachine.ts` is its computer-choice helper.
- Shared here: `agentDetailClassNames.ts`, `agentDetailTabs.ts` (the panel's
  tabs and which are public), `useEditableAgentRoleOptions.ts`.
- Most agent code still lives in `components/agent/` (rows, dialogs,
  activity, tabs' content) and moves here by feature later. State:
  `store/agentStore.ts`.
- `AgentDetailPanel`, `AgentProfileInfo` and `CreateAgentDialog` are each one
  component over 800 lines (module-shape baseline); splitting them is its own
  task, not a move.
- Tests live in `packages/web/tests/` (`agent*`, `createAgent*`, `runtime*`).
  Run named files with `pnpm --filter @botiverse/raft-web test:dom <files>`.
