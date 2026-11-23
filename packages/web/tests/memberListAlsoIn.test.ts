import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { vi } from "vitest";

// A member of the viewed server who is also in another one: the channel's
// member list says it in quiet text after the name, "Also in Raft", the same
// grey as the server written after someone from another server, never a
// coloured chip (cindyz, 2026-11-13, #wg-rbac:38225c7c).
vi.mock("../src/components/ui/Tooltip", () => ({ default: ({ children }: { children: unknown }) => children }));
// The member parts' sign-in status reads the Computer's live sign-in state
// (auth store, which needs a browser's localStorage): not part of this test.
vi.mock("../src/components/machine/useAgentRuntimeSignInView", () => ({ useAgentRuntimeSignInView: () => ({ serverId: null, authRuntime: null, view: null, status: null, offered: false }) }));
const { JointServerBadges } = await import("../src/components/agent/channelMemberParts");
const messages = {
  "channel.membersPage.alsoIn": "Also in {servers}",
  "channel.membersPage.sourceTagTooltip": "{name} is also a member of {server}",
};
const draw = (props: { labels: string[]; sourceOf?: string }) =>
  renderToStaticMarkup(createElement(IntlProvider, { locale: "en", messages }, createElement(JointServerBadges, props)));

test("a dual member reads 'Also in …' in quiet text, with the whole sentence for a screen reader", () => {
  const html = draw({ labels: ["Raft", "Acme Corp"], sourceOf: "wenyi" });
  assert.match(html, /text-foreground-hint/);
  assert.match(html, /Also in Raft, Acme Corp/);
  assert.match(html, /wenyi is also a member of Raft and Acme Corp/);
  assert.doesNotMatch(html, /data-slot="badge"/);
});

test("without a name (an agent's row) it still says 'Also in': server names alone would read as someone from another server", () => {
  const html = draw({ labels: ["Raft"] });
  assert.match(html, />Also in Raft</);
  assert.doesNotMatch(html, /is also a member of/);
  assert.match(html, /text-foreground-hint/);
  assert.doesNotMatch(html, /data-slot="badge"/);
});

test("no other server: nothing is drawn", () => {
  assert.equal(draw({ labels: [] }), "");
});
