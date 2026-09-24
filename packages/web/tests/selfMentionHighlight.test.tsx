import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import MentionLink from "../src/components/message/MentionLink";
import { useAuthStore } from "../src/store/authStore";

// Independent of `MSG_REF_CHIP` in product source. If the production
// constant shrinks, this expected set must still fail the rendered chip.
const EXPECTED_SELF_MENTION_BOX_TOKENS = [
  "inline-block",
  "max-w-full",
  "overflow-hidden",
  "text-ellipsis",
  "whitespace-nowrap",
  "align-bottom",
  "border",
  "border-black",
  "px-1",
  "py-0",
  "[font-size:0.875em]",
  "font-bold",
  "leading-[1.3em]",
  "select-text",
] as const;

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null } as never);
});

function renderMention(
  mentionType: "user" | "agent",
  mentionId: string,
  label: string,
) {
  return render(
    <MentionLink mentionType={mentionType} mentionId={mentionId} onNavigate={() => undefined}>
      {label}
    </MentionLink>,
  );
}

test("self mention uses the inbox mention-you yellow treatment", () => {
  useAuthStore.setState({ user: { id: "user-self", name: "self" } } as never);
  renderMention("user", "user-self", "@self");

  const chip = screen.getByText("@self");
  assert.match(
    chip.className,
    /(^|\s)bg-soft-signal(\s|$)/,
    "self mention must keep the yellow mention-you fill",
  );
  for (const token of EXPECTED_SELF_MENTION_BOX_TOKENS) {
    assert.match(
      chip.className,
      new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`),
      `self mention must keep box token ${token}`,
    );
  }
  assert.doesNotMatch(chip.className, /leading-\[21px\]/);
});

test("agent mentions never use the self-mention highlight", () => {
  useAuthStore.setState({ user: { id: "user-self", name: "self" } } as never);
  renderMention("agent", "user-self", "@agent");
  const agent = screen.getByText("@agent");
  assert.doesNotMatch(agent.className, /(^|\s)bg-soft-signal(\s|$)/, "agent mentions must not pick up the self-mention fill");
  assert.match(agent.className, /underline/);
  cleanup();

  renderMention("user", "user-other", "@other");
  const other = screen.getByText("@other");
  assert.doesNotMatch(other.className, /(^|\s)bg-soft-signal(\s|$)/, "other-human mentions stay underlined, not yellow");
  assert.match(other.className, /underline/);
});
