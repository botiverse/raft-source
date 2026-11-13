import { Suspense } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import { useIntl } from "react-intl";
import { Spinner } from "@botiverse/raft-ui";
import { lazyPanel } from "../../boot/deferredUi";

// The feedback workspace and its stylesheet; a failed download of either shows Try again in its place.
const AboutFeedbackPanel = lazyPanel(async () => {
  const [, panel] = await Promise.all([
    import.meta.env
      ? import("@botiverse/hands-feedback-react/styles.css")
      : Promise.resolve(),
    import("./AboutFeedbackDialog"),
  ]);
  return panel;
});

function FeedbackWorkspacePending() {
  const { formatMessage } = useIntl();
  const loading = formatMessage({ id: "settings.about.feedbackWorkspaceLoading" });

  return (
    <div
      aria-busy="true"
      className="flex h-full min-h-40 items-center justify-center gap-3 bg-layer-canvas px-4 py-8 text-callout text-foreground-hint"
    >
      <div role="status" className="flex items-center gap-3">
        <Spinner size="md" aria-label={loading} />
        <span>{loading}</span>
      </div>
    </div>
  );
}

export function LazyAboutFeedbackPanel({
  panel: Panel = AboutFeedbackPanel,
}: {
  panel?: ComponentType | LazyExoticComponent<ComponentType>;
}) {
  return (
    <Suspense fallback={<FeedbackWorkspacePending />}>
      <Panel />
    </Suspense>
  );
}
