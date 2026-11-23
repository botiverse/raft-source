import { describe, expect, it } from "vitest";

import type { Agent } from "../src/store/agentStore";
import type { Channel } from "../src/store/channelStore";
import type { BrowserInUse } from "../src/features/webPreview/browserInUseStore";
import { sidebarItemConversationId, sidebarMarkableConversationIds, sidebarRowBrowserInUse, sidebarSectionBrowserInUse } from "../src/features/sidebar/sidebarBrowserInUse";
import type { SidebarDndDisplayItem } from "../src/features/sidebar/sidebarDisplayItems";

// The sidebar's browser mark (SidebarBrowserInUseMark), from what the built-in browser's kept pages of each
// conversation do: a row's, never the conversation on screen's, and a folded section head's for its rows together.
const audible: BrowserInUse = { audible: true, muted: false, media: [] };
const muted: BrowserInUse = { audible: false, muted: true, media: [] };
const microphone: BrowserInUse = { audible: false, muted: false, media: ["microphone"] };
const camera: BrowserInUse = { audible: true, muted: false, media: ["camera"] };
const byOwner = { "ch-audible": audible, "ch-muted": muted, "dm-mic": microphone, "dm-camera": camera };

describe("the sidebar's browser mark", () => {
  it("a row shows what its conversation's kept pages do, the store's own object; none for the conversation on screen or one with none", () => {
    expect(sidebarRowBrowserInUse(byOwner, "dm-mic", null)).toBe(microphone);
    expect(sidebarRowBrowserInUse(byOwner, "dm-mic", "ch-audible")).toBe(microphone);
    expect(sidebarRowBrowserInUse(byOwner, "dm-mic", "dm-mic")).toBeNull();
    expect(sidebarRowBrowserInUse(byOwner, "ch-quiet", null)).toBeNull();
    expect(sidebarRowBrowserInUse(byOwner, undefined, null)).toBeNull();
    expect(sidebarRowBrowserInUse({}, "dm-mic", null)).toBeNull();
  });

  it("a folded section's head shows its rows' together: every device, sound heard over muted; never the conversation on screen's", () => {
    expect(sidebarSectionBrowserInUse(byOwner, ["ch-quiet", null, "ch-muted"], null)).toEqual(muted);
    expect(sidebarSectionBrowserInUse(byOwner, ["ch-muted", "ch-audible"], null)).toEqual({ audible: true, muted: false, media: [] });
    expect(sidebarSectionBrowserInUse(byOwner, ["dm-camera", "ch-muted", "dm-mic"], null)).toEqual({ audible: true, muted: false, media: ["microphone", "camera"] });
    expect(sidebarSectionBrowserInUse(byOwner, ["dm-camera", "dm-mic"], "dm-camera")).toEqual(microphone);
    expect(sidebarSectionBrowserInUse(byOwner, ["dm-mic"], "dm-mic")).toBeNull();
    expect(sidebarSectionBrowserInUse(byOwner, ["ch-quiet"], null)).toBeNull();
    expect(sidebarSectionBrowserInUse(byOwner, [], null)).toBeNull();
  });

  it("a row's conversation is the one it opens: an agent's row its DM's, once there is one", () => {
    const channel = { id: "ch-1" } as Channel;
    const agent = { id: "agent-1" } as Agent;
    expect(sidebarItemConversationId({ type: "channel", channel, label: "general" }, {})).toBe("ch-1");
    expect(sidebarItemConversationId({ type: "dm", dm: { id: "dm-1" } as Channel, label: "Ann" }, {})).toBe("dm-1");
    expect(sidebarItemConversationId({ type: "agent", agent, label: "Bot" }, { "agent-1": "dm-2" })).toBe("dm-2");
    expect(sidebarItemConversationId({ type: "agent", agent, label: "Bot" }, {})).toBeNull();
    expect(sidebarItemConversationId({ type: "lounge", lounge: { channelId: "lounge-1" } as never, label: "Bot's Lounge" }, {})).toBe("lounge-1");
  });

  it("the conversations it can mark are every row's, in every section, a folded one's too (its head shows the mark), a Lounge's, each once", () => {
    const items = new Map<string, SidebarDndDisplayItem>([
      ["channel:ch-1", { type: "channel", channel: { id: "ch-1" } as Channel, label: "general" }],
      ["channel:dm-1", { type: "dm", dm: { id: "dm-1" } as Channel, label: "Ann" }],
      ["agent:agent-1", { type: "agent", agent: { id: "agent-1" } as Agent, label: "Bot" }],
      ["agent:agent-2", { type: "agent", agent: { id: "agent-2" } as Agent, label: "No DM yet" }],
      ["channel:lounge-1", { type: "lounge", lounge: { channelId: "lounge-1" } as never, label: "Bot's Lounge" }],
    ]);
    const projection = {
      pinned: ["channel:ch-1"],
      // A folded custom section: its rows are not drawn, but its head shows the mark.
      "custom:folded": ["channel:dm-1", "agent:agent-1"],
      channels: ["channel:ch-1", "channel:gone"],
      dms: ["agent:agent-2", "channel:lounge-1"],
    };
    expect(sidebarMarkableConversationIds(projection, items, { "agent-1": "dm-2" }).sort()).toEqual(["ch-1", "dm-1", "dm-2", "lounge-1"]);
    // A DM closed or a channel left: no row, not markable.
    expect(sidebarMarkableConversationIds({ dms: ["channel:lounge-1"] }, items, {})).toEqual(["lounge-1"]);
    expect(sidebarMarkableConversationIds({}, items, {})).toEqual([]);
  });
});
