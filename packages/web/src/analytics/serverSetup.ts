// The server setup steps (#proj-onboarding:#7, Ferry; events defined by Nova in
// docs/analytics/product-events.md "The new-user journey"): which step an owner
// saw, what they did there and what held them, so the funnel can say where the
// 30% who never connect a computer stop.
import { SERVER_SETUP_BLOCK_REASONS } from "@botiverse/raft-shared";
import type { SERVER_SETUP_ACTIONS, SERVER_SETUP_STEPS } from "@botiverse/raft-shared";
import type { CopyTarget } from "../components/machine/ComputerCommandGuide";
import { readRaftHostOnboardingContext } from "../embed/hostBridge";
import { isNativeOnboardingPath, readNativeOnboardingGeneration } from "../embed/nativeOnboarding";
import { trackEvent } from "./track";

export type ServerSetupStep = (typeof SERVER_SETUP_STEPS)[number];
export type ServerSetupAction = (typeof SERVER_SETUP_ACTIONS)[number];
type ServerSetupBlockReason = (typeof SERVER_SETUP_BLOCK_REASONS)[number];

/** `step_shown` once per server and step, `blocked` once per server, step and reason, per page load. */
const recordedThisPageLoad = new Set<string>();

/**
 * `native_host: true` when this page is the mobile app's setup (mobile_server_setup_v1,
 * Lagoon 2026-11-08): the app opens this onboarding in a WebView, either handing
 * it its `raft-onboarding-v1` context or on the app-only surface
 * `/s/:slug/onboarding?generation=…` (App.tsx; a browser without a generation is
 * sent back to the server). Absent in a browser and in Desktop.
 */
function hostDetails(): { native_host?: true } {
  if (readRaftHostOnboardingContext()) return { native_host: true };
  if (typeof window === "undefined") return {};
  const { pathname, search } = window.location;
  return isNativeOnboardingPath(pathname) && readNativeOnboardingGeneration(search) ? { native_host: true } : {};
}

function once(key: string): boolean {
  if (recordedThisPageLoad.has(key)) return false;
  recordedThisPageLoad.add(key);
  return true;
}

export function trackServerSetupStepShown(serverId: string | undefined, step: ServerSetupStep | null): void {
  if (!serverId || !step || !once(`shown:${serverId}:${step}`)) return;
  trackEvent("server_setup_step_shown", { step, ...hostDetails() }, { serverId });
}

/** Only the gate reasons that hold a step count; `setup_complete`, permission and pending states do not. */
export function trackServerSetupBlocked(
  serverId: string | undefined,
  step: ServerSetupStep | null,
  reason: string | null | undefined,
): void {
  if (!serverId || !step || !reason || !(SERVER_SETUP_BLOCK_REASONS as readonly string[]).includes(reason)) return;
  if (!once(`blocked:${serverId}:${step}:${reason}`)) return;
  trackEvent("server_setup_blocked", { step, reason: reason as ServerSetupBlockReason, ...hostDetails() }, { serverId });
}

export function trackServerSetupAction(
  serverId: string | undefined,
  step: ServerSetupStep,
  action: ServerSetupAction,
  os?: "mac_linux" | "windows",
): void {
  if (!serverId) return;
  trackEvent("server_setup_step_action", { step, action, ...(os ? { os } : {}), ...hostDetails() }, { serverId });
}

/** A command the computer step's guide copied, as the action and the tab it came from. */
export function serverSetupCopyAction(target: CopyTarget): { action: ServerSetupAction; os: "mac_linux" | "windows" } {
  const os = target.startsWith("windows") ? "windows" : "mac_linux";
  if (target === "mac-linux-install-and-setup") return { action: "copy_install_and_setup_command", os };
  return { action: target.endsWith("-install") ? "copy_install_command" : "copy_setup_command", os };
}

export function resetServerSetupTrackingForTest(): void {
  recordedThisPageLoad.clear();
}
