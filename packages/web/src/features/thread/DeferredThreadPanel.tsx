import { Suspense } from "react";
import { ThreadPanelRoot } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { deferredPanel } from "../../boot/deferredUi";
import { PanelLoading } from "../../components/layout/PanelLoading";
import { loadThreadPanel } from "./threadPanelChunk";
import type { ThreadPanelProps } from "./threadPanelTypes";

const LazyThreadPanel = deferredPanel(loadThreadPanel);

function ThreadPanelLoading({ presentation, edge }: Pick<ThreadPanelProps, "presentation" | "edge">) {
  const { formatMessage } = useIntl();
  // The panel's own root (raft-ui ThreadPanelRoot, as AuthenticatedThreadPanel and ReadOnlyThreadPanel draw
  // it): its left divider is there while the code loads, so the column neither moves nor loses its edge when it
  // arrives (public page: one line at the thread's left edge, public-server-parity.spec.ts).
  return (
    <ThreadPanelRoot
      // AuthenticatedThreadPanel's own rule: a modal or an inset panel has no attached left edge.
      className={presentation === "modal" || presentation === "mobile-modal" || edge === "inset"
        ? "isolate flex h-full min-h-0 w-full flex-col bg-layer-canvas border-l-0"
        : "isolate flex h-full min-h-0 w-full flex-col bg-layer-canvas"}
    >
      <PanelLoading className="flex h-full min-h-0 w-full" label={formatMessage({ id: "layout.main.loading" })} testId="thread-panel-loading" />
    </ThreadPanelRoot>
  );
}

/** ThreadPanel, its code deferred (threadPanelChunk.ts): the loading line in its place until it is in. */
export function ThreadPanel(props: ThreadPanelProps) {
  return (
    <Suspense fallback={<ThreadPanelLoading presentation={props.presentation} edge={props.edge} />}>
      <LazyThreadPanel {...props} />
    </Suspense>
  );
}
