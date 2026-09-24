import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";

import { useAttachmentPreviewBridge } from "../src/components/message/attachmentPreviewBridge";

afterEach(cleanup);

test("each iframe load receives a fresh parent-minted document epoch", () => {
  const messages: Array<Record<string, unknown>> = [];
  const { result } = renderHook(() => useAttachmentPreviewBridge());
  result.current.iframeRef.current = {
    contentWindow: {
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
      },
    },
  } as unknown as HTMLIFrameElement;

  act(() => result.current.activateDocument());
  act(() => result.current.activateDocument());

  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, "activate-document");
  assert.equal(messages[1].type, "activate-document");
  assert.equal(messages[0].nonce, messages[1].nonce, "the preview instance nonce remains stable");
  assert.equal(typeof messages[0].documentEpoch, "string");
  assert.equal(typeof messages[1].documentEpoch, "string");
  assert.notEqual(
    messages[0].documentEpoch,
    messages[1].documentEpoch,
    "a preview-lifetime epoch would let delayed old-document reports cross a self-navigation",
  );
});
