/**
 * Task #255: staging "default-on" for feature flags.
 *
 * When an environment sets `FEATURE_FLAGS_DEFAULT_ON` (truthy: "true" or "1"),
 * the LAST step of flag evaluation, the stored `default_enabled` fallback,
 * answers ON, and so does a key with no row at all (Tenny: newly merged flags
 * must work on staging without creating rows; evaluate a missing row as
 * `{ key, defaultEnabled: false }`). Nothing else moves: the kill switch,
 * `enabled = false`, every matching rule (deny rules included) and the
 * missing-randomization-unit guard still decide before the fallback is read.
 * The pre-auth evaluator only answers rows marked pre_auth_evaluable, so a
 * missing row stays off there.
 *
 * A key listed in FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS (with the reason) keeps
 * the stored default. No server is exempt (Tenny, task #255): a server that
 * needs a flag off adds a deny rule for it in FFA.
 *
 * The API honours the variable only where DEPLOYMENT_ENV is "staging"
 * (featureFlagDefaultPolicy in featureFlagService.ts); the Worker's production
 * config is pinned and does not carry it.
 *
 * Pure and env-free on purpose: the API server reads process.env and the
 * Feature Flag Admin Worker reads its own Worker vars, then both call
 * `featureFlagDefaultPolicyFromEnv` / `describeEffectiveDefault`. Imported by
 * the Worker through the `@botiverse/raft-shared/feature-flag-default-policy`
 * leaf, so it must not import anything.
 */

export const FEATURE_FLAGS_DEFAULT_ON_ENV = "FEATURE_FLAGS_DEFAULT_ON";

/** Entries whose key ends with this suffix match every flag key starting with the rest. */
export const FEATURE_FLAG_DEFAULT_ON_PREFIX_WILDCARD = "*";

/**
 * Flags whose fallback must never flip under default-on, with the reason.
 * A key ending in `*` is a prefix entry (`antiproton_*` covers every
 * `antiproton_` flag). Under default-on a key with no row turns on too, so a
 * code-only ("not seeded; missing = off") flag that must stay off belongs
 * here: run packages/server/scripts/feature-flags-default-on-diff.ts first.
 *
 * Rule for adding one (Tenny, task #255): a flag is an exception only if on
 * means "stop" or "restrict"; it deletes data or locks people out; it costs
 * money; it is under security review; or it needs something staging does not
 * have (an external service or credential, a data prerequisite, a peer that is
 * not ready). Anything else is on by default on staging.
 */
// Not an exception, but note: external_channels_v1 stays on under default-on because staging has no launch-backfill
// marker and no freeze rows. Running that backfill on staging would start the 14-day freeze clock for its Free test
// servers that sit in two or more shared channels.
export const FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS: Record<string, string> = {
  // Inverted or emergency switches: ON means "stop" or "restrict".
  legacy_mobile_oauth_upgrade_required_v0: "inverted: on forces old mobile clients to upgrade",
  // Minimum supported mobile build gates. The variant is an integer build number (1.20.0 = 12000000), set only
  // through the default variant; no per-server rules.
  mobile_min_build_android_v1: "inverted: on blocks Android builds below the default variant's build number",
  mobile_min_build_ios_v1: "inverted: on blocks iOS builds below the default variant's build number",
  remote_computer_upgrade_hold_linux: "inverted: on holds Linux Computer upgrades",
  remote_computer_upgrade_hold_macos: "inverted: on holds macOS Computer upgrades",
  remote_computer_upgrade_hold_windows: "inverted: on holds Windows Computer upgrades",
  computer_version_enforcement: "emergency: on holds agents on Computers below the version floor",
  runner_credential_reconcile_count_only: "emergency: evidence mode for runner credential reconcile, toggled by hand",
  sync_inbox_staging_held_v0: "restrict, staging testing aid: on holds every inbox_row of a capable sync pull, then resets held_too_long",
  // Destructive, or can lock people out.
  closed_server_purge: "destructive: purges closed servers' data",
  runner_credential_reconcile: "destructive: revokes runner credentials on every daemon reconnect",
  agent_repeated_wake_guard: "stop: ends the process of an agent woken repeatedly by one message (#proj-runtime:#62); count-only until a human turns it on",
  account_deletion_v0: "destructive: lets people schedule deleting their account",
  server_sso_required_v1: "lockout: requires SSO sign-in for a server's members",
  auth_second_factor_v1: "lockout: enrols and enforces a second sign-in factor",
  joint_source_exit_v1: "operator-only: turned on only by activate-joint-source-exit.ts after its guarded checks",
  // Billing or paid calls.
  pro_seat_add: "billing: adds paid Pro seats",
  llm_translation_v0: "billing: paid LLM translation calls",
  pro_prepaid: "billing: starts prepaid Pro checkouts through Alipay",
  // External services, credentials or public indexing.
  mobile_push_fcm_v0: "external: sends through FCM and needs its credentials",
  slack_bridge_v0: "external: Slack bridge needs Slack app credentials",
  slack_attachment_transfer: "external: works only through the Slack bridge (an exception above)",
  agent_migration_hosted_v0: "external: needs the hosted runtime, as antiproton_*",
  vault_app: "external: staging has no Vault app registered, so on would offer an app that is not there",
  "antiproton_*": "external: Antiproton hosted runtime and models need hosted credentials",
  "agent_runtime_oar_*": "external: OAR runtime host needs daemons that advertise it",
  grok_runtime_v0: "external: Grok runtime needs provider credentials",
  assistant_wechat_v0: "external: WeChat channel needs WeChat credentials",
  public_server_search_index_v0: "indexing: exposes servers to search engines; publicSearch also reads default_enabled in raw SQL",
  public_server_v0: "external: makes servers publicly reachable",
  // Data or legal prerequisites that a deploy does not satisfy.
  search_joint_conversation_walk_v0: "data: only after the 0764 conversation_id backfill verified 0/0 and its index is valid",
  reminder_app: "data: staging has no Reminder app, so on makes the built-in reminder commands refuse; lift once staging registers its own Reminder app",
  public_visitor_id_v0: "legal: cookie banner and visitor id only once the privacy policy and banner copy are published",
  // Under staged acceptance: stays off until its acceptance is read.
  inbox_row_position_v1: "acceptance: Activity list path; on only after its staging drift audit is accepted (#triage:#244)",
  // Both halves exist (Computers advertise agent:focus-v1) and the focused-body size limits are in the code
  // (16 KB a message, 32 KB a write, set from production message sizes; docs/contracts/agent-focus.md, "Size limits").
  // Stays off for every production server, our own included, until the scripted staging test passes on both agent
  // hosts and the limits' telemetry is confirmed arriving from staging ("Not done"). On staging it is turned on per
  // server through the flag admin for that test; lift this once both hold.
  agent_focus_v0: "acceptance: off for every production server, our own included, until the scripted staging test passes on both agent hosts and the size-limit telemetry is confirmed arriving from staging (docs/contracts/agent-focus.md, Not done)",
  // Half built: the start and the route exist; the mover and the switch do not, so an on job never finishes.
  channel_conversion_online_move_v1: "peer not ready: an online move's job waits in online_move until the mover and switch land",
  // Under security review: stays off until the review closes.
  prepared_request_card_v0: "security: runs a request with the presser's authority; staged review (RFC 085)",
  data_export_v0: "security: copies personal and server data out of Raft; under Tenny/Warden review; on only through allow rules",
  // Protocol or worker-version gates: on before the other side is ready breaks old peers.
  interactive_link_cards: "protocol: on sends link-preview v2 with no v1 fallback; only for servers whose Apps answer v2",
  sidebar_mark_all_read_v0: "protocol: only after every read worker supports the mark-all-read mutation",
  agent_activity_kernel_arbitration_v0: "protocol: default-dark gate for kernel-arbitrated agent activity serving-map writes",
  apple_web_login_v0: "protocol: gated by a required platform rule that a default-on would bypass",
  social_completion_binding: "protocol: refuses social sign-in completions from web bundles that do not post the binding cookie",
  agent_secret_encryption_write_v1: "protocol: seals agent secrets on DB write; stays off during rolling deploy and rollback window until all replicas can decrypt (#proj-runtime:#79)",
  replica_seal_agent_config_v1: "protocol: seals agent:start and agent:config across Redis; stays off during rolling deploy until all replicas can open sealed frames (#proj-runtime:#79)",
  // Retired: kept only for rolling upgrades.
  wiki_v0: "retired",
  slack_reaction_sync: "retired",
};

export type FeatureFlagDefaultPolicy = {
  /** FEATURE_FLAGS_DEFAULT_ON is truthy in this environment. */
  defaultOn: boolean;
};

export type EffectiveDefaultSource =
  /** default-on is off here, or the stored default is already on. */
  | "stored"
  /** default-on flipped a stored off to on. */
  | "default_on"
  /** default-on is set but the key is an exception. */
  | "exception";

export type EffectiveDefault = {
  enabled: boolean;
  source: EffectiveDefaultSource;
  /** The exception reason when `source` is "exception". */
  reason?: string;
};

export type FeatureFlagDefaultRow = { key: string; defaultEnabled: boolean };

/** "true" or "1" (case- and whitespace-insensitive). Anything else, including unset, is off. */
export function parseFeatureFlagsDefaultOn(raw: string | null | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Reads FEATURE_FLAGS_DEFAULT_ON from a plain env record (process.env or a Worker `env`). */
export function featureFlagDefaultPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>> | null | undefined,
): FeatureFlagDefaultPolicy {
  return { defaultOn: parseFeatureFlagsDefaultOn(env?.[FEATURE_FLAGS_DEFAULT_ON_ENV]) };
}

/** The exception reason for a key (exact entry first, then the longest prefix entry), or null. */
export function featureFlagDefaultOnException(key: string): string | null {
  if (Object.prototype.hasOwnProperty.call(FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS, key)) {
    return FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS[key] ?? null;
  }
  let best: { prefix: string; reason: string } | null = null;
  for (const [entry, reason] of Object.entries(FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS)) {
    if (!entry.endsWith(FEATURE_FLAG_DEFAULT_ON_PREFIX_WILDCARD)) continue;
    const prefix = entry.slice(0, -FEATURE_FLAG_DEFAULT_ON_PREFIX_WILDCARD.length);
    // An empty prefix would exempt everything; never treat a bare "*" as a match.
    if (prefix.length === 0 || !key.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, reason };
  }
  return best?.reason ?? null;
}

/** The fallback a flag row answers at the end of evaluation, and why. */
export function describeEffectiveDefault(row: FeatureFlagDefaultRow, policy: FeatureFlagDefaultPolicy): EffectiveDefault {
  if (!policy.defaultOn || row.defaultEnabled) return { enabled: row.defaultEnabled, source: "stored" };
  const reason = featureFlagDefaultOnException(row.key);
  if (reason !== null) return { enabled: row.defaultEnabled, source: "exception", reason };
  return { enabled: true, source: "default_on" };
}

export function effectiveDefaultEnabled(row: FeatureFlagDefaultRow, policy: FeatureFlagDefaultPolicy): boolean {
  return describeEffectiveDefault(row, policy).enabled;
}
