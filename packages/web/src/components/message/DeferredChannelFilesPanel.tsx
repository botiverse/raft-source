import { Suspense } from "react";
import type { ComponentProps } from "react";
import { useIntl } from "react-intl";
import { deferredPanel } from "../../boot/deferredUi";
import { ContentLoading } from "../ui/ContentLoading";

// The channel's files (the Files card and the legacy Files tab) open from a
// click, so their code is deferred (boot/deferredUi): fetched after the first
// screen, normally in before anyone opens them.
const LazyChannelFilesPanel = deferredPanel(() => import("./ChannelFilesPanel"));

/** ChannelFilesPanel, its code deferred: until it is in, the line the panel shows while its files load. */
export function ChannelFilesPanel(props: ComponentProps<typeof LazyChannelFilesPanel>) {
  const { formatMessage } = useIntl();
  return (
    <Suspense fallback={<ContentLoading className="h-full flex-1">{formatMessage({ id: "message.channelFilesPanel.loading" })}</ContentLoading>}>
      <LazyChannelFilesPanel {...props} />
    </Suspense>
  );
}
