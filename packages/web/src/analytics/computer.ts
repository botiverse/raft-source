import { trackEvent } from "./posthog";

export function trackComputerWindowsInterestClick(source: "computer_command_guide"): void {
  trackEvent("computer_windows_interest_click", { source });
}
