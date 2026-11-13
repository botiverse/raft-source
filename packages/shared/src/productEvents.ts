// Product event registry (RFC-067 §3.2).
//
// Every product event and its allowed properties is declared here, once, for
// every client and for server ingest. Clients get their typed `track()` API
// from it; ingest rejects (and counts) anything validateProductEvent refuses.
//
// Product events are designed on purpose. Add, rename or remove one only with
// the event-registry owner's sign-off, never as a side effect of feature work:
// each entry states the question it answers and who asked. Properties are
// low-cardinality ids/enums/counts only — never message text or other user
// content. Names starting with `$` are reserved for fields the pipeline adds.
//
// PRODUCT_EVENT_REGISTRY is plain JSON-shaped data on purpose: native clients
// (RFC-067 §6) will generate their APIs from a JSON export of it.

// What "Share usage data" means for a user who has not chosen; the server gate,
// the settings UI and the legacy wizard route all read it. Default on: decided
// by cindyz (#proj-analytics:63b84f03, 2026-10-05), disclosed in the privacy
// policy and the sign-up consent line. A per-region default (e.g. EU opt-in)
// may still follow from legal review (RFC-067 §9.4).
export const SHARE_USAGE_DATA_DEFAULT = true;

export const PRODUCT_EVENT_SOURCES = ["server", "web", "desktop", "android", "ios", "harmonyos"] as const;
/**
 * The `platform` column of a client event (xxchan, 2026-10-22, task #13):
 * which client, as the server derives it on ingest. `web` is a computer's
 * browser, `mobile_web` a phone's or tablet's browser, `pwa` the web installed
 * as an app, `desktop_app` the Electron app; the native apps are themselves.
 */
export const CLIENT_PLATFORMS = ["web", "mobile_web", "pwa", "desktop_app", "ios", "android", "harmonyos"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];
/** `$account_age` on client events: account age when the event happened, coarse on purpose. */
export const ACCOUNT_AGE_BUCKETS = ["0-7d", "8-30d", "31-90d", "91-365d", "365d+"] as const;
export type ProductEventSource = (typeof PRODUCT_EVENT_SOURCES)[number];

export type ProductEventPropertySpec = (
  /** `maxLength`, when set, bounds every value too (a registry test checks the list fits it). */
  | { readonly type: "enum"; readonly values: readonly string[]; readonly maxLength?: number }
  | { readonly type: "boolean" }
  /** `min` / `max`, when set, are inclusive bounds; clients clamp to them before sending. */
  | { readonly type: "integer"; readonly min?: number; readonly max?: number }
  /**
   * A release version such as `1.21.58` or `0.62.0-beta.1`: dotted numbers
   * and an optional lowercase pre-release, nothing else (PRODUCT_EVENT_VERSION).
   */
  | { readonly type: "version" }
  /**
   * Only for short tokens such as a campaign source; never free text. Values
   * must match PRODUCT_EVENT_STRING_TOKEN, so an email, phone number or
   * sentence cannot get through.
   */
  | { readonly type: "string"; readonly maxLength: number }
  /**
   * A bare host name such as a referring site (`x.com`): lowercase labels
   * joined by dots, no scheme, path, query, port or IP address.
   */
  | { readonly type: "hostname" }) & { readonly required?: true };

export const PRODUCT_EVENT_STRING_TOKEN = /^[a-z0-9_-]*$/;
export const PRODUCT_EVENT_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9a-z]{1,16}(?:\.[0-9a-z]{1,16}){0,3})?$/;
export const PRODUCT_EVENT_HOSTNAME = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const IPV4_ADDRESS = /^\d+(?:\.\d+){3}$/;

export interface ProductEventSpec {
  /** The question this event answers. "It might be useful" is not one. */
  readonly question: string;
  /** Who asked for it (and reads the answer). */
  readonly requestedBy: string;
  readonly sources: readonly ProductEventSource[];
  readonly properties: Readonly<Record<string, ProductEventPropertySpec>>;
}

const WEB_CLIENTS = ["web", "desktop"] as const;
const NATIVE_CLIENTS = ["ios", "android", "harmonyos"] as const;
const APP_CLIENTS = [...WEB_CLIENTS, ...NATIVE_CLIENTS] as const;

const PWA_INSTALL_PROPERTIES = {
  platform: { type: "enum", values: ["ios_safari", "ios_other", "android_chromium", "desktop_chromium", "other"] },
  surface: { type: "enum", values: ["notification_center", "ios_instruction_sheet", "settings"] },
  trigger: { type: "enum", values: ["supported_browser", "settings"] },
  display_mode: { type: "enum", values: ["browser", "standalone", "fullscreen", "minimal-ui", "unknown"] },
  session_count_bucket: { type: "enum", values: ["1", "2", "3-5", "6+"] },
  cooldown_state: { type: "enum", values: ["not_dismissed", "dismissed_active", "expired"] },
  outcome: { type: "enum", values: ["accepted", "dismissed"] },
} as const;

const PWA_INSTALL_QUESTION =
  "Does the add-to-home-screen prompt get mobile web users to install the app, and where do they drop off (per platform and surface)?";

// The native apps (artin, 2026-10-21, #proj-mobile:5a014ada) send the same
// routes for the same screens, plus the ones only they have: `home`, `more`,
// `thread` and `task` (a task opens as a thread on phones) as screens of their
// own, and `conversation_search` (search inside one channel or DM; `search` is
// the global one). Nothing before sign-in: no account, so no choice to share.
/** The member relationship graph (/members/graph), removed 2026-11; its path now redirects to /members. Accepted from older web bundles. */
export const RETIRED_PAGE_VIEW_ROUTES = ["members_graph"] as const;

export const PAGE_VIEW_ROUTES = [
  "channel", "dm", "activity", "tasks", "saved", "search", "members",
  "agent", "human", "computer", "computers", "settings", "release_notes",
  "home", "more", "thread", "task", "conversation_search",
  // 2026-10-23: the personal assistant's page (/assistant).
  "assistant",
  // 2026-10-28: the Apps page (/apps).
  "apps",
  // 2026-11-12: the Artifacts page (/artifacts; its rail entry needs `workspace_artifacts_v0`).
  "artifacts",
  // Retired routes: no current page sends them, but a bundle cached from before still may.
  ...RETIRED_PAGE_VIEW_ROUTES,
] as const;

/**
 * Retired Settings tabs, accepted from older web bundles: `mcp` (MCP Servers,
 * when MCP Apps moved into Applications); `shared-links` (Shared links, when
 * Share to X was retired on 2026-11-09).
 */
export const RETIRED_SETTINGS_PAGE_TABS = ["mcp", "shared-links"] as const;

/** Settings tab ids (web `SETTINGS_TABS`; a web test keeps the two in sync). */
export const SETTINGS_PAGE_TABS = [
  "account", "language-region", "appearance", "notifications", "theme", "server-notifications", "server", "billing", "administration",
  "im-bridges", "integrations", "labs", "providers", "about", "feedback",
  // Retired tabs: no current page sends them, but a bundle cached from before still may.
  ...RETIRED_SETTINGS_PAGE_TABS,
] as const;

/** Settings sections only the native apps have. */
export const NATIVE_SETTINGS_PAGE_TABS = ["mobile", "storage"] as const;

// `members_page` (the Members page's Create agent): the native apps' entry
// (Lagoon, 2026-10-23); they send channel_members too.
// `sidebar` / `sidebar_external`: the Members sidebar's + menu, until the web
// Members page replaced it (2026-11-05); `members_page` is that page's Create
// agent too, and `members_page_external` the Connect an external agent item in
// its Create agent ▾ menu, which takes over from the web's `sidebar_external`.
// `computer_rack`: Create agent in a Computers page card's … menu (2026-11-10;
// web and the apps).
export const AGENT_CREATE_ENTRIES = ["sidebar", "sidebar_external", "channel_members", "computer_detail", "members_page", "members_page_external", "computer_rack"] as const;

// Bulk "Change model" on the Computer page (flag bulk_change_model_web_v0).
// Contract agreed with John in #raft-botiverse-user-analytics (2026-10-14).
// One random operation_id per dialog open links the four events. Apply is a
// series of ordinary agent updates, so agent PATCH counts are not usage.
// The four *_count results on bulk_model_change_finished are per agent and
// mutually exclusive; they add up to change_count + restart_only_count.
// "Succeeded" means the update / restart request completed, not that the agent
// is now running well.
const BULK_MODEL_CHANGE_QUESTION =
  "Do people use bulk Change model, and does it finish? (Decides whether to widen the bulk_change_model_web_v0 trial.)";
const BULK_MODEL_CHANGE_REVIEW = "cindyz; contract reviewed with John (2026-10-14)";
const BULK_MODEL_CHANGE_OPERATION = { type: "string", maxLength: 36 } as const;

// Public Server visit counts. Written by the server from
// POST /api/public-visits/:slug (never from a client batch), so anonymous
// visitors count too. Named `public_page_*`: what happens ON the public page,
// not "a public channel" (cindyz, 2026-10-15; renamed before any prod data).
// An in-app event about a channel says which kind it is with `channel_scope`
// (public_page / members / private), never with a channel id. Design reviewed in #proj-analytics (Tenny, 2026-10-14):
// rows carry no IP, cookie or visitor id; analytics_id only for a signed-in
// visitor who shares usage data. `visitor` is decided by the server.
//
// Where visits come from (cindyz, 2026-10-14): only on the view that opened
// the tab (`entry: landing`) — the referring site (the server keeps only the
// registrable domain, publicVisitCounts.referrerSite) and the utm_source /
// utm_medium / utm_campaign of the landing link. Never the full referring URL.
// Which channel was opened: the public channel's id.
//
// Visitor id (cindyz / Tenny, 2026-10-14): a
// logged-out visitor who accepts the page's cookie banner sends a random id.
// It is personal data and never goes into these rows: the server writes it to
// product.public_visitors (395-day retention) under the visit's uuid.
const PUBLIC_SERVER_VISIT_QUESTION =
  "After a server goes public, how often is its public page visited, where do visits come from, and which channels are opened, by anonymous vs signed-in visitors? (Counts, not people.)";
const PUBLIC_SERVER_VISIT_REVIEW = "cindyz; contract reviewed with John, endpoint with Tenny (2026-10-14)";
export const PUBLIC_SERVER_VISITORS = ["anonymous", "signed_in_non_member", "signed_in_member"] as const;
export const PUBLIC_SERVER_VISIT_ENTRIES = ["landing", "in_app"] as const;
/**
 * How long a public-page visitor id lives (cindyz, 2026-10-14: 13 months): the
 * browser's consent choice and id expire after it, and product.public_visitors
 * is created with the same DATA RETENTION.
 */
export const PUBLIC_VISITOR_ID_MAX_AGE_DAYS = 395;
/**
 * How a public page treats the visitor id, decided by the server from the
 * visitor's country (cindyz, 2026-10-15): `ask` where the law requires consent
 * first (or the country is unknown), `default_on` elsewhere, with an opt-out
 * in Cookie settings, and `default_off` there instead when the browser sends
 * Global Privacy Control (Tenny): no id unless the visitor opts in.
 */
export const PUBLIC_VISITOR_ID_MODES = ["ask", "default_on", "default_off"] as const;
export type PublicVisitorIdMode = (typeof PUBLIC_VISITOR_ID_MODES)[number];
const CAMPAIGN_TOKEN = { type: "string", maxLength: 64 } as const;

// First journey batch, reviewed with Vivian / meichen in
// #raft-botiverse-user-analytics (2026-10-05). Outcomes (an agent exists) stay
// database facts; these record only the path.
const JOURNEY_REVIEW = "nova; reviewed by Vivian/meichen (2026-10-05)";

// Primary navigation entries (xxchan, 2026-10-17,
// #raft-botiverse-user-analytics:01aa9a67): which entry people use to reach
// each main surface, per platform, to decide what the mobile tab bar holds.
// One event per click on an entry (not per route change: page_viewed counts
// those); `was_active` marks a tap on the surface the user is already on,
// usually "back to the top". No ids, paths or text. Compare entries with this
// event only; activity_open stays for stdrc's Activity question. Native apps
// send it too, with the same values (agreed with Lagoon, #proj-mobile:5a02b7a8):
// `surface` names the kind of entry, while `source` and `$device_type` tell
// the platform, so a native tablet's side bar is `rail` like the web's.
// `more` (2026-10-20): the phone's More tab. Since 2026-10-21 it opens the
// Settings sections, with Members and Computers on top. Since 2026-10-23 the
// phone web's server tab takes its slot and sends it when its popover opens.
// `assistant` (2026-10-23): the personal assistant, a rail tab on desktop and a
// row at the top of the phone's Home.
// `apps` (2026-10-28): the Apps page, a rail tab on desktop and a button in the
// phone server tab's popover.
export const NAV_DESTINATIONS = ["home", "activity", "search", "saved", "tasks", "members", "computers", "settings", "more", "assistant", "apps", "artifacts"] as const;
/**
 * mobile_home_shortcuts: the Saved row at the top of the phone's Home (its
 * Search and Activity rows were removed 2026-10-20; the bar carries both).
 * mobile_more: the Members / Computers rows at the top of the phone's More
 * tab (a Settings row too until 2026-10-21); since 2026-10-23 on the phone
 * web, the Members / Computers / Settings buttons in the server tab's popover. sidebar: the desktop channel
 * sidebar (Saved). keyboard_shortcut: ⌘K / Ctrl+K. The phone's Search slot in
 * the tab bar is `mobile_tab_bar`.
 */
export const NAV_SURFACES = ["mobile_tab_bar", "rail", "top_bar", "mobile_home_shortcuts", "sidebar", "keyboard_shortcut", "mobile_more"] as const;
const NAV_ENTRY_SOURCES = APP_CLIENTS;

// Entry-level tracking (xxchan, 2026-10-23, #proj-analytics:11ec2a34: "几乎所有的这种入口级功能都应该有"):
// one event per area of the screen, each with fixed values, no ids or text, so
// the interface usage view (report Artifact) can place every entry. Coverage per
// entry: docs/analytics/product-events.md "Entry-level events".
const ENTRY_LEVEL_REQUESTED_BY = "xxchan (2026-10-23, #proj-analytics:11ec2a34)";

/**
 * A conversation's Chat / Tasks / Files. `header_tabs`: the header's tabs (the
 * web without task v2, and the native apps). With task v2 the web shows Tasks
 * and Files as side cards: `side_card_toggle` is the header button that shows
 * or hides one, `side_column_tabs` the switch between them in the side column,
 * `side_card_close` the card's own close. `was_active`: it was already showing
 * (for a toggle or a close: this click hid it).
 */
export const CHANNEL_TABS = ["chat", "tasks", "files"] as const;
// `header_swipe`: the native apps switch the header's tabs by a swipe too (Lagoon, 2026-10-23).
export const CHANNEL_TAB_SURFACES = ["header_tabs", "header_swipe", "side_card_toggle", "side_column_tabs", "side_card_close"] as const;

/**
 * What someone did to one message, and from where. Surfaces: the hover toolbar;
 * the message menu opened by right-click (`context_menu`), by long-press
 * (`long_press`) or by the toolbar's More (`toolbar_menu`); the sender's name
 * (`sender_name`, a click inserts an @mention) and its right-click menu
 * (`sender_menu`). `open_menu` records the menu opening itself; `open_reaction_picker`
 * opens every emoji, `react_quick` is one of the menu's quick reactions, or the
 * hover toolbar's reaction button (a click adds the person's most-used reaction).
 */
export const MESSAGE_ACTIONS = [
  "open_menu", "open_reaction_picker", "react_quick", "reply_in_thread", "follow_thread", "unfollow_thread",
  "task_done", "task_reopen", "create_task", "convert_to_task",
  "copy_link", "copy_markdown", "select_text", "forward", "select", "save", "unsave", "translate",
  "mention_sender", "copy_sender_name", "copy_sender_handle",
] as const;
export const MESSAGE_ACTION_SURFACES = ["hover_toolbar", "context_menu", "long_press", "toolbar_menu", "sender_name", "sender_menu"] as const;

// Upgrade path (requested by cindyz, 2026-10-19; measurement contract reviewed
// by meichen, 2026-10-20): which upgrade
// prompts Free owners see and act on, and whether that reaches Stripe checkout. Only
// the path: a paid upgrade stays the `subscriptions` row, so there is no "checkout
// returned" event. `surface` grows as more prompts are instrumented.
const UPGRADE_PATH_QUESTION =
  "Do Free owners who see an upgrade prompt act on it and go on to start Stripe checkout, and which prompt works? (Paid conversion stays the subscriptions table.)";
const UPGRADE_PATH_REVIEW = "cindyz (2026-10-19); measurement contract reviewed by meichen (2026-10-20)";
export const UPGRADE_PROMPT_SURFACES = ["onboarding_setup"] as const;
/** Where Stripe checkout was started from: the billing page, or straight from a prompt (the onboarding Pro step, or the upgrade dialog a Free paywall opens). */
export const CHECKOUT_ENTRIES = ["settings", "onboarding_setup", "paywall_panel"] as const;
/**
 * `checkout_started.opened_from`: what opened the upgrade dialog a
 * `paywall_panel` checkout started from, when it was not a paywall: an
 * agent's upgrade card (`agent_card`: `plan:upgrade`, task #6), or a member's
 * request for Pro (`member_request`: the same card, sent by a person, task
 * #10). Absent means a paywall opened it (older clients can only open it from
 * one). Not `source`: that is the event's platform column.
 */
export const CHECKOUT_OPENED_FROM = ["agent_card", "member_request"] as const;
export type CheckoutOpenedFrom = (typeof CHECKOUT_OPENED_FROM)[number];

// Paid features and billing (xxchan via Till, 2026-10-20, #proj-analytics:8fc671a3).
// Which paywalls people hit and who hits them, what they do next, and which
// paywalls lead an owner to pay. Hits, checkouts and seat updates are server
// facts, recorded for everyone the gate allows (no analytics_id without
// "Share usage data"); paywall_shown / paywall_action are client events.
// Payment outcomes come from Stripe's webhook, never from the browser coming
// back. No checkout or Stripe ids: Stripe metadata holds the real user id, so
// a shared id would link analytics_id to the account (RFC-067 §3.5).
/**
 * Paywalls that have their own UI. The web's upgrade-dialog gates
 * (`UPGRADE_GATES` in upgradeGates.ts, Till, 2026-10-21) use these same names: the three joint
 * channel limits (free cap, the host's limit, and over the limit in the grace
 * period, before it turns read-only) and `plan_downgraded`.
 */
export const PAYWALL_GATES = [
  "history_30d", "agent_migration", "seat_limit_agent_create", "seat_limit_invite",
  "joint_channel_free_cap", "joint_channel_host_limit", "joint_channel_over_limit", "joint_channel_read_only",
  "upload_file_size", "upload_monthly_quota", "translation", "cloud_agent_daily_quota", "plan_downgraded",
  "pro_theme",
  // The Free plan's one external channel (Nova, 2026-11-10, #wg-rbac:#60).
  // `external_channel_free_limit`: a Free server already in one is stopped
  // adding another (create, send an invite, accept, connect a server,
  // unarchive; the server's `free_external_limit`). `external_channel_frozen`:
  // a server over the limit, read-only (registered; nothing sends it yet).
  "external_channel_free_limit", "external_channel_frozen",
] as const;
export type PaywallGate = (typeof PAYWALL_GATES)[number];
/**
 * `paywall_hit.limit_side`, on the two external channel gates only: whether
 * the server the row is counted for was the channel's `host` or the
 * `connecting` side (the refusal's `limitSide`). Absent on every other gate.
 */
export const PAYWALL_LIMIT_SIDES = ["host", "connecting"] as const;
export type PaywallLimitSide = (typeof PAYWALL_LIMIT_SIDES)[number];
/**
 * Upload limits as the web meets them (upload_limit_hit). `file_size`: over
 * Free's per-file limit, within Pro's; `file_size_beyond_pro`: over every
 * plan's (or a paid plan's own); `monthly_quota`: more than the month has
 * left; the rest no plan changes.
 */
export const UPLOAD_LIMITS = [
  "file_size", "file_size_beyond_pro", "monthly_quota", "attachment_count", "empty_file", "limit_unknown",
] as const;
/**
 * Where it was met: a file picked, dropped or pasted; Attach file, Attach
 * media or Save as Artifact tapped with the month used up; an upload the
 * server refused after the selection was checked.
 */
export const UPLOAD_LIMIT_ENTRIES = [
  "picker", "drop", "paste", "attach_file", "attach_media", "save_artifact", "upload_refused",
] as const;
/** The largest refused file, coarse: Free's 50 MB, Pro's 200 MB, and halfway. */
export const UPLOAD_SIZE_BANDS = ["under_50mb", "50_100mb", "100_200mb", "200mb_plus"] as const;
/**
 * How an owner reached checkout or a seat update: the paywall whose button
 * opened Plan & Billing or whose upgrade dialog started checkout (`general`
 * when the dialog was opened for no specific limit), else where
 * checkout started (`settings` when the page was opened without a paywall,
 * `onboarding_setup` for the setup Pro step), `unknown` when the request did
 * not say (older clients). Never `paywall_panel`: the dialog always names its
 * paywall here (agreed with Till, #proj-analytics:8fc671a3).
 */
const SERVER_CHECKOUT_ENTRIES = CHECKOUT_ENTRIES.filter(
  (entry): entry is Exclude<(typeof CHECKOUT_ENTRIES)[number], "paywall_panel"> => entry !== "paywall_panel",
);
export const BILLING_ENTRIES = [
  ...PAYWALL_GATES,
  // Opened from the upgrade dialog when no specific limit applies; today only
  // the agent upgrade card does this. Not a paywall, so the paywall events
  // never carry it.
  "general",
  ...SERVER_CHECKOUT_ENTRIES,
  "unknown",
] as const;
export type BillingEntry = (typeof BILLING_ENTRIES)[number];
export const PAYWALL_VIEWER_ROLES = ["owner", "admin", "member", "guest"] as const;
/**
 * Where a paywall was met, for a gate shown in more than one place (Nova,
 * 2026-10-29: `history_30d`; and `upload_monthly_quota` met from an Artifact,
 * cindyz, #proj-commercial:#22; the other gates leave it out, and a missing
 * value is an older client). `conversation`: a channel, DM or thread
 * (task) conversation's history card or banner, a thread opened on its
 * paywall; `search`: the search page and ⌘K; `saved`, `files`: those lists;
 * `quoted_message`: a quoted link to an old message; `agent_activity`: the
 * agent profile's Activity tab; `artifact`: an Artifact surface (Save as
 * Artifact today; an attachment upload sends none). The external channel
 * gates' (Nova, 2026-11-10, #wg-rbac:#60; the web's Upgrades for
 * `external_channel_free_limit` send all but `channel_banner`, which nothing
 * sends yet): `create_channel`: Create Channel's External step;
 * `external_invite_dialog`: the host's dialog for inviting people outside the
 * server, and, at the limit, its entry in a channel's member list, which opens
 * the upgrade dialog in its place; `external_invite_page`: the invitee's
 * invite page; `connect_request_page`: the approver's page for a request to
 * connect their server; `channel_banner`: a banner in the channel; `sidebar`
 * (Nova, 2026-11-12): the sidebar External section's create entries (its "+"
 * and its menu's, and the sidebar menu's Create External Channel), which at
 * the limit open the upgrade dialog instead of Create Channel.
 */
export const PAYWALL_SURFACES = [
  "conversation", "search", "saved", "files", "quoted_message", "agent_activity", "artifact",
  "create_channel", "external_invite_dialog", "external_invite_page", "connect_request_page", "channel_banner",
  "sidebar",
] as const;
export type PaywallSurface = (typeof PAYWALL_SURFACES)[number];
/**
 * `paywall_hit.via`: the Artifacts write the server's monthly file upload
 * quota refused (`upload_monthly_quota` only; xxchan, 2026-11-08,
 * #proj-workspace:#231 item 10). `artifact_publish`: a push (its inline
 * files, or the listed files the server lacks, by their declared sizes,
 * before any upload); `artifact_upload`: the agent API's raw upload (`PUT
 * uploads/:sha256`), past that check;
 * `artifact_import`: an import from raft-artifacts.com (web or agent);
 * `artifact_save_attachment`: Save as Artifact (web or agent);
 * `artifact_comment_image`: an image for an Artifact comment. Absent: an
 * attachment upload, or another gate.
 */
export const PAYWALL_HIT_VIAS = [
  "artifact_publish", "artifact_upload", "artifact_import", "artifact_save_attachment", "artifact_comment_image",
] as const;
export type PaywallHitVia = (typeof PAYWALL_HIT_VIAS)[number];
/**
 * Whom a `paywall_hit`'s refusal is attributed to (meichen, 2026-11-11,
 * #raft-botiverse-user-analytics:ad42552e): `person` when the request carries
 * a user id, `agent` when it has none; never read from `viewer_role` (a
 * person without a member row is still `person`). `person` is a refusal
 * record attributed to that user; it does not prove the person acted
 * themselves (a personal assistant acting as its owner carries the owner's
 * user id).
 * People's hits are once per person, server, gate, `via` and UTC day; every
 * agent of a server shares one key, so `agent` rows count refusals per
 * server, gate, `via` and day, not agents. Rows written before this property
 * have none: read them as unknown, never as `agent`.
 */
export const PAYWALL_HIT_ACTORS = ["person", "agent"] as const;
export type PaywallHitActor = (typeof PAYWALL_HIT_ACTORS)[number];
/** Same values as ServerPlan (a shared test keeps them in sync). */
export const PAYWALL_PLANS = ["free", "founder", "partner", "pro"] as const;
const PAYWALL_QUESTION =
  "Which paywalls do people hit, as owner, admin or member, and what do they do next? (Decides which paywall to fix first.)";
const BILLING_QUESTION =
  "Which paywalls lead owners to pay, and how do they set seats and billing interval when they buy? (Upgrade funnel and first-purchase seat default.)";
const BILLING_REQUESTED_BY = "xxchan (2026-10-20, via Till)";
const BILLING_INTERVAL = { type: "enum", values: ["monthly", "annual"], required: true } as const;
const BILLING_ENTRY = { type: "enum", values: BILLING_ENTRIES, required: true } as const;
/**
 * The checkout events' `surface` (cindyz, #proj-commercial:#22): an upgrade
 * an Artifact led to reads apart from one an attachment upload did.
 */
const CHECKOUT_SURFACE = { type: "enum", values: PAYWALL_SURFACES } as const;
const BILLING_CHECKOUT_PROPERTIES = {
  entry: BILLING_ENTRY,
  billing_interval: BILLING_INTERVAL,
  seat_quantity: { type: "integer", required: true },
  /** The seat count the page proposed; absent from older clients. */
  default_seat_quantity: { type: "integer" },
  /** The server had a Stripe customer before (bought, then cancelled). */
  returning_customer: { type: "boolean", required: true },
  /** What opened the upgrade dialog, when not a paywall (CHECKOUT_OPENED_FROM); absent otherwise and from older clients. */
  opened_from: { type: "enum", values: CHECKOUT_OPENED_FROM },
  /** The surface the paywall that opened the dialog was on (PAYWALL_SURFACES); absent otherwise and from older clients. */
  surface: CHECKOUT_SURFACE,
} as const;

// Prepaid Pro (task #19, #proj-commercial): its own events, so the
// subscription checkout counts above keep meaning subscriptions.
const BILLING_PREPAID_CHECKOUT_PROPERTIES = {
  entry: BILLING_ENTRY,
  /** 1 or 12. */
  months: { type: "integer", required: true },
  seat_quantity: { type: "integer", required: true },
  /** The seat count the page proposed; absent from older clients. */
  default_seat_quantity: { type: "integer" },
  /** Bought while prepaid time or its grace days were left: the period continues from the paid end. */
  renewal: { type: "boolean", required: true },
  opened_from: { type: "enum", values: CHECKOUT_OPENED_FROM },
  /** The surface the paywall that opened the dialog was on (PAYWALL_SURFACES); absent otherwise and from older clients. */
  surface: CHECKOUT_SURFACE,
} as const;

/** Seats added to prepaid time mid-period (task #19 PR4). */
const BILLING_PREPAID_SEATS_CHECKOUT_PROPERTIES = {
  entry: BILLING_ENTRY,
  /** Seats added. */
  seat_quantity: { type: "integer", required: true },
  /** Seats the prepaid time had before. */
  previous_seat_quantity: { type: "integer", required: true },
  /** Days charged: from now to the end of the paid time, a started day counted whole. */
  days: { type: "integer", required: true },
  opened_from: { type: "enum", values: CHECKOUT_OPENED_FROM },
} as const;

// Plan & Billing (cindyz, 2026-10-30, #proj-commercial:94664f92; names Nova).
/**
 * The page's dialogs. `keep_pro`: the add-seats dialog Keep Pro opens when the
 * server uses more seats than it has bought, apart from adding seats unprompted.
 */
export const PLAN_BILLING_DIALOGS = ["upgrade", "add_seats", "keep_pro", "remove_seats", "cancel_subscription"] as const;
export type PlanBillingDialog = (typeof PLAN_BILLING_DIALOGS)[number];
/** The button that opened Stripe's billing portal; `unknown` when the request did not say (older clients). */
export const BILLING_PORTAL_FROM = ["plan_card", "past_due_banner", "unknown"] as const;
export type BillingPortalFrom = (typeof BILLING_PORTAL_FROM)[number];
const PLAN_BILLING_QUESTION =
  "On Plan & Billing, which dialogs do owners and admins open and how many finish, and how many owners schedule a cancellation, withdraw it, or open Stripe's billing portal?";
const PLAN_BILLING_REQUESTED_BY = "cindyz (2026-10-30, #proj-commercial:94664f92)";
const BILLING_CANCELLATION_PROPERTIES = {
  entry: BILLING_ENTRY,
  /** The seats the subscription had, as in billing_seats_updated. */
  seat_quantity: { type: "integer", required: true },
  billing_interval: BILLING_INTERVAL,
} as const;
const PLAN_BILLING_DIALOG_PROPERTIES = {
  dialog: { type: "enum", values: PLAN_BILLING_DIALOGS, required: true },
  entry: BILLING_ENTRY,
  viewer_role: { type: "enum", values: PAYWALL_VIEWER_ROLES, required: true },
} as const;

// Workspace Artifacts (xxchan, 2026-10-26, #proj-workspace:7c500d89): where
// people open Artifacts and whether they come back, which viewer features they
// use, whether they comment and share, whether saving an attachment and the
// legacy import are used, and whether framed pages open fast. Sent by the web
// Artifacts UI, which only renders with workspace_artifacts_v0 on. Fixed values
// only: never an Artifact's id, title, name, path or content. Coverage per
// event: docs/analytics/product-events.md "Workspace Artifacts".
const ARTIFACTS_REQUESTED_BY = "xxchan (2026-10-26, #proj-workspace:7c500d89)";
/** An Artifact's kind (shared ArtifactKind; a shared test keeps the two in sync). */
export const ARTIFACT_EVENT_KINDS = ["html", "markdown", "text", "csv", "image", "pdf", "video", "other"] as const;
/** The kinds drawn in the content-origin frame (shared ARTIFACT_FRAMED_KINDS). */
export const ARTIFACT_FRAMED_EVENT_KINDS = ["html", "markdown", "pdf"] as const;
/**
 * What an Artifact was opened from. `message_card`: the card under a message;
 * `message_chip`: its chip in a message's text (Remy, #proj-workspace:fbc76200);
 * `link`: opened from a link (the "Saved as Artifact" line under an
 * attachment, or any canonical Artifact URL `/artifacts/<id>` followed: an
 * outside link, a card or chip opened with Cmd/Ctrl-click or a middle click,
 * or a plain click on one where no channel panel can hold the viewer, e.g. in
 * Activity or Search; the permalink adds `&from=link`); `dashboard`: a row
 * of the Artifacts page's For you tab (its sections); `search`: a search hit;
 * `activity`: a card in a conversation opened from Activity. `share` and
 * `other` are reserved: a sent Artifact is an ordinary message with its link,
 * so its card counts as `message_card`. `all`: a row of the Artifacts page's
 * All tab (task #115), apart from `dashboard` so the two tabs read apart.
 */
export const ARTIFACT_OPEN_SOURCES = ["message_card", "message_chip", "link", "dashboard", "search", "activity", "share", "other", "all"] as const;
/** Where the viewer was when it opened: the channel's side card, maximized (expanded, or the Artifacts page), or a phone's full screen. */
export const ARTIFACT_VIEWER_SURFACES = ["side", "maximized", "phone"] as const;
export const ARTIFACT_VIEWER_ACTIONS = [
  "version_switch", "comments_open", "follow", "unfollow", "copy_link", "download", "maximize", "share_open", "embed_copy",
] as const;
/** Where a comment points: the whole Artifact, a file, a place the page names, or text (a selection, lines or rows). */
export const ARTIFACT_COMMENT_ANCHORS = ["none", "file", "page_anchor", "text"] as const;
export const ARTIFACT_MENTION_COUNT_BUCKETS = ["0", "1", "2-3", "4+"] as const;
export const ARTIFACT_SHARE_TARGETS = ["channel", "dm", "thread"] as const;
export const ARTIFACT_SHARE_WIDEN = ["none", "server", "public"] as const;
export const ARTIFACT_FRAME_RESULTS = ["ok", "error", "timeout"] as const;
export const ARTIFACT_FRAME_DURATION_BUCKETS = ["<500ms", "500ms-2s", "2-5s", ">5s"] as const;

// Action cards (`raft action prepare`): an agent prepares an action and a person
// decides on it. Moving the card funnel from the Postgres `product_events`
// table (action_card.*) to here: both are written while readers switch
// (cindyz, 2026-10-26, #proj-analytics:69ac4304). The card itself and its
// state stay in Postgres (`action_cards`).
/** Every card type, as `ACTION_CARD_ACTION_TYPES` (the registry test keeps them equal; this file imports nothing). */
export const PRODUCT_EVENT_ACTION_CARD_TYPES = [
  "channel:create",
  "agent:create",
  "channel:add_member",
  "integration:approve_agent_login",
  "integration:connect_mcp",
  "integration:install_marketplace_app",
  "integration:register_app",
  "integration:update_app_registration",
  "integration:recover_app_owner",
  "feedback:submit",
  "plan:upgrade",
  "agent:migrate",
  "question:ask",
] as const;
export function isProductEventActionCardType(type: string): type is (typeof PRODUCT_EVENT_ACTION_CARD_TYPES)[number] {
  return (PRODUCT_EVENT_ACTION_CARD_TYPES as readonly string[]).includes(type);
}
/** The Postgres funnel's steps, without its prefix (`action_card.open` is `open`). */
export const PRODUCT_EVENT_ACTION_CARD_ACTIONS = ["open", "dismiss", "execute_attempt", "execute_success", "execute_fail"] as const;
export const PRODUCT_EVENT_ACTION_CARD_ERROR_CLASSES = ["validation", "permission", "not_found", "conflict", "network", "unknown"] as const;
const ACTION_CARD_REQUESTED_BY = "cindyz (2026-10-26, #proj-analytics:69ac4304)";

// New features without a "did people use it" signal (AndyLok, #proj-o11y:#16; #proj-analytics:#17).
const FEATURE_GAPS_REQUESTED_BY = "AndyLok (2026-10-31, #proj-o11y:#16)";
const NOTIFICATION_LEVEL_QUESTION =
  "Which notification levels do people choose for a server and for single channels, and how often do they mute a conversation?";
const CONFIRM_UNDO_QUESTION =
  "Do people go through with the actions we ask them to confirm, and how often do they undo one they could undo?";
// The account-wide notification settings (Settings › Notifications: pause and
// quiet hours, content), which had no signal but the current row (cindyz,
// 2026-11-09, #proj-analytics:fbb8f05c).
const NOTIFICATION_SETTINGS_REQUESTED_BY = "cindyz (2026-11-09, #proj-analytics:fbb8f05c)";
/** `notification_settings_changed.setting`: one per setting a write changed. */
export const NOTIFICATION_ACCOUNT_SETTINGS = ["pause", "quiet_hours", "preview", "sound", "mobile_delay"] as const;
/**
 * `notification_settings_changed.change` for the on/off settings: turned on,
 * turned off, or `edited` (a pause moved while paused, quiet hours' window
 * moved while on), so "turned on" is never counted twice.
 */
export const NOTIFICATION_SETTING_CHANGES = ["on", "off", "edited"] as const;
/**
 * How long a new pause runs, measured when it is saved. The bounds sit between
 * the presets (30m, 1h, 2h, until 9:00 tomorrow) so the time a request takes
 * never moves a preset into the next bucket (assuming the client's clock is
 * roughly right: the client picks the time, the server measures it); a custom
 * time lands where its length falls.
 */
export const NOTIFICATION_PAUSE_LENGTHS = ["up_to_45m", "45m_to_90m", "90m_to_3h", "3h_to_36h", "over_36h"] as const;
/** The account's notification preview (`notifications.ts` NOTIFICATION_PREVIEW_MODES; a test keeps the two in sync). */
export const NOTIFICATION_SETTINGS_PREVIEW_MODES = ["full", "sender_only", "hidden"] as const;
/** When a phone alerts (`notifications.ts` NOTIFICATION_MOBILE_DELAYS; a test keeps the two in sync). */
export const NOTIFICATION_SETTINGS_MOBILE_DELAYS = ["always", "inactive", "1m", "2m", "5m", "10m"] as const;
/** The dangerous actions behind a confirm dialog (`confirm_dialog_closed.dialog`). */
export const CONFIRM_DIALOGS = [
  "invite_link_update", "app_notifications_rotate_secret", "computer_restart", "computer_upgrade",
  "artifact_unpublish", "artifact_make_public", "artifact_move_to_server", "artifact_move_to_conversation",
  "agent_app_revoke", "self_demote",
] as const;
/** The actions a toast offers to undo (`undo_offered.action`, `undo_used.action`). */
export const UNDOABLE_ACTIONS = ["role_change", "activity_done", "activity_unfollow", "activity_mute", "mcp_app_revoke"] as const;

// The new-user journey (#proj-onboarding:#2, Ferry; spec onboarding-events-spec):
// the steps before a person has a server are recorded by the server, since the
// web cannot send client events without one; the setup steps after it by the web.
const ONBOARDING_REQUESTED_BY = "Ferry (2026-10-31, #proj-onboarding:#2)";
const ONBOARDING_ACCOUNT_QUESTION =
  "Where do new accounts stop between signing up and having a server (verification email, identity, first server), how long does each step take, and on which client?";
const ONBOARDING_SETUP_QUESTION =
  "Which server setup step do new owners stop at (connecting a computer, Cindy, the survey, the handoff), what did they do there, and what blocked them?";
const ACCOUNT_EVENT_PLATFORM = { type: "enum", values: [...CLIENT_PLATFORMS, "unknown"], required: true } as const;
// External channel invites (cindyz via Warden/Nova, 2026-11-11, #wg-rbac:#60 / #proj-analytics:51bc46e0):
// the invite emails a host sends, the invite link opened signed out, and the invitee opening the invite page.
const EXTERNAL_INVITE_REQUESTED_BY = "cindyz via Warden/Nova (2026-11-11, #wg-rbac:#60 / #proj-analytics:51bc46e0)";
const EXTERNAL_INVITE_QUESTION =
  "How many external channel invite emails do hosts send and resend, how many does the mail provider take, how many invites have their link opened, and when invitees open the invite page, which ways of joining are they offered?";
// The host's side of the same flow, from the web (cindyz via Warden/Nova, 2026-11-12, #wg-rbac:db8d6e83):
// Invite People Outside <server> on a channel, and Create Channel's External choice.
const EXTERNAL_INVITE_FLOW_REQUESTED_BY = "cindyz via Warden/Nova (2026-11-12, #wg-rbac:db8d6e83)";
const EXTERNAL_INVITE_FLOW_QUESTION =
  "How many owners and admins open the invite-people-outside flow and from which entry, how many reach the review, how do their sends end, and at which stage do they leave?";
/** `existing_channel`: Invite People Outside <server> on a channel; `create_channel`: Create Channel with External chosen. */
export const EXTERNAL_INVITE_FLOWS = ["existing_channel", "create_channel"] as const;
/**
 * What opened the flow. A channel's Members: the row in its add-members panel,
 * the button under the Members page. Create Channel opened with External
 * chosen: the sidebar External section's +, its menu, the sidebar's own menu,
 * a link (`?dialog=create-joint-channel`). `create_channel_visibility`:
 * External picked inside a Create Channel dialog opened some other way.
 */
export const EXTERNAL_INVITE_ENTRIES = [
  "add_members_row", "members_page_button", "sidebar_section_button", "sidebar_section_menu", "sidebar_surface_menu",
  "link", "create_channel_visibility",
] as const;
/** Addresses a send would act on (at most 20 at a time), and the person's own servers checked. */
export const EXTERNAL_INVITE_EMAIL_BUCKETS = ["0", "1", "2-5", "6-20"] as const;
export const EXTERNAL_INVITE_SERVER_BUCKETS = ["0", "1", "2+"] as const;
/** Where the person was when the flow closed; `details` and `people` are Create Channel's own steps. */
export const EXTERNAL_INVITE_STAGES = ["details", "people", "input", "review"] as const;
/** The server's refusal codes the dialog has a sentence for (web `ERROR_MESSAGE_IDS`); anything else is `other`. */
export const EXTERNAL_INVITE_SEND_ERROR_CODES = [
  "daily_cap", "free_external_limit", "channel_full", "external_members_keep_private", "channel_membership_required",
  "make_private_required", "channel_archived", "channel_not_invitable", "forbidden", "connecting", "invite_not_pending",
  "invalid_input", "not_found", "other",
] as const;
const EXTERNAL_INVITE_FLOW = { type: "enum", values: EXTERNAL_INVITE_FLOWS, required: true } as const;
// The end of each attempt to join or connect to an external channel (cindyz via Warden,
// 2026-11-12, #wg-rbac:db8d6e83): which way, whether it worked, and which rule stopped it.
const EXTERNAL_CONNECT_REQUESTED_BY = "cindyz via Warden (2026-11-12, #wg-rbac:db8d6e83)";
const EXTERNAL_CONNECT_QUESTION =
  "When someone tries to join or connect to an external channel, which way did they try, did it work, and if not, which rule stopped them?";
/**
 * `external_channel_connect_finished.path`: the way in. `guest`: accept as a
 * Guest; `connect`: an invitee's server they own or administer (one, or each
 * such server of a multi-connect); `new_server`: a server created to connect;
 * `request_approval`: an invitee asking a server's owner or admin (one, or
 * each such server of a multi-connect); `approve` / `decline`: that approver's
 * answer; `host_direct`: a host owner/admin's "Your servers"; `self_connect`:
 * a channel member connecting their own servers.
 */
export const EXTERNAL_CONNECT_PATHS = [
  "guest", "connect", "new_server", "request_approval", "approve", "decline", "host_direct", "self_connect",
] as const;
/**
 * How it finished. `connecting`: answered 202, the channel's conversion first
 * (the worker's own row follows); `declined`: a `decline` that went through;
 * `expired`: the worker found the invite run out; `error`: an unexpected
 * failure (a 500, a multi-connect's `internal_error`).
 */
export const EXTERNAL_CONNECT_RESULTS = [
  "connected", "connecting", "awaiting_approval", "declined", "refused", "expired", "error",
] as const;
/**
 * `refusal_code` (with `refused` only): the refusal codes these routes answer,
 * `invite_unusable` for the one invalid-invite 404 (every reason), and
 * `other` for any code not listed, so a new one never fails validation.
 */
export const EXTERNAL_CONNECT_REFUSAL_CODES = [
  "invite_unusable", "approval_in_progress", "connect_in_progress", "guest_unavailable", "channel_archived",
  "already_member", "guest_elsewhere", "invalid_server", "invalid_approver", "server_admin_required",
  "server_membership_required", "approver_lost_role", "request_not_found", "request_not_pending", "request_expired",
  "requester_left", "membership_changed", "guests_present", "already_connected", "guest_has_computer",
  "connect_unavailable", "channel_full", "free_external_limit", "joint_free_server_limit",
  "joint_channel_free_limit_reached", "joint_channel_plan_limit_reached", "joint_server_limit", "joint_party_limit",
  "channel_conversion_in_progress", "channel_conversion_uploads_in_flight", "invalid_input",
  // The host side's refusals (host_direct, self_connect; Nova, #14526). Its
  // `connecting` is recorded as connect_in_progress.
  "channel_not_invitable", "make_private_required", "forbidden", "channel_membership_required", "invite_open",
  "invite_not_pending", "daily_cap",
  "other",
] as const;
export type ExternalConnectPath = (typeof EXTERNAL_CONNECT_PATHS)[number];
export type ExternalConnectFinishedResult = (typeof EXTERNAL_CONNECT_RESULTS)[number];
export type ExternalConnectRefusalCode = (typeof EXTERNAL_CONNECT_REFUSAL_CODES)[number];
/** The host server's plan, coarse: `free`, or any paid plan (`paid`). */
export const EXTERNAL_CONNECT_HOST_PLANS = ["free", "paid"] as const;
/** The setup steps, in the order an owner meets them; not every owner sees every one (the Pro step is Free + flag). */
export const SERVER_SETUP_STEPS = ["computer_runtime", "create_agent", "survey", "upgrade", "display_style", "handoff"] as const;
/** What a person did on a setup step (`server_setup_step_action.action`); each step uses its own few. */
export const SERVER_SETUP_ACTIONS = [
  // computer_runtime: the commands it shows (mac/Linux: one install-and-connect command, or under "already
  // installed" the connect one; Windows: 1. install the CLI, 2. connect it to this server), the runtime's install
  // command when the runtime is missing, the desktop app's "use this computer", and the way out.
  "copy_install_and_setup_command", "copy_install_command", "copy_setup_command", "copy_runtime_install_command",
  "use_this_computer", "next",
  "start_over", "switch_server", "server_settings", "use_cloud_agent",
  // create_agent
  "create_cindy",
  // survey, display_style
  "continue",
  // handoff
  "lets_go",
] as const;
/** Why a setup step cannot go on (`ServerSetupGateReason` values that hold the step). */
export const SERVER_SETUP_BLOCK_REASONS = [
  "computer_offline", "computer_status_unknown", "runtime_not_ready", "runtime_checking", "runtime_error",
  "runtime_status_unknown", "official_onboarding_agent_missing", "official_onboarding_agent_unusable",
  "official_onboarding_agent_status_unknown", "resolver_error",
] as const;
const SERVER_SETUP_STEP = { type: "enum", values: SERVER_SETUP_STEPS, required: true } as const;
/**
 * `true` when the setup page runs inside the mobile app (mobile_server_setup_v1:
 * the app opens this web onboarding in a WebView, with its `raft-onboarding-v1`
 * context or on the app-only `/s/:slug/onboarding?generation=…` surface);
 * absent in a browser and in Desktop.
 */
const SERVER_SETUP_NATIVE_HOST = { type: "boolean" } as const;

/** Feature ids of the feature map (`feature_action.feature`); the dashboard's feature files use the same ids. */
export const PRODUCT_FEATURES = ["invite"] as const;
export type ProductFeature = (typeof PRODUCT_FEATURES)[number];

// Raft Desktop's move from its embedded Computer to the official
// raft-computer (apps/desktop/src/main/computer/computerMigration.ts), from
// 1.21.58. Designed with and approved by AndyLok (data owner, 2026-11-08):
// before it, the only signal was a machine disappearing from the machines
// table. One event per attempt's final result; an attempt that ends with the
// installer still finishing (`still_finishing`) is followed by the next
// attempt's event under the same operation_id. operation_id is random, made
// once per move and kept in Desktop's migration journal across Retry and
// relaunches: never a machine or user id. Closed lists only: no paths, proxy
// addresses, user names, OS messages or machine ids. Its companion signal, the
// Computer's `ready.migratedFrom` (COMPUTER_MIGRATED_FROM, `migrated_from` on
// the server's ready trace), means the move reached its `start` step, not that
// it succeeded: this event says whether it did.
/** The move's steps, in order (Desktop's journal names the next one). */
export const DESKTOP_COMPUTER_MIGRATION_STEPS = ["install", "quiet", "stop", "marker", "start", "verify"] as const;
export const DESKTOP_COMPUTER_MIGRATION_OUTCOMES = ["succeeded", "failed", "still_finishing"] as const;
/**
 * The stable codes an attempt can end with. `computer_cli_failed`: a
 * `raft-computer` command failed with its own code (the CLI's codes are not a
 * closed list); `journal`: Desktop could not read or write its record of the
 * move; `other`: anything else. Never the message.
 */
export const DESKTOP_COMPUTER_MIGRATION_ERROR_CODES = [
  "computer_install_failed", "computer_install_held", "computer_install_unsupported", "computer_install_still_finishing",
  "computer_unreadable", "computer_cli_failed",
  "computer_migration_unattested", "computer_migration_still_embedded", "computer_migration_not_running", "computer_migration_step_failed",
  "computer_busy", "journal", "other",
] as const;
export const DESKTOP_COMPUTER_MIGRATION_ERROR_CODE_MAX_LENGTH = 40;
/**
 * Where the installer's and the CLI's proxy came from (Desktop's networkEnv.ts):
 * `unsupported_socks` = the system offered only a SOCKS proxy, which neither
 * reads, so it went direct. The source only, never the address.
 */
export const DESKTOP_COMPUTER_MIGRATION_PROXY_SOURCES = ["none", "env", "shell", "system", "unsupported_socks"] as const;
/** Desktop's OS and architecture (`process.platform`-`process.arch`); `other` for the rest. */
export const DESKTOP_COMPUTER_MIGRATION_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64", "other"] as const;
export const DESKTOP_COMPUTER_MIGRATION_MAX_ATTEMPT = 20;
export const DESKTOP_COMPUTER_MIGRATION_MAX_DURATION_MS = 3_600_000;
/** `ended_at` is kept to the minute. */
export const DESKTOP_COMPUTER_MIGRATION_ENDED_AT_BUCKET_MS = 60_000;

// Gated features without a server record (tygg, 2026-11-08, #proj-o11y:a5f3094f:
// how much each partly enabled feature is used; AndyLok counts it). Only those
// whose use leaves nothing on the server: Drafts live in the browser, and the
// agents' read faces are a display. The rest are counted from Postgres and
// traces (docs/analytics/product-events.md, "Gated features").
const GATED_FEATURES_REQUESTED_BY = "tygg (2026-11-08, #proj-o11y:a5f3094f); counted by AndyLok";
/** How many drafts the Drafts page listed when it opened. */
export const DRAFT_COUNT_BUCKETS = ["0", "1", "2-5", "6+"] as const;
/** Where a draft was started: a channel's or DM's composer, a thread's, a task's. */
export const DRAFT_PLACES = ["channel", "dm", "thread", "task"] as const;
/** The two parts of agent read progress: the faces, and the line under your message that will not reach an agent. */
export const AGENT_READ_PROGRESS_PARTS = ["faces", "not_reaching_line"] as const;
export const AGENT_READ_PROGRESS_CONVERSATIONS = ["channel", "thread"] as const;

// The Computers page (/computers; cindyz, 2026-11-12, #proj-analytics:a559ea75):
// which filters, groupings and default sort the page needs. A snapshot of what
// the page showed when it opened, each control the person changed, and each
// computer they opened. Enums, booleans and counts only: no computer id, name
// or host name, and never the search text or its length.
const COMPUTERS_LIST_REQUESTED_BY = "cindyz (2026-11-12, #proj-analytics:a559ea75)";
/** The desktop page (the rack beside the rail) or the phone's page. */
export const COMPUTERS_LIST_VARIANTS = ["desktop", "phone"] as const;
export const COMPUTERS_LIST_VIEWS = ["cards", "list"] as const;
export const COMPUTERS_LIST_GROUP_BYS = ["none", "prefix", "provider"] as const;
/** `default`: no sort chosen (Mine first). `remaining`: a runtime's remaining quota; which runtime is its own property. */
export const COMPUTERS_LIST_SORT_KEYS = ["default", "name", "remaining", "disk", "memory"] as const;
export const COMPUTERS_LIST_SORT_DIRECTIONS = ["asc", "desc"] as const;
export const COMPUTERS_LIST_STATUS_FILTERS = ["all", "online", "offline", "attention"] as const;
/** A runtime with a usage column, by its account provider. */
// Written out, not imported: this file stays import-free (see the top). A test
// holds it to RUNTIME_ACCOUNT_USAGE_PROVIDERS (runtimeAccountUsage.ts).
export const COMPUTERS_LIST_SORT_RUNTIMES = ["claude", "codex", "kimi", "grok", "antigravity"] as const;
/** The Runtime filter's choices: the providers, and `other` (every runtime that reports no usage). */
export const COMPUTERS_LIST_RUNTIMES = [...COMPUTERS_LIST_SORT_RUNTIMES, "other"] as const;
/** A group's or the Offline section's fold, after the click. */
export const COMPUTERS_LIST_FOLD_STATES = ["folded", "open"] as const;
export const COMPUTERS_LIST_CONTROLS = [
  "search", "status", "runtime", "group", "sort_key", "sort_direction", "view", "clear_all", "group_fold", "offline_fold",
] as const;
/** What a control was set to, one list for every control that has a value (`search`, `runtime` and `clear_all` have none). */
export const COMPUTERS_LIST_CONTROL_VALUES = [
  ...COMPUTERS_LIST_STATUS_FILTERS,
  ...COMPUTERS_LIST_GROUP_BYS,
  ...COMPUTERS_LIST_SORT_KEYS,
  ...COMPUTERS_LIST_SORT_DIRECTIONS,
  ...COMPUTERS_LIST_VIEWS,
  ...COMPUTERS_LIST_FOLD_STATES,
] as const;
/**
 * Where the control is: the toolbar; `more_menu`, the toolbar's ⋯ once Group,
 * Sort and the view fold into it; `column_heading`, a heading of the desktop
 * list; `empty_state`, Clear all where nothing matches; `list`, the folds.
 */
export const COMPUTERS_LIST_CONTROL_SURFACES = ["toolbar", "more_menu", "column_heading", "empty_state", "list"] as const;
/** Whose computer: the one Raft Desktop runs on, one the viewer attached or owns, anyone else's (the list's own tiers). */
export const COMPUTERS_LIST_RELATIONS = ["this_device", "own", "other"] as const;
export const COMPUTERS_LIST_COMPUTER_STATUSES = ["online", "offline"] as const;
/** The most a count or a position says; clients clamp to it. */
export const COMPUTERS_LIST_MAX_COUNT = 10_000;

export const PRODUCT_EVENT_REGISTRY = {
  // New accounts (xxchan, 2026-10-22, task #13): on which client people sign
  // up, how, and whether an invite brought them. The cohort start for "new
  // users"; the client is what the signup request said (X-Raft-Client-Platform),
  // `unknown` when it did not. Nothing that identifies the person.
  account_created: {
    question: "On which client do new accounts sign up, with which method, and did an invite bring them? (Where new users come from; the start of new-user cohorts.)",
    requestedBy: "xxchan (2026-10-22, task #13)",
    sources: ["server"],
    properties: {
      platform: { type: "enum", values: [...CLIENT_PLATFORMS, "unknown"], required: true },
      method: { type: "enum", values: ["email", "google", "github", "apple"], required: true },
      invited: { type: "boolean", required: true },
    },
  },
  // The verification email of an email signup went out, at signup or on "Resend": whether the
  // provider took it, or (resend) the cooldown refused it. Social signups are verified by the
  // provider and get none.
  email_verification_sent: {
    question: ONBOARDING_ACCOUNT_QUESTION,
    requestedBy: ONBOARDING_REQUESTED_BY,
    sources: ["server"],
    properties: {
      trigger: { type: "enum", values: ["signup", "resend"], required: true },
      result: { type: "enum", values: ["sent", "failed", "rate_limited"], required: true },
      platform: ACCOUNT_EVENT_PLATFORM,
    },
  },
  // An email signup's address was verified (the link or the pasted code); the platform is the
  // client that opened the link, not necessarily the one that signed up.
  email_verified: {
    question: ONBOARDING_ACCOUNT_QUESTION,
    requestedBy: ONBOARDING_REQUESTED_BY,
    sources: ["server"],
    properties: { platform: ACCOUNT_EVENT_PLATFORM },
  },
  // The person finished identity setup (name and @handle), once per account.
  account_profile_completed: {
    question: ONBOARDING_ACCOUNT_QUESTION,
    requestedBy: ONBOARDING_REQUESTED_BY,
    sources: ["server"],
    properties: { platform: ACCOUNT_EVENT_PLATFORM },
  },
  // A server was created; its creator is the owner. `first_server`: they owned no server before.
  server_created: {
    question: ONBOARDING_ACCOUNT_QUESTION,
    requestedBy: ONBOARDING_REQUESTED_BY,
    sources: ["server"],
    properties: {
      first_server: { type: "boolean", required: true },
      platform: ACCOUNT_EVENT_PLATFORM,
    },
  },
  // One per external channel invite email handed to the mail provider, on a first send and
  // on a resend, counted for the host server and the person who sent it. `result`: whether
  // the provider took it. A send the daily cap or a plan limit refuses attempts no email
  // and records nothing (a resend has no cooldown, so there is no `rate_limited`). Never
  // the address, its domain, the invite or the channel.
  external_invite_email_sent: {
    question: EXTERNAL_INVITE_QUESTION,
    requestedBy: EXTERNAL_INVITE_REQUESTED_BY,
    sources: ["server"],
    properties: {
      trigger: { type: "enum", values: ["send", "resend"], required: true },
      result: { type: "enum", values: ["sent", "failed"], required: true },
    },
  },
  // The signed-in invitee was shown an open invite's page (GET /api/external-invites/:token
  // answered 200 to the invited account), once per person, invite and UTC day. No server:
  // the row carries no `server_id` (the invitee is not in the host server, and the host is
  // not theirs to be counted under), nor the invite, the channel or the inviter. The
  // `*_offered` booleans say which ways of joining that answer offered: as a Guest, a
  // server they own or administer (connect now), a server they are only a member of (ask
  // its owner or admin), a new server. `new_account`: the account was created less than 24
  // hours before the view; the server does not record which invite, if any, an account was
  // created for, so this is the nearest fact it has.
  external_invite_page_viewed: {
    question: EXTERNAL_INVITE_QUESTION,
    requestedBy: EXTERNAL_INVITE_REQUESTED_BY,
    sources: ["server"],
    properties: {
      guest_offered: { type: "boolean", required: true },
      connect_offered: { type: "boolean", required: true },
      request_approval_offered: { type: "boolean", required: true },
      new_server_offered: { type: "boolean", required: true },
      new_account: { type: "boolean", required: true },
    },
  },
  // The host's invite flow became visible: Invite People Outside <server> opened on a
  // channel, or Create Channel showed External (opened with it chosen, or the first time
  // it was picked; once per dialog).
  external_invite_opened: {
    question: EXTERNAL_INVITE_FLOW_QUESTION,
    requestedBy: EXTERNAL_INVITE_FLOW_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      flow: EXTERNAL_INVITE_FLOW,
      entry: { type: "enum", values: EXTERNAL_INVITE_ENTRIES, required: true },
    },
  },
  // The review was shown after the addresses were checked (each time). Buckets, never
  // counts: `emails` the addresses the send would act on, `servers` the person's own
  // servers checked. `history_warning_shown`: the stage before said earlier messages
  // would be seen; `becomes_private`: the review said the channel becomes private.
  external_invite_reviewed: {
    question: EXTERNAL_INVITE_FLOW_QUESTION,
    requestedBy: EXTERNAL_INVITE_FLOW_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      flow: EXTERNAL_INVITE_FLOW,
      emails: { type: "enum", values: EXTERNAL_INVITE_EMAIL_BUCKETS, required: true },
      servers: { type: "enum", values: EXTERNAL_INVITE_SERVER_BUCKETS, required: true },
      history_warning_shown: { type: "boolean", required: true },
      becomes_private: { type: "boolean", required: true },
    },
  },
  // The review's Send (Create Channel: Create and Invite) settled. `partial`: it answered,
  // but some of the person's own servers were refused or could not be connected.
  // `error_code` only with `failed`; `upgrade_offered`: the error shown offers Upgrade.
  external_invite_send_finished: {
    question: EXTERNAL_INVITE_FLOW_QUESTION,
    requestedBy: EXTERNAL_INVITE_FLOW_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      flow: EXTERNAL_INVITE_FLOW,
      result: { type: "enum", values: ["sent", "partial", "failed"], required: true },
      error_code: { type: "enum", values: EXTERNAL_INVITE_SEND_ERROR_CODES },
      upgrade_offered: { type: "boolean", required: true },
    },
  },
  // The flow ended, at most once per `external_invite_opened`: where the person was, and
  // whether a send of this opening had gone through (`sent` or `partial`).
  external_invite_closed: {
    question: EXTERNAL_INVITE_FLOW_QUESTION,
    requestedBy: EXTERNAL_INVITE_FLOW_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      flow: EXTERNAL_INVITE_FLOW,
      stage: { type: "enum", values: EXTERNAL_INVITE_STAGES, required: true },
      sent: { type: "boolean", required: true },
    },
  },
  // One row each time an attempt to join or connect to an external channel finishes,
  // successful or not: the request that made it (one per server a multi-connect chose),
  // and the worker's settlement of one answered `connecting` (`async`). No dedupe. Never
  // the invite or its token, the channel, the host server on an invitee's row, server
  // names or the error text. `host_plan` is read after the answer, wherever the host is
  // known. Nothing for an attempt on a host whose product analytics is off.
  // docs/analytics/product-events.md "Joining and connecting to an external channel".
  external_channel_connect_finished: {
    question: EXTERNAL_CONNECT_QUESTION,
    requestedBy: EXTERNAL_CONNECT_REQUESTED_BY,
    sources: ["server"],
    properties: {
      path: { type: "enum", values: EXTERNAL_CONNECT_PATHS, required: true },
      result: { type: "enum", values: EXTERNAL_CONNECT_RESULTS, required: true },
      /** With `refused` only (EXTERNAL_CONNECT_REFUSAL_CODES). */
      refusal_code: { type: "enum", values: EXTERNAL_CONNECT_REFUSAL_CODES },
      /** A limit refusal's side (PAYWALL_LIMIT_SIDES), as on paywall_hit and the span. */
      limit_side: { type: "enum", values: PAYWALL_LIMIT_SIDES },
      /** The background worker finished it. */
      async: { type: "boolean", required: true },
      /** The request chose more than one server. */
      multi: { type: "boolean", required: true },
      host_plan: { type: "enum", values: EXTERNAL_CONNECT_HOST_PLANS },
    },
  },
  // The signed-out invite link's page was opened: GET /api/external-invites/:token/preview
  // answered 200, at most once per invite, UTC day and likely_bot (Nova's contract, Tenny's conditions,
  // #wg-rbac:#60). Counts invites whose link was opened that day, not people: no
  // analytics_id, no server_id, nothing of the invite (the dedupe key, the day, a hash of the
  // invite id and likely_bot, lives only in Redis and the process for 26 hours). At most two
  // rows per invite and day: one likely a bot's, one not. `likely_bot`: a rough
  // judgment from the User-Agent, which is never kept. Nothing for an invite whose host has
  // product analytics off.
  external_invite_link_opened: {
    question: EXTERNAL_INVITE_QUESTION,
    requestedBy: EXTERNAL_INVITE_REQUESTED_BY,
    sources: ["server"],
    properties: {
      likely_bot: { type: "boolean", required: true },
    },
  },
  // A setup step was on screen, once per step per page load.
  server_setup_step_shown: {
    question: ONBOARDING_SETUP_QUESTION,
    requestedBy: ONBOARDING_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: { step: SERVER_SETUP_STEP, native_host: SERVER_SETUP_NATIVE_HOST },
  },
  // A button on a setup step. `os` only for the computer commands (the tab they were copied from).
  server_setup_step_action: {
    question: ONBOARDING_SETUP_QUESTION,
    requestedBy: ONBOARDING_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      step: SERVER_SETUP_STEP,
      action: { type: "enum", values: SERVER_SETUP_ACTIONS, required: true },
      os: { type: "enum", values: ["mac_linux", "windows"] },
      native_host: SERVER_SETUP_NATIVE_HOST,
    },
  },
  // A setup step cannot go on for this reason, once per step and reason per page load.
  server_setup_blocked: {
    question: ONBOARDING_SETUP_QUESTION,
    requestedBy: ONBOARDING_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      step: SERVER_SETUP_STEP,
      reason: { type: "enum", values: SERVER_SETUP_BLOCK_REASONS, required: true },
      native_host: SERVER_SETUP_NATIVE_HOST,
    },
  },
  // A person set a notification level (PUT /api/notification-levels, every client), when it changed.
  // `default`: a channel follows its server again (the picker's server level or "Reset to Default").
  notification_level_changed: {
    question: NOTIFICATION_LEVEL_QUESTION,
    requestedBy: FEATURE_GAPS_REQUESTED_BY,
    sources: ["server"],
    properties: {
      scope: { type: "enum", values: ["server", "channel"], required: true },
      level: { type: "enum", values: ["all", "mentions", "none", "default"], required: true },
    },
  },
  // A person muted or unmuted a conversation's Activity (PATCH /api/channels/:id/notification-settings).
  conversation_mute_changed: {
    question: NOTIFICATION_LEVEL_QUESTION,
    requestedBy: FEATURE_GAPS_REQUESTED_BY,
    sources: ["server"],
    properties: {
      muted: { type: "boolean", required: true },
      kind: { type: "enum", values: ["channel", "dm"], required: true },
    },
  },
  // A person changed an account-wide notification setting (PATCH
  // /api/me/notification-settings, every client), one event per setting the
  // write changed. Account level: no server. `change`: pause, quiet_hours and
  // sound (on / off; `edited` for a moved pause or quiet-hours window).
  // `pause_length`: a new or moved pause. `preview` / `mobile_delay`: the new value.
  notification_settings_changed: {
    question: "Do people use pause and quiet hours, and how do they set notification preview, sound and phone alerts?",
    requestedBy: NOTIFICATION_SETTINGS_REQUESTED_BY,
    sources: ["server"],
    properties: {
      setting: { type: "enum", values: NOTIFICATION_ACCOUNT_SETTINGS, required: true },
      change: { type: "enum", values: NOTIFICATION_SETTING_CHANGES },
      pause_length: { type: "enum", values: NOTIFICATION_PAUSE_LENGTHS },
      preview: { type: "enum", values: NOTIFICATION_SETTINGS_PREVIEW_MODES },
      mobile_delay: { type: "enum", values: NOTIFICATION_SETTINGS_MOBILE_DELAYS },
    },
  },
  // A confirm dialog for a dangerous action closed: confirmed, or cancelled (Cancel, Escape, outside).
  confirm_dialog_closed: {
    question: CONFIRM_UNDO_QUESTION,
    requestedBy: FEATURE_GAPS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      dialog: { type: "enum", values: CONFIRM_DIALOGS, required: true },
      result: { type: "enum", values: ["confirmed", "cancelled"], required: true },
    },
  },
  // A toast offered to undo an action just taken.
  undo_offered: {
    question: CONFIRM_UNDO_QUESTION,
    requestedBy: FEATURE_GAPS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: { action: { type: "enum", values: UNDOABLE_ACTIONS, required: true } },
  },
  // The person pressed the toast's Undo. `superseded`: the role had changed again meanwhile, so nothing was undone.
  undo_used: {
    question: CONFIRM_UNDO_QUESTION,
    requestedBy: FEATURE_GAPS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      action: { type: "enum", values: UNDOABLE_ACTIONS, required: true },
      result: { type: "enum", values: ["undone", "superseded", "failed"], required: true },
    },
  },
  /**
   * A pending card this person can act on was on screen (half of it in view),
   * once per card per page load: the base of the card funnel.
   */
  action_card_shown: {
    question: "How many of the people who could act on an agent's card saw it? (The base for how many open it and get it done.)",
    requestedBy: ACTION_CARD_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      action_type: { type: "enum", values: PRODUCT_EVENT_ACTION_CARD_TYPES, required: true },
    },
  },
  /**
   * One step of a card's funnel, written by the server next to its Postgres
   * row (`action_card.<action>`) and only when that row is written. The
   * client reports `open`, `dismiss` and the dialog flows' attempt and fail
   * (`reported_by: client`, after the server checks the card and the person
   * may see it); the server alone records `execute_success`, so a client
   * cannot make up a success.
   */
  action_card_action: {
    question: "Do people act on the cards agents prepare for them: which card types get opened, done, dismissed or fail, and on which client?",
    requestedBy: ACTION_CARD_REQUESTED_BY,
    sources: ["server"],
    properties: {
      action: { type: "enum", values: PRODUCT_EVENT_ACTION_CARD_ACTIONS, required: true },
      action_type: { type: "enum", values: PRODUCT_EVENT_ACTION_CARD_TYPES, required: true },
      reported_by: { type: "enum", values: ["client", "server"], required: true },
      /** Only on `execute_fail`. */
      error_class: { type: "enum", values: PRODUCT_EVENT_ACTION_CARD_ERROR_CLASSES },
      /** The client a client-reported step came from (X-Raft-Client-Platform); absent on server-recorded steps. */
      platform: { type: "enum", values: [...CLIENT_PLATFORMS, "unknown"] },
    },
  },
  page_viewed: {
    question: "Which parts of the Raft app do people use, and how often? (In-app navigation only; not raft.build / docs site visits.)",
    requestedBy: JOURNEY_REVIEW,
    sources: APP_CLIENTS,
    properties: {
      route: { type: "enum", values: PAGE_VIEW_ROUTES },
      settings_tab: { type: "enum", values: [...SETTINGS_PAGE_TABS, ...NATIVE_SETTINGS_PAGE_TABS] },
    },
  },
  // Native app opens (artin, 2026-10-21, #proj-mobile:5a014ada). `foreground`
  // only after at least 30 minutes in the background, the session gap, so each
  // event starts a session and app switching adds nothing. The app version is
  // on every row already (batch `app_version`).
  app_opened: {
    question: "How often do people open the native app, fresh or back after a break, and from where (icon, notification, link)?",
    requestedBy: "artin (2026-10-21)",
    sources: NATIVE_CLIENTS,
    properties: {
      start: { type: "enum", values: ["cold", "foreground"], required: true },
      via: { type: "enum", values: ["launcher", "notification", "link", "other"] },
    },
  },
  // The app asked the system for its rating prompt (App Store / Google Play in-app
  // review), mobile 1.25 on. At most once per device. "Asked" only: neither store
  // tells the app whether the prompt appeared or whether the person rated, so the
  // outcome is read from the stores' rating counts. Not sent for accounts on an
  // internal server (they are never asked). The platform and app version are on
  // every row already. iOS and Android only: the HarmonyOS app has no rating prompt.
  app_rating_prompt_requested: {
    question: "How many people does the app ask for a store rating, and after which moment (a finished task's result, an approved card)?",
    requestedBy: "Ginny/huxijin via Lagoon (2026-11-12, #proj-mobile:66f15a50)",
    sources: ["ios", "android"],
    properties: {
      trigger: { type: "enum", values: ["task_result_viewed", "action_card_approved"], required: true },
    },
  },
  agent_create_opened: {
    question: "From which entry points, outside the onboarding wizard, do people start creating an agent?",
    requestedBy: JOURNEY_REVIEW,
    sources: APP_CLIENTS,
    properties: { entry: { type: "enum", values: AGENT_CREATE_ENTRIES } },
  },
  // Group by announcement/version across contexts. A dismissal is not proof of reading.
  // announcement_id identifies operator-created content, never a person.
  announcement_shown: {
    question: "Did recipients see each announcement version? (Decides whether to re-deliver.)",
    requestedBy: "cindyz; explicit action classification requested 2026-10-15; reviewed with John and Nova",
    sources: WEB_CLIENTS,
    properties: { announcement_id: { type: "string", maxLength: 36, required: true }, delivery_version: { type: "integer", required: true } },
  },
  announcement_interacted: {
    question: "Which announcement control did recipients use? (Distinguishes CTA conversion from dismissal.)",
    requestedBy: "cindyz; explicit action classification requested 2026-10-15; reviewed with John and Nova",
    sources: WEB_CLIENTS,
    properties: { announcement_id: { type: "string", maxLength: 36, required: true }, delivery_version: { type: "integer", required: true }, action: { type: "enum", values: ["primary", "secondary", "close", "outside", "escape", "next"], required: true }, has_cta: { type: "boolean", required: true } },
  },
  bulk_model_change_opened: {
    question: BULK_MODEL_CHANGE_QUESTION,
    requestedBy: BULK_MODEL_CHANGE_REVIEW,
    sources: WEB_CLIENTS,
    properties: {
      operation_id: BULK_MODEL_CHANGE_OPERATION,
      entry: { type: "enum", values: ["machine_panel", "partial_receipt"] },
      agent_count: { type: "integer" },
    },
  },
  bulk_model_change_closed: {
    question: BULK_MODEL_CHANGE_QUESTION,
    requestedBy: BULK_MODEL_CHANGE_REVIEW,
    sources: WEB_CLIENTS,
    properties: {
      operation_id: BULK_MODEL_CHANGE_OPERATION,
      step: { type: "enum", values: ["choose", "review"] },
    },
  },
  bulk_model_change_submitted: {
    question: BULK_MODEL_CHANGE_QUESTION,
    requestedBy: BULK_MODEL_CHANGE_REVIEW,
    sources: WEB_CLIENTS,
    properties: {
      operation_id: BULK_MODEL_CHANGE_OPERATION,
      change_count: { type: "integer" },
      restart_only_count: { type: "integer" },
      skip_count: { type: "integer" },
    },
  },
  bulk_model_change_finished: {
    question: BULK_MODEL_CHANGE_QUESTION,
    requestedBy: BULK_MODEL_CHANGE_REVIEW,
    sources: WEB_CLIENTS,
    properties: {
      operation_id: BULK_MODEL_CHANGE_OPERATION,
      outcome: { type: "enum", values: ["all_succeeded", "partial", "none_succeeded"] },
      succeeded_count: { type: "integer" },
      restart_pending_count: { type: "integer" },
      save_failed_count: { type: "integer" },
      unconfirmed_count: { type: "integer" },
      duration_ms: { type: "integer" },
    },
  },
  public_page_viewed: {
    question: PUBLIC_SERVER_VISIT_QUESTION,
    requestedBy: PUBLIC_SERVER_VISIT_REVIEW,
    sources: ["server"],
    properties: {
      visitor: { type: "enum", values: PUBLIC_SERVER_VISITORS },
      entry: { type: "enum", values: PUBLIC_SERVER_VISIT_ENTRIES },
      referrer_domain: { type: "hostname" },
      utm_source: CAMPAIGN_TOKEN,
      utm_medium: CAMPAIGN_TOKEN,
      utm_campaign: CAMPAIGN_TOKEN,
    },
  },
  public_page_channel_opened: {
    question: PUBLIC_SERVER_VISIT_QUESTION,
    requestedBy: PUBLIC_SERVER_VISIT_REVIEW,
    sources: ["server"],
    properties: {
      visitor: { type: "enum", values: PUBLIC_SERVER_VISITORS },
      channel_id: { type: "string", maxLength: 36 },
    },
  },
  // Same beacon, flag and cap as the two above. `channel_id` is the public
  // channel the thread hangs off, `thread_channel_id` the thread itself: both
  // are ids of public content, checked by the server before they are kept.
  public_page_thread_opened: {
    question: "Which threads on a public page do visitors open, and in which channels? (Counts, not people.)",
    requestedBy: "cindyz (2026-10-15, via Tenny); endpoint reviewed with Tenny",
    sources: ["server"],
    properties: {
      visitor: { type: "enum", values: PUBLIC_SERVER_VISITORS },
      channel_id: { type: "string", maxLength: 36 },
      thread_channel_id: { type: "string", maxLength: 36 },
    },
  },
  // Written by POST /api/public/servers/:slug/join-as-guest after a join, for
  // a joiner who shares usage data (publicVisitCounts.recordPublicServerJoin).
  // That route is removed (#wg-rbac:#47), so nothing writes this event now;
  // the event and its writer stay for the analytics owners to retire.
  // With cookie consent, product.public_visitors keeps the page's visitor id
  // under the same uuid for 395 days: the visit -> join link (cindyz / Tenny,
  // 2026-10-14). `has_visitor_id` says whether that visitor row was written
  // (never the id itself), so a reconciliation can tell "no consent" from "row
  // lost" (AndyLok / Tenny).
  public_page_server_joined: {
    question: "How many public-page visitors go on to join the server they visited?",
    requestedBy: "cindyz; design reviewed with Tenny (2026-10-14)",
    sources: ["server"],
    properties: { has_visitor_id: { type: "boolean" } },
  },
  nav_entry_selected: {
    question: "Which primary navigation entries do people use to reach each main surface, and how often, per platform? (Decides the mobile tab bar.)",
    requestedBy: "xxchan (2026-10-17)",
    sources: NAV_ENTRY_SOURCES,
    properties: {
      destination: { type: "enum", values: NAV_DESTINATIONS, required: true },
      surface: { type: "enum", values: NAV_SURFACES, required: true },
      was_active: { type: "boolean", required: true },
      /** Web only: browser tab vs installed PWA. */
      display_mode: PWA_INSTALL_PROPERTIES.display_mode,
    },
  },
  channel_tab_selected: {
    question: "Which of a conversation's Chat, Tasks and Files do people open, from where, and how often, per platform? (Decides the conversation header.)",
    requestedBy: ENTRY_LEVEL_REQUESTED_BY,
    sources: APP_CLIENTS,
    properties: {
      tab: { type: "enum", values: CHANNEL_TABS, required: true },
      surface: { type: "enum", values: CHANNEL_TAB_SURFACES, required: true },
      was_active: { type: "boolean", required: true },
    },
  },
  message_action_selected: {
    question: "Which actions do people take on a message, and from which surface (hover toolbar, right-click or long-press menu), per platform? (Decides what the toolbar and the menu hold.)",
    requestedBy: ENTRY_LEVEL_REQUESTED_BY,
    sources: APP_CLIENTS,
    properties: {
      action: { type: "enum", values: MESSAGE_ACTIONS, required: true },
      surface: { type: "enum", values: MESSAGE_ACTION_SURFACES, required: true },
      /** The message is a reply inside a thread (not a top-level row). */
      in_thread: { type: "boolean" },
    },
  },
  // Written where the server refuses the action, once per user, server, gate
  // and UTC day (serverProductEvents.recordPaywallHit): the 30-day history
  // cut-off applies on every read. Paywalls the web stops before any request
  // (e.g. the agent-create seat precheck) only show up as paywall_shown.
  // An agent's refusal (an Artifacts write through the agent API) has no
  // person: no viewer_role, no analytics_id, once per server, gate, via and
  // day. The `upload_monthly_quota` usage numbers (xxchan, 2026-11-08,
  // #proj-workspace:#231 item 10; Till reviews the measurement contract):
  // the refused request and the server's month so far, from the quota's own
  // refusal (fileUploadQuotaService): a month nearly used up reads apart from
  // one large request refused with room left. docs/analytics/product-events.md
  // "The monthly file upload quota on the server".
  // The external channel gates (Nova, 2026-11-10, #wg-rbac:#60): the row is
  // counted for the server whose limit it is, and only when the person
  // stopped is a member of that server; `limit_side` says which side of the
  // channel that server was. Someone stopped by another server's limit
  // records nothing.
  paywall_hit: {
    question: PAYWALL_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: {
      gate: { type: "enum", values: PAYWALL_GATES, required: true },
      /** Whom the refusal is attributed to: a user, or the server's agents (PAYWALL_HIT_ACTORS). */
      actor: { type: "enum", values: PAYWALL_HIT_ACTORS, required: true },
      viewer_role: { type: "enum", values: PAYWALL_VIEWER_ROLES },
      plan: { type: "enum", values: PAYWALL_PLANS, required: true },
      /** Which Artifacts write was refused (PAYWALL_HIT_VIAS); absent for attachments and the other gates. */
      via: { type: "enum", values: PAYWALL_HIT_VIAS },
      /** `upload_monthly_quota`: the bytes the refused request asked for (all of a publish's or an import's new files together). */
      requested_bytes: { type: "integer", min: 0 },
      /** `upload_monthly_quota`: the server's bytes counted as uploaded this UTC month when it refused (uploads still in flight not included). */
      month_used_bytes: { type: "integer", min: 0 },
      /** `external_channel_free_limit` / `external_channel_frozen`: the counted server was the channel's host or the connecting side (PAYWALL_LIMIT_SIDES); absent for the other gates. */
      limit_side: { type: "enum", values: PAYWALL_LIMIT_SIDES },
    },
  },
  /** Once per page session, paywall and surface. */
  paywall_shown: {
    question: PAYWALL_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      gate: { type: "enum", values: PAYWALL_GATES, required: true },
      viewer_role: { type: "enum", values: PAYWALL_VIEWER_ROLES, required: true },
      plan: { type: "enum", values: PAYWALL_PLANS, required: true },
      surface: { type: "enum", values: PAYWALL_SURFACES },
    },
  },
  /** `surface`: where the paywall (and so the upgrade dialog it opened) was met. */
  paywall_action: {
    question: PAYWALL_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      gate: { type: "enum", values: PAYWALL_GATES, required: true },
      viewer_role: { type: "enum", values: PAYWALL_VIEWER_ROLES, required: true },
      action: { type: "enum", values: ["upgrade", "view_billing", "message_owner", "dismiss"], required: true },
      surface: { type: "enum", values: PAYWALL_SURFACES },
    },
  },
  /**
   * Every time, not once a session: one event per limit an action ran into
   * (a selection can hit two). The web refuses these before any request, so
   * they no longer reach paywall_hit.
   */
  upload_limit_hit: {
    question: "Which upload limits do people run into, from which entry (a picked, dropped or pasted file, an attach button or Save as Artifact with the month used up), and does Raft answer with the upgrade dialog or a file left unattached? (Decides Free's limits and whether the dialog converts.)",
    requestedBy: "cindyz (2026-10-28, #proj-commercial:3097abc4)",
    sources: WEB_CLIENTS,
    properties: {
      limit: { type: "enum", values: UPLOAD_LIMITS, required: true },
      entry: { type: "enum", values: UPLOAD_LIMIT_ENTRIES, required: true },
      response: { type: "enum", values: ["upgrade_dialog", "kept_unattached"], required: true },
      viewer_role: { type: "enum", values: PAYWALL_VIEWER_ROLES, required: true },
      plan: { type: "enum", values: PAYWALL_PLANS, required: true },
      /** The files this limit refused in the one action; 0 for an attach button tapped with the month used up. */
      files: { type: "integer", required: true },
      /** The largest of them, coarse; absent with no file. */
      largest_size: { type: "enum", values: UPLOAD_SIZE_BANDS },
    },
  },
  /** A Stripe Checkout session was created (owner only). */
  billing_checkout_started: {
    question: BILLING_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: BILLING_CHECKOUT_PROPERTIES,
  },
  /** Stripe's checkout.session.completed webhook, once it is processed. */
  billing_checkout_completed: {
    question: BILLING_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: BILLING_CHECKOUT_PROPERTIES,
  },
  /** A prepaid (Alipay, paid once) Checkout session was created (owner only). */
  billing_prepaid_checkout_started: {
    question: BILLING_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: BILLING_PREPAID_CHECKOUT_PROPERTIES,
  },
  /**
   * A paid prepaid Checkout was recorded by the webhook. `result`: `granted`
   * (the Server has the time), or `refunded` (another paid source was already
   * on it, the amount did not match, or the Server was gone; refunded at once).
   */
  billing_prepaid_checkout_completed: {
    question: BILLING_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: {
      ...BILLING_PREPAID_CHECKOUT_PROPERTIES,
      result: { type: "enum", values: ["granted", "refunded"], required: true },
    },
  },
  /** A Checkout adding seats to prepaid time mid-period was created (owner only). */
  billing_prepaid_seats_checkout_started: {
    question: BILLING_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: BILLING_PREPAID_SEATS_CHECKOUT_PROPERTIES,
  },
  /**
   * A paid seats Checkout was recorded by the webhook. `result`: `granted`
   * (the seats count now), or `refunded` (the prepaid time was gone or shorter
   * than priced, the amount did not match, or the Server was gone).
   */
  billing_prepaid_seats_checkout_completed: {
    question: BILLING_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: {
      ...BILLING_PREPAID_SEATS_CHECKOUT_PROPERTIES,
      result: { type: "enum", values: ["granted", "refunded"], required: true },
    },
  },
  /**
   * A Pro server's seat count changed in Stripe (owner only). `result` is
   * Stripe's answer: `updated` took effect at once and is only ever fewer
   * seats. More seats is `pending_webhook` (charged; Raft's capacity follows
   * the webhook) or `pending_payment` (not paid yet, and may never be).
   * Counting them: docs/analytics/product-events.md.
   */
  billing_seats_updated: {
    question: BILLING_QUESTION,
    requestedBy: BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: {
      entry: BILLING_ENTRY,
      previous_seat_quantity: { type: "integer", required: true },
      seat_quantity: { type: "integer", required: true },
      result: { type: "enum", values: ["updated", "pending_payment", "pending_webhook"], required: true },
    },
  },
  /**
   * An owner scheduled the Pro subscription to end with the period
   * (POST /billing/cancel, `cancel_at_period_end`): still Pro until then, and
   * Keep Pro withdraws it.
   */
  billing_cancellation_scheduled: {
    question: PLAN_BILLING_QUESTION,
    requestedBy: PLAN_BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: BILLING_CANCELLATION_PROPERTIES,
  },
  /**
   * A seat request withdrew a scheduled cancellation: Keep Pro, or a seat
   * change made while it was scheduled (that change is billing_seats_updated too).
   */
  billing_cancellation_withdrawn: {
    question: PLAN_BILLING_QUESTION,
    requestedBy: PLAN_BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: BILLING_CANCELLATION_PROPERTIES,
  },
  /** Stripe created a billing portal session (owner only); not what was done there. */
  billing_portal_opened: {
    question: PLAN_BILLING_QUESTION,
    requestedBy: PLAN_BILLING_REQUESTED_BY,
    sources: ["server"],
    properties: {
      entry: BILLING_ENTRY,
      from: { type: "enum", values: BILLING_PORTAL_FROM, required: true },
    },
  },
  /** A Plan & Billing dialog opened by the page's own button; not a paywall's dialog. */
  plan_billing_dialog_opened: {
    question: PLAN_BILLING_QUESTION,
    requestedBy: PLAN_BILLING_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: PLAN_BILLING_DIALOG_PROPERTIES,
  },
  /**
   * That dialog closed, at most once per opening: `completed` (seats changed, the
   * cancellation confirmed, off to Stripe, an admin's message to an owner
   * sent) or `dismissed` (closed without, also after an error).
   */
  plan_billing_dialog_closed: {
    question: PLAN_BILLING_QUESTION,
    requestedBy: PLAN_BILLING_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      ...PLAN_BILLING_DIALOG_PROPERTIES,
      result: { type: "enum", values: ["completed", "dismissed"], required: true },
    },
  },
  activity_open: {
    question: "How often do people open Activity, and from which entry point?",
    requestedBy: "stdrc",
    sources: WEB_CLIENTS,
    // sidebar: the phone Home row (removed 2026-10-20). mobile_tab_bar: the
    // phone's Activity tab (2026-10-20 on).
    properties: { from: { type: "enum", values: ["rail", "sidebar", "mobile_tab_bar"] } },
  },
  // Native apps from 2026-10-23 (Lagoon): their Activity rows and read marks.
  activity_item_open: {
    question: "Which kinds of Activity items do people open?",
    requestedBy: "stdrc",
    sources: APP_CLIENTS,
    // artifact: an Artifact's Activity row (an object row, its objectKind;
    // web from 2026-10-27, Remy).
    properties: { item_kind: { type: "enum", values: ["channel", "dm", "thread", "mention_action", "artifact"] } },
  },
  activity_mark: {
    question: "Do people triage Activity items (mark read / done)?",
    requestedBy: "stdrc",
    sources: APP_CLIENTS,
    // `unread` and `read_all` (Mark all read) added 2026-10-23; `read` was
    // registered but never sent before then.
    properties: { action: { type: "enum", values: ["read", "unread", "read_all", "done"] } },
  },
  community_cn_qr_page_view: {
    question: "How many people reach the Chinese community QR page, and from which campaign source?",
    requestedBy: "iynewz",
    sources: WEB_CLIENTS,
    properties: { from: { type: "string", maxLength: 64 } },
  },
  pwa_install_eligible: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_cta_shown: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_cta_clicked: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_native_prompt_result: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_ios_instruction_dismissed: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_appinstalled: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  pwa_install_standalone_detected: { question: PWA_INSTALL_QUESTION, requestedBy: "stdrc", sources: WEB_CLIENTS, properties: PWA_INSTALL_PROPERTIES },
  upgrade_prompt_shown: {
    question: UPGRADE_PATH_QUESTION,
    requestedBy: UPGRADE_PATH_REVIEW,
    sources: WEB_CLIENTS,
    properties: { surface: { type: "enum", values: UPGRADE_PROMPT_SURFACES, required: true } },
  },
  upgrade_prompt_interacted: {
    question: UPGRADE_PATH_QUESTION,
    requestedBy: UPGRADE_PATH_REVIEW,
    sources: WEB_CLIENTS,
    properties: {
      surface: { type: "enum", values: UPGRADE_PROMPT_SURFACES, required: true },
      action: { type: "enum", values: ["upgrade", "not_now"], required: true },
    },
  },
  // Sent once the Stripe session exists, just before the browser leaves for it.
  checkout_started: {
    question: UPGRADE_PATH_QUESTION,
    requestedBy: UPGRADE_PATH_REVIEW,
    sources: WEB_CLIENTS,
    properties: {
      entry: { type: "enum", values: CHECKOUT_ENTRIES, required: true },
      billing_interval: { type: "enum", values: ["monthly", "annual"], required: true },
      seat_count: { type: "integer", required: true },
      has_promotion_code: { type: "boolean", required: true },
      /** Only with entry paywall_panel: what opened the upgrade dialog, when not a paywall (CHECKOUT_OPENED_FROM). */
      opened_from: { type: "enum", values: CHECKOUT_OPENED_FROM },
      /** The surface the paywall that opened the dialog was on (PAYWALL_SURFACES); absent otherwise and from older clients. */
      surface: CHECKOUT_SURFACE,
    },
  },
  // Once per viewer opening, when the Artifact has loaded (a viewer that can't
  // open one records nothing). Coming back is the same person's later events.
  artifact_opened: {
    question: "Where do people discover and open Artifacts (message cards, links, the Artifacts page, search, Activity), what kind, their own or others', and do they come back?",
    requestedBy: ARTIFACTS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      source: { type: "enum", values: ARTIFACT_OPEN_SOURCES, required: true },
      kind: { type: "enum", values: ARTIFACT_EVENT_KINDS, required: true },
      /** The viewer is the author the card names (a pinned version's: its publisher). */
      is_author: { type: "boolean", required: true },
      surface: { type: "enum", values: ARTIFACT_VIEWER_SURFACES, required: true },
    },
  },
  artifact_viewer_action: {
    question: "Which Artifact viewer features do people use (versions, comments, follow, copy link, download, maximize, send)?",
    requestedBy: ARTIFACTS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: { action: { type: "enum", values: ARTIFACT_VIEWER_ACTIONS, required: true } },
  },
  // Once the server has the comment (a refused one records nothing). Edits are not comments.
  artifact_comment_posted: {
    question: "Do people give feedback on Artifacts, and where (the whole Artifact, a file, a place in the page, a passage), as replies, mentioning whom how often?",
    requestedBy: ARTIFACTS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      anchor: { type: "enum", values: ARTIFACT_COMMENT_ANCHORS, required: true },
      is_reply: { type: "boolean", required: true },
      mention_count_bucket: { type: "enum", values: ARTIFACT_MENTION_COUNT_BUCKETS, required: true },
    },
  },
  // Once the message is sent.
  artifact_shared: {
    question: "Does sending Artifacts to conversations spread them: where to, with a note, and does it widen who can see them?",
    requestedBy: ARTIFACTS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      target: { type: "enum", values: ARTIFACT_SHARE_TARGETS, required: true },
      with_note: { type: "boolean", required: true },
      widen: { type: "enum", values: ARTIFACT_SHARE_WIDEN, required: true },
    },
  },
  // A new Artifact was made from an attachment (not an attachment saved before).
  artifact_saved_from_attachment: {
    question: "Do people turn attachments into Artifacts (Save as Artifact)?",
    requestedBy: ARTIFACTS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {},
  },
  // The web sends `web`; imports through the CLI are counted from the server's
  // import audit rows, not by client telemetry.
  artifact_imported: {
    question: "Is importing an Artifact from the old raft-artifacts.com used, and from where?",
    requestedBy: ARTIFACTS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: { via: { type: "enum", values: ["web", "cli"], required: true } },
  },
  // One per frame attempt (a retry is a new one), from asking for the frame
  // to the page loading or failing. Closing the viewer first records nothing.
  artifact_frame_loaded: {
    question: "Do framed Artifact pages (html, markdown, pdf) open fast and reliably?",
    requestedBy: ARTIFACTS_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      result: { type: "enum", values: ARTIFACT_FRAME_RESULTS, required: true },
      kind: { type: "enum", values: ARTIFACT_FRAMED_EVENT_KINDS, required: true },
      duration_bucket: { type: "enum", values: ARTIFACT_FRAME_DURATION_BUCKETS, required: true },
    },
  },
  // See DESKTOP_COMPUTER_MIGRATION_STEPS above. `step`: where the attempt
  // ended (the failed step; `verify` on success); absent when the journal
  // failed before any step ran. `attempt`: 1 for the first, capped at 20;
  // `duration_ms`: this attempt's own time, capped at an hour. `report_id`:
  // random per attempt report, also the event's uuid, so a report Desktop
  // delivers again (it is kept until a batch with it was accepted) is
  // deduplicated. `ended_at`: when the attempt ended (epoch ms, to the
  // minute): a report can be sent long after (the next launch), and the
  // event's own timestamp is when it was sent (ingest refuses one older than
  // 24 h).
  desktop_computer_migration_finished: {
    question: "Does Raft Desktop's move from its embedded Computer to the official raft-computer finish, and when it does not, at which step, with which error, behind which kind of proxy and on which platform?",
    requestedBy: "AndyLok (data owner; event design approved 2026-11-08)",
    sources: ["desktop"],
    properties: {
      operation_id: { type: "string", maxLength: 36, required: true },
      report_id: { type: "string", maxLength: 36, required: true },
      outcome: { type: "enum", values: DESKTOP_COMPUTER_MIGRATION_OUTCOMES, required: true },
      step: { type: "enum", values: DESKTOP_COMPUTER_MIGRATION_STEPS },
      error_code: { type: "enum", values: DESKTOP_COMPUTER_MIGRATION_ERROR_CODES, maxLength: DESKTOP_COMPUTER_MIGRATION_ERROR_CODE_MAX_LENGTH },
      proxy: { type: "enum", values: DESKTOP_COMPUTER_MIGRATION_PROXY_SOURCES, required: true },
      platform: { type: "enum", values: DESKTOP_COMPUTER_MIGRATION_PLATFORMS, required: true },
      desktop_version: { type: "version", required: true },
      computer_version: { type: "version" },
      attempt: { type: "integer", min: 1, max: DESKTOP_COMPUTER_MIGRATION_MAX_ATTEMPT, required: true },
      duration_ms: { type: "integer", min: 0, max: DESKTOP_COMPUTER_MIGRATION_MAX_DURATION_MS, required: true },
      ended_at: { type: "integer", min: 0, required: true },
    },
  },
  // Drafts (drafts_section_v0): the page listing every unsent message, beside
  // Saved. Viewed once per opening of the page, with how many drafts it
  // listed; an item opened when a row takes the person to its conversation,
  // with the kind of place. Never a conversation, a draft's text or its length.
  drafts_page_viewed: {
    question: "Do people open the Drafts page, and does it hold drafts when they do?",
    requestedBy: GATED_FEATURES_REQUESTED_BY,
    sources: APP_CLIENTS,
    properties: { drafts: { type: "enum", values: DRAFT_COUNT_BUCKETS, required: true } },
  },
  drafts_item_opened: {
    question: "Do people go back to a draft from the Drafts page, and to which kind of conversation?",
    requestedBy: GATED_FEATURES_REQUESTED_BY,
    sources: APP_CLIENTS,
    properties: { place: { type: "enum", values: DRAFT_PLACES, required: true } },
  },
  // Agent read progress (agent_read_progress_v0): the display was generated in
  // a conversation the person opened, once per conversation and part per page
  // load. `faces`: at least one agent's face placed on a loaded timeline row;
  // `not_reaching_line`: the line under your latest message saying it will not
  // reach an agent was rendered. Not checked against the scrolled viewport (the
  // timeline is virtualized), so not an impression (meichen, 2026-11-08). No ids.
  agent_read_progress_shown: {
    question: "How many people open conversations where agents' read progress is generated, and how often is the line saying a message will not reach an agent rendered?",
    requestedBy: GATED_FEATURES_REQUESTED_BY,
    sources: APP_CLIENTS,
    properties: {
      part: { type: "enum", values: AGENT_READ_PROGRESS_PARTS, required: true },
      conversation: { type: "enum", values: AGENT_READ_PROGRESS_CONVERSATIONS, required: true },
    },
  },
  /**
   * One event for every feature in the feature map (cindyz, 2026-10-26,
   * #proj-analytics:4dc6995c): a new feature adds values here, not events.
   * Actions are generic (Tenny): `open` = the feature's surface opened;
   * `submit` = the person completed it, and each feature's file in the
   * dashboard says what that means. Pilot: invite people, where `submit` =
   * invites went out (email: the server accepted them, `count` of them; link:
   * the person copied the invite link).
   */
  feature_action: {
    question: "Which features do people start and finish, and from which entry point? (Feature map pilot: inviting people.)",
    requestedBy: "cindyz (2026-10-26, #proj-analytics:4dc6995c)",
    sources: WEB_CLIENTS,
    properties: {
      feature: { type: "enum", values: PRODUCT_FEATURES, required: true },
      action: { type: "enum", values: ["open", "submit"], required: true },
      surface: { type: "enum", values: ["sidebar", "server_menu", "settings", "members_page"] },
      variant: { type: "enum", values: ["email", "link"] },
      count: { type: "integer" },
    },
  },
  // The Computers page (COMPUTERS_LIST_* above). `computer_count`,
  // `online_count` and `own_count` count the server's whole list, before the
  // search and the filters.
  computers_list_viewed: {
    question: "Which view, grouping and sort do people have standing when they open the Computers page, by how many computers the server has? (Decides the page's defaults.)",
    requestedBy: COMPUTERS_LIST_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      variant: { type: "enum", values: COMPUTERS_LIST_VARIANTS, required: true },
      view: { type: "enum", values: COMPUTERS_LIST_VIEWS, required: true },
      group_by: { type: "enum", values: COMPUTERS_LIST_GROUP_BYS, required: true },
      sort_key: { type: "enum", values: COMPUTERS_LIST_SORT_KEYS, required: true },
      /** Absent when `sort_key` is `default`. */
      sort_direction: { type: "enum", values: COMPUTERS_LIST_SORT_DIRECTIONS },
      /** Only when `sort_key` is `remaining`: whose quota. */
      sort_runtime: { type: "enum", values: COMPUTERS_LIST_SORT_RUNTIMES },
      computer_count: { type: "integer", min: 0, max: COMPUTERS_LIST_MAX_COUNT, required: true },
      online_count: { type: "integer", min: 0, max: COMPUTERS_LIST_MAX_COUNT, required: true },
      /** This device and the viewer's own computers. */
      own_count: { type: "integer", min: 0, max: COMPUTERS_LIST_MAX_COUNT, required: true },
      // The search and the filters stand until another server, Clear all or a
      // reload, so a page opened again can show them with no change event.
      /** Status or Runtime stood at something other than its default. */
      filtered: { type: "boolean", required: true },
      /** The search held something. */
      searched: { type: "boolean", required: true },
    },
  },
  computers_list_control_changed: {
    question: "Which filters, grouping and sorts do people reach for on the Computers page, and from where (toolbar, the ⋯ menu, a column heading)? (Decides which controls the page keeps.)",
    requestedBy: COMPUTERS_LIST_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      control: { type: "enum", values: COMPUTERS_LIST_CONTROLS, required: true },
      /** What it was set to; absent for `search`, `runtime` and `clear_all`. A fold: its state after the click. */
      value: { type: "enum", values: COMPUTERS_LIST_CONTROL_VALUES },
      /** `runtime`: the one runtime toggled. `sort_key` = `remaining`: whose quota. */
      runtime: { type: "enum", values: COMPUTERS_LIST_RUNTIMES },
      /** `runtime` only: it was added to the filter (false: taken out). */
      runtime_selected: { type: "boolean" },
      surface: { type: "enum", values: COMPUTERS_LIST_CONTROL_SURFACES, required: true },
      variant: { type: "enum", values: COMPUTERS_LIST_VARIANTS, required: true },
      computer_count: { type: "integer", min: 0, max: COMPUTERS_LIST_MAX_COUNT, required: true },
    },
  },
  computers_list_computer_opened: {
    question: "Whose computers do people open from the Computers page, and did they need a filter or a search to get to them? When a search led there, which field did it find the computer by: name, host name or owner? (Decides the default order, what the filters are for, and whether one is missing.)",
    requestedBy: COMPUTERS_LIST_REQUESTED_BY,
    sources: WEB_CLIENTS,
    properties: {
      variant: { type: "enum", values: COMPUTERS_LIST_VARIANTS, required: true },
      view: { type: "enum", values: COMPUTERS_LIST_VIEWS, required: true },
      relation: { type: "enum", values: COMPUTERS_LIST_RELATIONS, required: true },
      status: { type: "enum", values: COMPUTERS_LIST_COMPUTER_STATUSES, required: true },
      /** Status or Runtime differs from its default. */
      filtered: { type: "boolean", required: true },
      searched: { type: "boolean", required: true },
      /** A sort other than the default (Mine first) is set. */
      sorted: { type: "boolean", required: true },
      grouped: { type: "boolean", required: true },
      /**
       * While the search holds something: which of this computer's fields hold
       * the search text (name, host name, owner's name). More than one can.
       * Absent with no search, and for this device's row while it is not one
       * of the server's computers. The answers only, never the text.
       */
      search_matched_name: { type: "boolean" },
      search_matched_hostname: { type: "boolean" },
      search_matched_owner: { type: "boolean" },
      /** Its place among the rows the list showed at that moment, from 1, top to bottom. */
      position: { type: "integer", min: 1, max: COMPUTERS_LIST_MAX_COUNT },
    },
  },
} as const satisfies Record<string, ProductEventSpec>;

type Registry = typeof PRODUCT_EVENT_REGISTRY;

export type ProductEventName = keyof Registry;

type PropertyValue<S> =
  S extends { type: "enum"; values: readonly (infer V)[] } ? V
    : S extends { type: "boolean" } ? boolean
      : S extends { type: "integer" } ? number
        : string;

type PropertiesFromSpec<P extends Readonly<Record<string, ProductEventPropertySpec>>> = {
  -readonly [K in keyof P as P[K] extends { required: true } ? K : never]-?: PropertyValue<P[K]>;
} & {
  -readonly [K in keyof P as P[K] extends { required: true } ? never : K]?: PropertyValue<P[K]>;
};
export type ProductEventProperties<E extends ProductEventName> = PropertiesFromSpec<Registry[E]["properties"]>;

export type ProductEventRejection =
  | "unregistered_event"
  | "source_not_allowed"
  | "unknown_property"
  | "invalid_property_value"
  | "missing_property";

export type ProductEventValidation =
  | { ok: true; event: ProductEventName }
  | { ok: false; reason: ProductEventRejection; property?: string };

export function isProductEventName(name: string): name is ProductEventName {
  return Object.prototype.hasOwnProperty.call(PRODUCT_EVENT_REGISTRY, name);
}

function isValidPropertyValue(spec: ProductEventPropertySpec, value: unknown): boolean {
  switch (spec.type) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value) && (spec.maxLength === undefined || value.length <= spec.maxLength);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isSafeInteger(value)
        && (spec.min === undefined || (value as number) >= spec.min)
        && (spec.max === undefined || (value as number) <= spec.max);
    case "version":
      return typeof value === "string" && PRODUCT_EVENT_VERSION.test(value);
    case "string":
      return typeof value === "string" && value.length <= spec.maxLength && PRODUCT_EVENT_STRING_TOKEN.test(value);
    case "hostname":
      return typeof value === "string" && PRODUCT_EVENT_HOSTNAME.test(value) && !IPV4_ADDRESS.test(value);
  }
}

/**
 * The host name of a referring URL, as the `hostname` type stores it
 * (lowercase, without a leading `www.`), or null when there is none to keep:
 * empty, not http(s), an IP address or anything else the type refuses.
 */
export function referrerHostname(referrer: string): string | null {
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return PRODUCT_EVENT_HOSTNAME.test(host) && !IPV4_ADDRESS.test(host) ? host : null;
}

/**
 * A campaign parameter (utm_*) as a `string` token, or null when it is not
 * one. Values are lowercased but never rewritten otherwise, so an email or a
 * sentence is dropped rather than squeezed into a token.
 */
export function campaignToken(value: string | null | undefined, maxLength = 64): string | null {
  const token = (value ?? "").trim().toLowerCase();
  return token !== "" && token.length <= maxLength && PRODUCT_EVENT_STRING_TOKEN.test(token) ? token : null;
}

/**
 * Checks an incoming event against the registry. Missing properties are allowed
 * unless explicitly required; unknown ones and values outside the declared type are not.
 */
export function validateProductEvent(
  name: string,
  properties: Readonly<Record<string, unknown>>,
  source: ProductEventSource,
): ProductEventValidation {
  if (!isProductEventName(name)) return { ok: false, reason: "unregistered_event" };
  const spec: ProductEventSpec = PRODUCT_EVENT_REGISTRY[name];
  if (!spec.sources.includes(source)) return { ok: false, reason: "source_not_allowed" };
  for (const [property, propertySpec] of Object.entries(spec.properties)) {
    if (propertySpec.required && (!Object.prototype.hasOwnProperty.call(properties, property) || properties[property] === undefined)) {
      return { ok: false, reason: "missing_property", property };
    }
  }
  for (const [property, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    const propertySpec = Object.prototype.hasOwnProperty.call(spec.properties, property)
      ? spec.properties[property]
      : undefined;
    if (!propertySpec) return { ok: false, reason: "unknown_property", property };
    if (!isValidPropertyValue(propertySpec, value)) {
      return { ok: false, reason: "invalid_property_value", property };
    }
  }
  return { ok: true, event: name };
}
