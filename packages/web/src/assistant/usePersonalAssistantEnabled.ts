import { useMyAssistant } from "./assistantClient";

/**
 * Whether the Assistant entry shows in the current server: the server's
 * `personal_assistant` flag is on (else nothing is asked), and the assistant
 * API says `enabled`. In v4 `enabled` means the `personal_assistant` flag is on
 * and the hosted runtime is available (it can provision the assistant).
 */
export function usePersonalAssistantEnabled({ ask = true }: { ask?: boolean } = {}): boolean {
  // Not asking (a pending frame): not shown, even if a previous server's answer is cached.
  return useMyAssistant({ ask }).status === "ready" && ask;
}
