import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import SelectShareLightbox from "../src/components/message/SelectShareLightbox";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const DATA_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av5NAAAAAElFTkSuQmCC";

type ClipboardPayload = Record<string, Blob | Promise<Blob>>;

class FakeClipboardItem {
  readonly payload: ClipboardPayload;

  constructor(payload: ClipboardPayload) {
    this.payload = payload;
  }
}

const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalPermissions = Object.getOwnPropertyDescriptor(navigator, "permissions");
let permissionQueryCalls = 0;

function installClipboard(
  write: (items: ClipboardItem[]) => Promise<void>,
  permissionState: PermissionState | null = "granted",
) {
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: FakeClipboardItem,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: permissionState === null
      ? undefined
      : {
          query: async () => {
            permissionQueryCalls += 1;
            return {
              state: permissionState,
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
            };
          },
        },
  });
}

beforeEach(() => {
  permissionQueryCalls = 0;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

afterEach(() => {
  cleanup();
  if (originalClipboardItem) {
    Object.defineProperty(globalThis, "ClipboardItem", originalClipboardItem);
  } else {
    Reflect.deleteProperty(globalThis, "ClipboardItem");
  }
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  if (originalPermissions) {
    Object.defineProperty(navigator, "permissions", originalPermissions);
  } else {
    Reflect.deleteProperty(navigator, "permissions");
  }
});

test("Share preview copies the generated PNG without closing the modal", async () => {
  const writes: ClipboardItem[][] = [];
  installClipboard(async (items) => {
    writes.push(items);
  });
  let closeCalls = 0;

  render(
    <SelectShareLightbox
      dataUrl={DATA_IMAGE}
      onClose={() => {
        closeCalls += 1;
      }}
    />,
  );

  fireEvent.click(await screen.findByTestId("select-share-lightbox-copy-image"));

  await screen.findByText("Copied");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.length, 1);
  const item = writes[0]?.[0] as unknown as FakeClipboardItem;
  const png = await item.payload["image/png"];
  assert.ok(png instanceof Blob);
  assert.equal(png.type, "image/png");
  assert.ok(png.size > 0);
  assert.equal(closeCalls, 0, "copy should preserve the preview and current selection");
});

test("Share preview renders every footer action as a compact raft-ui Button", async () => {
  installClipboard(async () => undefined);

  render(
    <SelectShareLightbox
      dataUrl={DATA_IMAGE}
      onClose={() => undefined}
      onShareToX={async () => undefined}
    />,
  );

  const actionIds = [
    "select-share-lightbox-copy-image",
    "select-share-lightbox-download",
    "select-share-lightbox-share-x",
  ];

  for (const testId of actionIds) {
    const action = await screen.findByTestId(testId);
    assert.equal(action.getAttribute("data-slot"), "button", `${testId} should be owned by raft-ui Button`);
    assert.equal(action.classList.contains("h-7"), true, `${testId} should use the 28px shared-button height`);
    assert.equal(action.classList.contains("text-xs"), true, `${testId} should use compact button text`);
    assert.equal(action.classList.contains("h-11"), false, `${testId} must not restore the oversized footer action`);
  }
});

test("Share preview does not render Copy when image clipboard is unsupported", async () => {
  Reflect.deleteProperty(globalThis, "ClipboardItem");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write: undefined },
  });

  render(<SelectShareLightbox dataUrl={DATA_IMAGE} onClose={() => undefined} />);
  await waitFor(() => {
    assert.equal(screen.queryByTestId("select-share-lightbox-copy-image"), null);
  });
  assert.ok(screen.getByTestId("select-share-lightbox-download"));
});

test("Share preview does not render Copy when clipboard-write permission is denied", async () => {
  installClipboard(async () => undefined, "denied");

  render(<SelectShareLightbox dataUrl={DATA_IMAGE} onClose={() => undefined} />);
  await waitFor(() => {
    assert.equal(permissionQueryCalls, 1);
    assert.equal(screen.queryByTestId("select-share-lightbox-copy-image"), null);
  });
  assert.ok(screen.getByTestId("select-share-lightbox-download"));
});

test("Share preview does not upscale the captured CSS width", () => {
  render(<SelectShareLightbox dataUrl={DATA_IMAGE} onClose={() => undefined} />);
  const image = screen.getByRole("img", { name: "Selected messages screenshot preview" });
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1098 });

  act(() => {
    fireEvent.load(image);
  });

  assert.equal(image.getAttribute("style"), "width: 549px;");
});
