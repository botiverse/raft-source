import type { ServerId } from "./brandedIds";
import type { ActionCardFormSubmission, ActionCardSpecCard } from "./actionCardSpec";
// Operation cards (B-mode) — agents prepare a privileged action and post it
// inline as a chat message; a human admin clicks the action button to commit
// it under their own identity. The card is the entire body of the system
// message that carries it (`actionMetadata.kind === "action-card"`).
//
// Contrast with approval (A-mode) where the *agent* is the actor and the
// human merely gates: in B-mode, the *human* is the actor, the agent is
// just preparing the form. Most button labels are action verbs rather than
// generic "Approve"; explicit approval surfaces may use "Approve <thing>".
//
// v1 supported action types: `channel:create`, `agent:create`,
// `channel:add_member`, `integration:approve_agent_login`,
// `integration:register_app`, `integration:update_app_registration`,
// `feedback:submit` (wherever the deployment has product feedback
// configured), and `plan:upgrade` (only on a Free server, and never in a
// shared channel).
// `channel:join` (A-mode, agent acting on itself) stays deferred for the
// approval surface.

import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH, FEEDBACK_SUBMIT_TYPES } from "./feedbackSubmit";
import { AGENT_UPGRADE_CARD_GATES } from "./upgradeGates";
import { validateEmailAddress } from "./emailValidation";

const uuidSchema = lazySchema("uuidSchema", () => z.uuid());

/**
 * `idOrHandleSchema` — schema for fields that accept either a Slock UUID
 * (e.g. `c29682ed-...`) or an agent-facing handle reference:
 *   - `@alice` / `alice` for humans (server resolves via `resolveUserByName`)
 *   - `@scout` / `scout` for agents (server resolves via `resolveAgentByName`)
 *   - `#general` / `general` for channels (server resolves via
 *     `resolveChannelByName`)
 *
 * The AX invariant (per xxchan #engineering msg=f629320c, 2026-05-11):
 * agents never see UUIDs. Action-card payloads from agents always carry
 * handles; `actionCardsService.prepareActionCard` resolves them to UUIDs
 * before persisting, so the stored card metadata is UUID-only. Existing
 * UUID callers (server-internal, tests, future flows that already have
 * IDs) continue to work because a UUID literal is also a valid handle
 * (it just resolves to itself).
 *
 * Validation only checks "non-empty string"; type-specific resolution and
 * not-found errors live in the server's prepare step.
 */
const idOrHandleSchema = lazySchema("idOrHandleSchema", () => z.string().min(1).max(120));

export const APPROVAL_RUNTIMES = ["claude", "codex", "kimi", "kimi-sdk", "gemini", "opencode"] as const;
export type ActionCardAgentRuntime = (typeof APPROVAL_RUNTIMES)[number];

const draftHintSchema = lazySchema("draftHintSchema", () => z
  .string()
  .trim()
  .max(2_000)
  .optional()
  .describe(
    "Why the agent prepared this for you. Shows below the form on the card; not the action itself.",
  ));

export const channelCreateOperationSchema = lazySchema("channelCreateOperationSchema", () => z.object({
  type: z.literal("channel:create"),
  name: z.string().trim().min(1).max(80),
  visibility: z.enum(["public", "private"]).default("public"),
  description: z.string().trim().max(500).optional(),
  /**
   * Humans to add to the channel on creation. Each entry is a handle
   * (`@alice` or bare `alice`) or a UUID. Server resolves via
   * `resolveUserByName` at prepare time; resolved UUIDs are stored.
   */
  initialHumans: z.array(idOrHandleSchema).max(64).optional(),
  /**
   * Agents to add to the channel on creation. Each entry is a handle
   * (`@scout` or bare `scout`) or a UUID. Server resolves via
   * `resolveAgentByName` at prepare time; resolved UUIDs are stored.
   */
  initialAgents: z.array(idOrHandleSchema).max(64).optional(),
  draftHint: draftHintSchema,
}));

export const agentCreateOperationSchema = lazySchema("agentCreateOperationSchema", () => z.object({
  type: z.literal("agent:create"),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional(),
  /**
   * Optional computer placement contract. Agents may only set this when the
   * human request is explicitly computer-bound; server prepare resolves the
   * name/UUID and stores the UUID-only form. `suggestedComputer` preselects
   * the dialog when available; `requiredComputer` prevents silent fallback to
   * any other computer.
   *
   * Runtime / model / reasoning effort remain human-picked technical fields,
   * except for a hosted agent's model below.
   */
  suggestedComputer: idOrHandleSchema.optional(),
  requiredComputer: idOrHandleSchema.optional(),
  /**
   * Where the agent runs. `antiproton` preselects "Hosted by Raft
   * (Antiproton)" (no computer); absent or `computer` keeps the computer
   * picker. Prepare refuses `antiproton` when hosting is off for the server.
   * The human can still change it in the dialog.
   */
  hosting: z.enum(["computer", "antiproton"]).optional()
    .describe('Where the new agent runs: "antiproton" proposes a cloud agent (one that runs in Raft\'s cloud, not on a Computer); omit it or use "computer" for a Computer the human picks. The human can change it.'),
  /**
   * Hosted model id, only with `hosting: "antiproton"`. Prepare checks it
   * against the provider's current list; absent means the provider default.
   * The human can still change it in the dialog.
   */
  model: z.string().trim().min(1).max(200).optional()
    .describe('Cloud agent model id, only with hosting: "antiproton"; omit for the default. An id the cloud runtime does not offer is refused, and the refusal lists the offered ids.'),
  draftHint: draftHintSchema,
}));

/**
 * `channel:add_member` — agent prepares a list of humans and/or agents to add
 * to an existing channel. The human clicks "Add Members" on the card, an
 * `<AddMembersDialog>` opens prefilled with the agent's list (editable, the
 * human can deselect / add more), and submission calls the existing
 * `POST /api/channels/:id/members` add endpoints under the human's identity.
 *
 * Per stdrc 2026-05-11 #proj-permission msg=670d903f: the dialog UI mirrors
 * the channel members panel so the experience is familiar; the human keeps
 * final say over who actually gets added.
 *
 * `humans` and `agents` are independently optional but at least one of
 * them must be non-empty — preparing an add-member card with no candidates
 * is meaningless and would render an empty dialog. The non-empty check is
 * enforced by `validateActionCardAction()` rather than inside this schema:
 * zod's `discriminatedUnion` requires plain `ZodObject` options (no
 * `ZodEffects` from `.refine`), so cross-field constraints live in the
 * post-parse validator.
 *
 * Field naming (per xxchan #engineering msg=d22fb886, 2026-05-11): these
 * fields used to be `*Id` / `*Ids` when the schema required UUIDs. Now
 * that they accept handles too, the `Id` suffix is misleading. The
 * field names mirror `channelCreateOperationSchema.initialHumans` /
 * `initialAgents` for symmetry.
 */
export const channelAddMemberOperationSchema = lazySchema("channelAddMemberOperationSchema", () => z.object({
  type: z.literal("channel:add_member"),
  /**
   * Target channel. Handle (`#general` or bare `general`) or UUID.
   * Server resolves via `resolveChannelByName` at prepare time; the
   * resolved UUID is stored in the card metadata.
   */
  channel: idOrHandleSchema,
  /** Same resolution rule as `channelCreateOperationSchema.initialHumans`. */
  humans: z.array(idOrHandleSchema).max(64).optional(),
  /** Same resolution rule as `channelCreateOperationSchema.initialAgents`. */
  agents: z.array(idOrHandleSchema).max(64).optional(),
  draftHint: draftHintSchema,
}));

export const integrationApproveAgentLoginOperationSchema = lazySchema("integrationApproveAgentLoginOperationSchema", () => z.object({
  type: z.literal("integration:approve_agent_login"),
  requestId: uuidSchema,
  agentId: uuidSchema,
  agentName: z.string().trim().min(1).max(120),
  clientId: uuidSchema,
  clientKey: z.string().trim().min(1).max(120),
  clientName: z.string().trim().min(1).max(120),
  scopes: z.array(z.string().trim().min(1).max(120)).max(64),
  draftHint: draftHintSchema,
}));

export const integrationInstallMarketplaceAppOperationSchema = lazySchema("integrationInstallMarketplaceAppOperationSchema", () => z.object({
  type: z.literal("integration:install_marketplace_app"),
  clientId: uuidSchema,
  clientKey: z.string().trim().min(1).max(120),
  setupUrl: z.string().max(2000).optional(),
  setupDescription: z.string().max(1000).optional(),
  setupRevision: z.number().int().positive().optional(),
  /**
   * Canonical inert display projection. The raw publisher-controlled name
   * must never enter an action-card carrier.
   */
  clientName: z.string().trim().min(1).max(1_000),
  /** Opaque binding to the exact raw publisher-controlled name at prepare time. */
  clientNameSha256: z.string().regex(/^[a-f0-9]{64}$/),
  agentId: uuidSchema,
  agentName: z.string().trim().min(1).max(120),
  scopes: z.array(z.string().trim().min(1).max(120)).max(64),
  /**
   * The app's login scopes and data groups when the card was prepared, set by
   * the server. Installing approves exactly these, and only while they still
   * match the app's declaration. Absent on cards prepared before
   * the binding existed; those can't be executed.
   */
  installScopes: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
  installGroups: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
  /**
   * The app's prompt-text revision when the card was prepared, and its text
   * (name, description, When to use), set by the server (task #4,
   * #proj-apps) and inert-rendered because the card carrier reaches agents.
   * The card shows this text as agents would read it; executing confirms
   * exactly this revision, and only while it is still current.
   */
  installTextRevisionId: uuidSchema.optional(),
  installText: z.object({
    name: z.string().max(1_000),
    // Omitted reads as null (the tool-schema form has no required nullable).
    description: z.string().max(10_000).nullable().optional(),
    whenToUse: z.string().max(1_000).nullable().optional(),
  }).optional(),
  draftHint: draftHintSchema,
}));

const integrationAppDraftFieldsSchema = lazySchema("integrationAppDraftFieldsSchema", () => z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1_000).optional(),
  category: z.string().trim().min(1).max(120).optional(),
  homepageUrl: z.string().trim().max(2_000).optional(),
  returnUrl: z.string().trim().max(2_000).optional(),
  agentManifestUrl: z.string().trim().max(2_000).optional(),
  setupUrl: z.string().trim().max(2_000).optional(),
  setupDescription: z.string().trim().max(500).optional(),
}));

export const integrationRegisterAppOperationSchema = lazySchema("integrationRegisterAppOperationSchema", () => integrationAppDraftFieldsSchema.extend({
  type: z.literal("integration:register_app"),
  name: z.string().trim().min(1).max(120),
  clientKey: z.string().trim().min(1).max(120).optional(),
  returnUrl: z.string().trim().min(1).max(2_000),
  scopes: z.array(z.string().trim().min(1).max(120)).max(64).default([]),
  unsafeDemoUrlOverride: z.boolean().optional(),
  draftHint: draftHintSchema,
}));

export const integrationUpdateAppRegistrationOperationSchema = lazySchema("integrationUpdateAppRegistrationOperationSchema", () => integrationAppDraftFieldsSchema.extend({
  type: z.literal("integration:update_app_registration"),
  clientKey: z.string().trim().min(1).max(120),
  scopes: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
  unsafeDemoUrlOverride: z.boolean().optional(),
  draftHint: draftHintSchema,
}));

export const integrationRecoverAppOwnerOperationSchema = lazySchema("integrationRecoverAppOwnerOperationSchema", () => z.object({
  type: z.literal("integration:recover_app_owner"),
  clientKey: z.string().trim().min(1).max(120),
  targetAgent: z.string().trim().min(1).max(120),
  draftHint: draftHintSchema,
}));

export const integrationConnectMcpOperationSchema = lazySchema("integrationConnectMcpOperationSchema", () => z.object({
  type: z.literal("integration:connect_mcp"),
  mcpServerId: z.string().trim().uuid(),
  agentId: z.string().trim().uuid(),
  /** Why the card exists. A closed set, so the durable row never carries free text. */
  reason: z.literal("login_required"),
  /** The server config revision this was raised against, so a stale card is detectable. */
  revision: z.number().int().nonnegative(),
  draftHint: draftHintSchema,
}));

/**
 * `agent:migrate` — an agent asks a person to move an agent to another
 * computer (its computer is offline, short of room, ...): itself, or, with
 * `agent`, another agent it names (an ops agent that prepared the move for
 * it). The server resolves the agent at prepare and stores its id
 * (storedAgentMigrateActionSchema). The human clicks "Move agent" and the
 * existing migration dialog opens, preselecting `suggestedComputer` when it
 * can be chosen; the migration route (POST /api/agents/:id/migrate) does the
 * move under the human's identity, then the web marks the card executed. The
 * card is done once the migration starts; its progress stays on the agent's
 * page.
 */
function agentMigrateAgentShape() {
  return {
    type: z.literal("agent:migrate"),
    /**
     * The computer the agent suggests moving to. Handle (computer name) or
     * UUID; prepare resolves it and stores the UUID. The human can pick
     * another in the dialog.
     */
    suggestedComputer: idOrHandleSchema.optional()
      .describe("The computer you suggest moving to, by name. The person can pick another one in the dialog."),
    draftHint: draftHintSchema,
  };
}

export const agentMigrateOperationSchema = lazySchema("agentMigrateOperationSchema", () => z.object({
  ...agentMigrateAgentShape(),
  /**
   * The agent to move, by handle (`@name` or `name`), when it is not the
   * agent preparing the card. Prepare resolves it on the server (same
   * server, not deleted, one the preparing agent can find by name) and
   * stores only its id; the card never keeps the handle.
   */
  agent: idOrHandleSchema.optional()
    .describe("The agent to move, by handle (@name), when it is not you. Leave it out to ask for yourself."),
}));

/**
 * A stored `agent:migrate` card's action: what the agent sent, less `agent`,
 * plus what the server sets at prepare: `agentId`, the agent to move (the
 * preparing agent, or the one its `agent` named; absent only on a card
 * built for a test; without it no one may act on the card, as
 * actionCardTypeAuthority's `agent` rule finds no Agent). Who prepared it is
 * the card's requesterAgentId. The computer the agent was on then is the
 * server's own record (its action_cards row), never part of the action
 * clients see.
 */
export const storedAgentMigrateActionSchema = lazySchema("storedAgentMigrateActionSchema", () => z.object({
  ...agentMigrateAgentShape(),
  agentId: uuidSchema.optional(),
}));
export type AgentMigrateAction = z.infer<typeof storedAgentMigrateActionSchema>;

export { FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH, FEEDBACK_SUBMIT_TYPES } from "./feedbackSubmit";
export type { FeedbackSubmitType } from "./feedbackSubmit";

/**
 * `feedback:submit` — an agent drafts product feedback (Raft product ideas or
 * problems) for a human. The card is a summary; its button opens the in-app
 * feedback form prefilled with the draft, where the human may edit it before
 * sending. It is filed as the person who sends it (their Settings ›
 * Feedback), through POST /api/product-feedback, which also marks the card
 * done. No flag gates it; the server prepares it wherever the deployment
 * has product feedback configured (not a self-hosted or local one without
 * HANDS_FEEDBACK_*), and refuses it elsewhere with FEATURE_DISABLED.
 */
export const feedbackSubmitOperationSchema = lazySchema("feedbackSubmitOperationSchema", () => z.object({
  type: z.literal("feedback:submit"),
  feedbackType: z.enum(FEEDBACK_SUBMIT_TYPES)
    .describe('"idea" for a suggestion, "problem" for something that does not work.'),
  message: z.string().trim().min(1).max(FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH)
    .describe("The feedback text. The human reviews and can edit it, then sends it under their own name."),
  draftHint: draftHintSchema,
}));

// Above the schema: its factory reads these when it is built (lazySchema.test
// builds every schema eagerly, so a later `const` would be in its TDZ).
/** `reason` on a `plan:upgrade` card, counted in Unicode code points after trimming. */
export const PLAN_UPGRADE_REASON_MAX_LENGTH = 200;

function isPlanUpgradeReasonLength(reason: string): boolean {
  const length = Array.from(reason).length;
  return length >= 1 && length <= PLAN_UPGRADE_REASON_MAX_LENGTH;
}

/** A reason that is still a `<…>` placeholder: wrapped whole in angle brackets (after trimming). */
function isPlanUpgradeReasonPlaceholder(reason: string): boolean {
  return reason.startsWith("<") && reason.endsWith(">");
}

/** The validation error for any field besides `type`, `reason` and `gate` on a `plan:upgrade` card. */
export const PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE =
  'plan:upgrade takes only "reason" and an optional "gate". Remove the other fields.';

/** The validation error for a missing, empty or too long `reason` on a `plan:upgrade` card. */
export const PLAN_UPGRADE_REASON_MESSAGE =
  `plan:upgrade needs "reason": one plain sentence (up to ${PLAN_UPGRADE_REASON_MAX_LENGTH} characters) saying why this person needs Pro.`;

/** The validation error for a `reason` still wrapped whole in `<…>`, like the hint's placeholder. */
export const PLAN_UPGRADE_REASON_PLACEHOLDER_MESSAGE =
  'plan:upgrade "reason" is still the placeholder: replace <…> with your own sentence on why this person needs Pro.';

/**
 * `plan:upgrade` — an agent offers Pro to a person who needs it, usually
 * because they ran into a Free-plan limit. The card executes nothing: its
 * button opens the web's existing upgrade dialog for the card's server (an
 * owner pays there, anyone else messages an owner). Strict: `reason` (the
 * agent's one sentence on why, shown as plain text) and an optional `gate`
 * (the limit hit; Raft adds that limit's fact to the card; absent means
 * `general`). The server refuses to prepare it unless the server is on Free,
 * refuses it in a shared (joint) channel, answers a repeat for the same
 * conversation and gate within a day with that card, and otherwise refuses another one in a conversation that had an
 * agent's upgrade card lately (409 UPGRADE_CARD_COOLDOWN, 14 days).
 */
export const planUpgradeOperationSchema = lazySchema("planUpgradeOperationSchema", () => z.strictObject({
  type: z.literal("plan:upgrade"),
  reason: z.string({ error: PLAN_UPGRADE_REASON_MESSAGE })
    .trim()
    .refine(isPlanUpgradeReasonLength, { error: PLAN_UPGRADE_REASON_MESSAGE, abort: true })
    // The hint's example carries a `<…>` placeholder; posted verbatim it
    // would show on the card as is.
    .refine((reason) => !isPlanUpgradeReasonPlaceholder(reason), { error: PLAN_UPGRADE_REASON_PLACEHOLDER_MESSAGE })
    // Scoped in its own words: the SDK's flattened card merges it with
    // integration:connect_mcp's `reason`.
    .describe(`For plan:upgrade: one plain sentence (up to ${PLAN_UPGRADE_REASON_MAX_LENGTH} characters) saying why this person needs Pro, shown on the card as plain text (no markup; links are not clickable).`),
  gate: z.enum(AGENT_UPGRADE_CARD_GATES).optional()
    .describe("The Free limit the person ran into, when there is one (history_30d: messages older than 30 days; uploads; shared channels; agent migration). Raft adds that limit's fact to the card. Leave it out (or `general`) when no specific limit applies."),
}, {
  // Every reporter (CLI, Agent API contract check, SDK) shows the issue's
  // message, so this says why, instead of `Unrecognized key: "message"`.
  error: (issue) => (issue.code === "unrecognized_keys" ? PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE : undefined),
}));

/** The card types an agent may prepare whose stored action is the one it sent. */
function agentActionCardOperationSchemasStoredAsSent() {
  return [
    channelCreateOperationSchema,
    agentCreateOperationSchema,
    channelAddMemberOperationSchema,
    integrationApproveAgentLoginOperationSchema,
    integrationConnectMcpOperationSchema,
    integrationInstallMarketplaceAppOperationSchema,
    integrationRegisterAppOperationSchema,
    integrationUpdateAppRegistrationOperationSchema,
    integrationRecoverAppOwnerOperationSchema,
    feedbackSubmitOperationSchema,
    planUpgradeOperationSchema,
  ] as const;
}

// The agent types' union, actionCardActionSchema, is below the question card's
// schemas, which it takes (lazySchema.test builds every schema eagerly, in
// module order).

// ── Person-requested cards (task #10 #proj-commercial) ──────────────────────
//
// A member or admin who runs out of Pro seats asks an owner for them with a
// card; only an owner adds the seats. Not an agent type: it is not in
// `actionCardActionSchema`, so the Agent API, CLI and SDK neither offer nor
// accept it. Stored cards are read with `storedActionCardActionSchema`.

/** How long a seat request stays open; after that it can't be acted on and what it held is cleared. */
export const SEAT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SEAT_REQUEST_REASON_MAX_LENGTH = 500;
export const SEAT_REQUEST_MAX_INVITES = 20;

/**
 * What the seats are for: the action the requester was taking when the seats
 * ran out. Holds only what the card shows and what finishing needs; no
 * secrets (an agent's env vars or provider keys stay in the requester's form).
 * Cleared (`null`) once the request is executed or expired.
 */
export const seatsAddPurposeSchema = lazySchema("seatsAddPurposeSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent:create"),
    name: z.string().trim().min(1).max(60),
  }),
  z.strictObject({ kind: z.literal("assistant:create") }),
  z.strictObject({
    kind: z.literal("invite"),
    emails: z.array(z.string().trim().max(320).refine((email) => validateEmailAddress(email) === null, { error: "Not an email address" }))
      .min(1).max(SEAT_REQUEST_MAX_INVITES),
  }),
  z.strictObject({
    kind: z.literal("member:promote"),
    userId: uuidSchema,
    /** Shown on the card; the server sets it from `userId` (a client's is ignored). */
    name: z.string().trim().min(1).max(120),
    role: z.enum(["member", "admin"]),
  }),
  z.strictObject({
    /** Let someone a full join link turned away in (`seat_join_blocks`): they open the link again once there's a seat. */
    kind: z.literal("join"),
    userId: uuidSchema,
    /** Shown on the card; the server sets it from `userId` (a client's is ignored). */
    name: z.string().trim().min(1).max(120),
  }),
]));
export type SeatsAddPurpose = z.infer<typeof seatsAddPurposeSchema>;

/** The seats a purpose takes, in tenths, as the server counts them: a person 10, an agent 1. */
export function seatsAddPurposeTenths(purpose: SeatsAddPurpose): number {
  switch (purpose.kind) {
    case "agent:create":
    case "assistant:create":
      return 1;
    case "invite":
      return new Set(purpose.emails.map((email) => email.trim().toLowerCase())).size * 10;
    case "member:promote":
    case "join":
      return 10;
  }
}

/**
 * What came of a completed seat request, recorded on the card so the owner
 * sees it too (cindyz, 2026-10-27). Invites and a Guest's promotion are done
 * by the owner who added the seats, as the owner: they saw exactly what on the
 * card. An agent or assistant is the requester's own, so they go ahead
 * themselves (`ready`). Kept after the purpose is cleared: counts and names,
 * never an address; a join's person is not named (the thread reply names
 * them, the card keeps no one who isn't on the server).
 */
export type SeatRequestOutcome =
  | { kind: "invites"; sent: number; failed: number }
  | { kind: "promoted"; name: string; role: "member" | "admin" }
  | { kind: "ready"; purpose: "agent:create"; name: string }
  | { kind: "ready"; purpose: "assistant:create" }
  | { kind: "ready"; purpose: "invite"; count: number }
  | { kind: "ready"; purpose: "member:promote"; name: string; role: "member" | "admin" }
  /** Nothing for the owner to do: the person opens the link again. */
  | { kind: "ready"; purpose: "join" }
  /** They can no longer do it here (left, or lost the right). */
  | { kind: "requester_cannot" }
  /** A join for someone no longer waiting (they joined, or their notice ended): ended without seats. */
  | { kind: "not_needed" };

/** A completed request's outcome when the requester may still do it. */
export function seatRequestReadyOutcome(purpose: SeatsAddPurpose): Extract<SeatRequestOutcome, { kind: "ready" }> {
  switch (purpose.kind) {
    case "agent:create":
      return { kind: "ready", purpose: "agent:create", name: purpose.name };
    case "assistant:create":
      return { kind: "ready", purpose: "assistant:create" };
    case "invite":
      return { kind: "ready", purpose: "invite", count: new Set(purpose.emails.map((email) => email.trim().toLowerCase())).size };
    case "member:promote":
      return { kind: "ready", purpose: "member:promote", name: purpose.name, role: purpose.role };
    case "join":
      return { kind: "ready", purpose: "join" };
  }
}

/** `seats:add` — a person asks an owner for Pro seats so their action fits. */
export const seatsAddOperationSchema = lazySchema("seatsAddOperationSchema", () => z.strictObject({
  type: z.literal("seats:add"),
  /** Seats to add, as counted when asked (the owner may add more). */
  seats: z.number().int().min(1).max(1000),
  purpose: seatsAddPurposeSchema.nullable(),
  reason: z.string().trim().max(SEAT_REQUEST_REASON_MAX_LENGTH).optional(),
  expiresAt: z.iso.datetime(),
}));
export type SeatsAddAction = z.infer<typeof seatsAddOperationSchema>;

// ── Server-built cards: antiproton held-call approvals ──────────────────────
//
// `agent:approve_call` (docs/contracts/hosted-agent-approvals.md): a hosted
// agent's call that its mount's policy held, or that the agent asked a person
// for, waits for the agent's owner; when the owner has left the server, for a
// server owner or admin. The server builds the card from antiproton's approval
// item and posts it as the agent's message in each decider's DM with the
// agent. Not an agent type: an agent never prepares it. Every text on it came
// from antiproton and may carry what the agent wrote, so it is plain text, cut
// to its slot, without control or bidi characters (plainActionCardText).

/** A hold's state, as antiproton reports it, and `unavailable`: antiproton no longer has it (Raft's own end). */
export const AGENT_CALL_APPROVAL_STATUSES = ["pending", "approved", "executed", "failed", "denied", "expired", "unavailable"] as const;
export type AgentCallApprovalStatus = (typeof AGENT_CALL_APPROVAL_STATUSES)[number];
/** The grounds on which Raft lets a person decide (antiproton's `decidedBy.role`). */
export const AGENT_CALL_APPROVAL_ROLES = ["agent_owner", "server_owner", "server_admin"] as const;
export type AgentCallApprovalRole = (typeof AGENT_CALL_APPROVAL_ROLES)[number];
/** Who ended a hold, by role only: a card never names the person behind a decision it did not take. */
export type AgentCallApprovalDecidedBy =
  | { via: "raft"; role: AgentCallApprovalRole }
  | { via: "console" }
  | { via: "expiry" };

/** antiproton bounds `args.summary` at 800 characters; the card keeps at most this many code points. */
export const AGENT_CALL_APPROVAL_SUMMARY_MAX = 2000;
export const AGENT_CALL_APPROVAL_DESCRIPTION_MAX = 1000;

// C0 and C1 controls (but tab and newline), line/paragraph separators, and
// every format character (\p{Cf}): bidi embeddings, overrides, isolates and
// marks, zero-width spaces and joiners, invisible operators, the BOM, tag
// characters (the whole U+E0000-E007F block). None of them is visible, and
// each can make text read differently from what it says.
const UNSAFE_CARD_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\u{E0000}-\u{E007F}]/gu;

/**
 * Text from outside Raft for a card, as plain text: without control and bidi
 * characters (a viewer reads it in the order it is stored), newlines kept
 * only when `multiline`, at most `max` code points (cut with an ellipsis).
 */
export function plainActionCardText(value: string, max: number, options: { multiline?: boolean } = {}): string {
  let text = value.replace(/\r\n?/gu, "\n").replace(UNSAFE_CARD_TEXT, "");
  if (!options.multiline) text = text.replace(/[\n\t]+/gu, " ");
  text = text.trim();
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/** `agent:approve_call`: one held call, as the server built it from antiproton's item. */
export const agentApproveCallOperationSchema = lazySchema("agentApproveCallOperationSchema", () => z.strictObject({
  type: z.literal("agent:approve_call"),
  /** agent_runtime_approvals.id: the hold every card for it shares. */
  approvalId: uuidSchema,
  /** The agent whose call is held (the card's requester). */
  agentId: uuidSchema,
  agentName: z.string().min(1).max(120),
  /** `service` · `action` when the call names them, else `mount.tool`. */
  call: z.string().min(1).max(200),
  /** The plugin behind the mount, as context; null when the mount was removed since. */
  plugin: z.string().min(1).max(120).nullable(),
  /** `policy`: the mount's policy holds the tool; `agent`: the agent asked for a person itself. */
  heldBy: z.enum(["policy", "agent"]),
  /** What is being approved (`args.summary`), verbatim but for plainActionCardText. */
  summary: z.string().max(AGENT_CALL_APPROVAL_SUMMARY_MAX),
  summaryTruncated: z.boolean(),
  /** antiproton could not open the agent's sealed values: nothing is shown rather than something unredacted. */
  summaryWithheld: z.boolean(),
  /** A bridged request: `METHOD path (repo #pr)`. */
  request: z.string().min(1).max(600).nullable(),
  /** antiproton's line on what approving does and when the hold expires, verbatim. */
  description: z.string().max(AGENT_CALL_APPROVAL_DESCRIPTION_MAX),
  createdAt: z.iso.datetime(),
  /** Null only when the deployment turned expiry off. */
  expiresAt: z.iso.datetime().nullable(),
  /** Who the card went to: the agent's owner, or (the owner gone) a server owner or admin. */
  decider: z.enum(["owner", "server_admin"]),
}));
export type AgentApproveCallAction = z.infer<typeof agentApproveCallOperationSchema>;

// ── Server-built cards: a personal assistant's owner actions ────────────────
//
// `assistant:owner_action` (#proj-assistant:#19): a personal assistant asked
// to do something as its owner that is in its owner-action table at tier
// `confirm` (services/assistantOwnerActions.ts). Raft builds the card from the
// table entry and the parameters it resolved as the owner, and posts it as the
// assistant's message in its DM with its owner; the assistant writes none of
// the text. Only the owner may decide. Confirm runs the stored route as the
// owner (their own session, the route's own handler); Decline runs nothing.

/** The route a confirmed card runs, as admitted when the card was posted. */
export const ASSISTANT_OWNER_ACTION_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export const ASSISTANT_OWNER_ACTION_TEXT_MAX = 1000;

export const assistantOwnerActionOperationSchema = lazySchema("assistantOwnerActionOperationSchema", () => z.strictObject({
  type: z.literal("assistant:owner_action"),
  /** The personal assistant that asked (the card's requester). */
  assistantAgentId: uuidSchema,
  /** Its display name ("Ottie"), as the card names it. */
  assistantName: z.string().min(1).max(120),
  /** The only person who may decide. */
  ownerUserId: uuidSchema,
  /** The table entry (`key`) and its tool. */
  actionKey: z.string().min(1).max(80),
  tool: z.string().min(1).max(80),
  /** What it does, Raft's text with names, lower case: "move Sage to build-box-1". */
  phrase: z.string().min(1).max(200),
  /** Its past form, for the confirmed event: "Moved Sage to build-box-1". */
  done: z.string().min(1).max(200),
  /** What confirming does, Raft's text with names. */
  description: z.string().min(1).max(ASSISTANT_OWNER_ACTION_TEXT_MAX),
  /**
   * The same card as names the web shows in the viewer's language (actionCardMessages):
   * an entry with its own copy says which, and the names that fill it. Absent on
   * cards posted before views (and on an entry without its own copy): then the
   * card shows `phrase` and `description` as they are.
   */
  view: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("moveAgent"),
      agent: z.string().min(1).max(200),
      from: z.string().min(1).max(200).nullable(),
      to: z.string().min(1).max(200),
    }),
  ]).optional(),
  /** The owner route Confirm runs, exactly as admitted (path with ids filled in, the route's own body). */
  request: z.strictObject({
    method: z.enum(ASSISTANT_OWNER_ACTION_METHODS),
    path: z.string().min(1).max(600),
    body: z.record(z.string(), z.unknown()),
  }),
  /** Same entry and same request: the same card (idempotency key, sha256 hex). */
  paramsKey: z.string().regex(/^[0-9a-f]{64}$/),
  /** The tool's arguments as the assistant named things ("@Sage"), for its events. */
  args: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}));
export type AssistantOwnerActionCardAction = z.infer<typeof assistantOwnerActionOperationSchema>;

/** How an owner-action card ended, as names (the result's `line`). `failed.error` is the route's own text, in English. */
export type AssistantOwnerActionResultLine =
  | { kind: "declined" }
  | { kind: "unknown" }
  | { kind: "moveStarted"; agent: string; to: string; arrivalAt: string | null }
  | { kind: "failed"; error: string };

// ── Question cards: an agent asks a person (question-card spec) ──────────────
//
// `question:ask`: an agent's questions (single choice, multiple choice, free
// text) to one person, or to anyone in the channel. The server builds the
// card (actionCardSpecBuilder questionAsk: a Choice / TextArea form, paged by
// `pages`); the answers land in `metadata.result` (`question-answers`) and in
// a reply that @mentions the agent. Every text is the agent's plain text: a
// Field or Text string, or the raw Msg (actionCardRawText) where a slot takes
// only a Msg, so each limit below is at most 500 code points.
//
// Two schemas: what an agent sends (questionAskOperationSchema, one of the
// agent types), and what a card
// stores (storedQuestionAskActionSchema: the same plus `addressee` and
// `expiresAt`, which only the server writes at prepare). An agent's own
// `addressee` or `expiresAt` is an unknown key, refused like any other.

/**
 * The bounds of a `question:ask` card's fields, in Unicode code points for
 * text (after trimming). They do not by themselves keep the card within its
 * 24576 UTF-8 bytes (actionCardSpec maxBytes): a card with every field at its
 * maximum in 4-byte characters (emoji) does not fit. Prepare also measures
 * the card it would send, in every state it can reach, with
 * measureQuestionCard (actionCardSpecBuilder) and refuses one over
 * QUESTION_CARD_SIZE_THRESHOLD with 400 CARD_TOO_LARGE, naming what each
 * question costs. Agent text may hold no character JSON escapes to 6 bytes
 * (see questionText); people's answers are not limited by any of this (the
 * card shows each cut to `shownAnswer`; metadata.result keeps them whole).
 */
export const QUESTION_ASK_LIMITS = {
  questions: { min: 1, max: 4 },
  /** One option is a confirm: the card shows it as one button, and offers no Other… (isQuestionAskConfirm). */
  options: { min: 1, max: 4 },
  /** A question id (also its form field name): at most 16 of a-z A-Z 0-9 _, starting a-z. */
  id: 16,
  /** An option value: at most 16 of A-Z a-z 0-9 _ . : - */
  optionValue: 16,
  text: 120,
  description: 120,
  reason: 300,
  optionLabel: 40,
  placeholder: 40,
  /** `ref` never shows on the card (it comes back in metadata.result and the reply). */
  ref: 64,
  /** An answer's "Other" text (a Choice's Other maxLength): the default and the maximum. */
  otherMaxLength: 500,
  /** A text question's answer: default and maximum (a single-line one: at most `singleLineMaxLength`). */
  answerMaxLength: { default: 1000, max: 2000 },
  singleLineMaxLength: 500,
  /** One page a question at most: a page per question is the default. */
  pages: 4,
  expiresInMinutes: { min: 5, max: 43_200, default: 10_080 },
  /**
   * How much of each answer the answered card shows, in code points, cut with
   * an ellipsis: the chosen options' labels and the person's own text
   * together (each half when both), or a text answer. metadata.result keeps
   * every answer whole.
   */
  shownAnswer: 50,
} as const;
/**
 * The most UTF-8 bytes a question card may take, in the largest state it can
 * reach (measureQuestionCard): 24576 less 15% headroom, so Raft's copy can
 * grow a little without a prepared card later failing to rebuild.
 */
export const QUESTION_CARD_SIZE_THRESHOLD = 20_890;

/** `to` that asks anyone in the channel (not in a DM): the first valid answer counts. */
export const QUESTION_ASK_ANYONE = "anyone";
/** A question id: a form field name (actionCardSpec FIELD_NAME), at most QUESTION_ASK_LIMITS.id, not a reserved one. */
const QUESTION_ID = /^[a-z][a-zA-Z0-9_]{0,15}$/;
const QUESTION_RESERVED_IDS: readonly string[] = ["constructor", "prototype", "__proto__"];
/** A `ref`: actionCardSpec's OPTION_VALUE (1-64). */
const QUESTION_REF = /^[A-Za-z0-9_.:-]{1,64}$/;
/** An option value: OPTION_VALUE within QUESTION_ASK_LIMITS.optionValue. May not be `other` (ACTION_CARD_CHOICE_RESERVED_VALUE). */
const QUESTION_OPTION_VALUE = /^[A-Za-z0-9_.:-]{1,16}$/;
/**
 * What agent text may not hold: characters JSON escapes to 6 bytes (C0
 * controls but tab and newline, and lone surrogates), which would break the
 * card's size bound (QUESTION_ASK_LIMITS).
 */
const JSON_ESCAPED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const codePointsWithin = (min: number, max: number) => (value: string) => {
  const length = Array.from(value).length;
  return length >= min && length <= max;
};
/** Plain text of 1-`max` code points after trimming, without control characters. */
const questionText = (max: number, what: string) => z.string().trim()
  .refine(codePointsWithin(1, max), { error: `${what}: 1-${max} characters of plain text`, abort: true })
  .refine((value) => !JSON_ESCAPED.test(value), { error: `${what}: no control characters` });

const questionAskOptionSchema = lazySchema("questionAskOptionSchema", () => z.strictObject({
  value: z.string().regex(QUESTION_OPTION_VALUE, { error: `an option value is 1-${QUESTION_ASK_LIMITS.optionValue} of A-Z a-z 0-9 _ . : -` })
    .refine((value) => value !== "other", { error: '"other" is reserved: every choice question offers Other… itself' }),
  // No description: it does not fit the card's 24 KiB (QUESTION_ASK_LIMITS).
  label: questionText(QUESTION_ASK_LIMITS.optionLabel, "option label"),
}));

export const questionAskQuestionSchema = lazySchema("questionAskQuestionSchema", () => z.strictObject({
  id: z.string().regex(QUESTION_ID, { error: `a question id starts with a-z, then up to ${QUESTION_ASK_LIMITS.id - 1} of a-z A-Z 0-9 _` })
    .refine((id) => !QUESTION_RESERVED_IDS.includes(id), { error: "reserved id" }),
  kind: z.enum(["single", "multiple", "text"]),
  text: questionText(QUESTION_ASK_LIMITS.text, "question text"),
  description: questionText(QUESTION_ASK_LIMITS.description, "question description").optional(),
  required: z.boolean().default(true),
  /** single and multiple: QUESTION_ASK_LIMITS.options. */
  options: z.array(questionAskOptionSchema).min(QUESTION_ASK_LIMITS.options.min).max(QUESTION_ASK_LIMITS.options.max).optional(),
  /** multiple only: how many items (options, plus Other) an answer takes. Default 1 and all of them. */
  minItems: z.number().int().min(1).optional(),
  maxItems: z.number().int().min(1).optional(),
  /**
   * single and multiple with two or more options: Other… is always offered
   * (Raft's copy); this only sets its placeholder and length. A question with
   * one option is a confirm and takes none. One object, not `true | {…}`: an agent
   * type's fields must project to the SDK's tool schema (raft-sdk
   * toolSchema), which takes no union of a literal and an object, and `true`
   * said no more than leaving it out.
   */
  other: z.strictObject({
    placeholder: questionText(QUESTION_ASK_LIMITS.placeholder, "other placeholder").optional(),
    maxLength: z.number().int().min(1).max(QUESTION_ASK_LIMITS.otherMaxLength).optional(),
  }).optional()
    .describe("single and multiple with two or more options: Other… is always offered; this sets its placeholder and the most its answer takes. A question with one option is a confirm button: it offers no Other… and takes no `other`."),
  /** text only: a text area (default) or, false, one line. */
  multiline: z.boolean().optional(),
  /** text only: 1-2000, default 1000 (one line: at most 500). */
  maxLength: z.number().int().min(1).max(QUESTION_ASK_LIMITS.answerMaxLength.max).optional(),
}));

/** Who a stored question card asks, resolved by the server at prepare (an agent's own value is replaced). */
export const questionAskAddresseeSchema = lazySchema("questionAskAddresseeSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: uuidSchema, handle: z.string().min(1).max(120) }),
  z.strictObject({ kind: z.literal("anyone") }),
]));
export type QuestionAskAddressee = z.infer<typeof questionAskAddresseeSchema>;

/**
 * Whether a question is a confirm: a choice question (single or multiple)
 * with exactly one option. The person presses that one option or leaves it;
 * there is nothing to choose between, so the card offers no Other… and every
 * client draws it as one button (the form's field is a single Choice of one
 * option without `other`, actionCardSpecBuilder questionField). The answer is
 * a choice answer as any other: `{ kind: "choice", selected: [value] }`.
 */
export function isQuestionAskConfirm(question: { kind: string; options?: readonly unknown[] }): boolean {
  return question.kind !== "text" && question.options?.length === 1;
}

/**
 * `question:ask`'s rules across fields: options for the choice kinds only,
 * bounds for a multiple one within its items (options + Other; a confirm's
 * one option alone), no `other` on a confirm, one-line answers within 500, ids and option values unique, `pages` naming every
 * question exactly once.
 */
function checkQuestionAsk(action: { questions: QuestionAskQuestion[]; pages?: string[][] }, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const ids = action.questions.map((question) => question.id);
  action.questions.forEach((question, index) => {
    const at = (key: string) => ["questions", index, key];
    if (ids.indexOf(question.id) !== index) issue(at("id"), `question id "${question.id}" is used twice`);
    if (question.kind === "text") {
      for (const key of ["options", "minItems", "maxItems", "other"] as const) {
        if (question[key] !== undefined) issue(at(key), `a text question takes no ${key}`);
      }
      if (question.multiline === false && (question.maxLength ?? QUESTION_ASK_LIMITS.answerMaxLength.default) > QUESTION_ASK_LIMITS.singleLineMaxLength) {
        issue(at("maxLength"), `a one-line answer (multiline: false) takes at most ${QUESTION_ASK_LIMITS.singleLineMaxLength} characters`);
      }
      return;
    }
    for (const key of ["multiline", "maxLength"] as const) {
      if (question[key] !== undefined) issue(at(key), `a ${question.kind} question takes no ${key}`);
    }
    if (!question.options) {
      issue(at("options"), `a ${question.kind} question needs ${QUESTION_ASK_LIMITS.options.min}-${QUESTION_ASK_LIMITS.options.max} options`);
      return;
    }
    const values = question.options.map((option) => option.value);
    if (new Set(values).size !== values.length) issue(at("options"), "option values must be unique");
    const confirm = isQuestionAskConfirm(question);
    if (confirm && question.other !== undefined) issue(at("other"), "a question with one option is a confirm button: it offers no Other… and takes no other");
    if (question.kind === "single") {
      for (const key of ["minItems", "maxItems"] as const) {
        if (question[key] !== undefined) issue(at(key), `a single question takes one answer: no ${key}`);
      }
      return;
    }
    // Other… counts as one more item; a confirm has none.
    const items = question.options.length + (confirm ? 0 : 1);
    const most = confirm ? `at most ${items} (the one option)` : `at most ${items} (the options and Other…)`;
    if (question.minItems !== undefined && question.minItems > items) issue(at("minItems"), most);
    if (question.maxItems !== undefined && question.maxItems > items) issue(at("maxItems"), most);
    if (question.maxItems !== undefined && question.maxItems < (question.minItems ?? 1)) issue(at("maxItems"), "maxItems is less than minItems");
  });
  if (action.pages) {
    const named = action.pages.flat();
    const unknown = named.filter((id) => !ids.includes(id));
    if (unknown.length > 0) issue(["pages"], `pages name no question ${unknown.map((id) => `"${id}"`).join(", ")}`);
    const twice = named.filter((id, index) => named.indexOf(id) !== index);
    if (twice.length > 0) issue(["pages"], `pages name ${twice.map((id) => `"${id}"`).join(", ")} more than once`);
    const missing = ids.filter((id) => !named.includes(id));
    if (missing.length > 0) issue(["pages"], `pages leave out ${missing.map((id) => `"${id}"`).join(", ")}`);
  }
}

/** `question:ask`'s fields as an agent writes them (both schemas below). */
const questionAskAgentShape = () => ({
  type: z.literal("question:ask"),
  to: z.string().trim().min(1).max(120).optional()
    .describe('Who answers: a person\'s handle ("@tenny" or "tenny"), or "anyone" for whoever in the channel answers first. In a DM leave it out (the person in the DM).'),
  reason: questionText(QUESTION_ASK_LIMITS.reason, "reason").optional()
    .describe(`Why you ask, in plain text (up to ${QUESTION_ASK_LIMITS.reason} characters); shown on the card as the reason.`),
  ref: z.string().regex(QUESTION_REF, { error: `ref is 1-${QUESTION_ASK_LIMITS.ref} of A-Z a-z 0-9 _ . : -` }).optional()
    .describe("Your own id for this question card; it comes back with the answers."),
  expiresInMinutes: z.number().int().min(QUESTION_ASK_LIMITS.expiresInMinutes.min).max(QUESTION_ASK_LIMITS.expiresInMinutes.max)
    .default(QUESTION_ASK_LIMITS.expiresInMinutes.default),
  questions: z.array(questionAskQuestionSchema).min(QUESTION_ASK_LIMITS.questions.min).max(QUESTION_ASK_LIMITS.questions.max),
  pages: z.array(z.array(z.string()).min(1).max(QUESTION_ASK_LIMITS.questions.max)).min(1).max(QUESTION_ASK_LIMITS.pages).optional(),
});

/**
 * `question:ask` — an agent asks a person (`to`: a handle, or "anyone" in a
 * channel; in a DM it may be left out) 1-4 questions on one card (QUESTION_ASK_LIMITS). `pages`
 * groups them into the sheet's pages (default: one question a page). It
 * expires after `expiresInMinutes`; only the agent that asked may withdraw
 * it. `ref` comes back with the answers.
 */
export const questionAskOperationSchema = lazySchema("questionAskOperationSchema", () => z.strictObject(questionAskAgentShape()).superRefine(checkQuestionAsk));

/**
 * A stored `question:ask` card's action: the agent's, plus `addressee` and
 * `expiresAt`, which the server sets at prepare from `to` and
 * `expiresInMinutes` (absent only on a card built for a test).
 */
export const storedQuestionAskActionSchema = lazySchema("storedQuestionAskActionSchema", () => z.strictObject({
  ...questionAskAgentShape(),
  /** Set by the server at prepare. */
  addressee: questionAskAddresseeSchema.optional(),
  /** Set by the server at prepare: when the card expires (createdAt + expiresInMinutes). */
  expiresAt: z.iso.datetime().optional(),
}).superRefine(checkQuestionAsk));
/** A stored question card's action (what the builders, the form handler and the sweep read). */
export type QuestionAskAction = z.infer<typeof storedQuestionAskActionSchema>;
/** A question card as an agent sends it. */
export type QuestionAskAgentAction = z.infer<typeof questionAskOperationSchema>;
export type QuestionAskQuestion = z.infer<typeof questionAskQuestionSchema>;

/** The card types an agent may prepare (the Agent API, CLI and SDK take these). */
function agentActionCardOperationSchemas() {
  return [...agentActionCardOperationSchemasStoredAsSent(), agentMigrateOperationSchema, questionAskOperationSchema] as const;
}

export const actionCardActionSchema = lazySchema("actionCardActionSchema", () => z.discriminatedUnion("type", agentActionCardOperationSchemas()));

export type ActionCardAction = z.infer<typeof actionCardActionSchema>;
export type ActionCardActionType = ActionCardAction["type"];

/** Every card type a stored card may hold: the agent types, the person-requested ones and the server-built ones. */
export const storedActionCardActionSchema = lazySchema("storedActionCardActionSchema", () => z.discriminatedUnion("type", [
  ...agentActionCardOperationSchemasStoredAsSent(),
  storedAgentMigrateActionSchema,
  seatsAddOperationSchema,
  agentApproveCallOperationSchema,
  storedQuestionAskActionSchema,
  assistantOwnerActionOperationSchema,
]));
export type StoredActionCardAction = z.infer<typeof storedActionCardActionSchema>;
export type StoredActionCardActionType = StoredActionCardAction["type"];

export interface ActionCardPresentationItem {
  key: string;
  value: string;
  /** The value has been replaced server-side and is safe to persist/display. */
  redacted?: boolean;
}

/**
 * Backward-compatible presentation envelope for clients that do not yet know
 * a newly introduced action type. The server owns whether generic execution
 * is permitted; absence/false is display-only and must fail closed.
 */
export interface ActionCardPresentation {
  title: string;
  confirmLabel: string;
  genericApprovalAllowed: boolean;
  displayItems: ActionCardPresentationItem[];
  warning?: string | null;
  riskLevel?: "normal" | "elevated";
  /**
   * The card described as data (`action-card.v1`, actionCardSpec.ts), built
   * by the server beside the fields above, which stay for clients that do not
   * read it. A client reads it with `parseActionCardSpec(raw, { mode: "read" })`
   * and falls back to the fields above when that fails.
   */
  card?: ActionCardSpecCard;
}

// Keyed by every union member, so a type missing here (or one the union does
// not have) fails typecheck instead of rendering view-only on the web.
const ACTION_CARD_ACTION_TYPE_KEYS = {
  "channel:create": true,
  "agent:create": true,
  "channel:add_member": true,
  "integration:approve_agent_login": true,
  "integration:install_marketplace_app": true,
  "integration:register_app": true,
  "integration:update_app_registration": true,
  "integration:recover_app_owner": true,
  "integration:connect_mcp": true,
  "feedback:submit": true,
  "plan:upgrade": true,
  "agent:migrate": true,
  "question:ask": true,
} satisfies Record<ActionCardActionType, true>;

export const ACTION_CARD_ACTION_TYPES: readonly ActionCardActionType[] = Object.freeze(
  Object.keys(ACTION_CARD_ACTION_TYPE_KEYS) as ActionCardActionType[],
);

/** Every type a stored card may hold, agent, person-requested and server-built (what a client renders). */
export const STORED_ACTION_CARD_ACTION_TYPES: readonly StoredActionCardActionType[] = Object.freeze([
  ...ACTION_CARD_ACTION_TYPES,
  "seats:add",
  "agent:approve_call",
  "assistant:owner_action",
] satisfies StoredActionCardActionType[]);

const SENSITIVE_PRESENTATION_KEY_PARTS = [
  "secret",
  "token",
  "password",
  "credential",
  "authorization",
  "privatekey",
  "private_key",
  "access_token",
  "refresh_token",
] as const;

function isSensitivePresentationKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("-", "").replaceAll(".", "");
  return SENSITIVE_PRESENTATION_KEY_PARTS.some((part) => normalized.includes(part));
}

function safePresentationValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => safePresentationValue(item)).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([key, child]) => (
      `${key}: ${isSensitivePresentationKey(key) ? "Hidden" : safePresentationValue(child)}`
    )).join(", ");
  }
  return "-";
}

function actionPresentationItems(action: StoredActionCardAction): ActionCardPresentationItem[] {
  return Object.entries(action)
    .filter(([key]) => key !== "type" && key !== "draftHint" && key !== "clientNameSha256")
    .slice(0, 24)
    .map(([key, value]) => {
      const redacted = isSensitivePresentationKey(key);
      const rendered = redacted ? "Hidden" : safePresentationValue(value);
      return {
        key,
        value: rendered.length <= 500 ? rendered : `${rendered.slice(0, 497)}...`,
        ...(redacted ? { redacted: true } : {}),
      };
    })
    .filter((item) => item.value.length > 0);
}

export function buildActionCardPresentation(action: StoredActionCardAction): ActionCardPresentation {
  const displayItems = actionPresentationItems(action);
  switch (action.type) {
    case "integration:approve_agent_login":
      return {
        title: `Approve ${action.clientName} for @${action.agentName.replace(/^@/, "")}`,
        confirmLabel: "Approve Login",
        genericApprovalAllowed: true,
        displayItems,
        riskLevel: "elevated",
      };
    case "integration:install_marketplace_app":
      return {
        title: `Install ${action.clientName} on this Server`,
        confirmLabel: "Install App",
        genericApprovalAllowed: true,
        displayItems,
        warning: `This installs the Marketplace app for this Server so @${action.agentName.replace(/^@/, "")} can request the listed scopes.`,
        riskLevel: "elevated",
      };
    case "integration:connect_mcp":
      return {
        // No name in the title, because no name is STORED. Every other card in this file keeps an
        // agentName/clientName on the durable row; this one deliberately does not (@peng): the row
        // holds App id, Agent id, reason and revision, and nothing that identifies an account.
        // Whoever may act on it, and which Connections they may choose, is projected fresh from the
        // CURRENT viewer's permissions at render time -- never frozen into the card.
        title: "Authorize an MCP connection",
        confirmLabel: "Authorize",
        // A generic "approve" cannot pick WHICH Connection, and picking is the whole decision.
        genericApprovalAllowed: false,
        displayItems,
        warning: "An agent tried to use this MCP server and has no authorized connection. Choose a connection to grant, or authorize a new one.",
        riskLevel: "elevated",
      };
    case "integration:register_app":
      return {
        title: `Register Connected App ${action.name}`,
        confirmLabel: "Register App",
        genericApprovalAllowed: true,
        displayItems,
        warning: "The requesting agent becomes the initial app owner. No client secret is stored in this card.",
        riskLevel: "elevated",
      };
    case "integration:recover_app_owner":
      return {
        title: "Recover Connected App owner",
        confirmLabel: "Recover Owner",
        genericApprovalAllowed: true,
        displayItems,
        warning: "This changes the owner of a server-local Connected App.",
        riskLevel: "elevated",
      };
    case "integration:update_app_registration":
      return {
        title: "Connected App update unavailable",
        confirmLabel: "Unavailable",
        genericApprovalAllowed: false,
        displayItems,
        warning: "Use the current Connected Apps management command instead.",
        riskLevel: "normal",
      };
    case "channel:create":
      return {
        title: `Create channel #${action.name.replace(/^#/, "")}`,
        confirmLabel: "Create Channel",
        genericApprovalAllowed: false,
        displayItems,
        riskLevel: "normal",
      };
    case "agent:create":
      return {
        title: `Create Agent @${action.name.replace(/^@/, "")}`,
        confirmLabel: "Create Agent",
        genericApprovalAllowed: false,
        displayItems,
        riskLevel: "normal",
      };
    case "agent:migrate":
      // Started from the migration dialog (POST /api/agents/:id/migrate), never by a generic confirm.
      return {
        title: "Move agent to another computer",
        confirmLabel: "Move Agent",
        genericApprovalAllowed: false,
        displayItems,
        riskLevel: "normal",
      };
    case "channel:add_member":
      return {
        title: "Add channel members",
        confirmLabel: "Add Members",
        genericApprovalAllowed: false,
        displayItems,
        riskLevel: "normal",
      };
    case "feedback:submit":
      // Sent from the feedback form (POST /api/product-feedback), never by a
      // generic confirm.
      return {
        title: "Submit feedback",
        confirmLabel: "Submit Feedback",
        genericApprovalAllowed: false,
        displayItems,
        riskLevel: "normal",
      };
    case "plan:upgrade":
      // Nothing to approve: the button opens the upgrade dialog, and the
      // server has no action for this type.
      return {
        title: "Upgrade to Pro",
        confirmLabel: "Upgrade to Pro",
        genericApprovalAllowed: false,
        displayItems,
        riskLevel: "normal",
      };
    case "seats:add":
      // An owner adds the seats in the add-seats dialog; no generic confirm.
      return {
        title: `Add ${action.seats} ${action.seats === 1 ? "seat" : "seats"}`,
        confirmLabel: "Add Seats",
        genericApprovalAllowed: false,
        displayItems: [],
        riskLevel: "normal",
      };
    case "question:ask": {
      // Answered in its form, never by a generic confirm. Who is asked, then
      // each question as asked (design fallback-unknown); English only, as
      // every legacy field.
      const single = action.questions.length === 1;
      const asked = action.addressee?.kind === "user"
        ? `@${action.addressee.handle}`
        : action.addressee?.kind === "anyone" || action.to === QUESTION_ASK_ANYONE ? "Anyone in this channel" : action.to ?? "-";
      return {
        title: single ? "Answer Question" : "Answer Questions",
        confirmLabel: single ? "Answer Question" : "Answer Questions",
        genericApprovalAllowed: false,
        displayItems: [
          { key: "For", value: clipPresentationValue(asked) },
          ...action.questions.map((question, index) => ({ key: single ? "Question" : `Question ${index + 1}`, value: clipPresentationValue(question.text) })),
        ],
        riskLevel: "normal",
      };
    }
    case "agent:approve_call":
      // Decided in its form (approve or deny, no default), never by a generic confirm.
      return {
        title: `Approve a call by ${action.agentName}`,
        confirmLabel: "Decide",
        genericApprovalAllowed: false,
        displayItems: [
          { key: "call", value: action.call },
          ...(action.request ? [{ key: "request", value: action.request }] : []),
          { key: "summary", value: action.summaryWithheld ? "Withheld" : clipPresentationValue(action.summary) },
          ...(action.expiresAt ? [{ key: "expiresAt", value: action.expiresAt }] : []),
        ],
        riskLevel: "elevated",
      };
    case "assistant:owner_action":
      // Decided in its form (confirm or decline, no default), only by the owner.
      return {
        title: `${action.assistantName} wants to ${action.phrase} as you`,
        confirmLabel: "Decide",
        genericApprovalAllowed: false,
        displayItems: [
          { key: "What happens", value: clipPresentationValue(action.description) },
          { key: "expiresAt", value: action.expiresAt },
        ],
        riskLevel: "elevated",
      };
  }
}

function clipPresentationValue(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

/**
 * UUID v1-v8 / nil / max — same shape the agent-facing handle resolvers use
 * to short-circuit and pass UUIDs through verbatim. Mirrors zod's
 * `z.uuid()` accept set so action-card resolution and other zod validation
 * stay consistent on what counts as a UUID literal vs a handle.
 */
const UUID_PATTERN =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

export function looksLikeUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Strip a leading sigil (`@` for humans/agents, `#` for channels) so the
 * remaining handle can be fed straight into `resolveUserByName` /
 * `resolveAgentByName` / `resolveChannelByName`. Agents are free to use
 * either form (`@alice` or `alice`); we normalize before resolution.
 */
export function extractHandleName(raw: string, sigil: "@" | "#"): string {
  const trimmed = raw.trim();
  return trimmed.startsWith(sigil) ? trimmed.slice(1) : trimmed;
}

/**
 * One reason an action card failed its checks. `path` is the dotted field
 * path inside the action (`type`, `reason`, `humans.0`, ...), or `action` for
 * the action as a whole.
 */
export interface ActionCardActionIssue {
  path: string;
  message: string;
}

/**
 * Post-schema cross-field validation. The discriminated union catches type
 * structure issues; this catches semantic constraints that don't fit a pure
 * schema (e.g. `channel:add_member` requires at least one member).
 *
 * Returns null when the action is valid, or the first failure with the field
 * it is about. Call this AFTER `actionCardActionSchema.parse()`.
 */
export function actionCardActionCrossFieldIssue(action: ActionCardAction): ActionCardActionIssue | null {
  if (action.type === "agent:create") {
    if (action.suggestedComputer && action.requiredComputer) {
      return { path: "requiredComputer", message: "agent:create must include only one of suggestedComputer or requiredComputer" };
    }
    if (action.hosting === "antiproton" && (action.suggestedComputer || action.requiredComputer)) {
      return {
        path: action.suggestedComputer ? "suggestedComputer" : "requiredComputer",
        message: 'agent:create with hosting: "antiproton" makes a cloud agent, which does not run on a Computer; leave out suggestedComputer and requiredComputer',
      };
    }
    if (action.model !== undefined && action.hosting !== "antiproton") {
      return { path: "model", message: 'agent:create model is only for a cloud agent (hosting: "antiproton")' };
    }
  }
  if (action.type === "channel:add_member") {
    const total = (action.humans?.length ?? 0) + (action.agents?.length ?? 0);
    if (total === 0) {
      return { path: "action", message: "channel:add_member must include at least one human or agent" };
    }
  }
  if (action.type === "integration:update_app_registration") {
    const hasMetadataPatch = action.name !== undefined
      || action.description !== undefined
      || action.homepageUrl !== undefined
      || action.returnUrl !== undefined
      || action.agentManifestUrl !== undefined
      || action.setupUrl !== undefined
      || action.setupDescription !== undefined
      || action.scopes !== undefined;
    if (!hasMetadataPatch) {
      return { path: "action", message: "integration:update_app_registration must include at least one field to update" };
    }
  }
  return null;
}

/**
 * `actionCardActionCrossFieldIssue`'s message alone: null when the action is
 * valid. Call this AFTER `actionCardActionSchema.parse()`.
 */
export function validateActionCardAction(action: ActionCardAction): string | null {
  return actionCardActionCrossFieldIssue(action)?.message ?? null;
}

/**
 * Every card type the schema validates, in schema order: the discriminator
 * values of `actionCardActionSchema` itself, so it cannot drift from what
 * validation accepts.
 */
export function actionCardSchemaTypes(): ActionCardActionType[] {
  return actionCardActionSchema.options.map((option) => option.shape.type.value);
}

/** An invalid-action answer names at most this many issues, then "and N more". */
export const INVALID_ACTION_CARD_MAX_ISSUES = 10;
// Caps on the parts of an issue that echo the caller's input (an unknown
// `type`, unrecognized keys), so a huge body cannot make a huge answer, and on
// the allowed values a reason lists. The schema's own messages are fixed text.
const ISSUE_ECHO_MAX_LENGTH = 60;
const ISSUE_MAX_UNRECOGNIZED_KEYS = 3;
const ISSUE_MAX_LISTED_VALUES = 10;

function clipEcho(value: string): string {
  return value.length <= ISSUE_ECHO_MAX_LENGTH ? value : `${value.slice(0, ISSUE_ECHO_MAX_LENGTH - 1)}…`;
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((part) => clipEcho(String(part))).join(".") || "action";
}

/** The card's `type` as sent, when the schema could not match it to a card type. */
function cardTypeIssue(input: unknown): ActionCardActionIssue {
  const type = input && typeof input === "object" ? (input as { type?: unknown }).type : undefined;
  if (type === undefined) return { path: "type", message: "required" };
  if (typeof type !== "string") return { path: "type", message: "must be a string" };
  return { path: "type", message: `unknown card type ${JSON.stringify(clipEcho(type))}` };
}

/** The value at an issue's path in what was sent (undefined when it is absent). */
function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const part of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[part];
  }
  return value;
}

/**
 * Zod's own text for `issue`, so a message the schema wrote itself (e.g.
 * plan:upgrade's `reason`, which already says why) is kept rather than
 * shortened.
 */
function zodDefaultMessage(issue: z.core.$ZodIssue, value: unknown): string | undefined {
  const out = z.config().localeError?.({ ...issue, input: value } as unknown as z.core.$ZodRawIssue);
  return typeof out === "string" ? out : out?.message;
}

const TYPE_NAMES: Partial<Record<string, string>> = { int: "integer" };
// Formats whose Zod text states the rule itself (a pattern, a prefix, ...).
const RULE_FORMATS = new Set(["regex", "starts_with", "ends_with", "includes", "lowercase", "uppercase"]);
const FORMAT_NAMES: Partial<Record<string, string>> = { uuid: "UUID", guid: "GUID", url: "URL", email: "email address", jwt: "JWT" };

function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

function countOf(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function sizeReason(issue: z.core.$ZodIssueTooBig | z.core.$ZodIssueTooSmall): string | null {
  const big = issue.code === "too_big";
  const limit = Number(big ? (issue as z.core.$ZodIssueTooBig).maximum : (issue as z.core.$ZodIssueTooSmall).minimum);
  const inclusive = issue.inclusive !== false;
  const unit = issue.origin === "string" ? "character" : issue.origin === "array" || issue.origin === "set" ? "item" : null;
  if (unit) {
    const n = inclusive ? limit : big ? limit - 1 : limit + 1;
    return `${issue.exact ? "exactly" : big ? "at most" : "at least"} ${countOf(n, unit)}`;
  }
  if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
    if (issue.exact) return `must be ${limit}`;
    return inclusive ? `${big ? "at most" : "at least"} ${limit}` : `${big ? "less" : "more"} than ${limit}`;
  }
  return null;
}

/**
 * A short reason for one schema issue: "required", "must be a string", "at
 * most 60 characters", "must be one of a, b", "not a valid UUID". A message
 * the schema wrote itself, and any other kind of issue, keeps its own text.
 */
function shortReason(issue: z.core.$ZodIssue, input: unknown): string {
  const value = valueAtPath(input, issue.path);
  if (issue.message !== zodDefaultMessage(issue, value)) return issue.message;
  switch (issue.code) {
    case "invalid_type":
      if (value === undefined) return "required";
      return `must be ${withArticle(TYPE_NAMES[issue.expected] ?? issue.expected)}`;
    case "too_big":
    case "too_small":
      return sizeReason(issue) ?? issue.message;
    case "invalid_value": {
      const shown = issue.values.slice(0, ISSUE_MAX_LISTED_VALUES).map((option) => String(option));
      if (issue.values.length === 1) return `must be ${shown[0]}`;
      const more = issue.values.length - shown.length;
      return `must be one of ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    }
    case "invalid_format":
      if (RULE_FORMATS.has(issue.format)) return issue.message;
      return `not a valid ${FORMAT_NAMES[issue.format] ?? issue.format}`;
    default:
      return issue.message;
  }
}

/**
 * `actionCardActionSchema`'s issues for `input` as `path: reason` pairs with
 * short reasons (shortReason); an unknown or missing `type` (zod says only
 * "Invalid input") names the type sent, and unrecognized keys are the path.
 */
export function actionCardSchemaIssues(input: unknown, error: z.ZodError): ActionCardActionIssue[] {
  return error.issues.map((issue) => {
    if (issue.code === "invalid_union" && issue.path.length === 1 && issue.path[0] === "type") {
      return cardTypeIssue(input);
    }
    if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
      const shown = issue.keys.slice(0, ISSUE_MAX_UNRECOGNIZED_KEYS).map((key) => issuePath([...issue.path, key]));
      const more = issue.keys.length - shown.length;
      return { path: `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`, message: issue.message };
    }
    return { path: issuePath(issue.path), message: shortReason(issue, input) };
  });
}

/**
 * The next step for an action card that failed its checks, in one string
 * (raft-sdk shows only the code and this): each issue as `path: reason`, at
 * most `INVALID_ACTION_CARD_MAX_ISSUES` of them, then the card types the
 * server accepts.
 */
export function formatInvalidActionCardNextStep(
  issues: readonly ActionCardActionIssue[],
  acceptedTypes: readonly string[],
): string {
  return `Fix these fields and run it again: ${formatInvalidActionCardFields(issues)}. Card types this server accepts: ${acceptedTypes.join(", ") || "none"}.`;
}

/**
 * The issues alone, `path: reason; …`, bounded as in the next step: also the
 * refusal's `error`, since a CLI from Computer 1.0.53 or older prints only
 * `error` (Sage, #11537).
 */
export function formatInvalidActionCardFields(issues: readonly ActionCardActionIssue[]): string {
  const shown = issues.slice(0, INVALID_ACTION_CARD_MAX_ISSUES)
    .map((issue) => `${issue.path}: ${issue.message.trim().replace(/\.+$/, "")}`);
  const more = issues.length - shown.length;
  if (more > 0) shown.push(`and ${more} more`);
  return shown.length > 0 ? shown.join("; ") : "action: failed validation";
}

// ── Card state on the carrier message ───────────────────────────────────────
//
// State lives on `messages.action_metadata` (jsonb) and is mirrored by the
// durable action_cards row. Conversion adds an authority-aware lifecycle:
//   prepared → frozen → reconfirm_required → prepared/ready → executed
//   prepared → failed     (admin clicked, action failed; card shows error and
//                          stays "prepared" so click can be retried —
//                          `failed` is a UI hint, the canonical state stays
//                          `prepared` for retry)
//
// The action is idempotent at the server level: a click while state is
// already `executed` is rejected.

/**
 * `expired` ends a person-requested card (`seats:add`, a person's
 * `plan:upgrade`) without acting: no owner answered it within
 * `SEAT_REQUEST_TTL_MS`; and a `question:ask` card nobody answered by its
 * `expiresAt`. `withdrawn` (question cards): the agent that asked took it
 * back while it was still `prepared` (POST
 * /agent-api/actions/:messageId/withdraw); `withdrawnAt` says when, and no
 * reply follows. States are additive: a client reads one it does not know as
 * ended (view-only, nothing to press).
 */
export type ActionCardState = "prepared" | "executed" | "frozen" | "reconfirm_required" | "expired" | "withdrawn";

/**
 * How long a card can be completed (#proj-apps:#40): 30 days from when it was
 * prepared (`action_cards.created_at`). Past that, every path whose press
 * causes the effect (execute and its forms, a feedback card's send, reconfirm)
 * refuses it, 409 ACTION_CARD_EXPIRED, and a read serves it as `expired`
 * (ActionCardMetadata.expiresAt). Its row stays `prepared`. Recording what a
 * dialog already did (mark-executed) is never refused. A type exempt from it
 * (isActionCardExpiryExempt) keeps its own rule.
 */
export const ACTION_CARD_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const ACTION_CARD_EXPIRED_ERROR_CODE = "ACTION_CARD_EXPIRED";

/**
 * Types the 30-day rule leaves alone. They end by a deadline of their own:
 * `question:ask`, `agent:approve_call` and `assistant:owner_action` at their
 * `action.expiresAt`, `seats:add` at its `expiresAt`, a person's
 * `plan:upgrade` SEAT_REQUEST_TTL_MS after it was asked; or by none: an
 * agent's `plan:upgrade` only opens the upgrade dialog, and nothing completes
 * it on the server.
 */
export function isActionCardExpiryExempt(actionType: string): boolean {
  return actionType === "question:ask" || actionType === "agent:approve_call" || actionType === "assistant:owner_action"
    || actionType === "seats:add" || actionType === "plan:upgrade";
}

/**
 * When a card stops being completable, as a read serves it
 * (ActionCardMetadata.expiresAt): `createdAt` (action_cards.created_at) plus
 * ACTION_CARD_EXPIRY_MS, or an exempt type's own deadline; null when it has
 * none (an agent's plan:upgrade, a held call whose deployment turned expiry
 * off).
 */
export function actionCardExpiresAt(card: { action: { type: string }; requesterUserId?: string | null; createdAt: Date | string }): string | null {
  const preparedAt = new Date(card.createdAt).getTime();
  const after = (ms: number) => (Number.isFinite(preparedAt) ? new Date(preparedAt + ms).toISOString() : null);
  if (card.action.type === "plan:upgrade") return card.requesterUserId ? after(SEAT_REQUEST_TTL_MS) : null;
  if (isActionCardExpiryExempt(card.action.type)) {
    const own = (card.action as { expiresAt?: unknown }).expiresAt;
    return typeof own === "string" && Number.isFinite(Date.parse(own)) ? new Date(own).toISOString() : null;
  }
  return after(ACTION_CARD_EXPIRY_MS);
}

/** Whether a card the 30-day rule covers, prepared at `createdAt`, is past it at `now`. Never an exempt type. */
export function isActionCardPastExpiry(card: { actionType: string; createdAt: Date | string }, now: number = Date.now()): boolean {
  if (isActionCardExpiryExempt(card.actionType)) return false;
  const preparedAt = new Date(card.createdAt).getTime();
  return Number.isFinite(preparedAt) && now - preparedAt > ACTION_CARD_EXPIRY_MS;
}

export interface ActionCardMetadata {
  kind: "action-card";
  /**
   * The card's target server, fixed at prepare time (the preparing agent's
   * server). Execution always acts on this server and the confirmer's
   * permissions are checked there, whichever joint projection they view it
   * from. Read paths overwrite it from `action_cards.server_id`.
   */
  sourceServerId?: ServerId | null;
  /** Display name of `sourceServerId` at prepare time ("Acts on <name>"). */
  targetServerName?: string | null;
  /** Frozen at prepare time. */
  action: StoredActionCardAction;
  /**
   * Set when a person asked for the card (`seats:add`, a person's
   * `plan:upgrade`, the `agent:create` card an owner sends back); agent cards
   * have none.
   */
  requesterUserId?: string | null;
  /**
   * The agent that prepared the card (action_cards.requester_agent_id), set at
   * prepare: who asks, for a client to name (a question card's "{agent}
   * withdrew…" line). Absent on cards prepared before it was written, and on
   * cards a person asked for.
   */
  requesterAgentId?: string | null;
  /** Set when a seat request is completed: what came of it. */
  seatOutcome?: SeatRequestOutcome | null;
  /** Safe fallback presentation for older clients. */
  presentation?: ActionCardPresentation | null;
  state: ActionCardState;
  /**
   * Served only, never stored (#proj-apps:#40): when this `prepared` card
   * stops being completable, RFC 3339 UTC (actionCardExpiresAt). A card the
   * 30-day rule covers: 30 days after it was prepared, and once that is past
   * the read also serves `state: "expired"` (its row stays `prepared`), so a
   * client that ignores this field still draws it ended. An exempt type
   * (isActionCardExpiryExempt): its own deadline, its state as stored. Absent
   * when there is none, and on a card in any other state.
   *
   * A client's `now > expiresAt` only decides whether it shows the card's
   * buttons (and so opens no dialog for a card that ran out while the page
   * was open). The server's refusal (409 ACTION_CARD_EXPIRED, or the type's
   * own) is the only authority: no client treats its own clock as final.
   */
  expiresAt?: string;
  /** Set when state = withdrawn (a question card its agent took back). */
  withdrawnAt?: string | null;
  /** Set when state = executed. */
  executedAt?: string | null;
  executedByUserId?: string | null;
  executedByUserName?: string | null;
  /** Resource produced by the execute step (e.g. created channel id). */
  result?: ActionCardResult | null;
  /** Persisted optimistic credential. Conversion retires the old value. */
  confirmationVersion?: number;
  /** Durable conversion identity; present only after this card was frozen. */
  conversionJobId?: string;
  conversionEpoch?: string;
  reconfirmedAt?: string;
}

/**
 * Every key `action_metadata` may carry to a client, and whether the mobile
 * App's canonical message V2 keeps it (#proj-apps:#40, Lagoon d328aa9c). The
 * App builds its strict V2 from the plain rows the server sends, and first
 * keeps only the keys it knows (`withKnownActionCardKeysOnly`, its
 * `ACTION_CARD_ROOT_KEYS`, App 1.16.1 and later); the rest are dropped from
 * the V2 copy only. The App's own card code still reads the plain row, so it
 * can use a `"v2-drops"` key (`requesterUserId`, `expiresAt`). App 1.16.0 has
 * no such step: a row with any `"v2-drops"` key fails its V2 conversion there
 * (logged, not fatal).
 *
 * Exhaustive over ActionCardMetadata, so adding a key fails to compile until
 * it is listed here. That is the moment to ask the App owner whether its V2
 * keeps it, drops it, or needs a release first; the keys marked
 * `"v2-drops"` below had already shipped when this list was written.
 */
export const ACTION_CARD_METADATA_KEYS = {
  kind: "v2-keeps",
  sourceServerId: "v2-keeps",
  targetServerName: "v2-keeps",
  action: "v2-keeps",
  requesterUserId: "v2-drops",
  requesterAgentId: "v2-drops",
  seatOutcome: "v2-drops",
  presentation: "v2-keeps",
  state: "v2-keeps",
  expiresAt: "v2-drops",
  withdrawnAt: "v2-drops",
  executedAt: "v2-keeps",
  executedByUserId: "v2-keeps",
  executedByUserName: "v2-keeps",
  result: "v2-keeps",
  confirmationVersion: "v2-keeps",
  conversionJobId: "v2-drops",
  conversionEpoch: "v2-drops",
  reconfirmedAt: "v2-drops",
} as const satisfies Record<keyof ActionCardMetadata, "v2-keeps" | "v2-drops">;

/** Every key of any member of a union (`keyof` of a union is only the keys all members share). */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * Every key a card's `action` may carry to a client, whatever its type, and
 * whether the mobile App's canonical message V2 keeps it (#proj-apps:#40).
 * The App keeps the action's keys it knows (its `ACTION_CARD_ACTION_KEYS`, one
 * set for every type) and drops the rest from the V2 copy only, in the same
 * step as the root's (`withKnownActionCardKeysOnly`); App 1.16.0 instead
 * fails the row's V2 conversion on any `"v2-drops"` key. Its own card code
 * still reads the plain row, so a type's own keys (`plan:upgrade`'s
 * `reason`) still reach its card.
 *
 * One list over every stored action type, as the App's filter is by key and
 * not by type. Exhaustive over StoredActionCardAction, so a new key on any
 * type fails to compile until it is listed here: the moment to ask the App
 * owner whether its V2 keeps it. A type that takes a key another type already
 * has is not caught; the App treats the key the same either way. Grouped by
 * the first type (in the stored union's order) that has each dropped key.
 */
export const ACTION_CARD_ACTION_KEYS = {
  type: "v2-keeps",
  name: "v2-keeps",
  description: "v2-keeps",
  visibility: "v2-keeps",
  channel: "v2-keeps",
  suggestedComputer: "v2-keeps",
  requiredComputer: "v2-keeps",
  humans: "v2-keeps",
  agents: "v2-keeps",
  initialHumans: "v2-keeps",
  initialAgents: "v2-keeps",
  draftHint: "v2-keeps",
  requestId: "v2-keeps",
  agentId: "v2-keeps",
  agentName: "v2-keeps",
  clientId: "v2-keeps",
  clientKey: "v2-keeps",
  clientName: "v2-keeps",
  scopes: "v2-keeps",
  // agent:create
  hosting: "v2-drops",
  model: "v2-drops",
  // integration:connect_mcp
  mcpServerId: "v2-drops",
  reason: "v2-drops",
  revision: "v2-drops",
  // integration:install_marketplace_app
  clientNameSha256: "v2-drops",
  installGroups: "v2-drops",
  installScopes: "v2-drops",
  installText: "v2-drops",
  installTextRevisionId: "v2-drops",
  setupDescription: "v2-drops",
  setupRevision: "v2-drops",
  setupUrl: "v2-drops",
  // integration:register_app, integration:update_app_registration
  agentManifestUrl: "v2-drops",
  category: "v2-drops",
  homepageUrl: "v2-drops",
  returnUrl: "v2-drops",
  unsafeDemoUrlOverride: "v2-drops",
  // integration:recover_app_owner
  targetAgent: "v2-drops",
  // feedback:submit
  feedbackType: "v2-drops",
  message: "v2-drops",
  // plan:upgrade
  gate: "v2-drops",
  // seats:add
  purpose: "v2-drops",
  seats: "v2-drops",
  expiresAt: "v2-drops",
  // agent:approve_call
  approvalId: "v2-drops",
  call: "v2-drops",
  createdAt: "v2-drops",
  decider: "v2-drops",
  heldBy: "v2-drops",
  plugin: "v2-drops",
  request: "v2-drops",
  summary: "v2-drops",
  summaryTruncated: "v2-drops",
  summaryWithheld: "v2-drops",
  // question:ask
  addressee: "v2-drops",
  expiresInMinutes: "v2-drops",
  pages: "v2-drops",
  questions: "v2-drops",
  ref: "v2-drops",
  to: "v2-drops",
  // assistant:owner_action
  actionKey: "v2-drops",
  args: "v2-drops",
  assistantAgentId: "v2-drops",
  assistantName: "v2-drops",
  done: "v2-drops",
  ownerUserId: "v2-drops",
  paramsKey: "v2-drops",
  phrase: "v2-drops",
  tool: "v2-drops",
  view: "v2-drops",
} as const satisfies Record<KeysOfUnion<StoredActionCardAction>, "v2-keeps" | "v2-drops">;

export type ActionCardResult =
  | { kind: "channel"; id: string; name: string }
  | { kind: "agent"; id: string; name: string }
  | {
      /**
       * An `agent:migrate` card's migration started (the card is done then;
       * its progress is on the agent's page). The card's own Agent and the
       * computer it is moving to, as POST /api/agents/:id/migrate answered;
       * the server checks the move really started before it records this.
       */
      kind: "agent-migration";
      agentId: string;
      targetMachineId: string;
    }
  | {
      kind: "channel-members";
      /** Channel the members were added to. */
      channelId: string;
      channelName: string;
      /** UUIDs of humans the dialog actually submitted. The agent's
       *  prefilled list is just a suggestion — the human may have
       *  deselected entries or added different ones, so we record the
       *  effective add list (the actual API submission). */
      addedHumanIds: string[];
      /** UUIDs of agents actually added. Same semantics as
       *  `addedHumanIds`. */
      addedAgentIds: string[];
      /**
       * Whether the person changed the agent's list in the dialog: it added
       * someone the card didn't ask for, or left out someone it asked for who
       * is not a member. Someone asked for who was a member already is not a
       * change (the dialog drops them before it opens). Someone the dialog
       * drops because this client can't resolve them (they left the server, or
       * the agent was deleted) counts as left out, so it is a change: agreed in
       * #proj-apps:#40, not a bug. Set by the server when the card is marked
       * executed, whatever the client sent; absent on cards executed before it
       * was recorded.
       */
      changed?: boolean;
    }
  | {
      /**
       * An MCP Connection was authorized for an Agent (task #21).
       *
       * ⚠️ Carries ONLY the two ids already present on the card itself. Deliberately NOT the
       * Connection id and NOT anything identifying its owner: this result is stored on a MESSAGE,
       * visible to everyone who can see the channel the card was posted in, while a private
       * Connection's id is withheld even from an Agent manager who cannot see it. Putting it here
       * would leak through the card what the projection refuses to hand over.
       *
       * The pair is still worth recording: it is what lets the server verify the client is
       * resolving THIS card rather than another, and it renders "connected" without a second read.
       */
      kind: "mcp-connection";
      mcpServerId: string;
      agentId: string;
    }
  | {
      kind: "agent-integration-login";
      requestId: string;
      agentId: string;
      agentName: string;
      clientId: string;
      clientKey: string;
      clientName: string;
      scopes: string[];
      grantId: string | null;
    }
  | {
      kind: "marketplace-app-installation";
      clientId: string;
      clientKey: string;
      clientName: string;
      serverId: string;
      agentId: string;
      agentName: string;
      scopes: string[];
      setupUrl?: string;
    }
  | {
      kind: "integration-app-registration";
      mode: "register" | "update";
      clientId: string;
      clientKey: string;
      clientName: string;
      returnUrl: string | null;
      homepageUrl: string | null;
      agentManifestUrl: string | null;
      setupUrl?: string | null;
      setupDescription?: string | null;
      scopes: string[];
      unsafeDemoUrlOverride?: boolean;
    }
  | {
      kind: "integration-app-owner-recovery";
      clientId: string;
      clientKey: string;
      clientName: string;
      ownerAgentId: string;
      ownerAgentName: string;
    }
  | {
      /**
       * A `feedback:submit` card sent as its submitter's product feedback.
       * Only the server records it, from the Hands receipt; a client cannot
       * mark this kind.
       */
      kind: "product-feedback";
      /**
       * The Hands ticket. Null when Hands said this person had already filed
       * this card (a resend with different text) without naming the ticket;
       * the card then links to their Settings › Feedback list.
       */
      ticketId: string | null;
      /** Hands' human-readable reference, when it sent one. */
      reference: string | null;
      /**
       * The Hands app the ticket was filed into, named by the client kind it
       * serves: the sender's client (web, ios, android, ohos; web's is the
       * single legacy app). Cards done while every client filed into the
       * single app record `web`. A
       * ticket is read through its own app, so a client offers to open it
       * (intent `feedback_ticket`) only when it can reach that app: an App
       * only its own, the web any (its link names the app). Absent on cards
       * done before it was recorded.
       */
      source?: ProductFeedbackAppSource;
    }
  | {
      /**
       * How an `agent:approve_call` hold ended (or that it was approved and
       * is running), as antiproton reports it. Every card for the hold shows
       * it, whoever decided: who by role only, never a user id.
       */
      kind: "agent-call-approval";
      status: Exclude<AgentCallApprovalStatus, "pending">;
      decidedBy: AgentCallApprovalDecidedBy | null;
      decidedAt: string | null;
      /** What the run returned or its error (`outcome`), redacted and bounded by antiproton; plainActionCardText. */
      outcome: { summary: string; truncated: boolean; withheld: boolean } | null;
    }
  | {
      /**
       * How an `assistant:owner_action` card ended: the owner declined it
       * (nothing ran), or confirmed it and the route answered `status`.
       * `summary` is Raft's line about it (the route's own error when it
       * failed), plain text.
       */
      kind: "assistant-owner-action";
      decision: "confirmed" | "declined";
      /** The route's HTTP status; null when declined. */
      status: number | null;
      ok: boolean;
      /** Confirmed, but no answer came in time (it may have run): neither done nor failed. */
      unknown?: boolean;
      summary: string;
      /**
       * The same line as names, so a card with its own copy (the action's `view`) shows it in the viewer's
       * language. Absent on results written before it, and on a card without a view: `summary` as it is.
       * The assistant's event stays English either way.
       */
      line?: AssistantOwnerActionResultLine;
      decidedAt: string;
    }
  | {
      /**
       * A `question:ask` card's answers. The one exception to "submitted
       * values stay in submitted_input": the card exists to hand them to the
       * agent, so everyone who can see the card sees them (the form says so).
       * Cleared with the card when its message is retracted.
       */
      kind: "question-answers";
      /** The agent's `ref`, when it sent one. */
      ref: string | null;
      /** Who answered (also executedByUserId); a handle for the agent, since agents never see UUIDs. */
      answeredBy: { userId: string; handle: string };
      /** RFC 3339 UTC. */
      answeredAt: string;
      /** By question id, in question order. */
      answers: Record<string, ActionCardQuestionAnswer>;
    };

/**
 * Every key a card's `result` may carry to a client, by result kind, and
 * whether the mobile App's canonical message V2 keeps it (#proj-apps:#40).
 * The App keeps the keys its list for the result's kind names
 * (`CANONICAL_ACTION_CARD_RESULT_KEYS_BY_KIND`, App 1.16.1 and later) and
 * drops the rest from the V2 copy only; for a kind it does not list it keeps
 * only `kind`, so every other key of `agent-call-approval`,
 * `assistant-owner-action` and `question-answers` is `"v2-drops"`. App 1.16.0
 * has one strict set for every kind instead (the `channel` / `agent` /
 * `channel-members` keys before `changed`): any other key fails the row's V2
 * conversion there. Its own card code still reads the plain row.
 *
 * Exhaustive over every ActionCardResult kind and each kind's keys, so a new
 * kind or a new key on one fails to compile until it is listed here: the
 * moment to ask the App owner whether its V2 keeps it.
 */
export const ACTION_CARD_RESULT_KEYS = {
  channel: { kind: "v2-keeps", id: "v2-keeps", name: "v2-keeps" },
  agent: { kind: "v2-keeps", id: "v2-keeps", name: "v2-keeps" },
  // An App that does not list this kind keeps `kind` only; its card reads the plain row.
  "agent-migration": { kind: "v2-keeps", agentId: "v2-drops", targetMachineId: "v2-drops" },
  "channel-members": {
    kind: "v2-keeps",
    channelId: "v2-keeps",
    channelName: "v2-keeps",
    addedHumanIds: "v2-keeps",
    addedAgentIds: "v2-keeps",
    changed: "v2-drops",
  },
  "mcp-connection": { kind: "v2-keeps", mcpServerId: "v2-keeps", agentId: "v2-keeps" },
  "agent-integration-login": {
    kind: "v2-keeps",
    requestId: "v2-keeps",
    agentId: "v2-keeps",
    agentName: "v2-keeps",
    clientId: "v2-keeps",
    clientKey: "v2-keeps",
    clientName: "v2-keeps",
    scopes: "v2-keeps",
    grantId: "v2-keeps",
  },
  "marketplace-app-installation": {
    kind: "v2-keeps",
    clientId: "v2-keeps",
    clientKey: "v2-keeps",
    clientName: "v2-keeps",
    serverId: "v2-keeps",
    agentId: "v2-keeps",
    agentName: "v2-keeps",
    scopes: "v2-keeps",
    setupUrl: "v2-keeps",
  },
  "integration-app-registration": {
    kind: "v2-keeps",
    mode: "v2-keeps",
    clientId: "v2-keeps",
    clientKey: "v2-keeps",
    clientName: "v2-keeps",
    returnUrl: "v2-keeps",
    homepageUrl: "v2-keeps",
    agentManifestUrl: "v2-keeps",
    setupUrl: "v2-keeps",
    setupDescription: "v2-keeps",
    scopes: "v2-keeps",
    unsafeDemoUrlOverride: "v2-keeps",
  },
  "integration-app-owner-recovery": {
    kind: "v2-keeps",
    clientId: "v2-keeps",
    clientKey: "v2-keeps",
    clientName: "v2-keeps",
    ownerAgentId: "v2-keeps",
    ownerAgentName: "v2-keeps",
  },
  "product-feedback": { kind: "v2-keeps", ticketId: "v2-keeps", reference: "v2-keeps", source: "v2-keeps" },
  "agent-call-approval": {
    kind: "v2-keeps",
    status: "v2-drops",
    decidedBy: "v2-drops",
    decidedAt: "v2-drops",
    outcome: "v2-drops",
  },
  "assistant-owner-action": {
    kind: "v2-keeps",
    decision: "v2-drops",
    status: "v2-drops",
    ok: "v2-drops",
    unknown: "v2-drops",
    summary: "v2-drops",
    line: "v2-drops",
    decidedAt: "v2-drops",
  },
  "question-answers": {
    kind: "v2-keeps",
    ref: "v2-drops",
    answeredBy: "v2-drops",
    answeredAt: "v2-drops",
    answers: "v2-drops",
  },
} as const satisfies {
  [Kind in ActionCardResult["kind"]]: Record<KeysOfUnion<Extract<ActionCardResult, { kind: Kind }>>, "v2-keeps" | "v2-drops">;
};

/**
 * One question's answer. `choice`: the chosen option values and the person's
 * own text (`other`, from Other…); a single question has exactly one of them.
 * `skipped`: an optional question left empty.
 */
export type ActionCardQuestionAnswer =
  | { kind: "choice"; selected: string[]; other?: string }
  | { kind: "text"; text: string }
  | { kind: "skipped" };

/**
 * The refusals a question card adds (question-card spec §3.1, §4.4): 403
 * NOT_ADDRESSEE (someone else submits a card asked of one person); 409
 * QUESTION_EXPIRED / QUESTION_WITHDRAWN (a submit after the card ended); 409
 * ALREADY_ANSWERED (a withdraw after an answer; the body's metadata carries
 * the answers); 409 TOO_MANY_OPEN_QUESTIONS (prepare: the agent's open cards
 * in this conversation are at their cap, so wait for an answer or withdraw
 * one); 429 QUESTION_RATE_LIMITED (prepare: the agent's cards in the last hour,
 * anywhere on its server, are at their cap; QuestionRateLimitedDetails says
 * when the next one may go); 400 CARD_TOO_LARGE (prepare: the card would not
 * fit, QuestionCardTooLargeBody).
 */
export const QUESTION_CARD_ERROR_CODES = {
  notAddressee: "NOT_ADDRESSEE",
  expired: "QUESTION_EXPIRED",
  withdrawn: "QUESTION_WITHDRAWN",
  alreadyAnswered: "ALREADY_ANSWERED",
  tooManyOpen: "TOO_MANY_OPEN_QUESTIONS",
  /** 429 at prepare: too many question cards in the last hour (QuestionRateLimitedDetails). */
  rateLimited: "QUESTION_RATE_LIMITED",
  /** 400 at prepare: the card would be over QUESTION_CARD_SIZE_THRESHOLD (QuestionCardTooLargeBody). */
  cardTooLarge: "CARD_TOO_LARGE",
} as const;
export const QUESTION_CARD_TOO_LARGE_STATUS = 400;
export const QUESTION_CARD_RATE_LIMITED_STATUS = 429;
/**
 * 429 QUESTION_RATE_LIMITED's body, beside `error`, `errorCode` and
 * `suggestedNextAction`: the cap (`limit` cards per `windowSeconds`) and the
 * whole seconds until the agent's oldest card in the window leaves it, when
 * one more may be prepared (at least 1).
 */
export interface QuestionRateLimitedDetails { limit: number; windowSeconds: number; retryAfterSeconds: number }
/** What one question costs on the card, in UTF-8 bytes (measureQuestionCard's attribution). */
export interface QuestionCardQuestionBytes { id: string; bytes: number }
/**
 * 400 CARD_TOO_LARGE: the card's size in its largest state, the threshold, and
 * each question's share, so the agent can see what to shorten; like
 * UPLOAD_TOO_LARGE it names the next step for the agent.
 */
export interface QuestionCardTooLargeBody {
  error: string;
  errorCode: typeof QUESTION_CARD_ERROR_CODES.cardTooLarge;
  bytes: number;
  threshold: number;
  perQuestion: QuestionCardQuestionBytes[];
  /** What the agent does next, e.g. shorten the largest questions or options and prepare again. */
  suggestedNextAction: string;
}
/** 409 from withdraw when the card was answered first: the answers come with it. */
export interface QuestionCardAlreadyAnsweredBody { error: string; errorCode: typeof QUESTION_CARD_ERROR_CODES.alreadyAnswered; metadata: ActionCardMetadata }

/** A Hands feedback app, named by the client kind it serves (server productFeedbackApps.ts). */
export type ProductFeedbackAppSource = "web" | "ios" | "android" | "ohos";

// Body shape for POST /api/actions/:messageId/execute
export interface ExecuteActionRequestBody {
  /** Optimistic-concurrency guard against double-execute. */
  expectedState?: ActionCardState;
  expectedConfirmationVersion?: number;
  /** A submitted form sheet (`open_form`, form.v1); see ActionCardFormInvalidBody and ActionCardAlreadyExecutedBody. */
  form?: ActionCardFormSubmission;
}

// Body shape for POST /api/actions/:messageId/mark-executed (dialog flow)
export interface MarkActionExecutedRequestBody {
  result: ActionCardResult;
  expectedConfirmationVersion?: number;
}

export interface ActionCardRegularWriterContext {
  messageId: string;
  confirmationVersion: number;
}

/** A shared history copy never grants authority to execute in another workspace. */
export function isActionCardReadOnlyInServer(sourceServerId: ServerId | null | undefined, viewerServerId: string | undefined): boolean {
  // Undefined is the additive-protocol fallback for an older server. Current
  // servers explicitly send null if the canonical card owner is unavailable.
  return sourceServerId !== undefined && (sourceServerId === null || sourceServerId !== viewerServerId);
}
