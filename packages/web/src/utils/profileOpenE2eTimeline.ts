// Privacy-safe Profile-open diagnostics for the Playwright build only.
//
// Callers provide only bounded enums/booleans. Entity ids, message text, raw
// URLs, request headers, and errors never enter this buffer. In production the
// VITE_E2E branch is compiled false, so recording is a no-op.

export type ProfileOpenDiagnosticProfileType = "agent" | "human" | "computer" | "external" | "unknown";
export type ProfileOpenDiagnosticSource = "channel" | "thread" | "unknown";
export type ProfileOpenDiagnosticModule = "profile-panel" | "agent-detail";
export type ProfileOpenDiagnosticDomTarget = "wrapper" | "fallback" | "panel";

export type ProfileOpenDiagnosticEvent =
  | {
      atMs: number;
      kind: "avatar-click";
      avatarKind: ProfileOpenDiagnosticProfileType;
      surface: ProfileOpenDiagnosticSource;
    }
  | {
      atMs: number;
      kind: "profile-store-open" | "profile-store-retarget";
      profileType: ProfileOpenDiagnosticProfileType;
      source: ProfileOpenDiagnosticSource;
    }
  | { atMs: number; kind: "profile-store-close" }
  | {
      atMs: number;
      kind: "profile-url-read" | "profile-url-write";
      present: boolean;
      profileType: ProfileOpenDiagnosticProfileType | "none";
      navigation?: "push" | "replace";
    }
  | {
      atMs: number;
      kind: "lazy-import-start" | "lazy-import-resolve" | "lazy-import-reject" | "module-evaluated";
      module: ProfileOpenDiagnosticModule;
    }
  | {
      atMs: number;
      kind: "dom-mount" | "dom-unmount";
      target: ProfileOpenDiagnosticDomTarget;
    };

export interface ProfileOpenDiagnosticTimeline {
  schema: "profile-open-browser-timeline";
  version: 1;
  origin: "shared-receipt-start";
  unit: "ms";
  active: boolean;
  events: ProfileOpenDiagnosticEvent[];
  truncated: number;
}

type EventWithoutTime = ProfileOpenDiagnosticEvent extends infer Event
  ? Event extends { atMs: number }
    ? Omit<Event, "atMs">
    : never
  : never;

const MAX_EVENTS = 64;
const enabled = import.meta.env.VITE_E2E === "true";

let active = false;
let receiptStartedAtEpochMs = 0;
let events: ProfileOpenDiagnosticEvent[] = [];
let truncated = 0;

function elapsedMs(): number {
  return Math.max(0, Date.now() - receiptStartedAtEpochMs);
}

export function startProfileOpenE2eTimeline(startedAtEpochMs: number): void {
  if (!enabled) return;
  receiptStartedAtEpochMs = Number.isFinite(startedAtEpochMs) ? startedAtEpochMs : Date.now();
  events = [];
  truncated = 0;
  active = true;
}

export function stopProfileOpenE2eTimeline(): void {
  active = false;
}

export function isProfileOpenE2eTimelineActive(): boolean {
  return enabled && active;
}

export function recordProfileOpenE2eEvent(event: EventWithoutTime): void {
  if (!enabled || !active) return;
  if (events.length >= MAX_EVENTS) {
    truncated += 1;
    return;
  }
  events.push({ ...event, atMs: elapsedMs() } as ProfileOpenDiagnosticEvent);
}

export function recordProfileOpenE2eUrl(
  kind: "profile-url-read" | "profile-url-write",
  search: string,
  navigation?: "push" | "replace",
): void {
  if (!enabled || !active) return;
  const value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("profile");
  const prefix = value?.split(":", 1)[0];
  const profileType = prefix === "agent" || prefix === "human" || prefix === "computer" || prefix === "external"
    ? prefix
    : value
      ? "unknown"
      : "none";
  recordProfileOpenE2eEvent({
    kind,
    present: value !== null,
    profileType,
    ...(navigation ? { navigation } : {}),
  });
}

export function observeProfileOpenE2eImport<T>(
  module: ProfileOpenDiagnosticModule,
  load: () => Promise<T>,
): Promise<T> {
  if (!enabled) return load();
  recordProfileOpenE2eEvent({ kind: "lazy-import-start", module });
  return load().then(
    (value) => {
      recordProfileOpenE2eEvent({ kind: "lazy-import-resolve", module });
      return value;
    },
    (error: unknown) => {
      // Deliberately retain no error text: dynamic-import failures commonly
      // include full asset URLs and must stay outside the attachment.
      recordProfileOpenE2eEvent({ kind: "lazy-import-reject", module });
      throw error;
    },
  );
}

export function readProfileOpenE2eTimeline(): ProfileOpenDiagnosticTimeline {
  return {
    schema: "profile-open-browser-timeline",
    version: 1,
    origin: "shared-receipt-start",
    unit: "ms",
    active: enabled && active,
    events: events.map((event) => ({ ...event })),
    truncated,
  };
}
