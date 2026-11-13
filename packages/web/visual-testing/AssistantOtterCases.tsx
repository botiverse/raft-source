import { useEffect, useState } from "react";
import api from "../src/api/client";
import { AssistantOtterAnchor } from "../src/assistant/AssistantOtter";
import { AssistantOtterSettingsSection } from "../src/assistant/AssistantOtterSettings";
import { AssistantOwnerSection } from "../src/assistant/AssistantOwnerSection";
import LocalizedToastProvider from "../src/components/LocalizedToastProvider";
import { showToast } from "../src/components/toastBridge";
import { useAuthStore } from "../src/store/authStore";
import { PERSONAL_ASSISTANT_FLAG_KEY, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

// #proj-assistant:#21 for Kirby: Settings › Appearance › Assistant (the switch
// and the shortcut row; capture state), and the toast after the shortcut hides
// the otter. Captured at desktop width and 390px (`?case=…`).

export const ASSISTANT_OTTER_CASE_IDS = [
  "components.settings.appearance.assistant-otter",
  "components.settings.appearance.assistant-otter.capture",
  "components.assistant.otter-hidden-toast",
  "components.assistant.owner-section",
  "components.assistant.otter-dock",
] as const;

const SERVER_ID = "visual-server";

function primeAssistant() {
  useAuthStore.setState({ user: { id: "visual-user", name: "owner", displayName: "Owner", assistantOtterVisible: true, assistantOtterShortcut: null } } as never);
  useServerStore.setState({ current: { id: SERVER_ID, name: "Raft", slug: "raft", ownerId: "visual-user", role: "owner", plan: "pro" }, members: [] } as never);
  setServerFeatureFlagForTests(SERVER_ID, PERSONAL_ASSISTANT_FLAG_KEY, true);
  api.get = (async (url: string) => {
    if (url === `/servers/${SERVER_ID}/assistant`) {
      return { data: { enabled: true, assistant: { id: "visual-ottie", name: "Ottie", agentId: "visual-ottie", dmChannelId: "visual-dm", readsDms: true, sendAsOwner: true, ownerNotes: "" } } };
    }
    if (url === `/servers/${SERVER_ID}/assistant/wechat/status`) return { data: { available: true, binding: null } };
    if (url === `/servers/${SERVER_ID}/assistant/setting-changes`) {
      return { data: { changes: [{ id: "v1", assistantName: "Ottie", setting: "agentMove", serverId: SERVER_ID, targetRef: "@sage", confirmed: true, previousValue: "MacBook", nextValue: "Cloud", createdAt: "2026-11-08T12:00:00.000Z" }] } };
    }
    return { data: {} };
  }) as typeof api.get;
}

function SettingsFrame({ capture }: { capture: boolean }) {
  const [ready] = useState(() => {
    primeAssistant();
    return true;
  });
  useEffect(() => {
    if (!capture) return;
    const timer = window.setTimeout(() => {
      (document.querySelector("[data-testid='assistant-otter-shortcut-change']") as HTMLButtonElement | null)?.click();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [capture]);
  if (!ready) return null;
  return (
    <div className="min-h-screen bg-layer-canvas p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <AssistantOtterSettingsSection />
      </div>
    </div>
  );
}

function ToastFrame() {
  useEffect(() => {
    const timer = window.setTimeout(() => showToast({ title: "Ottie hidden. Press ⌘⇧. to show it." }), 100);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <LocalizedToastProvider>
      <div className="min-h-screen bg-layer-canvas" />
    </LocalizedToastProvider>
  );
}

/** #proj-assistant:#21 (Artea af3f1bc4, Kirby 4f20e4e7): the owner's section under the assistant's profile, at the profile panel's width. */
function OwnerSectionFrame() {
  const [ready] = useState(() => {
    primeAssistant();
    return true;
  });
  if (!ready) return null;
  return (
    <div className="min-h-screen bg-layer-canvas">
      <div className="mx-auto max-w-[420px] border-x border-line-seam">
        <AssistantOwnerSection agentId="visual-ottie" />
      </div>
    </div>
  );
}

/**
 * #proj-assistant:#24 (Artea 5733d2fb): a sidebar, a main pane and a
 * composer frame, the otter on the composer. Drag it to a pane's edge: it
 * snaps there and stays (this browser's localStorage); drop it on the
 * composer's top edge to bring it back.
 */
function OtterDockFrame() {
  const [ready] = useState(() => {
    primeAssistant();
    useChannelStore.setState({
      channels: [{ id: "visual-general", serverId: SERVER_ID, name: "general", type: "channel", archived: false }],
      dmChannels: [{ id: "visual-dm", serverId: SERVER_ID, name: "dm", type: "dm", peerId: "visual-ottie" }],
    } as never);
    return true;
  });
  if (!ready) return null;
  return (
    <div className="flex h-screen bg-layer-canvas">
      <div data-otter-dock="sidebar" className="w-60 shrink-0 border-r border-line-seam bg-layer-sidebar p-3 text-footnote text-foreground-secondary max-md:hidden">Sidebar</div>
      <div data-otter-dock="main" className="flex min-w-0 flex-1 flex-col">
        <div className="h-12 shrink-0 border-b border-line-seam px-4 py-3 text-footnote text-foreground">#general</div>
        <div data-virtual-timeline="" className="min-h-0 flex-1 p-4 text-body text-foreground">
          {["The first message.", "Another message in the conversation.", "The last message, long enough to reach the corner where the otter lies."].map((text) => (
            <p key={text} className="py-1">{text}</p>
          ))}
        </div>
        <div className="p-3">
          <div data-composer-frame-edge="" className="relative h-20 rounded-container border border-line-field bg-layer-card p-3 text-foreground-tertiary">
            Message #general
            <AssistantOtterAnchor hostId="visual-composer" channelId="visual-general" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function AssistantOtterCase({ caseId }: { caseId: string }) {
  if (caseId === "components.assistant.otter-dock") return <OtterDockFrame />;
  if (caseId === "components.assistant.otter-hidden-toast") return <ToastFrame />;
  if (caseId === "components.assistant.owner-section") return <OwnerSectionFrame />;
  return <SettingsFrame capture={caseId.endsWith(".capture")} />;
}
