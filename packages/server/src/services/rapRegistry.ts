/**
 * RAP — Local Raft APP registry (task #140).
 *
 * Contract: attachment `2168f101` (§1 identity, §2 Q1/Q3, §3 surface). Criteria:
 * #138 red-criteria v16. Both are frozen elsewhere; this file implements, it does
 * not restate them.
 *
 * ⚠️ THIS FILE CONTAINS NO APP NAMES, and must not gain any. The manifest is the
 * single OS-layer file permitted to name an app (#137's sole exemption), so a
 * name appearing here is new named coupling and the APP-name ratchet will go red.
 * If something here seems to need a name, that is a finding about the contract,
 * not a reason to add one -- criteria X4.
 *
 * What is NOT here yet, stated so nothing reads as done: persistence. Every
 * function below is pure or operates on a caller-held store, so installs do not
 * survive a restart. Durable storage is the next slice; #138's items 1/5/6 cannot
 * be run against this file alone.
 */

/**
 * Dotted, lowercase, allocated at registration -- e.g. `x.alpha`.
 *
 * The example is synthetic on purpose. Writing a real app's id here would put an
 * APP name in an OS-layer file, which #137's ratchet counts and reds on. It did:
 * the first version of this line used one, and the gate caught it on this file's
 * first run. Kept as a note because "just a comment" is precisely the case where
 * the exemption feels harmless.
 */
export type AppId = string & { readonly __brand: "AppId" };

/** `app@<app_id>` — minted by the registry, never by an app (§1 A2). */
export type AppPrincipal = string & { readonly __brand: "AppPrincipal" };

/**
 * The closed set of declarable RAP hooks -- task #237.
 *
 * ⚠️ THIS ARRAY IS THE SOLE HAND-WRITTEN SOURCE. `HookName` is derived from it,
 * so adding or removing a hook is ONE edit that moves the type and the runtime
 * acceptance set together.
 *
 * It used to be a hand-written union PLUS a hand-written array stating the same
 * fact -- the identical shape task #141-A collapsed on the syscall axis, and the
 * one @Huaihuai's mutations kept exploiting on the hook axis in task #151: two
 * closed sets agree exactly until someone edits one of them, and a tooth that
 * compares their current values cannot tell a derivation from a restatement.
 *
 * ⛔ Direction is frozen (@XX): `HOOKS` is the source, `HookName` derives from
 * it, and `REGISTERABLE_HOOKS` is a subset checked against `HookName`. It must
 * not be wired backwards -- deriving `HOOKS` from the union would put the
 * hand-written fact back in the type and reopen the drift.
 */
export const HOOKS = [
  "onInstall", "onEnable", "onDisable", "onUninstall", "onDue", "onThresholdCrossed",
] as const;
export type HookName = (typeof HOOKS)[number];

/**
 * The closed set of RAP syscalls -- §3, task #141.
 *
 * ⚠️ THIS ARRAY IS THE SOLE SOURCE. `SyscallName` is derived from it, so adding
 * or removing a name is ONE edit that moves the type and the runtime acceptance
 * set together. It used to be a hand-written union plus a hand-written array:
 * two closed sets stating the same fact, which agree right up until someone
 * edits one of them. That is the identical defect @Huaihuai's mutations kept
 * proving on the hook axis in task #151, one layer up -- @XX's ruling on this
 * card was to collapse the pair rather than add a tooth to watch both.
 *
 * `readOwnState`/`writeOwnState` were removed here: they were declarable in a
 * manifest but had NO implementation anywhere in the tree, i.e. declarable but
 * uncallable. A manifest that may declare a name the OS cannot honour promises
 * a capability that silently never arrives. Task #227 may reintroduce them --
 * WITH an execution surface, not before it.
 *
 * ⛔ Removing a name is a breaking manifest change by construction: an existing
 * manifest declaring it now fails closed at `parseManifest` with
 * `syscall_unknown`. That is the intended loud failure, not a regression.
 */
export const SYSCALLS = ["notify", "schedule", "cancel", "resolveConversation"] as const;
export type SyscallName = (typeof SYSCALLS)[number];

export type AppConfigField =
  | {
      readonly type: "boolean";
      readonly default: boolean;
    }
  | {
      readonly type: "integer";
      readonly default: number;
      readonly minimum: number;
      readonly maximum: number;
    };

export type AppConfigSchema = Readonly<Record<string, AppConfigField>>;
export type AppConfigPublicField =
  | { readonly type: "boolean" }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number };


export interface AppManifest {
  readonly appId: AppId;
  readonly hooks: readonly HookName[];
  readonly syscalls: readonly SyscallName[];
  readonly notificationClasses: readonly string[];
  readonly config: AppConfigSchema;
}

export type ManifestParse =
  | { kind: "parsed"; manifest: AppManifest }
  | { kind: "rejected"; reason: ManifestRejection; detail: string };

export type ManifestRejection =
  | "app_id_missing"
  | "app_id_malformed"
  | "hook_unknown"
  | "syscall_unknown"
  | "notification_class_malformed"
  | "config_schema_invalid"
  | "not_an_object";

/**
 * A dotted, lowercase identifier: segments of [a-z][a-z0-9]* joined by '.'.
 *
 * Deliberately narrow. The id is used as a principal component and as a
 * ratchet/exemption path fragment, and a value that is a literal in one consumer
 * but a pattern in another is how an exemption silently widens -- the same defect
 * the APP-name ratchet's own root validation exists to prevent.
 */
const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export function isAppId(value: unknown): value is AppId {
  return typeof value === "string" && APP_ID_RE.test(value);
}

/**
 * §1 A2. The ONLY way an `app@` principal is produced. An app cannot mint its
 * own: it never sees this function, and the value is derived from the registered
 * id rather than from anything the app supplies.
 */
export function mintAppPrincipal(appId: AppId): AppPrincipal {
  return `app@${appId}` as AppPrincipal;
}

export function parseAppPrincipal(handle: string): AppId | null {
  if (!handle.startsWith("app@")) return null;
  const rest = handle.slice("app@".length);
  return isAppId(rest) ? rest : null;
}

/**
 * Parse a manifest. FAIL-CLOSED on anything undeclared or unrecognised (§2 Q3):
 * an unknown hook or syscall is a rejection, never a silently dropped field.
 *
 * "First-party" is deliberately not a parameter. Exemption is scoped to the
 * declared manifest, not to who wrote it -- if first-party became ambient
 * authority here, the boundary would have to be invented from scratch when
 * third-party apps arrive, and by then the built-ins would depend on not having
 * one.
 */
export function parseManifest(raw: unknown): ManifestParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "rejected", reason: "not_an_object", detail: typeof raw };
  }
  const obj = raw as Record<string, unknown>;

  if (!("app_id" in obj)) {
    return { kind: "rejected", reason: "app_id_missing", detail: "no app_id key" };
  }
  if (!isAppId(obj.app_id)) {
    return { kind: "rejected", reason: "app_id_malformed", detail: String(obj.app_id) };
  }
  const appId = obj.app_id;

  const hooks: HookName[] = [];
  for (const h of toArray(obj.hooks)) {
    if (!HOOKS.includes(h as HookName)) {
      return { kind: "rejected", reason: "hook_unknown", detail: String(h) };
    }
    if (!hooks.includes(h as HookName)) hooks.push(h as HookName);
  }

  const syscalls: SyscallName[] = [];
  for (const s of toArray(obj.syscalls)) {
    if (!SYSCALLS.includes(s as SyscallName)) {
      return { kind: "rejected", reason: "syscall_unknown", detail: String(s) };
    }
    if (!syscalls.includes(s as SyscallName)) syscalls.push(s as SyscallName);
  }

  const notificationClasses: string[] = [];
  for (const c of toArray(obj.notifications)) {
    // Notification classes are dotted namespaces (for example x.event), with
    // underscore-bearing segments also permitted. Keep the grammar literal:
    // whitespace, empty segments, path separators, and glob characters would
    // make a declaration mean different things in different consumers.
    if (typeof c !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(c)) {
      return { kind: "rejected", reason: "notification_class_malformed", detail: String(c) };
    }
    if (!notificationClasses.includes(c)) notificationClasses.push(c);
  }

  const config = parseConfigSchema(obj.config);
  if (config.kind === "rejected") return config;

  return {
    kind: "parsed",
    manifest: { appId, hooks, syscalls, notificationClasses, config: config.schema },
  };
}

function parseConfigSchema(value: unknown):
  | { kind: "parsed"; schema: AppConfigSchema }
  | { kind: "rejected"; reason: "config_schema_invalid"; detail: string } {
  // Legacy/test manifests that predate config remain equivalent to an explicitly
  // empty declaration. Production built-ins are separately ratcheted to declare
  // `config: {}` on every entry, so omission cannot silently reach production.
  if (value === undefined) return { kind: "parsed", schema: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "rejected", reason: "config_schema_invalid", detail: "config must be an object" };
  }

  const schema: Record<string, AppConfigField> = {};
  for (const [key, rawField] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      return { kind: "rejected", reason: "config_schema_invalid", detail: `invalid key: ${key}` };
    }
    if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) {
      return { kind: "rejected", reason: "config_schema_invalid", detail: `${key} must be an object` };
    }
    const field = rawField as Record<string, unknown>;
    if (field.type === "boolean") {
      if (Object.keys(field).some((candidate) => candidate !== "type" && candidate !== "default")) {
        return { kind: "rejected", reason: "config_schema_invalid", detail: `${key} has unknown declaration fields` };
      }
      if (typeof field.default !== "boolean") {
        return { kind: "rejected", reason: "config_schema_invalid", detail: `${key}.default must be boolean` };
      }
      schema[key] = { type: "boolean", default: field.default };
      continue;
    }
    if (field.type === "integer") {
      if (Object.keys(field).some((candidate) => !["type", "default", "minimum", "maximum"].includes(candidate))) {
        return { kind: "rejected", reason: "config_schema_invalid", detail: `${key} has unknown declaration fields` };
      }
      if (
        !Number.isSafeInteger(field.default)
        || !Number.isSafeInteger(field.minimum)
        || !Number.isSafeInteger(field.maximum)
        || (field.minimum as number) > (field.maximum as number)
        || (field.default as number) < (field.minimum as number)
        || (field.default as number) > (field.maximum as number)
      ) {
        return { kind: "rejected", reason: "config_schema_invalid", detail: `${key} integer declaration is invalid` };
      }
      schema[key] = {
        type: "integer",
        default: field.default as number,
        minimum: field.minimum as number,
        maximum: field.maximum as number,
      };
      continue;
    }
    return { kind: "rejected", reason: "config_schema_invalid", detail: `${key}.type is unsupported` };
  }
  return { kind: "parsed", schema };
}

/**
 * ⚠️ This folds "key absent" and "key present but null" into the same empty
 * array. That is the shape behind an org-level finding (absence collapsed into
 * non-existence, 4 cases across 3 subsystems), so the judgement below is scoped
 * deliberately rather than left implicit:
 *
 *   judged harmless at the THREE call sites above (hooks / syscalls /
 *   notifications) and nowhere else, because for those three an absent key and
 *   an explicit null grant exactly the same thing -- nothing -- so no
 *   behaviour-changing information is lost by folding them.
 *
 * ⇒ A NEW call site must make that judgement again. If a field ever exists
 * where "absent" and "explicitly null" mean different things, this helper will
 * silently erase the difference. The reasoning does not travel with the
 * function; it belongs to those three uses.
 */
function toArray(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Is this syscall permitted for this app? The manifest is the whole answer
 * (§2 Q3): undeclared fails closed regardless of who the app is.
 */
export function manifestPermitsSyscall(manifest: AppManifest, syscall: SyscallName): boolean {
  return manifest.syscalls.includes(syscall);
}

/** Same, for hooks the OS may call back into. */
export function manifestDeclaresHook(manifest: AppManifest, hook: HookName): boolean {
  return manifest.hooks.includes(hook);
}
