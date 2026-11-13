// E2E test hooks — exposed on `window.__SLOCK_E2E__` ONLY when the bundle is
// built with `VITE_E2E=true` (the Playwright e2e build). main.tsx imports this
// module only in that build (and renders after it is in); production / CF
// Pages builds omit the flag, so neither this module nor its imports (the
// screenshot export, the E2E probes) are in their bundle.
//
// Why this exists: the e2e suite previously reached into app internals via
// `page.evaluate(() => import("/src/store/messageStore.ts"))`, which only works
// against the Vite *dev* server (it serves `/src/*` modules over HTTP). Once the
// e2e webServer switched to `vite preview` (built static `/assets/*.js`, to kill
// the dynamic-import-reject flake under the ECONNRESET storm), those `/src`
// imports 404. Exposing the needed APIs through an explicit, build-gated hook is
// both preview-compatible and a cleaner contract than coupling specs to source
// module paths.
import { useMessageStore } from "./store/messageStore";
import { useProfileStore } from "./store/profileStore";
import { captureSelectedMessages, readLastCaptureMessageIds } from "./utils/selectScreenshot";
import {
  isProfileOpenE2eTimelineActive,
  readProfileOpenE2eTimeline,
  recordProfileOpenE2eEvent,
  startProfileOpenE2eTimeline,
  stopProfileOpenE2eTimeline,
} from "./utils/profileOpenE2eTimeline";
import {
  readSidebarDndProbe,
  startSidebarDndProbe,
  stopSidebarDndProbe,
} from "./utils/sidebarDndE2eProbe";
import type { SidebarDndProbeEntry } from "./utils/sidebarDndE2eProbe";
import type {
  ProfileOpenDiagnosticDomTarget,
  ProfileOpenDiagnosticProfileType,
  ProfileOpenDiagnosticSource,
  ProfileOpenDiagnosticTimeline,
} from "./utils/profileOpenE2eTimeline";

declare global {
  interface Window {
    __SLOCK_E2E__?: {
      loadMessages: (channelId: string) => Promise<void>;
      captureSelectedMessages: typeof captureSelectedMessages;
      // The message ids of the rows the last image capture rendered.
      readLastCaptureMessageIds: typeof readLastCaptureMessageIds;
      startProfileOpenTimeline: (receiptStartedAtEpochMs: number) => void;
      readProfileOpenTimeline: () => ProfileOpenDiagnosticTimeline;
      stopProfileOpenTimeline: () => void;
      // Sidebar drag/drop forensics (see utils/sidebarDndE2eProbe). Recording
      // starts only when a spec opts in via start(); read() returns the
      // bounded buffer; stop() disables recording and clears the hook.
      sidebarDndProbe: {
        start: () => void;
        read: () => SidebarDndProbeEntry[];
        stop: () => void;
      };
    };
  }
}

if (import.meta.env.VITE_E2E === "true") {
  const readDomCounts = (): Record<ProfileOpenDiagnosticDomTarget, number> => ({
    wrapper: document.querySelectorAll('[data-testid="thread-profile-side-column"]').length,
    fallback: document.querySelectorAll('[data-testid="profile-panel-fallback"]').length,
    panel: document.querySelectorAll('[data-testid="profile-panel"]').length,
  });
  let domCounts = readDomCounts();

  const profileDomObserver = new MutationObserver(() => {
    if (!isProfileOpenE2eTimelineActive()) return;
    const next = readDomCounts();
    for (const target of ["wrapper", "fallback", "panel"] as const) {
      if (next[target] === domCounts[target]) continue;
      recordProfileOpenE2eEvent({
        kind: next[target] > domCounts[target] ? "dom-mount" : "dom-unmount",
        target,
      });
    }
    domCounts = next;
  });
  profileDomObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("click", (event) => {
    if (!isProfileOpenE2eTimelineActive()) return;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-avatar-kind]")
      : null;
    if (!target) return;
    const rawKind = target.dataset.avatarKind;
    const avatarKind: ProfileOpenDiagnosticProfileType =
      rawKind === "agent" || rawKind === "human" || rawKind === "external"
        ? rawKind
        : "unknown";
    const surface: ProfileOpenDiagnosticSource = target.closest('[data-testid="thread-side-column"]')
      ? "thread"
      : target.closest('[data-testid="thread-main-column"]')
        ? "channel"
        : "unknown";
    recordProfileOpenE2eEvent({ kind: "avatar-click", avatarKind, surface });
  }, true);

  useProfileStore.subscribe((state, previous) => {
    if (!isProfileOpenE2eTimelineActive()) return;
    const wasOpen = !!previous.profileId;
    const isOpen = !!state.profileId;
    if (!wasOpen && isOpen) {
      recordProfileOpenE2eEvent({
        kind: "profile-store-open",
        profileType: state.profileType ?? "unknown",
        source: state.openSource ?? "unknown",
      });
    } else if (wasOpen && !isOpen) {
      recordProfileOpenE2eEvent({ kind: "profile-store-close" });
    } else if (
      isOpen
      && (state.profileId !== previous.profileId || state.profileType !== previous.profileType)
    ) {
      recordProfileOpenE2eEvent({
        kind: "profile-store-retarget",
        profileType: state.profileType ?? "unknown",
        source: state.openSource ?? "unknown",
      });
    }
  });

  // `loadMessages` is wrapped rather than exposing the store getState() surface,
  // so specs can refresh messages without reaching setState / other store ops.
  window.__SLOCK_E2E__ = {
    loadMessages: (channelId) => useMessageStore.getState().loadMessages(channelId),
    captureSelectedMessages,
    readLastCaptureMessageIds,
    startProfileOpenTimeline: (receiptStartedAtEpochMs) => {
      domCounts = readDomCounts();
      startProfileOpenE2eTimeline(receiptStartedAtEpochMs);
    },
    readProfileOpenTimeline: readProfileOpenE2eTimeline,
    stopProfileOpenTimeline: stopProfileOpenE2eTimeline,
    sidebarDndProbe: {
      start: startSidebarDndProbe,
      read: readSidebarDndProbe,
      stop: stopSidebarDndProbe,
    },
  };
}
