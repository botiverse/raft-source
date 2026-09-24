import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

/**
 * P0 regression (#proj-frontend task #298, reported by @tygg in task #297).
 *
 * Member/non-admin agent projections and the `agent:created` broadcast
 * legitimately strip the private `runtimeConfig`. A Built-in agent therefore
 * reaches the mention hover card as `runtime:"builtin"` with no provider, and
 * the card used to hydrate it unconditionally — which threw
 * `TypeError: Cannot read properties of undefined (reading 'providerId')`
 * while deriving trace attributes, blanking the card. Users hit it on hover and
 * again every ~10s after refresh.
 *
 * The card must degrade to the PUBLIC `runtime`/`model` columns instead, and
 * must never synthesize a provider just to render.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

const { cleanup, render } = await import("@testing-library/react");
const { default: ProfilePreviewCardContent } = await import("../src/components/message/ProfilePreviewCardContent");
const { useAgentStore } = await import("../src/store/agentStore");
const { useAuthStore } = await import("../src/store/authStore");
const { useMachineStore } = await import("../src/store/machineStore");
const { useServerStore } = await import("../src/store/serverStore");
const { TestIntlProvider } = await import("./helpers/intl");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  useAgentStore.setState({ agents: [], agentActivities: {}, activityLogs: {}, trajectoryLogs: {} } as never);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useMachineStore.setState({ machines: [] } as never);
  useServerStore.setState({ members: [] } as never);
});

function seedViewer(userId = "viewer-user") {
  useAuthStore.setState({
    user: {
      id: userId,
      email: `${userId}@slock.test`,
      gravatarHash: "",
      name: userId,
      displayName: null,
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "manual",
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    initialized: true,
  } as never);
}

test("mention hover of a Built-in agent with stripped runtimeConfig degrades to public runtime/model", () => {
  const agentId = "agent-stripped-builtin";
  seedViewer();
  useAgentStore.setState({
    agents: [
      {
        id: agentId,
        name: "stripped-builtin",
        displayName: "Stripped Builtin",
        status: "active",
        avatarUrl: null,
        creatorType: "user",
        // Viewer is NOT the creator and has no manageAgents capability, so this
        // mirrors the member projection that strips runtimeConfig.
        creatorId: "someone-else",
        runtime: "builtin",
        model: "deepseek/deepseek-v4-pro",
        // The private config is absent — this is the shape that crashed.
        runtimeConfig: null,
      },
    ],
    agentActivities: {},
    trajectoryLogs: {},
  } as never);

  // Before the fix this render threw while building trace attrs.
  render(
    <TestIntlProvider>
      <ProfilePreviewCardContent
        mentionType="agent"
        mentionId={agentId}
      />
    </TestIntlProvider>,
  );

  const text = document.body.textContent ?? "";
  // Public runtime column still projects a human-readable runtime.
  assert.match(text, /Built-in Pi/);
  // Public model column still projects; we did not need a provider to show it.
  assert.match(text, /deepseek/i);
  // No fabricated provider leaked into the rendered card.
  assert.doesNotMatch(text, /providerId/);
});
