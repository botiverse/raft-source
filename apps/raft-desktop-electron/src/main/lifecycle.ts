// Keep-alive lifecycle reducer. On macOS the app stays resident when the last
// window closes (Dock re-entry); quitting only happens through an explicit
// quit. The platform stays a parameter so the darwin assumption is not baked
// into the assembly layer.

export interface LifecycleState {
  readonly quitting: boolean;
}

export const INITIAL_LIFECYCLE_STATE: LifecycleState = { quitting: false };

export type LifecycleEvent =
  | { type: "before-quit" }
  | { type: "window-all-closed" }
  | { type: "activate"; hasServerWindows: boolean };

export type LifecycleDecision = "none" | "quit" | "reboot";

export function reduceLifecycle(
  state: LifecycleState,
  event: LifecycleEvent,
  platform: NodeJS.Platform,
): { state: LifecycleState; decision: LifecycleDecision } {
  switch (event.type) {
    case "before-quit":
      return { state: { quitting: true }, decision: "none" };
    case "window-all-closed":
      if (platform === "darwin" && !state.quitting) {
        return { state, decision: "none" };
      }
      return { state, decision: "quit" };
    case "activate":
      if (!event.hasServerWindows && !state.quitting) {
        return { state, decision: "reboot" };
      }
      return { state, decision: "none" };
  }
}
