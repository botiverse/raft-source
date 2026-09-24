import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AgentAvatar } from "../src/components/agent/PixelAvatar";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

test("a failed custom agent avatar falls back to the canonical pixel avatar", () => {
  const { container, rerender } = render(
    <TestIntlProvider>
      <AgentAvatar avatarUrl="https://cdn.example.com/broken-agent.png" size={32} />
    </TestIntlProvider>,
  );

  const customAvatar = container.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/broken-agent.png"]');
  assert.ok(customAvatar);
  assert.equal(container.querySelector("[data-cell-size]"), null);

  fireEvent.error(customAvatar);
  assert.equal(container.querySelector("img"), null);
  assert.ok(container.querySelector("[data-cell-size]"));

  rerender(
    <TestIntlProvider>
      <AgentAvatar avatarUrl="https://cdn.example.com/replacement-agent.png" size={32} />
    </TestIntlProvider>,
  );
  assert.ok(container.querySelector('img[src="https://cdn.example.com/replacement-agent.png"]'));
  assert.equal(container.querySelector("[data-cell-size]"), null);
});
