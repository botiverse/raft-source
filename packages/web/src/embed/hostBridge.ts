/**
 * Host↔Web event bridge — web-side helpers.
 *
 * The bridge is installed at document-start by the native WebView host (Android
 * `WebViewCompat.addDocumentStartJavaScript`, iOS `WKUserScript` with
 * `injectionTime = .atDocumentStart`, OHOS equivalent). Web does NOT provide the
 * `emit` implementation — the host does. This module provides only the safe helper
 * that DETECTS the injected global and CALLS it.
 *
 * Design contract: `mobile/docs/host-web-event-bridge-2026-07-15.md` (approved by
 * @MingQi at exact `919c2cca…`, 2026-07-15).
 *
 * ── Why the wrapper exists ─────────────────────────────────────────────────────
 * Every session-mutating call site would otherwise have to do the "is the bridge
 * present" dance itself, and each would drift a little differently. The helper
 * makes the check happen in exactly one place. It also gives every emit a typed
 * `kind` so the compiler can catch a `session:logot` typo, which the raw injected
 * `emit(kind: string, payload?: object)` cannot.
 *
 * ── Orthogonal to layout embed ─────────────────────────────────────────────────
 * `hasRaftHostEventBridge()` is NOT a layout-embed check. Layout embedding is
 * governed by `embed=raft-settings-v1&shell=host` and `isHostShell()` in
 * `../embed.ts`. Do not use bridge availability to decide what to render.
 */

/** Every event `kind` this web version knows how to emit. */
export type HostEventKind =
  | "onboarding:completed"
  | "onboarding:server-switch-request"
  | "session:logout"
  | "session:server-deleted"
  | "session:server-left"
  | "session:server-switched"
  | "session:token-refresh-failed";

/** Per-kind payload shapes. `never` = no payload; empty `{}` is emitted. */
export interface HostEventPayloads {
  /**
   * A wake signal only. The host MUST re-read setup-projection and may release its
   * gate only when the current account/server generation reports blocksChat=false.
   */
  "onboarding:completed": {
    contractVersion: "raft-onboarding-v1";
    serverId: string;
    serverSlug: string;
    generation: string;
  };
  "onboarding:server-switch-request": {
    contractVersion: "raft-onboarding-v1";
    generation: string;
    sourceServerId: string;
    targetServerId: string;
  };
  "session:logout": Record<string, never>;
  "session:server-deleted": { serverSlug: string };
  "session:server-left": { serverSlug: string };
  "session:server-switched": { serverSlug: string };
  "session:token-refresh-failed": Record<string, never>;
}

/** The injected global. Frozen by the platform script; do NOT mutate. */
interface RaftHostGlobal {
  version: "raft-host-v1";
  emit: (kind: string, payload: object) => void;
  onboarding?: unknown;
}

const RAFT_HOST_VERSION = "raft-host-v1";
const ONBOARDING_CONTRACT_VERSION = "raft-onboarding-v1";
const HOST_CONTEXT_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RaftHostOnboardingContext {
  contractVersion: "raft-onboarding-v1";
  generation: string;
  sourceServerId: string;
}

function readGlobal(): RaftHostGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  const rh = (window as unknown as { RaftHost?: unknown }).RaftHost;
  if (typeof rh !== "object" || rh === null) return undefined;
  const shape = rh as { version?: unknown; emit?: unknown };
  if (shape.version !== RAFT_HOST_VERSION) return undefined;
  if (typeof shape.emit !== "function") return undefined;
  return rh as RaftHostGlobal;
}

/**
 * True only when a compatible host installed the bridge for THIS WebView.
 * False in a regular browser and false in a layout-embedded WebView whose surface
 * did not enable `hostEventsEnabled`.
 */
export function hasRaftHostEventBridge(): boolean {
  // See emitHostEvent for the throw-safety rationale — same rule here: reading the
  // global can throw, and the caller must not learn about a host bug.
  try {
    return readGlobal() !== undefined;
  } catch {
    return false;
  }
}

export function readRaftHostOnboardingContext(): RaftHostOnboardingContext | null {
  try {
    const global = readGlobal();
    if (!global || typeof global.onboarding !== "object" || global.onboarding === null) return null;
    const context = global.onboarding as Record<string, unknown>;
    if (context.contractVersion !== ONBOARDING_CONTRACT_VERSION) return null;
    if (typeof context.generation !== "string" || !HOST_CONTEXT_VALUE.test(context.generation)) return null;
    if (typeof context.sourceServerId !== "string" || !HOST_CONTEXT_VALUE.test(context.sourceServerId)) return null;
    return {
      contractVersion: ONBOARDING_CONTRACT_VERSION,
      generation: context.generation,
      sourceServerId: context.sourceServerId,
    };
  } catch {
    return null;
  }
}

export function requestHostedOnboardingServerSwitch(targetServerId: string): "not-hosted" | "sent" | "failed" {
  try {
    const global = readGlobal();
    // RaftHost predates Native onboarding and is also installed by Desktop.
    // Only the explicit onboarding property opts this document into hosted
    // switching; an ordinary host must retain the existing Web-owned path.
    if (!global || global.onboarding === undefined) return "not-hosted";
    const context = readRaftHostOnboardingContext();
    if (!context || !HOST_CONTEXT_VALUE.test(targetServerId)) return "failed";
    global.emit("onboarding:server-switch-request", {
      contractVersion: ONBOARDING_CONTRACT_VERSION,
      generation: context.generation,
      sourceServerId: context.sourceServerId,
      targetServerId,
    });
    return "sent";
  } catch {
    return "failed";
  }
}

/**
 * Fire-and-forget emit. No-op when the bridge is absent. Silently drops any
 * emit that throws inside the host (a host bug must not take down the web app).
 *
 * Type-forced payload: TypeScript ensures the payload matches the declared shape
 * for each kind. The runtime payload is always sent as an object (never omitted),
 * so the host contract "payload is REQUIRED, must be an object" holds even when
 * the caller omits an empty payload.
 */
export function emitHostEvent<K extends HostEventKind>(
  kind: K,
  ...payload: HostEventPayloads[K] extends Record<string, never>
    ? [] | [Record<string, never>]
    : [HostEventPayloads[K]]
): void {
  // The FULL detect-and-invoke is inside try (@MingQi review r4 #2). Reading
  // `window.RaftHost.version` / `.emit` can throw when the injected global is a Proxy,
  // when someone installed a throwing getter, or when a hostile page tries to break the
  // caller. Any throw here must NOT propagate — `logout()` calls this synchronously and
  // a throw would derail the local-clear sequence. Silent drop is the correct behaviour
  // because the caller has no useful recovery: either the host is well-behaved and the
  // emit succeeded, or it wasn't and no signal was sent. The web app's state clear
  // (which is what actually protects the user) runs regardless.
  try {
    const global = readGlobal();
    if (global === undefined) return;
    const body = (payload[0] ?? {}) as object;
    global.emit(kind, body);
  } catch {
    // Any throw at any step above — reading, detection, invocation — is a host bug.
    // Callers must never learn about it.
  }
}
