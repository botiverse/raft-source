import { lazy, Suspense } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import { useIntl } from "react-intl";
import Spinner from "../ui/Spinner";

const AboutFeedbackPanel = lazy(async () => {
  const [, panel] = await Promise.all([
    import.meta.env
      ? import("@botiverse/hands-feedback-react/source/styles.css")
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
      className="flex h-full min-h-40 items-center justify-center gap-3 bg-layer-primary px-4 py-8 text-sm font-medium text-foreground-muted"
    >
      <div role="status" className="flex items-center gap-3">
        <Spinner size="md" label={loading} />
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
