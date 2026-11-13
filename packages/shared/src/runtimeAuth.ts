import { z } from "zod";
import { lazySchema } from "./lazySchema";

/**
 * Runtime account login and logout from the web (task #17, contract in
 * docs/contracts/runtime-auth.md). The login runs on the Computer through
 * OAR; credentials never leave it. Raft relays the status, the link or device
 * code (to the person who started the login only), Claude's pasted one-time
 * code (to that Computer and that login only), and the result. The one
 * credential that does pass through is a Qwen Code provider's API key: sent
 * once to that Computer for Qwen's own settings, never stored, logged or
 * traced on the way.
 */

/**
 * Runtimes whose sign-in Raft shows and drives from the web: the OAR runtimes
 * with a login, and Qwen Code, which has a provider key instead. These are
 * OAR's ids, not Raft's runtime ids (`runtimeAuthRuntimeFor` maps one to the
 * other). Antigravity is offered only where the server revives it
 * (`RUNTIME_AUTH_SERVER_GATED_RUNTIMES`). Pi signs in per model provider
 * (`RUNTIME_AUTH_PER_PROVIDER_RUNTIMES`). Grok Build signs in with its own
 * device code (OAR 0.99 `grok login --device-auth`). OpenCode 2 signs in per
 * provider too, through its own server (OAR 0.100 `createOpencodeProviderAuth`).
 * CodeBuddy Code signs in with its own link (OAR's stream-json `authenticate`).
 */
export const RUNTIME_AUTH_RUNTIMES = ["claude", "codex", "kimi", "qoder", "qwen", "antigravity", "pi", "grok", "opencode", "codebuddy"] as const;
export type RuntimeAuthRuntime = (typeof RUNTIME_AUTH_RUNTIMES)[number];

export function isRuntimeAuthRuntime(value: unknown): value is RuntimeAuthRuntime {
  return typeof value === "string" && (RUNTIME_AUTH_RUNTIMES as readonly string[]).includes(value);
}

/**
 * The runtimes every Computer with DAEMON_CAPABILITY_RUNTIME_AUTH signs in
 * and out, and the only ones a server without SERVER_CAPABILITY_RUNTIME_AUTH_V2
 * accepts in a report (its schema was strict on exactly these).
 */
export const RUNTIME_AUTH_V1_RUNTIMES = ["claude", "codex"] as const satisfies readonly RuntimeAuthRuntime[];

/**
 * The runtimes a Computer with DAEMON_CAPABILITY_RUNTIME_AUTH_V2 but without
 * DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER acts on: it drops a request for
 * Qwen Code.
 */
export const RUNTIME_AUTH_V2_RUNTIMES = ["claude", "codex", "kimi", "qoder"] as const satisfies readonly RuntimeAuthRuntime[];

/**
 * Runtimes the server offers sign-in for only where it runs them: Antigravity
 * is a deprecated runtime a server revives with its flag
 * (`agent_runtime_oar_antigravity`). The server leaves such a runtime out of
 * the Computer's `runtimes` and its stored status where the flag is off, and
 * refuses its login there; the web shows it no card at all unless `runtimes`
 * names it (no upgrade caption either: the web cannot tell a server that does
 * not offer it from a Computer too old to sign it in).
 */
export const RUNTIME_AUTH_SERVER_GATED_RUNTIMES = ["antigravity"] as const satisfies readonly RuntimeAuthRuntime[];

export function isRuntimeAuthServerGated(runtime: RuntimeAuthRuntime): boolean {
  return (RUNTIME_AUTH_SERVER_GATED_RUNTIMES as readonly RuntimeAuthRuntime[]).includes(runtime);
}

/**
 * `connect_provider`: save a model provider's API key in the runtime's own
 * settings on the Computer (Qwen Code: OAR's `createQwenProviderAuth`; Pi:
 * `createPiProviderAuth().setApiKey`). Qwen has no sign-in to run and nothing
 * to sign out of; Pi has both, per provider.
 */
export type RuntimeAuthAction = "login" | "logout" | "connect_provider";

/**
 * What OAR can do for each runtime: Qoder has a login but no logout; Qwen Code
 * a provider key only. Antigravity's logout (OAR 0.98, agy's ACP `logout`)
 * runs only on a Computer whose daemon advertises it
 * (`DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY_LOGOUT`, see
 * `runtimeAuthLogoutRuntimesOfComputer`). Grok Build's login and logout
 * (OAR 0.99) came together, on one capability
 * (`DAEMON_CAPABILITY_RUNTIME_AUTH_GROK`); so did OpenCode's per-provider
 * sign-in, sign-out and keys (OAR 0.100, `DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE`),
 * and CodeBuddy Code's login and logout (`DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY`).
 */
export const RUNTIME_AUTH_ACTIONS: Readonly<Record<RuntimeAuthRuntime, readonly RuntimeAuthAction[]>> = {
  claude: ["login", "logout"],
  codex: ["login", "logout"],
  kimi: ["login", "logout"],
  qoder: ["login"],
  qwen: ["connect_provider"],
  antigravity: ["login", "logout"],
  pi: ["login", "logout", "connect_provider"],
  grok: ["login", "logout"],
  opencode: ["login", "logout", "connect_provider"],
  codebuddy: ["login", "logout"],
};

export function runtimeAuthSupports(runtime: RuntimeAuthRuntime, action: RuntimeAuthAction): boolean {
  return RUNTIME_AUTH_ACTIONS[runtime].includes(action);
}

/** Where a Kimi Code account lives, as the Kimi Code SDK's login takes it (`region`). */
export const RUNTIME_AUTH_LOGIN_REGIONS = ["mainland-cn", "global"] as const;
export type RuntimeAuthLoginRegion = (typeof RUNTIME_AUTH_LOGIN_REGIONS)[number];

/**
 * The regions each runtime's login asks the person to choose from before it
 * starts; empty for a runtime that asks none. Kimi Code signs in through a
 * different service for mainland China and for everywhere else, and the person
 * always says which (xxchan): no default, no guess from the Computer.
 */
export const RUNTIME_AUTH_LOGIN_REGION_CHOICES: Readonly<Record<RuntimeAuthRuntime, readonly RuntimeAuthLoginRegion[]>> = {
  claude: [],
  codex: [],
  kimi: RUNTIME_AUTH_LOGIN_REGIONS,
  qoder: [],
  qwen: [],
  antigravity: [],
  pi: [],
  grok: [],
  opencode: [],
  codebuddy: [],
};

/**
 * Whether a login start's `region` fits its runtime: one of its choices for a
 * runtime that asks for one, absent for any other. The server and the daemon
 * both check a start with it.
 */
export function runtimeAuthLoginRegionFits(runtime: RuntimeAuthRuntime, region: unknown): region is RuntimeAuthLoginRegion | undefined {
  const choices: readonly unknown[] = RUNTIME_AUTH_LOGIN_REGION_CHOICES[runtime];
  return choices.length === 0 ? region === undefined : choices.includes(region);
}

/**
 * Raft runtime id to the runtime whose sign-in it uses. Kimi Code
 * (`kimi-sdk`) maps to `kimi`, which the daemon signs in on the Kimi Code SDK
 * it bundles (not OAR's `kimi`), in Kimi Code's own home (`~/.kimi-code`).
 * The deprecated Kimi CLI (`kimi`) has none: its agents run on
 * `~/.kimi/config.toml`, which that sign-in does not touch, so a Sign In on
 * its badge would not help them. Null for a runtime Raft cannot sign in from
 * the web.
 */
const AUTH_RUNTIME_BY_RAFT_RUNTIME = new Map<string, RuntimeAuthRuntime>([
  ["claude", "claude"],
  ["codex", "codex"],
  ["kimi-sdk", "kimi"],
  ["qoder", "qoder"],
  ["qwen", "qwen"],
  ["antigravity", "antigravity"],
  // The standalone Pi runtime, on the Computer's own Pi sign-ins
  // (`~/.pi/agent/auth.json`). Never Built-in Pi (`builtin`): its agent dir is
  // per agent and isolated, its providers Raft's own.
  ["pi", "pi"],
  // Grok Build, on either host: the legacy driver and OAR both start the
  // same `grok` CLI on the Computer's own sign-in (`$GROK_HOME/auth.json`,
  // `~/.grok` by default), which the web sign-in writes.
  ["grok", "grok"],
  // OpenCode on the Computer's own sign-ins (OpenCode 2's integrations,
  // through `opencode serve` in the daemon's environment), which its agents
  // read unless their env moves OpenCode's data dir (XDG_DATA_HOME).
  ["opencode", "opencode"],
  // CodeBuddy Code, OAR-only: its agents start the same `codebuddy` CLI in the
  // daemon's environment, on the sign-in the web login writes.
  ["codebuddy", "codebuddy"],
]);

export function runtimeAuthRuntimeFor(raftRuntimeId: string): RuntimeAuthRuntime | null {
  return AUTH_RUNTIME_BY_RAFT_RUNTIME.get(raftRuntimeId) ?? null;
}

/**
 * Runtimes that sign in per model provider (Pi: Anthropic, OpenAI, GitHub
 * Copilot, an API key for DeepSeek, ...; OpenCode 2: its integrations), each
 * provider on its own, so a login, a logout and a provider connect name the
 * provider (`providerId`); the other runtimes have one sign-in and never
 * take one on a login or logout. The providers are the runtime's own (pi's
 * `/login` list, OpenCode's integration registry), never a Raft list.
 */
export const RUNTIME_AUTH_PER_PROVIDER_RUNTIMES = ["pi", "opencode"] as const satisfies readonly RuntimeAuthRuntime[];

export function runtimeAuthSignsInPerProvider(runtime: RuntimeAuthRuntime): boolean {
  return (RUNTIME_AUTH_PER_PROVIDER_RUNTIMES as readonly RuntimeAuthRuntime[]).includes(runtime);
}

/**
 * Whether a login start's or a logout's `providerId` fits its runtime: a
 * provider id for a runtime that signs in per provider, absent for any other.
 * The server and the daemon both check with it.
 */
export function runtimeAuthProviderIdFits(runtime: RuntimeAuthRuntime, providerId: unknown): providerId is string | undefined {
  return runtimeAuthSignsInPerProvider(runtime) ? isRuntimeAuthProviderId(providerId) : providerId === undefined;
}

/**
 * Runtimes whose provider may offer more than one OAuth sign-in, and whose
 * login start names the one the person chose (`oauthMethod`: the method's
 * label as the runtime lists it). OpenCode: GitHub Copilot, OpenAI and others
 * list a device-code method beside a browser one. Pi picks its headless mode
 * itself and never takes one.
 */
export const RUNTIME_AUTH_OAUTH_METHOD_RUNTIMES = ["opencode"] as const satisfies readonly RuntimeAuthRuntime[];

export function runtimeAuthChoosesOAuthMethod(runtime: RuntimeAuthRuntime): boolean {
  return (RUNTIME_AUTH_OAUTH_METHOD_RUNTIMES as readonly RuntimeAuthRuntime[]).includes(runtime);
}

/** An OAuth method's label as a login start carries it: one short line, no control characters. */
export const RUNTIME_AUTH_OAUTH_METHOD_LABEL_MAX_LENGTH = 80;

export function isRuntimeAuthOAuthMethodLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= RUNTIME_AUTH_OAUTH_METHOD_LABEL_MAX_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * The schema an OAuth method's label is carried under in a provider list,
 * the same rule as a login start's `oauthMethod` (`isRuntimeAuthOAuthMethodLabel`,
 * never trimmed or rewritten: the label the web sends back must be OAR's own).
 * The daemon filters a provider's methods with it, so one odd label drops
 * that method only, never the provider.
 */
export const runtimeAuthOAuthMethodLabelSchema = lazySchema("runtimeAuthOAuthMethodLabelSchema", () => z.string().refine(isRuntimeAuthOAuthMethodLabel, "Not a sign-in method label"));

/**
 * Whether a login start's `oauthMethod` fits its runtime: optional for a
 * runtime that lets the person choose (absent: the runtime's only method),
 * absent for any other. The server and the daemon both check with it.
 */
export function runtimeAuthOAuthMethodFits(runtime: RuntimeAuthRuntime, oauthMethod: unknown): oauthMethod is string | undefined {
  if (oauthMethod === undefined) return true;
  return runtimeAuthChoosesOAuthMethod(runtime) && isRuntimeAuthOAuthMethodLabel(oauthMethod);
}

/** One web login, from its start to its result. Opaque; minted by the server only. */
export type RuntimeAuthLoginId = string & { readonly __runtimeAuthLoginId: unique symbol };

const LOGIN_ID_PATTERN = /^rtl_[A-Za-z0-9_-]{16,64}$/;

/**
 * A code pasted from a runtime's sign-in page, as both the server and the
 * daemon accept it: one line after trimming, no control characters, a sane
 * length. The server trims before sending; OAR strips any inner whitespace.
 */
export function isRuntimeAuthPastedCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The only mint for a login id: the server's random id, or one received over the wire and checked. */
export function asRuntimeAuthLoginId(value: string): RuntimeAuthLoginId | null {
  return LOGIN_ID_PATTERN.test(value) ? (value as RuntimeAuthLoginId) : null;
}

/**
 * How long the server keeps a login it relays. Each login is bounded on the
 * Computer (OAR: Claude 15 min, Codex 16, Qoder 5, Antigravity 15, Grok 15, OpenCode 10, CodeBuddy 5; the Kimi Code SDK 15);
 * this is the outer bound for a Computer that never answers.
 */
export const RUNTIME_AUTH_LOGIN_TTL_MS = 20 * 60_000;
/** Starts allowed per (person, Computer) in one window, so nobody keeps spawning logins on a machine. */
export const RUNTIME_AUTH_LOGIN_START_LIMIT = 5;
export const RUNTIME_AUTH_LOGIN_START_WINDOW_MS = 10 * 60_000;
/** The relay budget for a logout round trip (OAR's logout plus its status query). */
export const RUNTIME_AUTH_LOGOUT_RELAY_BUDGET_MS = 45_000;
/**
 * The relay budget for a provider list or a provider connect round trip: the
 * runtime's installation check, then one bounded OAR operation (Qwen Code
 * starts its own process for each, `RUNTIME_AUTH_PROVIDER_TIMEOUT_MS` on the
 * daemon).
 */
export const RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS = 30_000;

const safeTextSchema = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value),
  "Text contains control characters",
);
/**
 * A model provider the runtime's own settings know (Qwen Code's provider
 * menu: "DeepSeek API Key", "Coding Plan", a custom OpenAI-compatible
 * server), as the person chooses one on the web. Only what that choice
 * needs: never a key, never the provider's stored settings beyond whether it
 * has any (`configured`).
 */
const providerIdSchema = lazySchema("runtimeAuthProviderIdSchema", () => z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/));
const maskedLabelSchema = lazySchema("runtimeAuthMaskedLabelSchema", () => safeTextSchema(80).refine(
  (value) => /[*•…]/u.test(value),
  "Account labels must contain an explicit mask marker",
));
const httpsUrlSchema = lazySchema("runtimeAuthHttpsUrlSchema", () => z.string().max(4096).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Only https links are relayed"));

/** The account a runtime is signed in to, as shown on the web: the email masked on the Computer, never in full. */
export const runtimeAuthAccountSchema = lazySchema("runtimeAuthAccountSchema", () => z.strictObject({
  maskedLabel: maskedLabelSchema.optional(),
  planLabel: safeTextSchema(80).optional(),
  methodLabel: safeTextSchema(40).optional(),
}));
export type RuntimeAuthAccount = z.infer<typeof runtimeAuthAccountSchema>;

/**
 * One provider a per-provider runtime (Pi) holds a stored sign-in for on the
 * Computer: its id and name as the runtime lists them, and how it is signed
 * in (`oauth`: an account, `subscription` when the account is a provider
 * subscription such as Claude Pro/Max; `api_key`: a key). Read without
 * resolving anything (no OAuth refresh, no key command run): stored, not
 * known to work. Never the key, a token or an account.
 */
export const runtimeAuthSignedInProviderSchema = lazySchema("runtimeAuthSignedInProviderSchema", () => z.strictObject({
  id: providerIdSchema,
  label: safeTextSchema(80),
  method: z.enum(["oauth", "api_key"]),
  subscription: z.boolean().optional(),
}));
export type RuntimeAuthSignedInProvider = z.infer<typeof runtimeAuthSignedInProviderSchema>;

/** How many stored providers one per-provider status may name. */
export const RUNTIME_AUTH_SIGNED_IN_PROVIDER_LIMIT = 128;

/**
 * For Pi (per provider) `logged_in` means at least one provider has a stored
 * sign-in in the Computer's Pi `auth.json`, listed in `providers`; `logged_out`
 * that none has (a key in the environment or Pi's `models.json` is not seen,
 * so the badge does not turn orange for it).
 *
 * For Qwen Code (a provider key, no sign-in) `logged_in` means a provider
 * credential is configured in Qwen's user or system settings or environment
 * on the Computer, never that it works: OAR's check is presence only, and the
 * web words it so ("Provider configured"). `logged_out` means none is
 * configured there; a key in an agent's own environment or a workspace `.env`
 * is not seen.
 */
export const runtimeAuthStatusSchema = lazySchema("runtimeAuthStatusSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("logged_in"),
    account: runtimeAuthAccountSchema.optional(),
    /** A per-provider runtime's stored providers (Pi), and only its. */
    providers: z.array(runtimeAuthSignedInProviderSchema).max(RUNTIME_AUTH_SIGNED_IN_PROVIDER_LIMIT).optional(),
  }),
  z.strictObject({ kind: z.literal("logged_out") }),
  z.strictObject({ kind: z.literal("unknown") }),
  /** The runtime is not on this Computer, or too old for OAR's login. */
  z.strictObject({ kind: z.literal("unavailable"), reason: z.enum(["not_installed", "version_unsupported", "unsupported_installation"]) }),
]));
export type RuntimeAuthStatus = z.infer<typeof runtimeAuthStatusSchema>;

/**
 * One Computer's report. `runtimes` drops a runtime it does not know rather
 * than refusing the report, so a newer Computer's extra runtime never costs
 * the others their status. (Servers before SERVER_CAPABILITY_RUNTIME_AUTH_V2
 * refuse the whole report on an unknown key: the daemon sends them the V1
 * runtimes only.)
 */
export const runtimeAuthStatusReportSchema = lazySchema("runtimeAuthStatusReportSchema", () => z.strictObject({
  collectedAt: z.string().datetime({ offset: true }),
  runtimes: z.object({
    claude: runtimeAuthStatusSchema.optional(),
    codex: runtimeAuthStatusSchema.optional(),
    kimi: runtimeAuthStatusSchema.optional(),
    qoder: runtimeAuthStatusSchema.optional(),
    qwen: runtimeAuthStatusSchema.optional(),
    antigravity: runtimeAuthStatusSchema.optional(),
    pi: runtimeAuthStatusSchema.optional(),
    grok: runtimeAuthStatusSchema.optional(),
    opencode: runtimeAuthStatusSchema.optional(),
    codebuddy: runtimeAuthStatusSchema.optional(),
  } satisfies Record<RuntimeAuthRuntime, z.ZodType>),
}));
export type RuntimeAuthStatusReport = z.infer<typeof runtimeAuthStatusReportSchema>;

/**
 * What the person sees while a login runs. Never a token or a pasted code.
 * `code_prompt`: the runtime waits for the one-time code its sign-in page
 * shows (Claude; Antigravity also takes the address the browser landed on).
 */
export const runtimeAuthLoginEventSchema = lazySchema("runtimeAuthLoginEventSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("auth_url"), url: httpsUrlSchema, instructions: safeTextSchema(500).optional() }),
  z.strictObject({
    kind: z.literal("device_code"),
    userCode: safeTextSchema(32),
    verificationUri: httpsUrlSchema,
    expiresInSeconds: z.number().int().positive().max(3600).optional(),
  }),
  z.strictObject({ kind: z.literal("info"), message: safeTextSchema(500) }),
  z.strictObject({ kind: z.literal("code_prompt"), message: safeTextSchema(500).optional(), retry: z.boolean().optional() }),
]));
export type RuntimeAuthLoginEvent = z.infer<typeof runtimeAuthLoginEventSchema>;

/**
 * `loopback_required` (OpenCode, OAR 0.100 with `loopback: "refuse"`): the
 * sign-in the person chose returns the browser to a localhost address on the
 * Computer and takes no pasted code, so only a browser on the Computer itself
 * can finish it; it was cancelled before any link was shown. Only an OpenCode
 * login ends so, and only a server that knows OpenCode starts one.
 */
export const RUNTIME_AUTH_LOGIN_FAILURE_REASONS = ["timed_out", "rejected", "not_logged_in", "interaction_failed", "process_failed", "loopback_required"] as const;
export const RUNTIME_AUTH_UNSUPPORTED_REASONS = ["unsupported_installation", "version_unsupported", "not_installed"] as const;

export const runtimeAuthLoginResultSchema = lazySchema("runtimeAuthLoginResultSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("logged_in"), account: runtimeAuthAccountSchema.optional() }),
  z.strictObject({ kind: z.literal("failed"), reason: z.enum(RUNTIME_AUTH_LOGIN_FAILURE_REASONS), detail: safeTextSchema(300).optional() }),
  z.strictObject({ kind: z.literal("cancelled") }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.enum(RUNTIME_AUTH_UNSUPPORTED_REASONS), detail: safeTextSchema(300).optional() }),
  /** Another login for this runtime is already running on the Computer. */
  z.strictObject({ kind: z.literal("busy") }),
]));
export type RuntimeAuthLoginResult = z.infer<typeof runtimeAuthLoginResultSchema>;

/**
 * `busy` (OpenCode): a sign-in is running or waiting on that Computer's one
 * OpenCode facade, so the sign-out was not started. Only an OpenCode logout
 * ends so, and only a server that knows OpenCode sends one.
 */
export const RUNTIME_AUTH_LOGOUT_FAILURE_REASONS = ["timed_out", "rejected", "process_failed", "still_logged_in", "busy"] as const;

export const runtimeAuthLogoutResultSchema = lazySchema("runtimeAuthLogoutResultSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("logged_out") }),
  z.strictObject({ kind: z.literal("failed"), reason: z.enum(RUNTIME_AUTH_LOGOUT_FAILURE_REASONS), detail: safeTextSchema(300).optional() }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.enum(RUNTIME_AUTH_UNSUPPORTED_REASONS), detail: safeTextSchema(300).optional() }),
]));
export type RuntimeAuthLogoutResult = z.infer<typeof runtimeAuthLogoutResultSchema>;

/** Socket event to the person who started the login (their own sockets only). */
export interface RuntimeAuthLoginEventPush {
  machineId: string;
  runtime: RuntimeAuthRuntime;
  loginId: RuntimeAuthLoginId;
  event: RuntimeAuthLoginEvent;
}

/** Socket event to the person who started the login when it ends. */
export interface RuntimeAuthLoginResultPush {
  machineId: string;
  runtime: RuntimeAuthRuntime;
  loginId: RuntimeAuthLoginId;
  result: RuntimeAuthLoginResult;
}

export function isRuntimeAuthProviderId(value: unknown): value is string {
  return providerIdSchema.safeParse(value).success;
}

/** How many OAuth sign-ins one provider may offer to choose from (OpenCode). */
export const RUNTIME_AUTH_PROVIDER_OAUTH_METHOD_LIMIT = 8;

/** How many endpoints (regions, platforms) one provider may offer to choose from. */
export const RUNTIME_AUTH_PROVIDER_ENDPOINT_CHOICE_LIMIT = 10;

/**
 * How a per-provider runtime's OAuth sign-in runs from the web. Pi: the
 * daemon answers the runtime's own mode question itself, never the person
 * (xxchan): the headless choice wherever there is one.
 * - `device_code`: a code to enter on the provider's page (OpenAI Codex,
 *   GitHub Copilot, Kimi Coding, xAI, Meta, Radius).
 * - `paste_code`: the provider's page shows a code to paste back (Anthropic's
 *   copy-code mode).
 * - `paste_address`: the browser lands on a localhost page that will not load
 *   (the Computer's callback); the person pastes that page's address (OpenAI
 *   "Sign in with ChatGPT", OpenRouter). The Computer listens on that local
 *   port meanwhile, as pi does; the paste is what reaches it from elsewhere.
 * - `computer_only`: no flow Raft knows to run without a browser on the
 *   Computer itself; shown with that reason, never started.
 * - `link` (OpenCode): the provider's sign-in page, opened from the web; what
 *   follows (a code to paste back, or nothing) is known only once OpenCode
 *   starts the attempt. One that could only return to a browser on the
 *   Computer ends as `loopback_required` before any link is shown.
 */
export const RUNTIME_AUTH_PROVIDER_OAUTH_FLOWS = ["device_code", "paste_code", "paste_address", "computer_only", "link"] as const;
export type RuntimeAuthProviderOAuthFlow = (typeof RUNTIME_AUTH_PROVIDER_OAUTH_FLOWS)[number];

/**
 * How a per-provider runtime takes an API key from the web. `key`: one key
 * and nothing else (Pi's `setApiKey`). `more_fields`: its key login asks more
 * (Amazon Bedrock, Google Vertex, the Cloudflare providers: a credential
 * type, an account id); `outside`: the runtime has no prompt for it at all
 * (the environment or a cloud profile). Neither can be entered here.
 */
export const RUNTIME_AUTH_PROVIDER_KEY_ENTRIES = ["key", "more_fields", "outside"] as const;
export type RuntimeAuthProviderKeyEntry = (typeof RUNTIME_AUTH_PROVIDER_KEY_ENTRIES)[number];

export const runtimeAuthProviderSchema = lazySchema("runtimeAuthProviderSchema", () => z.strictObject({
  id: providerIdSchema,
  label: safeTextSchema(80),
  description: safeTextSchema(200).optional(),
  /** The runtime's own grouping of its menu (Qwen: "QwenCloud", "Alibaba ModelStudio", third-party, custom). */
  group: z.strictObject({ id: providerIdSchema, label: safeTextSchema(80).optional() }).optional(),
  /** The runtime's settings already hold something for this provider (presence only; never whether it works). */
  configured: z.boolean(),
  /**
   * Where the provider's API lives. `fixed`: the runtime knows it, nothing to
   * ask. `choice`: one of the provider's own endpoints (a region, a
   * platform), which the person picks; none is assumed. `custom`: a URL the
   * person types (a local server or a proxy).
   */
  endpoint: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("fixed") }),
    z.strictObject({
      kind: z.literal("choice"),
      options: z.array(z.strictObject({ id: providerIdSchema, label: safeTextSchema(80), url: httpsUrlSchema }))
        .min(1)
        .max(RUNTIME_AUTH_PROVIDER_ENDPOINT_CHOICE_LIMIT),
    }),
    z.strictObject({ kind: z.literal("custom"), placeholder: safeTextSchema(200).optional() }),
  ]),
  /** The provider brings no model list of its own, so the person names the model. */
  needsModelIds: z.boolean(),
  /**
   * A per-provider runtime's ways to sign this provider in, in its own
   * words; absent for Qwen Code. `configured` then says a sign-in is stored.
   * `subscription` is absent when the runtime does not say (OpenCode).
   */
  signIn: z.strictObject({
    oauth: z.strictObject({
      label: safeTextSchema(80),
      subscription: z.boolean().optional(),
      flow: z.enum(RUNTIME_AUTH_PROVIDER_OAUTH_FLOWS),
    }).optional(),
    /**
     * Every OAuth sign-in the provider offers, for a runtime whose login
     * start names the one chosen (`runtimeAuthChoosesOAuthMethod`, OpenCode),
     * device-code methods first; `oauth` is then absent.
     */
    oauthMethods: z.array(z.strictObject({
      label: runtimeAuthOAuthMethodLabelSchema,
      flow: z.enum(RUNTIME_AUTH_PROVIDER_OAUTH_FLOWS),
    })).min(1).max(RUNTIME_AUTH_PROVIDER_OAUTH_METHOD_LIMIT).optional(),
    apiKey: z.strictObject({
      label: safeTextSchema(80),
      entry: z.enum(RUNTIME_AUTH_PROVIDER_KEY_ENTRIES),
    }).optional(),
    /** How the stored sign-in authenticates, when `configured`. */
    stored: z.enum(["oauth", "api_key"]).optional(),
  }).optional(),
}));
export type RuntimeAuthProvider = z.infer<typeof runtimeAuthProviderSchema>;

/**
 * Why a provider list or connect did not complete. `rejected`: the runtime
 * refused the request (a key in the wrong shape, a missing field).
 * `timed_out`: it did not answer within its bound; a connect may or may not
 * have saved. `process_failed`: it could not start or stopped.
 * `invalid_response`: it answered in a shape Raft does not read.
 * `relay_failed` (connect only, set by the server, never by a Computer): the
 * server replica holding the Computer's socket could not open the sealed
 * connect another replica sent it, so nothing reached the Computer.
 */
export const RUNTIME_AUTH_PROVIDER_FAILURE_REASONS = ["rejected", "timed_out", "process_failed", "invalid_response", "relay_failed"] as const;
export type RuntimeAuthProviderFailureReason = (typeof RUNTIME_AUTH_PROVIDER_FAILURE_REASONS)[number];

/** How many providers one list may carry (Qwen 0.26 ships 15, pi 1.5 lists 43). */
export const RUNTIME_AUTH_PROVIDER_LIST_LIMIT = 128;

export const runtimeAuthProvidersResultSchema = lazySchema("runtimeAuthProvidersResultSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("listed"), providers: z.array(runtimeAuthProviderSchema).max(RUNTIME_AUTH_PROVIDER_LIST_LIMIT) }),
  z.strictObject({ kind: z.literal("failed"), reason: z.enum(RUNTIME_AUTH_PROVIDER_FAILURE_REASONS) }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.enum(RUNTIME_AUTH_UNSUPPORTED_REASONS) }),
]));
export type RuntimeAuthProvidersResult = z.infer<typeof runtimeAuthProvidersResultSchema>;

/**
 * A connect's outcome. `connected` means the runtime wrote its settings, not
 * that the provider accepts the key: Qwen checks it when an agent runs.
 * `busy`: another connect for this runtime is running on the Computer.
 */
export const runtimeAuthProviderConnectResultSchema = lazySchema("runtimeAuthProviderConnectResultSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("connected") }),
  z.strictObject({ kind: z.literal("failed"), reason: z.enum(RUNTIME_AUTH_PROVIDER_FAILURE_REASONS) }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.enum(RUNTIME_AUTH_UNSUPPORTED_REASONS) }),
  z.strictObject({ kind: z.literal("busy") }),
]));
export type RuntimeAuthProviderConnectResult = z.infer<typeof runtimeAuthProviderConnectResultSchema>;

/**
 * What a provider connect carries from the web to the Computer. `apiKey` is
 * the secret: it is sent once, to that Computer, and never stored, logged or
 * traced on the way (docs/contracts/runtime-auth.md §2).
 */
export interface RuntimeAuthProviderConnectInput {
  providerId: string;
  apiKey: string;
  /** The endpoint the person chose or typed; absent for a provider with a fixed one. */
  baseUrl?: string;
  /** The model the person named, for a provider with no model list of its own. */
  modelIds?: string[];
}

/**
 * The providers whose base URL the person types (Qwen's custom provider: a
 * local server or a proxy). Only these may take a plain-http URL; every
 * other endpoint is https, from the runtime's own menu. Plain http to a
 * remote host would carry the key unencrypted: an accepted risk for a local
 * server (docs/contracts/runtime-auth.md §6a).
 */
export const RUNTIME_AUTH_TYPED_ENDPOINT_PROVIDER_IDS: readonly string[] = ["custom-openai-compatible"];

/** The field a connect's input failed on. Never the value. */
export type RuntimeAuthProviderConnectField = "providerId" | "apiKey" | "baseUrl" | "modelIds";

export const RUNTIME_AUTH_PROVIDER_API_KEY_MAX_LENGTH = 4096;
const BASE_URL_MAX_LENGTH = 2048;
const MODEL_ID_MAX_LENGTH = 200;
const MODEL_IDS_LIMIT = 16;

/**
 * Checks a connect's input field by field, by hand rather than with a schema,
 * so no parser's error can ever quote the key. Both the server (the request
 * body) and the daemon (the message) take a connect through it.
 *
 * - `apiKey`: trimmed; one token with no whitespace or control character.
 * - `baseUrl`: an https URL with no user name or password in it; plain http
 *   only for a provider whose URL the person types
 *   (`RUNTIME_AUTH_TYPED_ENDPOINT_PROVIDER_IDS`).
 * - `modelIds`: 1 to 16 names with no whitespace.
 */
export function parseRuntimeAuthProviderConnectInput(value: unknown):
  | { ok: true; input: RuntimeAuthProviderConnectInput }
  | { ok: false; field: RuntimeAuthProviderConnectField } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (!isRuntimeAuthProviderId(body.providerId)) return { ok: false, field: "providerId" };
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey || apiKey.length > RUNTIME_AUTH_PROVIDER_API_KEY_MAX_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(apiKey)) {
    return { ok: false, field: "apiKey" };
  }
  const input: RuntimeAuthProviderConnectInput = { providerId: body.providerId, apiKey };
  if (body.baseUrl !== undefined) {
    if (!isProviderBaseUrl(body.baseUrl, RUNTIME_AUTH_TYPED_ENDPOINT_PROVIDER_IDS.includes(body.providerId))) return { ok: false, field: "baseUrl" };
    input.baseUrl = body.baseUrl;
  }
  if (body.modelIds !== undefined) {
    const ids = body.modelIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MODEL_IDS_LIMIT
      || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= MODEL_ID_MAX_LENGTH && !/[\s\u0000-\u001f\u007f]/u.test(id))) {
      return { ok: false, field: "modelIds" };
    }
    input.modelIds = ids as string[];
  }
  return { ok: true, input };
}

/**
 * Whether an API key may be saved in Pi's `auth.json`. Pi reads a stored key
 * that starts with `!` as a shell command and runs it, and fills in `$NAME`
 * / `${NAME}` from the environment, on every read by every Pi process of
 * that account, in Raft or not; a key that is neither is literal. Pi also
 * sends it in an HTTP header, so every character must be one byte (Latin-1),
 * as the Pi driver requires (`assertProviderApiKeyIsHeaderSafe`). Checked on
 * the server (400 `invalid_api_key`) and again on the daemon, on top of
 * `parseRuntimeAuthProviderConnectInput` (one token, no whitespace).
 */
export function isPiLiteralApiKey(apiKey: string): boolean {
  if (apiKey.startsWith("!") || apiKey.includes("$")) return false;
  for (let index = 0; index < apiKey.length; index += 1) {
    if (apiKey.charCodeAt(index) > 0xff) return false;
  }
  return true;
}

/**
 * Whether an API key may be saved in OpenCode's sign-ins. OpenCode sends it
 * in an HTTP header, so every character must be one byte (Latin-1), as for
 * Pi. OpenCode fills in `{env:NAME}` and `{file:path}` in its configuration
 * text; a stored credential is not configuration, but a key that reads as
 * one of those references is refused anyway, so a pasted reference is never
 * saved for something to resolve later. Checked on the server (400
 * `invalid_api_key`) and again on the daemon.
 */
export function isOpencodeLiteralApiKey(apiKey: string): boolean {
  if (/\{(?:env|file):/iu.test(apiKey)) return false;
  for (let index = 0; index < apiKey.length; index += 1) {
    if (apiKey.charCodeAt(index) > 0xff) return false;
  }
  return true;
}

/**
 * The key-content rule of a per-provider runtime (`isPiLiteralApiKey`,
 * `isOpencodeLiteralApiKey`); any key fits a runtime with none (Qwen Code's
 * own connect redacts and stores it as given).
 */
export function runtimeAuthLiteralApiKeyFits(runtime: RuntimeAuthRuntime, apiKey: string): boolean {
  switch (runtime) {
    case "pi": return isPiLiteralApiKey(apiKey);
    case "opencode": return isOpencodeLiteralApiKey(apiKey);
    default: return true;
  }
}

/**
 * A connect's input for this runtime, past the shape check every runtime's
 * goes through: a per-provider runtime (Pi, OpenCode) takes a provider and a
 * key only (no endpoint, no model), and only a key it keeps literal
 * (`runtimeAuthLiteralApiKeyFits`). The field a refusal names is the only
 * thing said about it.
 */
export function runtimeAuthProviderConnectFits(runtime: RuntimeAuthRuntime, input: RuntimeAuthProviderConnectInput):
  | { ok: true }
  | { ok: false; field: RuntimeAuthProviderConnectField } {
  if (!runtimeAuthSignsInPerProvider(runtime)) return { ok: true };
  if (input.baseUrl !== undefined) return { ok: false, field: "baseUrl" };
  if (input.modelIds !== undefined) return { ok: false, field: "modelIds" };
  return runtimeAuthLiteralApiKeyFits(runtime, input.apiKey) ? { ok: true } : { ok: false, field: "apiKey" };
}

function isProviderBaseUrl(value: unknown, httpAllowed: boolean): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > BASE_URL_MAX_LENGTH || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (httpAllowed && url.protocol === "http:")) && !url.username && !url.password;
  } catch {
    return false;
  }
}
