import type { ReactNode } from "react";
import { MessageItemSearchMatch } from "@botiverse/raft-ui";

/** A search hit inside a message's text: raft-ui's MessageItemSearchMatch, with the test id its surface reads. */
export function MessageTextMark({ testId, children }: { testId: string; children?: ReactNode }) {
  return <MessageItemSearchMatch data-testid={testId}>{children}</MessageItemSearchMatch>;
}
