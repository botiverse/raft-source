import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MentionLink from "../src/components/message/MentionLink";
import { useAuthStore } from "../src/store/authStore";

afterEach(() => cleanup());

function renderMention(label: string, onNavigate: () => void = () => {}) {
  return (
    <MemoryRouter>
      <MentionLink
        mentionType="agent"
        mentionId="agent-1"
        fallbackLabel="agent-handle"
        onNavigate={onNavigate}
      >
        {label}
      </MentionLink>
    </MemoryRouter>
  );
}

test("bare mention shows the best available label across cold-to-warm commits", () => {
  let navigateCount = 0;
  const visibleCommits: string[] = [];
  const view = render(renderMention("@agent-handle", () => { navigateCount++; }));

  const coldTrigger = screen.getByRole("link", { name: "@agent-handle" });
  visibleCommits.push(coldTrigger.textContent ?? "");
  coldTrigger.click();
  assert.equal(navigateCount, 1, "the cold fallback remains bound to the canonical mention id");

  view.rerender(renderMention("@Agent Display", () => { navigateCount++; }));
  const warmTrigger = screen.getByRole("link", { name: "@Agent Display" });
  visibleCommits.push(warmTrigger.textContent ?? "");

  assert.deepEqual(visibleCommits, ["@agent-handle", "@Agent Display"]);
});

test("resolved self-mention display labels keep canonical navigation", () => {
  const previousUser = useAuthStore.getState().user;
  useAuthStore.setState({ user: { id: "user-1" } as never });
  let navigateCount = 0;
  const view = render(
    <MemoryRouter>
      <MentionLink
        mentionType="user"
        mentionId="user-1"
        fallbackLabel="ada"
        onNavigate={() => { navigateCount++; }}
      >
        @Ada
      </MentionLink>
    </MemoryRouter>,
  );

  screen.getByText("@Ada").closest("a")?.click();
  assert.equal(navigateCount, 1);
  view.unmount();
  useAuthStore.setState({ user: previousUser });
});
