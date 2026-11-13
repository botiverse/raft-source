import { asServerId, type Brand, type ServerId } from "./src/brandedIds";
import { DISPLAY_LOCALES, type DisplayLocale } from "./src/displayLocales";

export type AnnouncementRecipientUserId = Brand<string, "AnnouncementRecipientUserId">;
export const ANNOUNCEMENT_CLIENT_PLATFORMS = ["android", "ios", "harmonyos"] as const;
export type AnnouncementClientPlatform = (typeof ANNOUNCEMENT_CLIENT_PLATFORMS)[number];
/**
 * One native App build range. A request matches when its User-Agent names this
 * platform and, for each constraint given, a build type in `buildTypes` and a
 * build number within `minBuild`..`maxBuild` (inclusive). A request that does
 * not state the constrained value (older App, web, desktop) does not match.
 */
export interface AnnouncementClientTarget {
  platform: AnnouncementClientPlatform;
  buildTypes?: string[];
  minBuild?: number;
  maxBuild?: number;
}
/** What the server read from the request's User-Agent; never the raw string. */
export interface AnnouncementClient {
  platform: AnnouncementClientPlatform;
  buildNumber?: number;
  buildType?: string;
}
/**
 * Where an announcement pops up. `desktop` = a computer browser or the desktop
 * app; `mobile` = the iOS / Android / HarmonyOS App or a phone or tablet
 * browser (cindyz, 2026-11-04, #wg-announcement). Absent = both, which is how
 * every announcement behaved before the choice existed; publishing a new one
 * requires it (feature-flag-admin publishDraft).
 */
export const ANNOUNCEMENT_DEVICES = ["desktop", "mobile"] as const;
export type AnnouncementDevice = (typeof ANNOUNCEMENT_DEVICES)[number];
/** Absent `clients` = every client. Present = only requests from a listed native App build. */
type ClientFilter = { devices?: AnnouncementDevice[]; clients?: AnnouncementClientTarget[]; rules?: AnnouncementAudienceRules };
export type AnnouncementAudience = ClientFilter & (
  | { type: "all" }
  | { type: "users"; userIds: AnnouncementRecipientUserId[] }
  | { type: "server_members"; serverIds: ServerId[] }
  | { type: "server_users"; targets: Array<{ serverId: ServerId; userIds: AnnouncementRecipientUserId[] }> }
);

export type AnnouncementDeliveryScope = { type: "account" } | { type: "server"; serverId: ServerId };
export interface AnnouncementAudienceSnapshot {
  audience: AnnouncementAudience;
  deliveryVersion: number;
  calculatedAt: string;
}

export const ANNOUNCEMENT_AUDIENCE_MAX_IDS = 10_000;
export const ANNOUNCEMENT_AUDIENCE_MAX_CLIENTS = 20;
const BUILD_TYPE = /^[a-z0-9_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("audience IDs must be UUIDs");
  return value.toLowerCase();
}

/** Mint only after validating the recipient identity at a DTO/fixture boundary. */
export function asAnnouncementRecipientUserId(value: string): AnnouncementRecipientUserId {
  return uuid(value) as AnnouncementRecipientUserId;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid announcement audience");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error("unknown announcement audience field");
  return input;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ANNOUNCEMENT_AUDIENCE_MAX_IDS) {
    throw new Error(`audience lists must contain 1-${ANNOUNCEMENT_AUDIENCE_MAX_IDS} IDs`);
  }
  return [...new Set(value.map(uuid))].sort();
}

function build(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

function clientTarget(value: unknown): AnnouncementClientTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid announcement client target");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["platform", "buildTypes", "minBuild", "maxBuild"].includes(key))) {
    throw new Error("unknown announcement client target field");
  }
  if (!ANNOUNCEMENT_CLIENT_PLATFORMS.includes(input.platform as AnnouncementClientPlatform)) {
    throw new Error(`client platform must be one of ${ANNOUNCEMENT_CLIENT_PLATFORMS.join(", ")}`);
  }
  // Key order is fixed so JSON comparisons of stored audiences stay stable.
  const target: AnnouncementClientTarget = { platform: input.platform as AnnouncementClientPlatform };
  if (input.buildTypes !== undefined) {
    if (!Array.isArray(input.buildTypes) || input.buildTypes.length === 0 || input.buildTypes.length > ANNOUNCEMENT_AUDIENCE_MAX_CLIENTS) {
      throw new Error(`client buildTypes must contain 1-${ANNOUNCEMENT_AUDIENCE_MAX_CLIENTS} build types`);
    }
    for (const buildType of input.buildTypes) {
      if (typeof buildType !== "string" || !BUILD_TYPE.test(buildType)) throw new Error("client build types must match [a-z0-9_-]{1,32}");
    }
    target.buildTypes = [...new Set(input.buildTypes as string[])].sort();
  }
  const minBuild = build(input.minBuild, "client minBuild");
  const maxBuild = build(input.maxBuild, "client maxBuild");
  if (minBuild !== undefined && maxBuild !== undefined && minBuild > maxBuild) throw new Error("client minBuild must not exceed maxBuild");
  if (minBuild !== undefined) target.minBuild = minBuild;
  if (maxBuild !== undefined) target.maxBuild = maxBuild;
  return target;
}

function clients(value: unknown): AnnouncementClientTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ANNOUNCEMENT_AUDIENCE_MAX_CLIENTS) {
    throw new Error(`audience clients must contain 1-${ANNOUNCEMENT_AUDIENCE_MAX_CLIENTS} targets`);
  }
  const byKey = new Map(value.map(clientTarget).map((target) => [JSON.stringify(target), target]));
  return [...byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, target]) => target);
}

function devices(value: unknown): AnnouncementDevice[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !ANNOUNCEMENT_DEVICES.includes(item as AnnouncementDevice))) {
    throw new Error(`audience devices must list 1-${ANNOUNCEMENT_DEVICES.length} of ${ANNOUNCEMENT_DEVICES.join(", ")}`);
  }
  return ANNOUNCEMENT_DEVICES.filter((item) => value.includes(item));
}

/** Syntax only. The publisher must separately resolve IDs and membership. */
export function validateAnnouncementAudience(value: unknown): AnnouncementAudience {
  const audience = validateAudienceType(value);
  const input = value as Record<string, unknown> | undefined;
  // Omitted keys stay omitted: stored audiences without them keep their exact JSON.
  const withDevices: AnnouncementAudience = input?.devices === undefined ? audience : { ...audience, devices: devices(input.devices) };
  const withClients: AnnouncementAudience = input?.clients === undefined ? withDevices : { ...withDevices, clients: clients(input.clients) };
  return input?.rules === undefined ? withClients : { ...withClients, rules: validateAnnouncementAudienceRules(input.rules) };
}

function validateAudienceType(value: unknown): AnnouncementAudience {
  if (value === undefined) return { type: "all" };
  const type = record(value, ["type", "userIds", "serverIds", "targets", "devices", "clients", "rules"]).type;
  switch (type) {
    case "all":
      record(value, ["type", "devices", "clients", "rules"]);
      return { type };
    case "users":
      return { type, userIds: ids(record(value, ["type", "userIds", "devices", "clients", "rules"]).userIds).map(asAnnouncementRecipientUserId) };
    case "server_members":
      return { type, serverIds: ids(record(value, ["type", "serverIds", "devices", "clients", "rules"]).serverIds).map(asServerId) };
    case "server_users": {
      const input = record(value, ["type", "targets", "devices", "clients", "rules"]);
      if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > ANNOUNCEMENT_AUDIENCE_MAX_IDS) {
        throw new Error("server_users requires bounded nonempty targets");
      }
      const targets = new Map<ServerId, Set<AnnouncementRecipientUserId>>();
      let count = 0;
      for (const target of input.targets) {
        const item = record(target, ["serverId", "userIds"]);
        const serverId = asServerId(uuid(item.serverId));
        const userIds = ids(item.userIds).map(asAnnouncementRecipientUserId);
        count += userIds.length;
        if (count > ANNOUNCEMENT_AUDIENCE_MAX_IDS) throw new Error("too many audience user IDs");
        const users = targets.get(serverId) ?? new Set<AnnouncementRecipientUserId>();
        userIds.forEach((id) => users.add(id));
        targets.set(serverId, users);
      }
      return { type, targets: [...targets].sort(([a], [b]) => a.localeCompare(b)).map(([serverId, users]) => ({ serverId, userIds: [...users].sort() })) };
    }
    default:
      throw new Error("unknown announcement audience type");
  }
}

/** The device class of a request platform; `null` (platform unknown) is neither. */
export function announcementDeviceOf(platform: AnnouncementRulePlatform | null): AnnouncementDevice | null {
  switch (platform) {
    case "web": case "desktop": return "desktop";
    case "mobile_web": case "ios": case "android": case "harmonyos": return "mobile";
    default: return null;
  }
}

/**
 * Absent = both. A request whose platform is unknown (an old client sending no
 * platform header and an unrecognised User-Agent) still sees it: hiding an
 * announcement from someone we cannot place is worse than showing it.
 */
export function matchesAnnouncementDevices(devices: AnnouncementDevice[] | undefined, platform: AnnouncementRulePlatform | null): boolean {
  if (!devices) return true;
  const device = announcementDeviceOf(platform);
  return device === null || devices.includes(device);
}

/** Mirrors the server's SQL client predicate (announcementService.audienceEligibility). */
export function matchesAnnouncementClient(targets: AnnouncementClientTarget[] | undefined, client: AnnouncementClient | null | undefined): boolean {
  if (!targets) return true;
  if (!client) return false;
  return targets.some((target) => target.platform === client.platform
    && (!target.buildTypes || (client.buildType !== undefined && target.buildTypes.includes(client.buildType)))
    && (target.minBuild === undefined || (client.buildNumber !== undefined && client.buildNumber >= target.minBuild))
    && (target.maxBuild === undefined || (client.buildNumber !== undefined && client.buildNumber <= target.maxBuild)));
}

/** Current membership is authoritative; a copied server ID never grants eligibility. */
export function matchesAnnouncementAudience(
  audience: AnnouncementAudience,
  userId: AnnouncementRecipientUserId,
  serverId: ServerId | null,
  isCurrentMember: boolean,
  client?: AnnouncementClient | null,
): boolean {
  if (!matchesAnnouncementClient(audience.clients, client)) return false;
  switch (audience.type) {
    case "all": return true;
    case "users": return audience.userIds.includes(userId);
    case "server_members": return serverId !== null && isCurrentMember && audience.serverIds.includes(serverId);
    case "server_users": return serverId !== null && isCurrentMember && audience.targets.some((target) => target.serverId === serverId && target.userIds.includes(userId));
  }
}

// ---------------------------------------------------------------------------
// Audience rules (task #31): conditions checked each time a user loads
// announcements, so people move in and out as their facts change. They narrow
// the base audience above; they never widen it.
//
// Two levels only: groups joined by one `match`, conditions inside a group
// joined by the group's `match`. Every condition may be negated. A condition
// whose fact is unknown for this request (no current Server for a Server
// condition, an unrecognised platform, no display language) is false whether
// or not it is negated, so "not admin" never matches someone outside a Server.

export const ANNOUNCEMENT_RULE_MAX_GROUPS = 5;
export const ANNOUNCEMENT_RULE_MAX_CONDITIONS = 15;
export const ANNOUNCEMENT_RULE_ROLES = ["owner", "admin", "member"] as const;
export const ANNOUNCEMENT_RULE_PLANS = ["free", "founder", "partner", "pro"] as const;
/** From `X-Raft-Client-Platform` (requestClientPlatform); `desktop` is the desktop app. */
export const ANNOUNCEMENT_RULE_PLATFORMS = ["web", "mobile_web", "desktop", "ios", "android", "harmonyos"] as const;
export const ANNOUNCEMENT_RULE_TIME_OPS = ["within_days", "older_than_days", "after", "before"] as const;
export const ANNOUNCEMENT_RULE_MAX_DAYS = 3650;

export type AnnouncementRuleRole = (typeof ANNOUNCEMENT_RULE_ROLES)[number];
export type AnnouncementRulePlan = (typeof ANNOUNCEMENT_RULE_PLANS)[number];
export type AnnouncementRulePlatform = (typeof ANNOUNCEMENT_RULE_PLATFORMS)[number];
export type AnnouncementRuleTimeOp = (typeof ANNOUNCEMENT_RULE_TIME_OPS)[number];
export type AnnouncementRuleMatch = "all" | "any";

type Negatable = { negate?: true };
/** `days` for within_days / older_than_days; `date` (YYYY-MM-DD, UTC midnight) for after / before. */
export type AnnouncementTimeCondition = Negatable & { field: "account_created" | "server_created"; op: AnnouncementRuleTimeOp; days?: number; date?: string };
export type AnnouncementCondition =
  | AnnouncementTimeCondition
  | (Negatable & { field: "server_role"; values: AnnouncementRuleRole[] })
  | (Negatable & { field: "server_plan"; values: AnnouncementRulePlan[] })
  /** On for this user in the current Server; negated = off. */
  | (Negatable & { field: "feature_flag"; key: string })
  | (Negatable & { field: "locale"; values: DisplayLocale[] })
  | (Negatable & { field: "platform"; values: AnnouncementRulePlatform[] });
export interface AnnouncementConditionGroup { match: AnnouncementRuleMatch; conditions: AnnouncementCondition[] }
export interface AnnouncementAudienceRules { match: AnnouncementRuleMatch; groups: AnnouncementConditionGroup[] }

/** The facts one request is judged on. `null` = unknown for this request. */
export interface AnnouncementRuleContext {
  now: Date;
  accountCreatedAt: Date;
  locale: DisplayLocale | null;
  platform: AnnouncementRulePlatform | null;
  /** The Server the user has open, with their non-Guest role there. */
  server: { createdAt: Date; plan: string; role: string } | null;
  /** Every key `announcementRuleFlagKeys` names, evaluated for this user and Server. */
  flags: ReadonlyMap<string, boolean>;
}

const FLAG_KEY = /^[a-z0-9_.-]{1,64}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60_000;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length) throw new Error(`${name} must list 1-${allowed.length} values`);
  for (const item of value) if (!allowed.includes(item as T)) throw new Error(`${name} must be among ${allowed.join(", ")}`);
  // Canonical order (the allowed order) keeps stored JSON comparisons stable.
  return allowed.filter((item) => value.includes(item));
}

function match(value: unknown, name: string): AnnouncementRuleMatch {
  if (value !== "all" && value !== "any") throw new Error(`${name} must be "all" or "any"`);
  return value;
}

function condition(value: unknown): AnnouncementCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid announcement condition");
  const input = value as Record<string, unknown>;
  if (input.negate !== undefined && input.negate !== true) throw new Error("condition negate must be true when present");
  const negate = input.negate === true ? { negate: true as const } : {};
  const keys = (allowed: string[]) => {
    if (Object.keys(input).some((key) => !["field", "negate", ...allowed].includes(key))) throw new Error(`unknown field in ${String(input.field)} condition`);
  };
  switch (input.field) {
    case "account_created":
    case "server_created": {
      keys(["op", "days", "date"]);
      const op = input.op as AnnouncementRuleTimeOp;
      if (!ANNOUNCEMENT_RULE_TIME_OPS.includes(op)) throw new Error(`time condition op must be one of ${ANNOUNCEMENT_RULE_TIME_OPS.join(", ")}`);
      if (op === "within_days" || op === "older_than_days") {
        if (input.date !== undefined) throw new Error(`${op} takes days, not date`);
        const days = input.days;
        if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > ANNOUNCEMENT_RULE_MAX_DAYS) throw new Error(`days must be an integer from 1 to ${ANNOUNCEMENT_RULE_MAX_DAYS}`);
        return { field: input.field, op, days, ...negate };
      }
      if (input.days !== undefined) throw new Error(`${op} takes date, not days`);
      const date = input.date;
      if (typeof date !== "string" || !DATE_ONLY.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new Error("date must be a calendar date YYYY-MM-DD");
      }
      return { field: input.field, op, date, ...negate };
    }
    case "server_role":
      keys(["values"]);
      return { field: "server_role", values: oneOf(input.values, ANNOUNCEMENT_RULE_ROLES, "server_role values"), ...negate };
    case "server_plan":
      keys(["values"]);
      return { field: "server_plan", values: oneOf(input.values, ANNOUNCEMENT_RULE_PLANS, "server_plan values"), ...negate };
    case "feature_flag":
      keys(["key"]);
      if (typeof input.key !== "string" || !FLAG_KEY.test(input.key)) throw new Error("feature_flag key must match [a-z0-9_.-]{1,64}");
      return { field: "feature_flag", key: input.key, ...negate };
    case "locale":
      keys(["values"]);
      return { field: "locale", values: oneOf(input.values, DISPLAY_LOCALES, "locale values"), ...negate };
    case "platform":
      keys(["values"]);
      return { field: "platform", values: oneOf(input.values, ANNOUNCEMENT_RULE_PLATFORMS, "platform values"), ...negate };
    default:
      throw new Error("unknown announcement condition field");
  }
}

/** Syntax and bounds only; a flag key that does not exist simply evaluates as off. */
export function validateAnnouncementAudienceRules(value: unknown): AnnouncementAudienceRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid announcement audience rules");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "match" && key !== "groups")) throw new Error("unknown announcement audience rules field");
  if (!Array.isArray(input.groups) || input.groups.length === 0 || input.groups.length > ANNOUNCEMENT_RULE_MAX_GROUPS) {
    throw new Error(`audience rules must contain 1-${ANNOUNCEMENT_RULE_MAX_GROUPS} groups`);
  }
  let total = 0;
  const groups = input.groups.map((group): AnnouncementConditionGroup => {
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("invalid announcement condition group");
    const item = group as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== "match" && key !== "conditions")) throw new Error("unknown announcement condition group field");
    if (!Array.isArray(item.conditions) || item.conditions.length === 0) throw new Error("every condition group needs at least one condition");
    total += item.conditions.length;
    if (total > ANNOUNCEMENT_RULE_MAX_CONDITIONS) throw new Error(`audience rules may contain at most ${ANNOUNCEMENT_RULE_MAX_CONDITIONS} conditions`);
    return { match: match(item.match, "group match"), conditions: item.conditions.map(condition) };
  });
  return { match: match(input.match, "rules match"), groups };
}

/** The flag keys a request must evaluate before `matchesAnnouncementRules`. */
export function announcementRuleFlagKeys(rules: AnnouncementAudienceRules | undefined): string[] {
  if (!rules) return [];
  return [...new Set(rules.groups.flatMap((group) => group.conditions.flatMap((item) => item.field === "feature_flag" ? [item.key] : [])))].sort();
}

function timeHolds(item: AnnouncementTimeCondition, at: Date, now: Date): boolean {
  switch (item.op) {
    case "within_days": return now.getTime() - at.getTime() <= item.days! * DAY_MS;
    case "older_than_days": return now.getTime() - at.getTime() > item.days! * DAY_MS;
    case "after": return at.getTime() >= Date.parse(`${item.date}T00:00:00Z`);
    case "before": return at.getTime() < Date.parse(`${item.date}T00:00:00Z`);
  }
}

/** true / false, or null when this request does not know the fact. */
function conditionHolds(item: AnnouncementCondition, ctx: AnnouncementRuleContext): boolean | null {
  switch (item.field) {
    case "account_created": return timeHolds(item, ctx.accountCreatedAt, ctx.now);
    case "server_created": return ctx.server ? timeHolds(item, ctx.server.createdAt, ctx.now) : null;
    case "server_role": return ctx.server ? (item.values as string[]).includes(ctx.server.role) : null;
    case "server_plan": return ctx.server ? (item.values as string[]).includes(ctx.server.plan) : null;
    case "feature_flag": return ctx.flags.get(item.key) ?? false;
    case "locale": return ctx.locale ? item.values.includes(ctx.locale) : null;
    case "platform": return ctx.platform ? item.values.includes(ctx.platform) : null;
  }
}

function conditionMatches(item: AnnouncementCondition, ctx: AnnouncementRuleContext): boolean {
  const holds = conditionHolds(item, ctx);
  if (holds === null) return false;
  return item.negate ? !holds : holds;
}

/** No rules = no narrowing. */
export function matchesAnnouncementRules(rules: AnnouncementAudienceRules | undefined, ctx: AnnouncementRuleContext): boolean {
  if (!rules) return true;
  const groupMatches = (group: AnnouncementConditionGroup) => group.match === "all"
    ? group.conditions.every((item) => conditionMatches(item, ctx))
    : group.conditions.some((item) => conditionMatches(item, ctx));
  return rules.match === "all" ? rules.groups.every(groupMatches) : rules.groups.some(groupMatches);
}
