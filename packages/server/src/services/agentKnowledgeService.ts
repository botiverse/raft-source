import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MANUAL_INDEX_COMMAND,
  validateKnowledgeContext,
  type KnowledgeContextValidationResult,
} from "@botiverse/raft-shared";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agentKnowledgeEvents, agents } from "../db/schema.js";

export const AGENT_KNOWLEDGE_STATUSES = ["success", "not_found", "denied", "error"] as const;
export type AgentKnowledgeStatus = (typeof AGENT_KNOWLEDGE_STATUSES)[number];

export const AGENT_KNOWLEDGE_SOURCES = ["cli"] as const;
export type AgentKnowledgeSource = (typeof AGENT_KNOWLEDGE_SOURCES)[number];

export const AGENT_KNOWLEDGE_DOC_STATES = ["draft", "published", "deprecated", "retired"] as const;
export type AgentKnowledgeDocState = (typeof AGENT_KNOWLEDGE_DOC_STATES)[number];

export const AGENT_KNOWLEDGE_OPERATIONS = ["get", "search"] as const;
export type AgentKnowledgeOperation = (typeof AGENT_KNOWLEDGE_OPERATIONS)[number];

export const AGENT_KNOWLEDGE_RESOLUTIONS = [
  "exact_id",
  "alias",
  "token_route",
  "lexical",
  "concept_expansion",
  "typo_correction",
  "mixed",
  "language_gate",
] as const;
export type AgentKnowledgeResolution = (typeof AGENT_KNOWLEDGE_RESOLUTIONS)[number];

export interface AgentKnowledgeDoc {
  docId: string;
  topicOrPath: string;
  docVersion: string;
  docState: AgentKnowledgeDocState;
  content: string;
  contentType: KnowledgeContentType;
}

export interface AgentKnowledgeSearchResult {
  slug: string;
  title: string;
  firstScreen: string;
  docVersion: string;
  docState: AgentKnowledgeDocState;
  /**
   * Why this result matched: the query terms that hit, and for typo-corrected
   * terms the doc token they were matched against. An agent reading results
   * can then judge relevance itself instead of inferring it from rank order.
   */
  matchedTerms: string[];
  correctedTerms: Array<{ term: string; matched: string }>;
}

export type AgentKnowledgeSearchScope = "recipes";

interface KnowledgeRegistryEntry {
  docId: string;
  aliases: readonly string[];
  docState: AgentKnowledgeDocState;
  contentType: KnowledgeContentType;
  sourcePath: string;
}

type KnowledgeContentType = "text/markdown" | "text/markdown";

export interface RecordAgentKnowledgeEventArgs {
  serverId: string;
  agentId: string;
  computerId?: string | null;
  docId?: string | null;
  topicOrPath: string;
  docVersion?: string | null;
  docState?: AgentKnowledgeDocState | null;
  source: AgentKnowledgeSource;
  status: AgentKnowledgeStatus;
  requestedAt?: Date;
  latencyMs?: number | null;
  responseBytes?: number | null;
  /**
   * Caller-provided semantic turn join key. The server stores it as opaque text
   * and does not infer, validate, or backfill semantic stability.
   */
  turnId?: string | null;
  /**
   * Caller-provided request/trace join key for debugging request paths. This is
   * opaque text and may differ from turnId across retries or split requests.
   */
  traceId?: string | null;
  intent?: string | null;
  reason?: string | null;
  contextContractVersion?: string | null;
  /**
   * The Manual operation is emitted by the authenticated route, never accepted
   * from the caller. Null is reserved for legacy rows.
   */
  operation?: AgentKnowledgeOperation | null;
  /**
   * Retrieval branch that produced the event. Most values describe successful
   * retrieval; `language_gate` labels the deliberate non-English search reject
   * without changing the legacy `not_found` status contract. Null is reserved
   * for legacy rows and ordinary miss/denied/error events.
   */
  resolution?: AgentKnowledgeResolution | null;
}

export interface AgentKnowledgeNotFoundGuidance {
  indexTopic: string;
  suggestedTopicIds: string[];
  suggestedNextAction: string;
  error: string;
}

const MAX_TOPIC_LENGTH = 200;
const MAX_CORRELATION_LENGTH = 200;
const MAX_SEARCH_RESULTS = 3;
const FIRST_SCREEN_MAX_CHARS = 700;
const MIN_SEARCH_SCORE = 70;
/** Shortest query term eligible for edit-distance-1 matching. */
const MIN_FUZZY_TERM_LENGTH = 5;
/**
 * A typo match is worth less than an exact match ON THE SAME FIELD, but a
 * typo'd doc-id/title hit is still stronger evidence than one stray exact
 * content token — so the discount is per field rather than one flat number.
 * A content-only typo match stays deliberately under MIN_SEARCH_SCORE: it is
 * too weak to carry a single-term query on its own.
 */
const FUZZY_FIELD_SCORES = { docId: 80, title: 75, alias: 45, content: 25 } as const;
const MIN_MULTI_TERM_COVERAGE = 0.5;
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "before",
  "but",
  "can",
  "do",
  "does",
  "for",
  "from",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "need",
  "needs",
  "new",
  "of",
  "on",
  "or",
  "please",
  "should",
  "that",
  "the",
  "this",
  "to",
  "up",
  "want",
  "we",
  "what",
  "when",
  "where",
  "with",
  "work",
  "working",
]);

const SEARCH_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  demo: ["preview"],
  morning: ["reminder"],
  next: ["reminder"],
  tomorrow: ["reminder"],
  wake: ["reminder"],
  week: ["reminder"],
  weekly: ["reminder"],
};

const SEARCH_SYNONYM_REPLACEMENTS = new Set([
  "morning",
  "next",
  "tomorrow",
  "wake",
  "week",
  "weekly",
]);

const LOW_SIGNAL_SEARCH_TERMS = new Set([
  "agent",
  "deploy",
  "human",
  "onboard",
  "production",
  "task",
]);


const SEARCH_STEM_OVERRIDES: Readonly<Record<string, string>> = {
  approval: "approve",
  approved: "approve",
  approves: "approve",
  morning: "morning",
  production: "production",
  running: "run",
  sent: "send",
};

const AGENT_KNOWLEDGE_SOURCE_PATHS = [
  "manual/agent-knowledge/index.md",
  "manual/agent-knowledge/account.md",
  "manual/agent-knowledge/action-cards.md",
  "manual/agent-knowledge/agent-access-boundaries.md",
  "manual/agent-knowledge/agent-draft-human-commit.md",
  "manual/agent-knowledge/agent-profile.md",
  "manual/agent-knowledge/agent-status.md",
  "manual/agent-knowledge/agent.md",
  "manual/agent-knowledge/app.md",
  "manual/agent-knowledge/attachment.md",
  "manual/agent-knowledge/channel.md",
  "manual/agent-knowledge/common-worked-patterns.md",
  "manual/agent-knowledge/computer.md",
  "manual/agent-knowledge/dm.md",
  "manual/agent-knowledge/external-agent.md",
  "manual/agent-knowledge/getting-started.md",
  "manual/agent-knowledge/inbox.md",
  "manual/agent-knowledge/integration.md",
  "manual/agent-knowledge/joint-channel.md",
  "manual/agent-knowledge/membership.md",
  "manual/agent-knowledge/mention.md",
  "manual/agent-knowledge/message.md",
  "manual/agent-knowledge/metric-safe-vocabulary.md",
  "manual/agent-knowledge/mobile-vs-desktop.md",
  "manual/agent-knowledge/notifications.md",
  "manual/agent-knowledge/permission-matrix.md",
  "manual/agent-knowledge/pricing-safe-answer.md",
  "manual/agent-knowledge/reminder.md",
  "manual/agent-knowledge/runtime.md",
  "manual/agent-knowledge/saved-messages.md",
  "manual/agent-knowledge/scopes-and-permissions.md",
  "manual/agent-knowledge/search.md",
  "manual/agent-knowledge/server-management.md",
  "manual/agent-knowledge/server-role.md",
  "manual/agent-knowledge/server.md",
  "manual/agent-knowledge/raft-cli-overview.md",
  "manual/agent-knowledge/rename-slock-to-raft.md",
  "manual/agent-knowledge/structural-enforcement.md",
  "manual/agent-knowledge/task.md",
  "manual/agent-knowledge/terminology-canon.md",
  "manual/agent-knowledge/thread.md",
  "manual/agent-knowledge/ui-surface-map.md",
  "manual/agent-knowledge/user-profile.md",
  "manual/agent-knowledge/voice-and-tone.md",
  "manual/agent-knowledge/what-slock-doesnt-have.md",
] as const;

const RECIPE_SOURCE_PATHS = [
  "manual/recipes/index.md",
  "manual/recipes/seeded.md",
  "manual/recipes/archetype/analyst.md",
  "manual/recipes/archetype/designer.md",
  "manual/recipes/archetype/operator.md",
  "manual/recipes/archetype/pa-coordinator.md",
  "manual/recipes/archetype/patrol.md",
  "manual/recipes/archetype/verify-gate.md",
  "manual/recipes/archetype/writer.md",
  "manual/recipes/decision/lane-design.md",
  "manual/recipes/decision/one-or-many.md",
  "manual/recipes/decision/stake-strictness.md",
  "manual/recipes/decision/when-to-ask-human.md",
  "manual/recipes/pattern/coordinator-synthesis.md",
  "manual/recipes/pattern/discuss-then-assign.md",
  "manual/recipes/pattern/evidence-handoff.md",
  "manual/recipes/pattern/gate-chain.md",
  "manual/recipes/pattern/interview-fanout.md",
  "manual/recipes/pattern/recurring-recovery.md",
  "manual/recipes/pattern/shard-and-merge.md",
  "manual/recipes/pattern/video-review-loop.md",
  "manual/recipes/playbook/billing-strictness.md",
  "manual/recipes/playbook/content-pipeline.md",
  "manual/recipes/technique/acceptance-surface.md",
  "manual/recipes/technique/attachment-comments.md",
  "manual/recipes/technique/group-chat-debug.md",
  "manual/recipes/technique/html-artifact-discussion.md",
  "manual/recipes/technique/login-with-raft.md",
  "manual/recipes/technique/memory-hygiene.md",
  "manual/recipes/technique/preview-env.md",
  "manual/recipes/technique/proof-of-work-receipts.md",
  "manual/recipes/technique/reminder-cron.md",
  "manual/recipes/technique/sent-zero.md",
  "manual/recipes/technique/task-claim-lock.md",
  "manual/recipes/technique/video-review.md",
] as const;

const LEGACY_AGENT_KNOWLEDGE_GROUP_BY_DOC_ID: Readonly<Record<string, string>> = {
  account: "participants",
  "action-cards": "coordination",
  "agent-access-boundaries": "participants",
  "agent-draft-human-commit": "cross-cutting",
  "agent-profile": "participants",
  "agent-status": "participants",
  agent: "participants",
  app: "coordination",
  attachment: "conversations",
  channel: "conversations",
  "common-worked-patterns": "cross-cutting",
  computer: "agent-substrate",
  dm: "conversations",
  "external-agent": "agent-substrate",
  inbox: "coordination",
  integration: "coordination",
  "joint-channel": "conversations",
  membership: "workspace",
  mention: "conversations",
  message: "conversations",
  "metric-safe-vocabulary": "cross-cutting",
  "mobile-vs-desktop": "cross-cutting",
  notifications: "coordination",
  "permission-matrix": "cross-cutting",
  "pricing-safe-answer": "cross-cutting",
  reminder: "coordination",
  runtime: "agent-substrate",
  "saved-messages": "conversations",
  "scopes-and-permissions": "participants",
  search: "conversations",
  "server-management": "workspace",
  "server-role": "workspace",
  server: "workspace",
  "raft-cli-overview": "cross-cutting",
  "rename-slock-to-raft": "cross-cutting",
  task: "coordination",
  "terminology-canon": "cross-cutting",
  thread: "conversations",
  "ui-surface-map": "cross-cutting",
  "user-profile": "participants",
  "voice-and-tone": "cross-cutting",
  "what-slock-doesnt-have": "cross-cutting",
};

const EXTRA_AGENT_KNOWLEDGE_ALIASES_BY_DOC_ID: Readonly<Record<string, readonly string[]>> = {
  index: ["list", "topics", "overview"],
  // New-agent orientation (first-boot / first-join / introduce). Aliases are only the
  // behavior-matched real asks from meichen's owner-lane readout 2026-07-23; human agent
  // creation/provisioning stays on `agent` and device setup stays on `computer` (no-shadow).
  "getting-started": [
    // "all-gree system greeting" intentionally NOT aliased here: the persistent
    // opener/all-gree loop recovery is still deferred (byte-verify pending), so
    // routing it to this topic would mask an unresolved need as a hit.
    "first boot greeting startup",
    "first boot greeting introduce welcome",
    // Exact real miss query (meichen owner-lane row 2026-07-21#381, "Respond correctly
    // after being added to a channel" / first-join greeting): the agent's literal
    // `manual get` topic. `manual get` does an exact normalized-alias match, so the
    // OR-form must be present verbatim for this row to convert not_found -> hit.
    "first boot OR greeting OR introduced OR welcome",
    "new agent greeting",
    "agent added welcome introduce",
    "onboarding new agent",
  ],
  channel: ["channels"],
  agent: ["agents", "agent-create", "agent-creation", "agent:create", "creating agents"],
  thread: ["threads", "thread-visibility"],
  runtime: [
    "runtimes",
    "runtime-profile",
    "agent-runtime",
    "runtime-config",
    "claude-md",
    "claude.md",
    "project-instructions",
    // Skill-discovery misses (meichen's reason-request digest 2026-08-31): the exact
    // observed shapes, verbatim — asks to the Manual about a specific runtime-side skill
    // by name. runtime.md's "Skills and slash commands" section is the correct landing
    // for any by-name skill ask (skills live runtime-side; the Manual cannot document them
    // individually). Deliberately NOT aliasing "skill"/"skills": not observed shapes, and
    // unobserved neighbors must stay visible in telemetry.
    "ponytail",
    "ponytail skill",
  ],
  "server-role": ["role", "roles", "admin"],
  "scopes-and-permissions": ["permissions", "permission"],
  computer: ["daemon", "onboarding", "setup", "machine", "machines", "computers"],
  "external-agent": ["external-agents", "external agent", "hermes", "device-code-login", "agent-login", "agent-bridge"],
  "joint-channel": ["joint-channels", "joint channel", "joint channels", "联合频道"],
  integration: ["integrations", "connected-apps", "connected-app", "connected apps", "login-with-raft", "app-login", "integration-login", "apps", "app"],
  "action-cards": ["actions", "action", "action-card", "action_prepare", "action-prepare", "action prepare"],
  task: ["tasks"],
  // Plural-form miss on the canonical scheduling page (meichen's reason-request
  // digest 2026-09-09): two natural rows, two Agents, two servers, `topic_or_path`
  // byte-identical and verbatim `reminders` — lowercase ASCII, no separators. The
  // shape is the observed one, not inferred from the singular page name, and
  // `manual search "reminders"` already ranks this page first, so only exact `get`
  // was missing. Deliberately NOT aliasing "reminding"/"schedule"/"schedules":
  // unobserved neighbors must stay visible in telemetry.
  reminder: ["reminders"],
  message: ["messaging", "messages"],
  mention: [
    "mentions",
    "channel-delivery",
    "pending mention",
    "mention pending",
    "undelivered mention",
    "mention recovery",
    "resolve mention",
    "reply mention",
    "mention pending resolve undelivered",
    "undelivered mention pending resolve",
  ],
  inbox: ["inbox notice", "agent-inbox"],
  // Human-invite discovery (meichen's reason-request digest 2026-08-29, task #126): the six
  // exact observed miss shapes from one agent's guessing loop, verbatim — no expansion or
  // imagined synonyms. "add member" is globally ambiguous (channel add-member vs server
  // invite) but membership.md disambiguates both senses in-text and routes channel
  // membership to the channel commands, so either intent lands correctly.
  membership: [
    "invite",
    "invite link",
    "invite human",
    "add member",
    "member invite",
    "human invite",
  ],
  "raft-cli-overview": [
    "slock-cli-overview",
    "slock cli overview",
    "slock manual get slock-cli-overview",
    "agent-knowledge/slock-cli-overview",
    "manual/agent-knowledge/slock-cli-overview",
    "docs/agent-knowledge/slock-cli-overview",
    "cross-cutting/slock-cli-overview",
    "agent-knowledge/cross-cutting/slock-cli-overview",
    "manual/agent-knowledge/cross-cutting/slock-cli-overview",
    "docs/agent-knowledge/cross-cutting/slock-cli-overview",
  ],
  "rename-slock-to-raft": [
    "slock to raft",
    "rename slock to raft",
    "raft rename",
    "raft formerly slock",
    "legacy slock references",
    "slock compatibility name",
    "raft command name",
    "slock command alias",
  ],
  "agent-status": [
    "agent not replying",
    "agent online but not replying",
    "agent stuck",
    "runtime stalled",
    "migration pending",
    "activity log",
    "agent-session",
    "session",
    "sessions",
    "agent-lifecycle",
    "lifecycle",
  ],
  "agent-access-boundaries": [
    "agent permissions",
    "what can the agent access",
    "can agent access github",
    "can agent read my files",
    "can agent run commands",
    "agent capabilities",
    "agent-browser",
  ],
  "pricing-safe-answer": [
    "pricing",
    "billing",
    "is this free",
    "how much does it cost",
    "refund",
    "quota",
  ],
};

// Agents commonly drop the `recipes/` prefix and query the bare `<class>/<slug>` form
// (observed miss recurring cross-agent/server in Manual telemetry, now across multiple
// classes: `decision/*` and `technique/*`). Rather than a per-recipe allowlist, add the
// stripped-prefix alias for every recipe whose class is on this whitelist.
//
// This is shadow-safe by construction: the bare `<class>/<slug>` alias is only ever
// generated for recipe cards that ACTUALLY EXIST under `manual/recipes/<class>/<slug>.md`.
// A bare query only resolves if a real recipe file backs it — a non-recipe topic sharing
// the `<class>/<slug>` shape gets no alias and still returns not_found. This is NOT a
// runtime "on-miss retry" that could catch arbitrary strings; it is a precomputed alias
// bound to real files, so it cannot shadow non-recipe topics.
const RECIPE_STRIPPED_PREFIX_WHITELIST_CLASSES: ReadonlySet<string> = new Set([
  "decision",
  "technique",
  "pattern",
  "playbook",
  "archetype",
]);

// A recipe `<relativePath>` (e.g. `decision/one-or-many`) gets the bare stripped-prefix
// alias iff its leading path segment is a whitelisted recipe class.
function recipeClassIsStrippedPrefixWhitelisted(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0] ?? "";
  return RECIPE_STRIPPED_PREFIX_WHITELIST_CLASSES.has(firstSegment);
}

const KNOWLEDGE_REGISTRY: readonly KnowledgeRegistryEntry[] = [
  {
    docId: "slock-home",
    // Legacy aliases kept: agents learned the RFC-era paths before the topic moved into the manual.
    aliases: ["slock-home", "raft-home", "rfcs/020-slock-home", "daemon/slock-home", "docs/daemon/slock-home"],
    docState: "published",
    contentType: "text/markdown",
    sourcePath: "manual/agent-knowledge/slock-home.md",
  },
  ...AGENT_KNOWLEDGE_SOURCE_PATHS.map(buildAgentKnowledgeRegistryEntry),
  ...RECIPE_SOURCE_PATHS.map(buildRecipeRegistryEntry),
];

export function normalizeKnowledgeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const topic = raw.trim();
  if (!topic || topic.length > MAX_TOPIC_LENGTH) return null;
  return topic;
}

export function normalizeKnowledgeSearchScope(raw: unknown): AgentKnowledgeSearchScope | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const scope = raw.trim().toLowerCase();
  if (!scope) return null;
  return scope === "recipes" ? "recipes" : undefined;
}

export function normalizeOptionalKnowledgeField(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_CORRELATION_LENGTH) return null;
  return value;
}

export function validateKnowledgeIntent(raw: unknown): KnowledgeContextValidationResult {
  return validateKnowledgeContext(raw, "intent");
}

export function validateKnowledgeReason(raw: unknown): KnowledgeContextValidationResult {
  return validateKnowledgeContext(raw, "reason");
}

export async function resolveAgentKnowledgeDoc(topicOrPath: string): Promise<AgentKnowledgeDoc | null> {
  const normalized = normalizeKnowledgeLookupTopic(topicOrPath);
  const entry = KNOWLEDGE_REGISTRY.find((candidate) =>
    candidate.aliases.some((alias) => alias.toLowerCase() === normalized)
  );
  if (!entry) return null;

  const content = await readKnowledgeContent(entry);
  const digest = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  return {
    docId: entry.docId,
    topicOrPath,
    docVersion: `sha256:${digest}`,
    docState: entry.docState,
    content,
    contentType: entry.contentType,
  };
}

/**
 * Bounded discovery-layer token routes, applied only after an exact alias
 * miss. Each rule fires on a COMPLETE token of the query (never a substring,
 * so `skillful` does not match) and routes to one canonical doc that answers
 * the whole ask class. Keep this table small and single-semantic: a token
 * belongs here only when every reasonable ask containing it has the same
 * correct landing page. Design ruling: #proj-docs thread 843fddc1 (Cindy
 * approved 2026-09-01); supersedes the earlier generic-skill no-shadow
 * contract from PR #7151.
 */
const KNOWLEDGE_TOKEN_ROUTES: ReadonlyArray<{ tokens: readonly string[]; docId: string }> = [
  { tokens: ["skill", "skills"], docId: "runtime" },
];

export type AgentKnowledgeGetResolution = "exact_id" | "alias" | "token_route";

export interface AgentKnowledgeDiscoveryResolution {
  doc: AgentKnowledgeDoc;
  resolution: AgentKnowledgeGetResolution;
}

function tokenizeTopicForRouting(topicOrPath: string): Set<string> {
  // Deliberately NOT tokenizeSearchText: no stemming, no stop words, no
  // minimum length. The router contract is complete-token membership on the
  // caller's literal query, so `skills` must not stem into `skill` and
  // `skillful` must not match anything.
  return new Set(topicOrPath.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * Exact resolution first; token routes only on exact miss, so an exact alias
 * always wins over a route (priority is part of the reviewed contract).
 */
export async function resolveAgentKnowledgeDocWithDiscovery(
  topicOrPath: string,
): Promise<AgentKnowledgeDiscoveryResolution | null> {
  const exact = await resolveAgentKnowledgeDoc(topicOrPath);
  if (exact) {
    const resolution = normalizeKnowledgeLookupTopic(topicOrPath) === exact.docId.toLowerCase()
      ? "exact_id"
      : "alias";
    return { doc: exact, resolution };
  }
  const topicTokens = tokenizeTopicForRouting(topicOrPath);
  for (const route of KNOWLEDGE_TOKEN_ROUTES) {
    if (route.tokens.some((token) => topicTokens.has(token))) {
      const doc = await resolveAgentKnowledgeDoc(route.docId);
      if (doc) return { doc: { ...doc, topicOrPath }, resolution: "token_route" };
    }
  }
  return null;
}

export async function searchAgentKnowledgeDocs(
  query: string,
  scope: AgentKnowledgeSearchScope | null = null,
): Promise<AgentKnowledgeSearchResult[]> {
  return (await searchAgentKnowledgeDocsWithResolution(query, scope)).results;
}

export interface AgentKnowledgeSearchOutcome {
  results: AgentKnowledgeSearchResult[];
  resolution: Extract<AgentKnowledgeResolution, "lexical" | "concept_expansion" | "typo_correction" | "mixed"> | null;
}

export async function searchAgentKnowledgeDocsWithResolution(
  query: string,
  scope: AgentKnowledgeSearchScope | null = null,
): Promise<AgentKnowledgeSearchOutcome> {
  const normalizedQuery = normalizeKnowledgeLookupTopic(query);
  const queryTerms = tokenizeSearchText(normalizedQuery);
  const rawTerms = rawSearchTokens(normalizedQuery);
  const entries = KNOWLEDGE_REGISTRY.filter((entry) =>
    !scope || entry.sourcePath.startsWith(`manual/${scope}/`)
  );
  const scored = [];

  // One pass to learn what words the corpus actually contains, so typo
  // candidacy can be judged corpus-wide instead of per-document. Contents are
  // read once and reused by the scoring pass below.
  const contents = new Map<string, string>();
  const corpusVocabulary = new Set<string>();
  for (const entry of entries) {
    const content = await readKnowledgeContent(entry);
    contents.set(entry.docId, content);
    for (const token of tokenizeKnowledgeTextParts(normalizeKnowledgeLookupTopic(content))) {
      corpusVocabulary.add(token);
    }
    for (const alias of entry.aliases) {
      for (const token of tokenizeKnowledgeTextParts(normalizeKnowledgeLookupTopic(alias))) {
        corpusVocabulary.add(token);
      }
    }
  }

  for (const entry of entries) {
    const content = contents.get(entry.docId) ?? await readKnowledgeContent(entry);
    const digest = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
    const title = extractKnowledgeTitle(content) ?? entry.docId;
    const firstScreen = extractFirstScreen(content);
    const scoringInput = {
      entry,
      title,
      content,
      normalizedQuery,
      queryTerms,
      rawTerms,
      corpusVocabulary,
    };
    const detailed = scoreKnowledgeEntryDetailed(scoringInput);
    const score = scoreKnowledgeEntry(scoringInput);
    if (score <= 0) continue;
    scored.push({
      slug: entry.docId,
      title,
      firstScreen,
      docVersion: `sha256:${digest}`,
      docState: entry.docState,
      matchedTerms: [...detailed.matchedTerms].sort(),
      correctedTerms: [...detailed.fuzzyTerms.entries()]
        .map(([term, matched]) => ({ term, matched }))
        .sort((a, b) => a.term.localeCompare(b.term)),
      resolution: classifySearchRetrievalPath({
        normalizedQuery,
        matchedTerms: detailed.matchedTerms,
        fuzzyTerms: detailed.fuzzyTerms,
        hasExactMatch: detailed.hasExactMatch,
      }),
      score,
    });
  }

  const ranked = scored
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, MAX_SEARCH_RESULTS);
  return {
    results: ranked.map(({ score: _score, resolution: _resolution, ...result }) => result),
    resolution: ranked[0]?.resolution ?? null,
  };
}

export function buildAgentKnowledgeIndexCommand(contextRequired = true): string {
  return contextRequired ? MANUAL_INDEX_COMMAND : "raft manual get index";
}

// Derive plain-text search keywords from a missed topic/path so the "try search"
// suggestion is copy-runnable. Every non-alphanumeric char (incl. `/ - . "`) collapses to
// a space, so the result is safe to wrap in double quotes in both POSIX and PowerShell.
function deriveManualSearchKeywords(topicOrPath: string): string {
  const keywords = topicOrPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return keywords.length > 0 ? keywords : "the workflow I need";
}

// When `get` misses, an exact-id retry is not always the answer — the agent may not know the
// id. Offer a copy-runnable `search` (discovery) command alongside the index browse. `search`
// also requires --intent/--reason, so the capable form carries executable examples; the
// legacy form omits them (old CLIs reject unknown flags).
export function buildAgentKnowledgeSearchCommand(topicOrPath: string, contextRequired = true): string {
  const keywords = deriveManualSearchKeywords(topicOrPath);
  return contextRequired
    ? `raft manual search "${keywords}" --intent "Find the Raft workflow I need" --reason "An exact topic id did not resolve"`
    : `raft manual search "${keywords}"`;
}

export interface AgentKnowledgeMissCandidate {
  slug: string;
  title: string;
  matchedTerms: string[];
}

/**
 * Relaxed-floor candidate discovery for not_found guidance. Requires at least
 * one matched term (so junk queries honestly return nothing) but skips the
 * ranked-search relevance floor — see scoreKnowledgeEntryDetailed for why.
 */
export async function findKnowledgeMissCandidates(
  topicOrPath: string,
  limit = 3,
): Promise<AgentKnowledgeMissCandidate[]> {
  const normalizedQuery = normalizeKnowledgeLookupTopic(topicOrPath);
  const queryTerms = tokenizeSearchText(normalizedQuery);
  if (queryTerms.length === 0) return [];
  const scored: Array<AgentKnowledgeMissCandidate & { score: number }> = [];
  for (const entry of KNOWLEDGE_REGISTRY) {
    const content = await readKnowledgeContent(entry);
    const title = extractKnowledgeTitle(content) ?? entry.docId;
    const detailed = scoreKnowledgeEntryDetailed({
      entry,
      title,
      content,
      normalizedQuery,
      queryTerms,
    });
    if (detailed.score <= 0 || detailed.matchedTerms.size === 0) continue;
    scored.push({
      slug: entry.docId,
      title,
      matchedTerms: [...detailed.matchedTerms].sort(),
      score: detailed.score,
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit)
    .map(({ score: _score, ...candidate }) => candidate);
}

export interface AgentKnowledgeNotFoundGuidanceWithCandidates extends AgentKnowledgeNotFoundGuidance {
  candidates: AgentKnowledgeMissCandidate[];
}

/**
 * not_found guidance plus inline closest-match candidates, so an agent gets
 * usable pointers in one round trip instead of being told to run a second
 * search command. The candidates are labeled suggestions: the response is
 * still a not_found and is still recorded as a miss in telemetry.
 */
export async function buildAgentKnowledgeNotFoundGuidanceWithCandidates(
  topicOrPath: string,
  contextRequired = true,
): Promise<AgentKnowledgeNotFoundGuidanceWithCandidates> {
  const base = buildAgentKnowledgeNotFoundGuidance(topicOrPath, contextRequired);
  const candidates = await findKnowledgeMissCandidates(topicOrPath);
  if (candidates.length === 0) return { ...base, candidates };
  const candidateLines = candidates
    .map((candidate, i) => `${i + 1}. ${candidate.slug} — "${candidate.title}" (matched: ${candidate.matchedTerms.join(", ")})`)
    .join("\n");
  const candidateBlock = `Closest matches by content:\n${candidateLines}`;
  const suggestedNextAction = `${candidateBlock}\n${base.suggestedNextAction}`;
  return {
    ...base,
    candidates,
    suggestedNextAction,
    error: `Manual topic not found. ${suggestedNextAction}`,
  };
}

export function buildAgentKnowledgeNotFoundGuidance(
  topicOrPath: string,
  contextRequired = true,
): AgentKnowledgeNotFoundGuidance {
  const suggestedTopicIds = suggestAgentKnowledgeTopicIds(topicOrPath, 5);
  const suggestionText = suggestedTopicIds.length > 0
    ? ` Available topics include: ${suggestedTopicIds.join(", ")}.`
    : "";
  const retryContext = contextRequired ? ", keeping your --intent/--reason" : "";
  const suggestedNextAction = `No topic matched. Retry with a close topic id${retryContext}. `
    + `If you do not know the exact id, search for it:\n${buildAgentKnowledgeSearchCommand(topicOrPath, contextRequired)}\n`
    + `Or browse all topics:\n${buildAgentKnowledgeIndexCommand(contextRequired)}`
    + suggestionText;
  return {
    indexTopic: "index",
    suggestedTopicIds,
    suggestedNextAction,
    error: `Manual topic not found. ${suggestedNextAction}`,
  };
}

/**
 * Scripts that make a query unmistakably non-English.
 *
 * The Manual corpus is English. Rather than translate queries into it, search
 * tells the caller to ask in English — but only when it can say so honestly.
 * Latin-script languages (French, Spanish, ...) are NOT detectable this way and
 * are deliberately not guessed at: a wrong guess would reject valid English
 * queries, which is worse than answering one in French.
 */
const NON_LATIN_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Greek}]/u;

/**
 * True when a query is written in a non-English script AND leaves nothing the
 * English index could match.
 *
 * Both halves matter. A mixed query like "如何 create channel" still carries
 * usable English terms, so it searches normally instead of being rejected for
 * the characters around them.
 */
export function manualQueryNeedsEnglish(query: string): boolean {
  const normalized = normalizeKnowledgeLookupTopic(query);
  if (!NON_LATIN_SCRIPT.test(normalized)) return false;
  return tokenizeSearchText(normalized).length === 0;
}


/**
 * Raw query tokens, pre-stemming and pre-synonym. Typo candidacy is judged on
 * what the caller actually typed: correcting a STEMMED token invents words the
 * user never wrote (holdout evidence: `retention` -> stem `retent` -> "corrected"
 * to `recent`, which changes the concept rather than fixing a slip).
 */
function rawSearchTokens(input: string): string[] {
  return [...new Set(
    input
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !SEARCH_STOP_WORDS.has(part)),
  )];
}

function tokenizeSearchText(input: string): string[] {
  const terms = input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !SEARCH_STOP_WORDS.has(part))
    .flatMap((part) => {
      const stemmed = stemSearchTerm(part);
      const synonyms = SEARCH_SYNONYMS[stemmed] ?? [];
      return SEARCH_SYNONYM_REPLACEMENTS.has(stemmed) ? [...synonyms] : [stemmed, ...synonyms];
    });
  return [...new Set(terms)];
}

function classifySearchRetrievalPath(input: {
  normalizedQuery: string;
  matchedTerms: ReadonlySet<string>;
  fuzzyTerms: ReadonlyMap<string, string>;
  hasExactMatch: boolean;
}): Extract<AgentKnowledgeResolution, "lexical" | "concept_expansion" | "typo_correction" | "mixed"> {
  const lexicalTerms = new Set<string>();
  const expansionTerms = new Set<string>();
  for (const rawTerm of rawSearchTokens(input.normalizedQuery)) {
    const stemmed = stemSearchTerm(rawTerm);
    const synonyms = SEARCH_SYNONYMS[stemmed] ?? [];
    if (!SEARCH_SYNONYM_REPLACEMENTS.has(stemmed)) lexicalTerms.add(stemmed);
    for (const synonym of synonyms) expansionTerms.add(synonym);
  }

  const fuzzyQueryTerms = new Set(
    [...input.fuzzyTerms.keys()].map((term) => stemSearchTerm(term)),
  );
  const hasTypo = input.fuzzyTerms.size > 0;
  const hasExpansion = [...input.matchedTerms].some((term) => expansionTerms.has(term));
  const hasLexical = input.hasExactMatch || [...input.matchedTerms].some(
    (term) => lexicalTerms.has(term) && !fuzzyQueryTerms.has(term),
  );

  const mechanisms = [hasLexical, hasExpansion, hasTypo].filter(Boolean).length;
  if (mechanisms > 1) return "mixed";
  if (hasTypo) return "typo_correction";
  if (hasExpansion) return "concept_expansion";
  return "lexical";
}

function stemSearchTerm(term: string): string {
  const override = SEARCH_STEM_OVERRIDES[term];
  if (override) return override;
  if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("ed")) return term.slice(0, -2);
  if (term.length > 4 && term.endsWith("ion")) return term.slice(0, -3);
  if (term.length > 3 && term.endsWith("s")) return term.slice(0, -1);
  return term;
}

function tokenizeKnowledgeText(input: string): Set<string> {
  return new Set(tokenizeKnowledgeTextParts(input));
}

function tokenizeKnowledgeTextParts(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .map(stemSearchTerm);
}

/**
 * True when `a` and `b` differ by at most one insertion, deletion, or
 * substitution. Bounded and allocation-free: used per (query term x doc token),
 * so it must stay O(len) with an early exit rather than a full DP matrix.
 */
function isWithinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;
  const lenDiff = a.length - b.length;
  if (lenDiff > 1 || lenDiff < -1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edited = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (edited) return false;
    edited = true;
    if (shorter.length === longer.length) i += 1;
    j += 1;
  }
  return true;
}

/**
 * Typo tolerance for a single query term, scoped deliberately narrow:
 * only terms of MIN_FUZZY_TERM_LENGTH or more are eligible (so `dm` and `ws`
 * cannot fuzz into unrelated tokens), and only when the term has no exact
 * match anywhere in the entry. Returns the doc token it matched, for the
 * caller to report as a match reason.
 */
function findFuzzyTokenMatch(term: string, tokens: Iterable<string>): string | null {
  if (term.length < MIN_FUZZY_TERM_LENGTH) return null;
  for (const token of tokens) {
    if (token.length < MIN_FUZZY_TERM_LENGTH) continue;
    if (isWithinEditDistanceOne(term, token)) return token;
  }
  return null;
}

function orderedCoverage(haystack: string[], needles: string[]): number {
  if (needles.length === 0) return 0;
  let cursor = 0;
  for (const token of haystack) {
    if (token === needles[cursor]) cursor += 1;
    if (cursor >= needles.length) return cursor / needles.length;
  }
  return cursor / needles.length;
}

function scoreKnowledgeEntry(input: {
  entry: KnowledgeRegistryEntry;
  title: string;
  content: string;
  normalizedQuery: string;
  queryTerms: string[];
}): number {
  const detailed = scoreKnowledgeEntryDetailed(input);
  if (!detailed.hasExactMatch && !passesSearchRelevanceFloor({
    score: detailed.score,
    queryTerms: input.queryTerms,
    matchedTerms: detailed.matchedTerms,
  })) {
    return 0;
  }
  return detailed.score;
}

/**
 * Floor-free scoring core, exposing which terms matched and which were
 * typo-corrected. `scoreKnowledgeEntry` (ranked search results) applies the
 * relevance floor on top. Two callers read this directly: match-reason
 * reporting, and miss-candidate discovery — the latter because its results are
 * labeled suggestions inside a not_found payload, never served as the answer,
 * so weak matches are acceptable there.
 */
function scoreKnowledgeEntryDetailed(input: {
  entry: KnowledgeRegistryEntry;
  title: string;
  content: string;
  normalizedQuery: string;
  queryTerms: string[];
  rawTerms?: string[];
  corpusVocabulary?: ReadonlySet<string>;
}): {
  score: number;
  matchedTerms: Set<string>;
  hasExactMatch: boolean;
  fuzzyTerms: Map<string, string>;
} {
  const { entry, title, content, normalizedQuery, queryTerms } = input;
  const rawTerms = input.rawTerms ?? queryTerms;
  const corpusVocabulary = input.corpusVocabulary;
  const normalizedTitle = normalizeKnowledgeLookupTopic(title);
  const normalizedAliases = entry.aliases.map(normalizeKnowledgeLookupTopic);
  const normalizedContent = normalizeKnowledgeLookupTopic(content);
  const aliasText = normalizedAliases.join(" ");
  const docIdTokens = tokenizeKnowledgeText(entry.docId);
  const titleTokens = tokenizeKnowledgeText(normalizedTitle);
  const aliasTokens = tokenizeKnowledgeText(aliasText);
  const contentTokenParts = tokenizeKnowledgeTextParts(normalizedContent);
  const contentTokens = new Set(contentTokenParts);
  const matchedTerms = new Set<string>();
  const fuzzyTerms = new Map<string, string>();
  let score = 0;

  // An exact hit on an alias, the doc id, or the title identifies the doc on its own.
  // The relevance floor below counts matched *tokens*, and tokenizeSearchText is
  // ASCII-only (`[^a-z0-9]+`, min length 3) — so a CJK, emoji, or <=2-char query
  // tokenizes to nothing, matches no terms, and the floor discards these scores.
  // Track exact hits so the floor cannot veto them; non-exact queries stay gated.
  const exactAliasMatch = normalizedAliases.includes(normalizedQuery);
  const exactDocIdMatch = entry.docId.toLowerCase() === normalizedQuery;
  const exactTitleMatch = normalizedTitle === normalizedQuery;
  const hasExactMatch = exactAliasMatch || exactDocIdMatch || exactTitleMatch;

  if (exactAliasMatch) score += 1000;
  if (exactDocIdMatch) score += 800;
  if (exactTitleMatch) score += 700;
  if (normalizedTitle.includes(normalizedQuery)) score += 240;
  if (normalizedContent.includes(normalizedQuery)) score += 90;

  for (const alias of normalizedAliases) {
    if (alias.includes(normalizedQuery) || normalizedQuery.includes(alias)) {
      score += 220;
    }
  }

  for (const term of queryTerms) {
    let termMatched = false;
    if (docIdTokens.has(term)) {
      score += 120;
      termMatched = true;
    }
    if (titleTokens.has(term)) {
      score += term === "reminder" ? 160 : 90;
      termMatched = true;
    }
    if (aliasTokens.has(term)) {
      score += 70;
      termMatched = true;
    }
    if (contentTokens.has(term)) {
      score += 35;
      termMatched = true;
    }
    if (termMatched) {
      matchedTerms.add(term);
      continue;
    }
    // Nothing matched this term exactly anywhere in the entry — only now is a
    // typo the likely explanation, so try edit-distance-1 against the entry's
    // own tokens. Scored below every exact field hit.
    // Typo candidacy is a property of the QUERY against the whole corpus, not
    // of one document. A word the corpus knows (`stage`) is a real word the
    // caller meant; rewriting it per-document — just because THIS document
    // lacks it — manufactures matches in unrelated docs (holdout evidence:
    // `stage` -> `state`/`stale`). Only a token no document contains can be a
    // typo, and it is judged on the raw, unstemmed form.
    const rawTerm = rawTerms.find((raw) => raw === term || stemSearchTerm(raw) === term);
    if (!rawTerm) continue;
    if (corpusVocabulary && corpusVocabulary.has(rawTerm)) continue;
    const fuzzyFields: Array<[keyof typeof FUZZY_FIELD_SCORES, Iterable<string>]> = [
      ["docId", docIdTokens],
      ["title", titleTokens],
      ["alias", aliasTokens],
      ["content", contentTokens],
    ];
    for (const [field, tokens] of fuzzyFields) {
      const fuzzyToken = findFuzzyTokenMatch(rawTerm, tokens);
      if (!fuzzyToken) continue;
      score += FUZZY_FIELD_SCORES[field];
      matchedTerms.add(term);
      fuzzyTerms.set(rawTerm, fuzzyToken);
      break;
    }
  }

  if (queryTerms.length >= 2 && orderedCoverage(contentTokenParts, queryTerms) >= MIN_MULTI_TERM_COVERAGE) {
    score += 180;
  }
  if (queryTerms.length >= 2 && isRecipeAggregateSearchEntry(entry)) score = Math.floor(score * 0.2);

  return { score, matchedTerms, hasExactMatch, fuzzyTerms };
}

function isRecipeAggregateSearchEntry(entry: KnowledgeRegistryEntry): boolean {
  return entry.docId === "recipes/index" || entry.docId === "recipes/seeded";
}

function passesSearchRelevanceFloor(input: {
  score: number;
  queryTerms: string[];
  matchedTerms: Set<string>;
}): boolean {
  const { score, queryTerms, matchedTerms } = input;
  const minMatchedTerms = queryTerms.length >= 4 ? 3 : queryTerms.length >= 2 ? 2 : 1;
  if (matchedTerms.size < minMatchedTerms) return false;
  if (queryTerms.length >= 2 && [...matchedTerms].every((term) => LOW_SIGNAL_SEARCH_TERMS.has(term))) {
    return false;
  }
  if (score >= 240) return true;
  if (score < MIN_SEARCH_SCORE) return false;
  if (queryTerms.length <= 1) return matchedTerms.size > 0 && score >= MIN_SEARCH_SCORE;
  return matchedTerms.size >= 2 && matchedTerms.size / queryTerms.length >= MIN_MULTI_TERM_COVERAGE;
}

function extractKnowledgeTitle(content: string): string | null {
  const frontmatterTitle = content.match(/^---\n[\s\S]*?\ntitle:\s*(.+?)\n[\s\S]*?\n---/);
  if (frontmatterTitle?.[1]) return frontmatterTitle[1].trim().replace(/^["']|["']$/g, "");
  const headingTitle = content.match(/^#\s+(.+)$/m);
  return headingTitle?.[1]?.trim() ?? null;
}

function extractFirstScreen(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"));
  const excerpt = lines.join("\n").slice(0, FIRST_SCREEN_MAX_CHARS).trim();
  return excerpt.length === FIRST_SCREEN_MAX_CHARS
    ? `${excerpt.replace(/\s+\S*$/, "")}...`
    : excerpt;
}

function listAgentKnowledgeTopicIds(): string[] {
  return KNOWLEDGE_REGISTRY
    .filter((entry) => entry.sourcePath.startsWith("manual/agent-knowledge/"))
    .map((entry) => entry.docId)
    .sort((a, b) => a.localeCompare(b));
}

function normalizeKnowledgeLookupTopic(topicOrPath: string): string {
  return topicOrPath
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function suggestAgentKnowledgeTopicIds(topicOrPath: string, limit: number): string[] {
  const normalized = normalizeKnowledgeLookupTopic(topicOrPath);
  const topicIds = listAgentKnowledgeTopicIds();
  const preferred = ["index", "server", "agent-status", "raft-cli-overview", "task", "channel"];
  const normalizedParts = new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean));
  const scored = topicIds
    .map((docId) => {
      const idParts = docId.split(/[^a-z0-9]+/).filter(Boolean);
      let score = 0;
      if (docId === normalized) score += 100;
      if (docId.includes(normalized) || normalized.includes(docId)) score += 40;
      for (const part of idParts) {
        if (normalizedParts.has(part)) score += 10;
      }
      return { docId, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    .map((item) => item.docId);

  const suggestions = new Set<string>(scored);
  for (const docId of preferred) {
    if (topicIds.includes(docId)) suggestions.add(docId);
    if (suggestions.size >= limit) break;
  }
  return [...suggestions].slice(0, limit);
}

export async function recordAgentKnowledgeEvent(args: RecordAgentKnowledgeEventArgs): Promise<void> {
  const db = getDb();
  await db.insert(agentKnowledgeEvents).values({
    serverId: args.serverId,
    agentId: args.agentId,
    computerId: args.computerId ?? null,
    docId: args.docId ?? null,
    topicOrPath: args.topicOrPath,
    docVersion: args.docVersion ?? null,
    docState: args.docState ?? null,
    source: args.source,
    status: args.status,
    requestedAt: args.requestedAt ?? new Date(),
    latencyMs: args.latencyMs ?? null,
    responseBytes: args.responseBytes ?? null,
    turnId: args.turnId ?? null,
    traceId: args.traceId ?? null,
    intent: args.intent ?? null,
    reason: args.reason ?? null,
    contextContractVersion: args.contextContractVersion ?? null,
    operation: args.operation ?? null,
    resolution: args.resolution ?? null,
  });
}

export async function agentBelongsToServer(agentId: string, serverId: string): Promise<boolean> {
  const [agent] = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)));
  return Boolean(agent);
}

async function readKnowledgeContent(entry: KnowledgeRegistryEntry): Promise<string> {
  for (const root of knowledgeRootCandidates()) {
    try {
      const source = await readFile(path.join(root, entry.sourcePath), "utf8");
      return sanitizeAgentKnowledgeContent(source);
    } catch {
      // Try the next candidate; missing deployed docs should be visible as an error event.
    }
  }
  throw new Error(`Knowledge document not found in deploy artifact: ${entry.sourcePath}`);
}

export function sanitizeAgentKnowledgeContent(source: string): string {
  let output = "";
  let cursor = 0;
  let inFence = false;

  for (const match of source.matchAll(/^```/gm)) {
    const markerIndex = match.index ?? 0;
    const segment = source.slice(cursor, markerIndex);
    output += inFence ? segment : stripSourceOnlyComments(segment);
    output += match[0];
    cursor = markerIndex + match[0].length;
    inFence = !inFence;
  }

  const tail = source.slice(cursor);
  output += inFence ? tail : stripSourceOnlyComments(tail);
  return output;
}

function stripSourceOnlyComments(source: string): string {
  return source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function knowledgeRootCandidates(): string[] {
  const roots = [
    process.env.SLOCK_KNOWLEDGE_ROOT,
    process.cwd(),
    path.resolve(process.cwd(), "../.."),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(roots)];
}

function buildAgentKnowledgeRegistryEntry(sourcePath: string): KnowledgeRegistryEntry {
  const relativePath = sourcePath
    .replace(/^manual\/agent-knowledge\//, "")
    .replace(/\.md$/, "");
  const docId = relativePath === "index" ? "index" : relativePath.replace(/\//g, ".");
  return {
    docId,
    aliases: buildAgentKnowledgeAliases(docId, relativePath),
    docState: "published",
    contentType: "text/markdown",
    sourcePath,
  };
}

function buildAgentKnowledgeAliases(docId: string, relativePath: string): readonly string[] {
  const aliases = new Set<string>([
    docId,
    relativePath,
    `agent-knowledge/${relativePath}`,
    `manual/agent-knowledge/${relativePath}`,
    `docs/agent-knowledge/${relativePath}`,
  ]);
  for (const alias of EXTRA_AGENT_KNOWLEDGE_ALIASES_BY_DOC_ID[docId] ?? []) {
    aliases.add(alias);
  }
  const legacyGroup = LEGACY_AGENT_KNOWLEDGE_GROUP_BY_DOC_ID[docId];
  if (legacyGroup) {
    const legacyPath = `${legacyGroup}/${docId}`;
    aliases.add(legacyPath);
    aliases.add(`agent-knowledge/${legacyPath}`);
    aliases.add(`manual/agent-knowledge/${legacyPath}`);
    aliases.add(`docs/agent-knowledge/${legacyPath}`);
  }
  if (relativePath === "index") {
    aliases.add("agent-knowledge");
    aliases.add("manual/agent-knowledge");
    aliases.add("docs/agent-knowledge");
  }
  return [...aliases];
}

function buildRecipeRegistryEntry(sourcePath: string): KnowledgeRegistryEntry {
  const relativePath = sourcePath
    .replace(/^manual\/recipes\//, "")
    .replace(/\.md$/, "");
  const docId = `recipes/${relativePath}`;
  return {
    docId,
    aliases: buildRecipeAliases(relativePath),
    docState: "published",
    contentType: "text/markdown",
    sourcePath,
  };
}

function buildRecipeAliases(relativePath: string): readonly string[] {
  const aliases = new Set<string>([
    `recipes/${relativePath}`,
    `manual/recipes/${relativePath}`,
    `docs/recipes/${relativePath}`,
  ]);
  if (relativePath === "index") {
    aliases.add("recipes");
    aliases.add("manual/recipes");
    aliases.add("docs/recipes");
  }
  if (recipeClassIsStrippedPrefixWhitelisted(relativePath)) {
    aliases.add(relativePath);
  }
  return [...aliases];
}
