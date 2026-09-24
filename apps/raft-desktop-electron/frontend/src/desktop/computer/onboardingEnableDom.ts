// Pure DOM targeting for the desktop onboarding one-click mount, kept free of
// React / @web imports so it is unit-testable under node (jsdom) — the mount
// component adds only the React portal + MutationObserver around it.
//
// The desktop adapts the reused web onboarding DOM at runtime instead of forking
// packages/web. We tag the STABLE step container (the connect log's parent) and
// hide the CLI command guide + terminal instructions via a CSS rule scoped to
// that tag — NOT by tagging the guide node itself. The guide node is re-created
// when the step re-renders while the computer connects, so a tag on it is lost
// and the CLI briefly flashes back; a tag on the durable container survives every
// re-render, so the CLI never reappears mid-flow.
//
// CONNECT_LOG is the anchor: it is present throughout the connect branch and
// absent in the offline-recovery branch (so one-click stays out of recovery). If
// the web onboarding renames it, the unit test breaks loudly.
export const CONNECT_LOG = '[data-testid="onboarding-connect-log"]';
export const HOST_ATTR = "data-raft-desktop-onboarding-enable-host";
export const STEP_ATTR = "data-raft-desktop-onboarding-step";

// Locate the onboarding connect step, tag its stable container, and ensure our
// portal host is that container's first child. Returns the host to portal into,
// or null when the connect step isn't on screen.
export function syncOnboardingEnableHost(doc: Document, node: HTMLElement | null): HTMLElement | null {
  const container = doc.querySelector(CONNECT_LOG)?.parentElement ?? null;
  if (!container) return null;
  // Tag the durable container so the CSS rule can hide the CLI guide +
  // instructions (any child that isn't our host or the progress log).
  container.setAttribute(STEP_ATTR, "");
  // Keep our CTA host as the container's first child (above the hidden guide).
  const host = node ?? doc.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  if (container.firstElementChild !== host) container.insertBefore(host, container.firstElementChild);
  return host;
}
