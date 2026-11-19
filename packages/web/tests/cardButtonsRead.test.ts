import { describe, expect, it } from "vitest";
import { readCardButtons } from "../src/features/apps/connected-apps/ownServerCardButtons";

// The Card buttons section's read of GET /integrations/clients/:id/action-endpoint (RFC 076 §17, #proj-apps:#73):
// `card_buttons` since the buttons moved to the installation (#14903), `own_server_actions` from a server before it.
const ENDPOINT = "https://app.example.com/raft/actions";
const view = (fields: Record<string, unknown>) => ({
  action_endpoint: ENDPOINT,
  own_server_actions: null,
  card_buttons: {
    mode: "allow",
    state: "not_allowed",
    in_force: false,
    action_endpoint: ENDPOINT,
    pending_action_endpoint: null,
    allowed_action_endpoint: null,
    changed_at: null,
    changed_by: null,
    ...fields,
  },
});

describe("readCardButtons", () => {
  it("reads card_buttons null as an official App only on an installed App's page; elsewhere no section", () => {
    const official = { action_endpoint: ENDPOINT, own_server_actions: null, card_buttons: null };
    expect(readCardButtons(official, { installed: true })).toEqual({ kind: "official" });
    // The editor of an App made here but not installed here also gets null: it is not official.
    expect(readCardButtons(official)).toBeNull();
  });

  it("reads an App made here: on by default, switched off with who and when", () => {
    expect(readCardButtons(view({ mode: "own_server", state: "on", in_force: true }))).toMatchObject({
      kind: "view",
      view: { mode: "own_server", state: "on", actionEndpoint: ENDPOINT, changedAt: null, changedBy: null },
    });
    const off = readCardButtons(view({ mode: "own_server", state: "off", changed_at: "2026-11-14T10:00:00.000Z", changed_by: { type: "agent", id: "a1", name: "Fixer" } }));
    expect(off).toMatchObject({ kind: "view", view: { state: "off", changedBy: { type: "agent", name: "Fixer" } } });
  });

  it("reads an App from elsewhere: not allowed, allowed, changed, waiting for review", () => {
    expect(readCardButtons(view({}))).toMatchObject({ kind: "view", view: { mode: "allow", state: "not_allowed" } });
    expect(readCardButtons(view({ state: "allowed", in_force: true, allowed_action_endpoint: ENDPOINT, changed_at: "2026-11-14T10:00:00.000Z" })))
      .toMatchObject({ kind: "view", view: { state: "allowed", allowedActionEndpoint: ENDPOINT } });
    expect(readCardButtons(view({ state: "endpoint_changed", allowed_action_endpoint: "https://old.example.com/a" })))
      .toMatchObject({ kind: "view", view: { state: "endpoint_changed", actionEndpoint: ENDPOINT, allowedActionEndpoint: "https://old.example.com/a" } });
    expect(readCardButtons(view({ state: "pending_review", action_endpoint: null, pending_action_endpoint: "https://next.example.com/a" })))
      .toMatchObject({ kind: "view", view: { state: "pending_review", pendingActionEndpoint: "https://next.example.com/a" } });
  });

  it("draws nothing for a state missing what it shows, or a shape it can't read", () => {
    expect(readCardButtons(view({ state: "allowed", allowed_action_endpoint: null }))).toBeNull();
    expect(readCardButtons(view({ state: "endpoint_changed", allowed_action_endpoint: null }))).toBeNull();
    expect(readCardButtons(view({ state: "pending_review", pending_action_endpoint: null }))).toBeNull();
    expect(readCardButtons(view({ mode: "elsewhere" }))).toBeNull();
    expect(readCardButtons(view({ changed_at: "not a date" }))).toBeNull();
    expect(readCardButtons(null)).toBeNull();
  });

  it("reads a server before #14903 (own_server_actions only) as an allow view, as it drew then", () => {
    expect(readCardButtons({
      action_endpoint: ENDPOINT,
      own_server_actions: { state: "allowed", confirmed_action_endpoint: ENDPOINT, confirmed_at: "2026-11-01T00:00:00.000Z", confirmed_by: { id: "u1", name: "Ana" } },
    })).toMatchObject({ kind: "view", view: { mode: "allow", state: "allowed", allowedActionEndpoint: ENDPOINT, changedBy: { type: "human", name: "Ana" } } });
    expect(readCardButtons({ action_endpoint: ENDPOINT, own_server_actions: null })).toBeNull();
    // Allowed with no date was not drawn then either ("Allowed by Ana on ." would be).
    expect(readCardButtons({
      action_endpoint: ENDPOINT,
      own_server_actions: { state: "allowed", confirmed_action_endpoint: ENDPOINT, confirmed_at: null, confirmed_by: { id: "u1", name: "Ana" } },
    })).toBeNull();
  });
});
