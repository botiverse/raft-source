import assert from "node:assert/strict";
import test from "node:test";
import mermaid from "mermaid";
import { renderMermaidDiagram } from "../src/components/markdown/mermaid/mermaidRenderer";

test("unknown diagram types reject before Mermaid's serialized parse queue", async () => {
  const originalParse = mermaid.parse;
  let parseCalls = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  mermaid.parse = (() => {
    parseCalls += 1;
    return new Promise<never>(() => {});
  }) as typeof mermaid.parse;

  try {
    const outcome = await Promise.race([
      renderMermaidDiagram("not a diagram from the queue-boundary test", "light").then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), 100);
      }),
    ]);

    assert.equal(outcome.kind, "rejected", "unknown source must not wait for the parse queue");
    assert.equal(parseCalls, 0, "Mermaid parse queue must remain untouched for an unknown type");
    if (outcome.kind === "rejected") {
      assert.match(String(outcome.error), /No diagram type detected/);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    mermaid.parse = originalParse;
  }
});
