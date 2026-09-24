import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceEntry } from "./types.js";
import { decideWorkspaceStep, hasAvailableWorkspace } from "./workspaceStep.js";

function ws(over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Workspace",
    slug: "workspace",
    role: "owner",
    attachable: true,
    alreadyAttached: false,
    ...over,
  };
}

test("decideWorkspaceStep: a single eligible workspace → picker, auto-selected", () => {
  const step = decideWorkspaceStep([ws({ slug: "alpha" })], []);
  assert.equal(step.step, "workspaces");
  if (step.step === "workspaces") assert.equal(step.selected, "alpha");
});

test("decideWorkspaceStep: multiple eligible → picker, nothing preselected", () => {
  const step = decideWorkspaceStep(
    [ws({ id: "a", slug: "a" }), ws({ id: "b", slug: "b" })],
    [],
  );
  assert.equal(step.step, "workspaces");
  if (step.step === "workspaces") assert.equal(step.selected, null);
});

test("hasAvailableWorkspace: excludes the just-connected workspace", () => {
  assert.equal(
    hasAvailableWorkspace(
      [
        ws({ id: "current", slug: "current", alreadyAttached: true }),
        ws({ id: "next", slug: "next", alreadyAttached: false }),
      ],
      [{ serverId: "current", machineId: "machine-1", serverConnected: true }],
      "current",
    ),
    true,
  );

  assert.equal(
    hasAvailableWorkspace(
      [ws({ id: "current", slug: "current", alreadyAttached: true })],
      [{ serverId: "current", machineId: "machine-1", serverConnected: true }],
      "current",
    ),
    false,
  );
});

// The all-connected screen is the correct end state when every attachable
// server is already attached and online. The old route reused the first
// connected attachment and showed a one-workspace success page.
test("decideWorkspaceStep: no eligible and connected attachments → all-connected", () => {
  const step = decideWorkspaceStep(
    [
      ws({ id: "894a", name: "cinoyue", slug: "cinoyue", alreadyAttached: true }),
      ws({ id: "comm", slug: "community", role: "member", attachable: false }),
    ],
    [{ serverId: "894a", machineId: "machine-1", serverConnected: true }],
  );
  assert.equal(step.step, "workspaces-empty");
  if (step.step === "workspaces-empty") assert.equal(step.reason, "all-connected");
});

// task #134 rule 1: after sign-out stopped the service, the surviving
// attachment is reused on re-login but its runner is NOT connected. It must
// route through `bringing-online` (restart + verify) so re-login comes back
// online — NOT straight to `success`, which would falsely claim "connected".
test("decideWorkspaceStep: no eligible but a stopped attachment → reuse via bring-online", () => {
  const step = decideWorkspaceStep(
    [ws({ id: "894a", name: "cinoyue", slug: "cinoyue", alreadyAttached: true })],
    [{ serverId: "894a", machineId: "machine-1", serverConnected: false }],
  );
  assert.equal(step.step, "bringing-online");
  if (step.step === "bringing-online") {
    assert.equal(step.workspaceSlug, "cinoyue");
    assert.equal(step.serverId, "894a");
    assert.equal(step.machineId, "machine-1");
  }
});

test("decideWorkspaceStep: already-attached with no matching local status row → picker for reconnect", () => {
  const step = decideWorkspaceStep(
    [ws({ id: "894a", slug: "cinoyue", alreadyAttached: true })],
    [],
  );
  assert.equal(step.step, "workspaces");
  if (step.step === "workspaces") assert.equal(step.selected, "cinoyue");
});

test("decideWorkspaceStep: nothing attachable and nothing attached → empty", () => {
  const step = decideWorkspaceStep(
    [ws({ role: "member", attachable: false, alreadyAttached: false })],
    [],
  );
  assert.equal(step.step, "workspaces-empty");
  if (step.step === "workspaces-empty") assert.equal(step.reason, "all-connected");
});

test("decideWorkspaceStep: no workspaces → no-servers empty reason", () => {
  const step = decideWorkspaceStep([], []);
  assert.equal(step.step, "workspaces-empty");
  if (step.step === "workspaces-empty") assert.equal(step.reason, "no-servers");
});
