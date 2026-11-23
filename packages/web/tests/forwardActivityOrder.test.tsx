import assert from "node:assert/strict";
import { act, cleanup, renderHook } from "@testing-library/react";
import { getForwardTargets } from "../src/components/message/forwardComposerModel";
import { useForwardActivity } from "../src/components/message/useForwardActivity";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";

// The forward dialog lists destinations by latest activity as it was when the
// dialog opened: a message arriving somewhere while it is open must not move a
// row under the pointer.

function ch(id: string): Channel {
  return { id, name: id, description: null, type: "channel", createdAt: "2026-01-01T00:00:00.000Z", joined: true };
}
const targets = [ch("a"), ch("b"), ch("c")];
const order = (activity: Record<string, string | null>) => getForwardTargets(targets, [], "", activity).map((target) => target.id);

afterEach(() => {
  cleanup();
  useChannelStore.setState(useChannelStore.getInitialState(), true);
});

test("the order follows the activity present when the dialog opens and holds while it is open", () => {
  useChannelStore.setState({ channelActivity: { a: "2026-02-01T00:00:00.000Z", b: "2026-02-03T00:00:00.000Z", c: "2026-02-02T00:00:00.000Z" } });
  let renders = 0;
  const dialog = renderHook(() => {
    renders += 1;
    return useForwardActivity(true);
  });
  assert.deepEqual(order(dialog.result.current), ["b", "c", "a"]);
  const opened = dialog.result.current;
  const rendersAtOpen = renders;

  act(() => useChannelStore.getState().touchChannelActivity("a", "2026-02-09T00:00:00.000Z"));
  assert.equal(useChannelStore.getState().channelActivity.a, "2026-02-09T00:00:00.000Z");
  assert.equal(dialog.result.current, opened);
  assert.deepEqual(order(dialog.result.current), ["b", "c", "a"]);
  assert.equal(renders, rendersAtOpen, "activity elsewhere does not render the dialog");
  dialog.rerender();
  assert.deepEqual(order(dialog.result.current), ["b", "c", "a"]);

  // Opened again, it has the newer activity.
  assert.deepEqual(order(renderHook(() => useForwardActivity(true)).result.current), ["a", "b", "c"]);
});

test("without the flag activity is ignored", () => {
  useChannelStore.setState({ channelActivity: { c: "2026-02-03T00:00:00.000Z" } });
  const dialog = renderHook(() => useForwardActivity(false));
  assert.deepEqual(dialog.result.current, {});
  assert.deepEqual(order(dialog.result.current), ["a", "b", "c"]);
});
