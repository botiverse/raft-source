import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";
import type { RuntimeFormV2Field } from "@botiverse/raft-runtime-form";
import { RuntimeFormV2FieldControl } from "../src/components/agent/RuntimeFormV2FieldControl";
import { TestIntlProvider } from "./helpers/intl";

// A boolean runtime setting (Codex "Fast mode") shows its hint once: as the
// option card's description, not again as the field's hint below it.

afterEach(() => cleanup());

const HINT = "Launch this runtime with higher speed at a higher cost per token.";

test("a boolean field's hint appears exactly once", () => {
  const field = { key: "fastMode", kind: "boolean", label: "Fast mode", hint: HINT } as RuntimeFormV2Field;
  const { container } = render(
    <TestIntlProvider>
      <RuntimeFormV2FieldControl
        field={field}
        sources={{}}
        values={{}}
        onChange={() => {}}
        error={undefined}
        editing={false}
        retryingSourceIds={[]}
      />
    </TestIntlProvider>,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Fast mode"));
  assert.equal(text.split(HINT).length - 1, 1);
});
