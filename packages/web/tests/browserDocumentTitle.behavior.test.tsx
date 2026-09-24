import assert from "node:assert/strict";
import test from "node:test";
import { render } from "@testing-library/react";
import { useBrowserDocumentTitle } from "../src/utils/browserDocumentTitle";

function TitleHarness({ title }: { title: string }) {
  useBrowserDocumentTitle(title);
  return null;
}

test("mounted host-shell title transitions never restore the generic title", () => {
  const writes: string[] = [];
  let currentTitle = "Raft";
  Object.defineProperty(document, "title", {
    configurable: true,
    get: () => currentTitle,
    set: (value: string) => {
      currentTitle = value;
      writes.push(value);
    },
  });

  try {
    const view = render(<TitleHarness title="Computers" />);
    view.rerender(<TitleHarness title="Jony's Mac" />);
    view.rerender(<TitleHarness title="Jony" />);
    view.rerender(<TitleHarness title="Jony's Mac" />);

    assert.deepEqual(writes, ["Computers", "Jony's Mac", "Jony", "Jony's Mac"]);

    view.unmount();
    assert.deepEqual(writes, ["Computers", "Jony's Mac", "Jony", "Jony's Mac", "Raft"]);
  } finally {
    Reflect.deleteProperty(document, "title");
  }
});
