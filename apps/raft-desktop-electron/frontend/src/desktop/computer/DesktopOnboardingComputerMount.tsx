// Turns the server-setup onboarding's "connect a computer" step into a ONE-CLICK
// action on desktop, WITHOUT modifying packages/web (shared with web + mobile).
//
// The web step is server-driven and hardcoded to a CLI flow for every client:
// "install the CLI via curl, run `raft-computer setup /<slug>` in a terminal,
// approve it in a browser". That is exactly wrong for this app, which BUNDLES the
// raft-computer binary and already holds the user's session — so all three steps
// are unnecessary. The desktop already owns a working one-click enable (the same
// bridge.enable the self-card uses: writeUserSession → attach → start); this just
// wires it into the onboarding step.
//
// Following DesktopSelfComputerMount's convention (adapt the rendered DOM at
// runtime, don't fork web source):
//   - detect the connect step by its stable log node
//     (data-testid="onboarding-connect-log", present throughout the connect
//     branch and absent in the offline-recovery branch);
//   - portal an <OnboardingEnableComputer/> CTA as the first child of that step's
//     container, above the (now hidden) CLI guide;
//   - hide the CLI command guide + the "run it in a terminal" instructions by
//     tagging the stable step container and hiding, via a style scoped to
//     html[data-raft-desktop-shell="electron"], every container child except our
//     host and the progress log. Anchoring on the durable container (not the
//     guide node) keeps the CLI from flashing back when the step re-renders mid-
//     connect.
// After enable succeeds the computer attaches + comes online, and the web step's
// own machineSignature → refreshProjection loop advances the flow — no extra
// plumbing. Fully inert on web / non-host builds: no bridge → nothing mounts.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAuthStore } from "@web/store/authStore";
import { useServerStore } from "@web/store/serverStore";
import { RUNTIME_API_ORIGIN } from "@web/desktopRuntimeEnvironment";
import Button from "@web/components/ui/Button";
import { getComputerBridge } from "./useSelfComputer";
import { syncOnboardingEnableHost } from "./onboardingEnableDom";

/** Turn a raw enable error (incl. Electron IPC strings) into one short line. */
function friendlyError(raw: string): string {
  if (/requires_admin|not_authorized|admin|authoriz/i.test(raw)) return "You need admin access on this server to run a computer here.";
  if (/No handler registered|host unavailable|not.?armed/i.test(raw)) return "The computer host isn't available in this build.";
  if (/network|fetch|timeout|ECONN/i.test(raw)) return "Network error — try again.";
  return "Couldn't enable this computer — try again.";
}

// The CTA that replaces the CLI dance. Small and focused: one sentence + one
// button. Once clicked it hands off to the enable bridge; the onboarding step's
// own progress log then shows the computer connecting and advances the flow.
function OnboardingEnableComputer() {
  const bridge = getComputerBridge();
  const currentServer = useServerStore((s) => s.current);
  const isMac = (globalThis as { raftDesktop?: { platform?: string } }).raftDesktop?.platform === "darwin";
  const deviceName = isMac ? "this Mac" : "this computer";
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onEnable = useCallback(() => {
    if (!bridge || !currentServer) return;
    const { accessToken, refreshToken, user } = useAuthStore.getState();
    if (!accessToken || !refreshToken) {
      setError("Please sign in first.");
      return;
    }
    setBusy(true);
    setError(null);
    void bridge
      .enable({
        serverSlug: currentServer.slug,
        serverUrl: RUNTIME_API_ORIGIN,
        accessToken,
        refreshToken,
        // Persist identity into the shared session, matching a device-code login.
        ...(user?.id ? { userId: user.id } : {}),
        ...(user?.email ? { userEmail: user.email } : {}),
        ...(user?.name ? { userName: user.name } : {}),
        ...(user?.displayName ? { userDisplayName: user.displayName } : {}),
      })
      .then(() => setDone(true))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [bridge, currentServer]);

  if (!bridge || !currentServer) return null;

  return (
    <div className="border-2 border-black bg-soft-signal/40 px-4 py-3" data-testid="onboarding-desktop-enable">
      <h2 className="text-sm font-bold">Use {deviceName}</h2>
      <p className="mt-1 text-xs leading-5 text-black/60">
        This app already includes everything needed — no terminal, no install. Enable {deviceName} to host
        your agents right here, signed in as you.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={onEnable} disabled={busy || done} data-testid="onboarding-desktop-enable-button">
          {done ? "Connecting…" : busy ? "Enabling…" : `Enable ${deviceName}`}
        </Button>
        {done && !error ? (
          <span className="text-xs text-black/55">Setting up — this appears below once it's online.</span>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xs font-bold text-red-700">{friendlyError(error)}</p> : null}
    </div>
  );
}

export function DesktopOnboardingComputerMount() {
  const bridge = getComputerBridge();
  const currentServer = useServerStore((s) => s.current);
  const active = !!bridge && !!currentServer;
  const [host, setHost] = useState<HTMLElement | null>(null);

  // Hide the CLI command guide + terminal instructions on desktop by hiding every
  // child of the tagged step container EXCEPT our Enable host and the progress
  // log. Anchoring on the durable container (not the guide node) means a
  // re-render while the computer connects can't unhide the CLI — the earlier
  // approach tagged the guide itself, which was re-created mid-flow and flashed
  // the command back. Pure CSS, so it survives re-renders without a timing gap.
  useEffect(() => {
    if (!active) return;
    const style = document.createElement("style");
    style.setAttribute("data-raft-desktop-onboarding-cli-hide", "");
    style.textContent =
      'html[data-raft-desktop-shell="electron"] [data-raft-desktop-onboarding-step]' +
      ' > *:not([data-raft-desktop-onboarding-enable-host]):not([data-testid="onboarding-connect-log"])' +
      "{display:none !important;}";
    document.head.appendChild(style);
    return () => style.remove();
  }, [active]);

  // Place (and keep) the portal host at the top of the connect step's container,
  // and tag the CLI guide so the style above can hide it.
  useEffect(() => {
    if (!active) {
      setHost(null);
      return;
    }
    let node: HTMLElement | null = null;

    const sync = () => {
      const next = syncOnboardingEnableHost(document, node);
      if (!next) {
        // Step not on screen (or we left it) — drop our host if we had one.
        if (node) {
          node.remove();
          node = null;
          setHost(null);
        }
        return;
      }
      node = next;
      setHost((prev) => (prev === next ? prev : next));
    };

    // The onboarding modal mounts/unmounts somewhere under body, so we must watch
    // the subtree to catch the connect step appearing. But this runs the whole
    // time the user is signed in, and a chat app mutates the DOM constantly — so
    // COALESCE bursts to at most one sync per animation frame instead of running
    // (and self-triggering) on every individual mutation. sync() is idempotent,
    // so its own DOM writes just settle on the next frame with nothing to do.
    let frame = 0;
    const scheduleSync = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };
    sync();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (node) node.remove();
      setHost(null);
    };
  }, [active]);

  return host ? createPortal(<OnboardingEnableComputer />, host) : null;
}
