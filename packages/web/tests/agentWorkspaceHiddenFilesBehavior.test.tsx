import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

afterEach(() => {
  localStorage.clear();
  cleanup();
});

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

test("Agent Workspace exposes hidden files with a direct eye toggle and reloads with includeHidden", async () => {
  installLocalStorage();
  const [{ default: AgentWorkspace }, { default: api }] = await Promise.all([
    import("../src/components/agent/AgentWorkspace"),
    import("../src/api/client"),
  ]);
  const originalGet = api.get.bind(api);
  const calls: Array<{ url: string; params?: Record<string, unknown> }> = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    calls.push({ url, params: config?.params });
    return { data: { files: [] } };
  }) as typeof api.get;

  const { container, getByLabelText } = render(<AgentWorkspace agentId="agent-1" />);
  await act(async () => {});

  const toggle = getByLabelText("Hidden files hidden") as HTMLButtonElement;
  assert.equal(
    container.querySelector('[title="View options"]'),
    null,
    "hidden-file control should be directly visible, not tucked behind the old view-options menu",
  );
  assert.equal(toggle.tagName, "BUTTON");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.match(toggle.className, /text-black\/40/);
  assert.doesNotMatch(toggle.className, /\bborder\b/);
  assert.doesNotMatch(toggle.className, /\bbg-white\b/);
  assert.deepEqual(calls.at(-1), {
    url: "/agents/agent-1/workspace-files",
    params: { includeHidden: false },
  });

  assert.equal(
    container.querySelector('input[type="checkbox"]'),
    null,
    "hidden-file control should be an icon toggle, not a checkbox",
  );

  await act(async () => {
    toggle.click();
  });

  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "Hidden files shown");
  assert.equal(localStorage.getItem("slock:agentWorkspace:agent-1:showHidden"), "true");
  assert.deepEqual(calls.at(-1), {
    url: "/agents/agent-1/workspace-files",
    params: { includeHidden: true },
  });

  api.get = originalGet;
});

test("Agent Workspace exposes the runtime path, copy and real markdown view controls", async () => {
  installLocalStorage();
  const [{ default: AgentWorkspace }, { default: api }, { useAgentStore }] = await Promise.all([
    import("../src/components/agent/AgentWorkspace"),
    import("../src/api/client"),
    import("../src/store/agentStore"),
  ]);
  const originalGet = api.get.bind(api);
  const originalClipboard = navigator.clipboard;
  const clipboardWrites: string[] = [];
  const runtimePath = "/srv/raft/agents/agent-1/workspace";
  const longToken = "workspace-inline-token-without-any-natural-breakpoints-0123456789";
  const markdown = `Runtime note with \`${longToken}\`.`;

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        clipboardWrites.push(value);
      },
    },
  });
  useAgentStore.setState({
    agents: [{
      id: "agent-1",
      name: "agent-1",
      displayName: "Agent One",
      runtimeProfile: {
        migrationStatus: "stable",
        current: { workspacePathRef: { path: runtimePath } },
      },
    } as never],
  });
  api.get = (async (url: string) => {
    if (url === "/agents/agent-1/workspace-files/read") {
      return {
        data: {
          path: "notes.md",
          content: markdown,
          binary: false,
          size: markdown.length,
          modifiedAt: "2026-08-20T00:00:00.000Z",
        },
      };
    }
    return {
      data: {
        files: [{
          name: "notes.md",
          path: "notes.md",
          isDirectory: false,
          size: markdown.length,
          modifiedAt: "2026-08-20T00:00:00.000Z",
        }],
      },
    };
  }) as typeof api.get;

  try {
    const { container } = render(<AgentWorkspace agentId="agent-1" compact />);

    await waitFor(() => assert.ok(screen.getByText(runtimePath)));
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Copy path"));
      await Promise.resolve();
    });
    assert.deepEqual(clipboardWrites, [runtimePath]);

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    });
    await screen.findByTestId("workspace-file-view-preview");

    const inlineCode = await screen.findByText(longToken);
    assert.match(inlineCode.className, /bg-soft-signal\/40/);
    assert.match(inlineCode.className, /\[overflow-wrap:anywhere\]/);
    assert.doesNotMatch(inlineCode.className, /\[overflow-wrap:normal\]|wrap-normal/);

    fireEvent.click(screen.getByTestId("workspace-file-view-raw"));
    assert.equal(screen.queryByText(longToken), null);
    assert.equal(container.querySelector("pre")?.textContent, markdown);

    fireEvent.click(screen.getByTestId("workspace-file-view-preview"));
    assert.ok(screen.getByText(longToken));
  } finally {
    api.get = originalGet as typeof api.get;
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  }
});
