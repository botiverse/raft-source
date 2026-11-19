import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { SuggestedRuntimeNotice } from "../src/features/agent/SuggestedRuntimeNotice";
import { TestIntlProvider } from "./helpers/intl";

// A Create Agent card's suggested runtime: preselected, it needs no note
// (cindyz, #customer-support:11e49258); not available on the chosen computer,
// the dialog still says why.

afterEach(() => cleanup());

function renderNotice(props: { runtime: string; unavailable: "not_on_computer" | "not_admitted" | null }) {
  return render(
    <TestIntlProvider>
      <SuggestedRuntimeNotice suggestedRuntime="codex" computerName="Mac mini" {...props} />
    </TestIntlProvider>,
  );
}

test("a preselected suggested runtime shows no note", () => {
  const { container } = renderNotice({ runtime: "codex", unavailable: null });
  assert.equal(container.textContent, "");
});

test("a suggested runtime the computer lacks still says why", () => {
  renderNotice({ runtime: "", unavailable: "not_on_computer" });
  const note = screen.getByTestId("create-agent-suggested-runtime-unavailable");
  assert.ok((note.textContent ?? "").includes("Mac mini"));
});
