import type { ComponentProps } from "react";
import type * as RaftUi from "@botiverse/raft-ui";

// raft-ui ScrollArea adds its overscroll class only while an axis overflows,
// which jsdom never lays out. For a test that needs the `overscroll` a call
// site asked for, wrap ScrollArea so the root also carries it as
// `data-test-overscroll` (raft-ui's default is "none"):
//
//   vi.mock("@botiverse/raft-ui", async (importOriginal) =>
//     (await import("./helpers/scrollAreaOverscrollProbe")).withOverscrollProbe(await importOriginal()));
export function withOverscrollProbe(actual: typeof RaftUi): typeof RaftUi {
  const { ScrollArea } = actual;
  function ProbedScrollArea(props: ComponentProps<typeof ScrollArea>) {
    return <ScrollArea {...props} data-test-overscroll={props.overscroll ?? "none"} />;
  }
  return { ...actual, ScrollArea: ProbedScrollArea as typeof ScrollArea };
}
