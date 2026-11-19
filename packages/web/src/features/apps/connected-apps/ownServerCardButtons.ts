import { z } from "zod";

/**
 * Whether an App's card buttons may act on this Server (RFC 076 §17), as
 * GET /integrations/clients/:id/action-endpoint says it to this Server's
 * owners and admins. Two kinds of App, two ways (#proj-apps:#73):
 * - `own_server`: an App made on this Server. Its buttons are on by default;
 *   the section can switch them off and on again.
 * - `allow`: an App installed here from elsewhere (shared, published, or one
 *   made here that is shared or published now). Its buttons only open links
 *   until someone here allows the endpoint in force; that allow can be
 *   withdrawn, and an App that changes its endpoint has to be allowed again.
 * The web draws the `state` it is given and derives none:
 * - both: `no_endpoint` (the App has none in force), `suspended` (on or
 *   allowed, but Raft can't verify the App's domain now);
 * - `own_server`: `off` (switched off here), `on`;
 * - `allow`: `pending_review` (its only endpoint waits for Raft's review:
 *   nothing to allow yet), `not_allowed`, `endpoint_changed` (what was
 *   allowed, `allowedActionEndpoint`, is no longer the one in force: allow
 *   it again), `allowed`.
 */
export type CardButtonsMode = "own_server" | "allow";
export type OwnServerCardButtonsState =
  | "no_endpoint"
  | "suspended"
  | "off"
  | "on"
  | "pending_review"
  | "not_allowed"
  | "endpoint_changed"
  | "allowed";

export type OwnServerCardButtons = {
  mode: CardButtonsMode;
  state: OwnServerCardButtonsState;
  /** The action endpoint in force now: the one an allow (or switching on) sends, exactly as shown. */
  actionEndpoint: string | null;
  /** A new endpoint waiting for Raft's review (shown, never allowable). */
  pendingActionEndpoint: string | null;
  /** `allow`: the endpoint allowed here. */
  allowedActionEndpoint: string | null;
  /** ISO time of the last switch (`own_server`; null: never, on by default) or of the allow in place. */
  changedAt: string | null;
  /** Who made that change; null when Raft no longer knows (the date alone is shown). */
  changedBy: { type: "human" | "agent"; id: string; name: string } | null;
};

/**
 * What the read says for the section: its view; `official`, an App Raft
 * reviewed, whose buttons Raft decides on every Server (nothing to switch or
 * allow: one line instead); null, no section (no answer, or one this client
 * can't read).
 */
export type CardButtonsRead = { kind: "view"; view: OwnServerCardButtons } | { kind: "official" } | null;

/**
 * What an allow (or switching on) came to: `done`; `endpoint_changed`, the
 * App changed its endpoint since the page loaded (409), with the one in force
 * now for the person to check and allow; `gone`, nothing to allow any more (no
 * endpoint, waiting for review, official now, or done already), so the dialog
 * closes on the section as it is now.
 */
export type AllowCardButtonsOutcome = { kind: "allowed" } | { kind: "endpoint_changed"; actionEndpoint: string } | { kind: "gone" };

const isoOrNull = z.string().nullable().refine((value) => value === null || !Number.isNaN(Date.parse(value)));

const viewSchema = z.object({
  mode: z.enum(["own_server", "allow"]),
  state: z.enum(["no_endpoint", "suspended", "off", "on", "pending_review", "not_allowed", "endpoint_changed", "allowed"]),
  action_endpoint: z.string().min(1).nullable(),
  pending_action_endpoint: z.string().min(1).nullable().optional(),
  allowed_action_endpoint: z.string().min(1).nullable().optional(),
  changed_at: isoOrNull.optional(),
  changed_by: z.object({ type: z.enum(["human", "agent"]), id: z.string(), name: z.string() }).nullable().optional(),
});

/** Before card buttons moved to the installation: a server_local App on its own Server, allowed or not. */
const legacySchema = z.object({
  action_endpoint: z.string().min(1).nullable(),
  own_server_actions: z.object({
    state: z.enum(["no_endpoint", "not_allowed", "endpoint_changed", "suspended", "allowed"]),
    confirmed_action_endpoint: z.string().min(1).nullable(),
    confirmed_at: isoOrNull,
    confirmed_by: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  }).nullable(),
});

/** A view drawable as given: each state has what it shows (an endpoint to allow or switch, the one allowed). */
function drawable(view: OwnServerCardButtons): OwnServerCardButtons | null {
  switch (view.state) {
    case "no_endpoint": return view;
    case "pending_review": return view.pendingActionEndpoint ? view : null;
    case "off":
    case "on":
    case "not_allowed": return view.actionEndpoint ? view : null;
    case "endpoint_changed": return view.actionEndpoint && view.allowedActionEndpoint ? view : null;
    case "allowed": return view.allowedActionEndpoint ? view : null;
    case "suspended": return view.mode === "own_server" ? (view.actionEndpoint ? view : null) : (view.allowedActionEndpoint ? view : null);
  }
}

/**
 * The section's view of a GET .../action-endpoint answer. `card_buttons` is
 * the server's view since #14903; a server before it answers only
 * `own_server_actions` (a server_local App on its own Server, where buttons
 * were allowed then), read as an `allow` view.
 *
 * `card_buttons: null` means an official App OR an App not installed here, so
 * it reads as `official` only where the App is known to be installed
 * (`installed`, the installed App's page); elsewhere (the editor) it is no section.
 */
export function readCardButtons(data: unknown, { installed = false }: { installed?: boolean } = {}): CardButtonsRead {
  if (data && typeof data === "object" && "card_buttons" in data) {
    const raw = (data as { card_buttons: unknown }).card_buttons;
    if (raw === null) return installed ? { kind: "official" } : null;
    const parsed = viewSchema.safeParse(raw);
    if (!parsed.success) return null;
    const v = parsed.data;
    const view = drawable({
      mode: v.mode,
      state: v.state,
      actionEndpoint: v.action_endpoint,
      pendingActionEndpoint: v.pending_action_endpoint ?? null,
      allowedActionEndpoint: v.allowed_action_endpoint ?? null,
      changedAt: v.changed_at ?? null,
      changedBy: v.changed_by ?? null,
    });
    return view ? { kind: "view", view } : null;
  }
  const legacy = legacySchema.safeParse(data);
  const own = legacy.success ? legacy.data.own_server_actions : null;
  if (!legacy.success || !own) return null;
  // As before #14903: a state that names when it was allowed is drawn only with that date.
  if (own.state !== "no_endpoint" && own.state !== "not_allowed" && !own.confirmed_at) return null;
  const view = drawable({
    mode: "allow",
    state: own.state,
    actionEndpoint: legacy.data.action_endpoint,
    pendingActionEndpoint: null,
    allowedActionEndpoint: own.confirmed_action_endpoint,
    changedAt: own.confirmed_at,
    changedBy: own.confirmed_by ? { type: "human", ...own.confirmed_by } : null,
  });
  return view ? { kind: "view", view } : null;
}
