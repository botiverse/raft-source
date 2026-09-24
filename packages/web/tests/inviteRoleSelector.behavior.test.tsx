import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import InviteHumanDialog from "../src/components/member/InviteHumanDialog";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";

/**
 * The invite dialog's per-row role (task #602).
 *
 * Two rules this file exists to protect:
 *
 * 1. The client NEVER quietly turns a Guest choice into a Member invite.
 *    Member is the wider grant; a silent rewrite hands out more access than the
 *    inviter picked and nothing in the UI would say so (@Huarong).
 * 2. Each row carries its OWN role. A single dialog-wide role could not express
 *    "two colleagues and one outside guest" — every invite was forced to the
 *    same grant (@cindyz).
 *
 * Element-vs-null is asserted as a BOOLEAN throughout: `assert.equal(el, null)`
 * inspects the element to build its failure message and OOMs the worker, so the
 * guard would kill the run instead of printing a diff (PR #7505).
 */

const originalGet = api.get;
const originalPost = api.post;
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useServerStore.setState(originalServerState, true);
  resetServerFeatureFlagsForTests();
});

function seedServer(role: "owner" | "admin" | "member" = "owner") {
  useServerStore.setState({
    current: { id: "server-1", slug: "server-1", name: "Server 1", role },
    billing: null,
    loadBilling: async () => {},
  } as never);
}

function renderDialog() {
  /*
   * The join-link effect must be stubbed, not left to hit the real client.
   *
   * Unstubbed it makes a genuine request that rejects on its own schedule and
   * calls `setError("Failed to prepare join link")` — which lands AFTER submit
   * and overwrites the server refusal this file asserts on. That made the
   * refusal assertion a race: it passed only while nothing awaited long enough
   * for the rejection to arrive, and adding one `await` to open the Select was
   * enough to flip it. A test that depends on losing a race is not a guard.
   */
  api.get = (async () => ({ data: [{ id: "link-1", token: "join-token" }] })) as typeof api.get;
  return render(
    <MemoryRouter initialEntries={["/s/server-1"]}>
      <TestIntlProvider>
        <InviteHumanDialog onClose={() => {}} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

/** Capture every invite POST body so the role actually sent can be asserted. */
function captureInvites() {
  const bodies: Array<Record<string, unknown>> = [];
  api.post = (async (url: string, body?: unknown) => {
    if (url.includes("/invites")) bodies.push(body as Record<string, unknown>);
    return { data: { id: "invite-1", invitedEmail: "a@b.com", expiresAt: new Date().toISOString() } } as never;
  }) as typeof api.post;
  return bodies;
}

const emailBoxes = () => screen.getAllByRole("textbox", { name: "Email address" });
const roleTriggers = () => screen.queryAllByRole("combobox", { name: "Role" });

function typeEmail(index: number, value: string) {
  fireEvent.change(emailBoxes()[index]!, { target: { value } });
}

/**
 * Drives the raft-ui Select, which is a button + listbox rather than a native
 * `<select>`; `fireEvent.change` does nothing to it.
 */
async function chooseRole(index: number, optionName: "Member" | "Guest") {
  const trigger = roleTriggers()[index];
  assert.ok(trigger, `row ${index} must offer a role control`);
  assert.equal(
    trigger.tagName,
    "BUTTON",
    "the role control must be the raft-ui Select, not a native <select> (@cindyz)",
  );
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

function send() {
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
}

test("each row carries its own role — colleagues and an outside guest go in one batch", async () => {
  seedServer("owner");
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  const bodies = captureInvites();
  renderDialog();

  await waitFor(() => assert.equal(roleTriggers().length, 1, "one row to start"));
  typeEmail(0, "colleague@example.com");

  fireEvent.click(screen.getByRole("button", { name: "Add another" }));
  await waitFor(() => assert.equal(emailBoxes().length, 2, "adding a row must add a row"));
  typeEmail(1, "outsider@example.com");
  await chooseRole(1, "Guest");

  send();

  await waitFor(() => assert.equal(bodies.length, 2, "both invites must be posted"));
  // The whole point of the redesign: one batch, two different grants.
  assert.deepEqual(
    bodies.map((body) => ({ email: body.email, role: body.role })).sort((a, b) => String(a.email).localeCompare(String(b.email))),
    [
      { email: "colleague@example.com", role: "member" },
      { email: "outsider@example.com", role: "guest" },
    ],
    "each row must be sent with the role chosen on THAT row",
  );
});

test("default is Member, and Member is what gets sent when untouched", async () => {
  seedServer("owner");
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  const bodies = captureInvites();
  renderDialog();

  await waitFor(() => assert.equal(roleTriggers().length, 1));
  typeEmail(0, "newcomer@example.com");
  send();

  await waitFor(() => assert.equal(bodies.length, 1));
  assert.equal(bodies[0].role, "member", "the wider grant is never what you get by not choosing");
});

test("rows can be removed, and a removed row's invite is not sent", async () => {
  seedServer("owner");
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  const bodies = captureInvites();
  renderDialog();

  await waitFor(() => assert.equal(emailBoxes().length, 1));
  // Removes the FIRST row, not the last. Removing the last row cannot tell
  // identity-based removal apart from "drop the tail" — both leave the same
  // survivor — so a positional implementation would pass while carrying the
  // wrong text in the wrong box.
  typeEmail(0, "drop@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Add another" }));
  await waitFor(() => assert.equal(emailBoxes().length, 2));
  typeEmail(1, "keep@example.com");

  fireEvent.click(screen.getAllByRole("button", { name: /Remove invitee/ })[0]!);
  await waitFor(() => assert.equal(emailBoxes().length, 1, "removing a row must remove it"));
  send();

  await waitFor(() => assert.equal(bodies.length, 1, "only the surviving row is invited"));
  assert.equal(bodies[0].email, "keep@example.com", "the removed row must not be sent");
});

test("the last row cannot be removed — an empty form has no way back", async () => {
  seedServer("owner");
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  renderDialog();

  await waitFor(() => assert.equal(emailBoxes().length, 1));
  assert.equal(
    screen.queryAllByRole("button", { name: /Remove invitee/ }).length === 0,
    true,
    "with one row there is nothing to remove, so the control must not be offered",
  );
});

test("with the gate off no role control renders, and invites still carry an explicit member role", async () => {
  seedServer("owner");
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, false);
  const bodies = captureInvites();
  renderDialog();

  await waitFor(() => assert.equal(emailBoxes().length, 1));
  typeEmail(0, "newcomer@example.com");
  // Queried by accessible name, not by a magic id: an id-based lookup passes
  // vacuously the moment the id changes, which is exactly how this guard rotted
  // once already.
  assert.equal(
    roleTriggers().length === 0,
    true,
    "with nothing to choose between, a control showing one option reads as broken rather than absent",
  );

  send();
  await waitFor(() => assert.equal(bodies.length, 1));
  assert.equal(bodies[0].role, "member", "the role is still stated explicitly rather than left to a server default");
});

/**
 * The one that matters.
 *
 * The client's view of the gate is a cached, possibly stale read of a
 * server-owned flag, so this sequence is reachable in production: the gate is on
 * when the dialog renders, the inviter picks Guest, the gate goes off, and the
 * submit still carries `role: "guest"`.
 *
 * The client must NOT "helpfully" rewrite that to member. Doing so would send a
 * WIDER invite than the inviter chose, succeed, and say nothing. The server
 * refuses with 400 instead, and that refusal has to reach the screen verbatim.
 */
test("a stale gate does not downgrade the choice — the request keeps guest and the refusal is shown verbatim", async () => {
  seedServer("owner");
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);

  const bodies: Array<Record<string, unknown>> = [];
  const SERVER_REFUSAL = "Guest access is not enabled for this server";
  api.post = (async (url: string, body?: unknown) => {
    if (url.includes("/invites")) {
      bodies.push(body as Record<string, unknown>);
      throw { response: { data: { error: SERVER_REFUSAL } } };
    }
    return { data: {} } as never;
  }) as typeof api.post;

  renderDialog();
  await waitFor(() => assert.equal(roleTriggers().length, 1));
  await chooseRole(0, "Guest");
  typeEmail(0, "outsider@example.com");

  // The gate flips after the choice — the client's copy is now stale.
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, false);
  // Wait for the flip to actually reach the component before submitting.
  // Without this the submit races the re-render and the gate is still ON at
  // send time, so the stale state under test is never reached — a silent
  // guest->member rewrite would pass unnoticed. This assertion IS the proof
  // that the stale condition is real.
  await waitFor(() => assert.equal(roleTriggers().length, 0, "the gate must actually be off before submitting"));

  send();

  await waitFor(() => assert.equal(bodies.length, 1, "the invite must still be attempted"));
  assert.equal(
    bodies[0].role,
    "guest",
    "the client must send the role that was CHOSEN. Rewriting it to member here would issue a wider invite than the inviter picked, and it would succeed silently.",
  );

  await waitFor(() => {
    assert.ok(
      screen.getByText(SERVER_REFUSAL),
      "the server's refusal must be shown as the server worded it — a frontend copy of this sentence would drift, and nothing would go red on the day it did",
    );
  });
});

test("a member cannot be offered Guest even when the gate is on", async () => {
  seedServer("member");
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  renderDialog();

  await waitFor(() => assert.equal(emailBoxes().length, 1));
  // Two independent conditions guard the control; this pins the capability half
  // so turning the gate on cannot by itself expose Guest to someone who may not
  // invite at all.
  assert.equal(
    roleTriggers().length === 0,
    true,
    "the Guest option is for callers who may invite — the gate alone must not surface it",
  );
});
