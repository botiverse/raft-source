import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentDMConversationList } from "../src/components/agent/AgentDMConversationList";
import { TestIntlProvider } from "./helpers/intl";

test("agent DM conversation rows render as activity-only cards without navigation affordance", () => {
  const html = renderToStaticMarkup(
    createElement(TestIntlProvider, null, createElement(AgentDMConversationList, {
      items: [
        {
          id: "dm-agent-1",
          createdAt: "2026-04-24T00:00:00.000Z",
          peerId: "agent-2",
          peerName: "helper",
          peerDisplayName: "Helper",
          peerAvatarUrl: null,
          lastMessageAt: "2026-04-24T01:00:00.000Z",
          lastMessagePreview: "Can you check this?",
        },
      ]
    }))
  );

  assert.match(html, /Agent DM/);
  assert.match(html, /Helper/);
  assert.match(html, /Can you check this\?/);
  assert.match(html, /aria-label="Helper agent DM activity"/);
  assert.match(html, /title="Agent DM activity"/);
  assert.match(html, /Activity only/);
  assert.doesNotMatch(html, /<button/);
});

test("agent DM conversation rows render zh chrome from FormatJS messages", () => {
  const html = renderToStaticMarkup(
    createElement(TestIntlProvider, { locale: "zh-cn" }, createElement(AgentDMConversationList, {
      items: [
        {
          id: "dm-agent-zh",
          createdAt: "2026-04-24T00:00:00.000Z",
          peerId: "agent-zh",
          peerName: "helper",
          peerDisplayName: "小帮手",
          peerAvatarUrl: null,
          lastMessageAt: "2026-04-24T01:00:00.000Z",
          lastMessagePreview: "",
        },
      ]
    }))
  );

  assert.match(html, /Agent 私信/);
  assert.match(html, /暂无消息/);
  assert.match(html, /aria-label="小帮手 的 Agent 私信动态"/);
  assert.match(html, /title="Agent 私信动态"/);
  assert.match(html, /仅动态/);
  assert.doesNotMatch(html, /Activity only|Agent DM activity|No messages yet/);
});

test("agent DM rows render zh relative time with 盘古之白 spacing (task #61)", () => {
  const fixedNow = Date.parse("2026-08-02T12:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const html = renderToStaticMarkup(
      createElement(TestIntlProvider, { locale: "zh-cn" }, createElement(AgentDMConversationList, {
        items: [
          {
            id: "dm-agent-spacing",
            createdAt: "2026-08-02T09:00:00.000Z",
            peerId: "agent-spacing",
            peerName: "helper",
            peerDisplayName: "小帮手",
            peerAvatarUrl: null,
            lastMessageAt: "2026-08-02T09:00:00.000Z",
            lastMessagePreview: "",
          },
        ]
      }))
    );
    // "3小时前" (digit pressed to CJK) is RED; the spaced form is required.
    assert.match(html, /3 小时前/);
    assert.doesNotMatch(html, /3小时前|2分钟前/);
  } finally {
    Date.now = realNow;
  }
});
