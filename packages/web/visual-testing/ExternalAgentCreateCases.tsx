import { useEffect, useState } from "react";
import api from "../src/api/client";
import { CreateExternalAgentDialog } from "../src/features/agent/CreateExternalAgentDialog";
import { useServerStore } from "../src/store/serverStore";

// #wg-external-agent-ux:#2 for Jasper: the external agent create dialog in each of its states, at desktop width
// and 390px (`?case=…`). The API is mocked; the states are reached by pressing the dialog's own buttons.

export const EXTERNAL_AGENT_CREATE_CASE_IDS = [
  "components.agent.create-external.start",
  "components.agent.create-external.existing-waiting",
  "components.agent.create-external.sdk-waiting",
  "components.agent.create-external.online",
  "components.agent.create-external.discard",
] as const;

const AGENT_ID = "6f2c9e41-8b3d-4a57-9c1e-2d7f0a8b5e13";
const stay = () => undefined;

function prime(connected: boolean) {
  useServerStore.setState({ current: { id: "visual-server", name: "Raft", slug: "raft", ownerId: "visual-user", role: "owner", plan: "pro" }, members: [] } as never);
  api.post = (async (url: string) => {
    if (url === "/agents") return { data: { id: AGENT_ID, name: "Nathan", displayName: "Nathan", status: "inactive", runtime: "external" } };
    return { data: { agentId: AGENT_ID, credentialId: "visual-cred", apiKey: "sk_agent_visual-example-not-a-key" } };
  }) as unknown as typeof api.post;
  api.put = (async (_url: string, body?: unknown) => ({ data: body })) as unknown as typeof api.put;
  api.get = (async () => ({ data: { setupState: connected ? "connected" : "credential_minted", credentialLastUsedAt: null, lastActivityAt: null } })) as unknown as typeof api.get;
}

function press(testId: string) {
  (document.querySelector(`[data-testid='${testId}']`) as HTMLElement | null)?.click();
}

function typeName(value: string) {
  const input = document.querySelector("[data-testid='create-external-agent-name']") as HTMLInputElement | null;
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function ExternalAgentCreateCase({ caseId }: { caseId: string }) {
  const [ready] = useState(() => {
    prime(caseId.endsWith(".online"));
    return true;
  });
  useEffect(() => {
    const steps: Array<() => void> = [() => typeName("Nathan")];
    if (caseId.endsWith(".sdk-waiting")) steps.push(() => press("create-external-agent-sdk"));
    if (!caseId.endsWith(".start")) steps.push(() => press("create-external-agent-next"));
    if (caseId.endsWith(".discard")) steps.push(() => press("create-external-agent-cancel"));
    const timers = steps.map((step, index) => window.setTimeout(step, 150 * (index + 1)));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [caseId]);
  if (!ready) return null;
  return (
    <div className="min-h-screen bg-layer-canvas">
      <CreateExternalAgentDialog onClose={stay} />
    </div>
  );
}
